// Build-layer tests for gulp/tasks/package.js: the packaged output a consumer
// ships. The one build.js and no sidecar, the version guard, the icon prune,
// declared arrays beating defaults, a real firefox artifact (panel keys, gecko
// id, chrome-only permissions), resolved config tokens in the manifest and the
// store descriptions, and the build hook paths and ctx. Each test stages a temp
// project and requires the task fresh inside it (utils/package-project.js).

require('@omega.js/devkit/test/temp-home');

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const JSON5 = require('json5');
const defineCases = require('@omega.js/devkit/test/define-cases');
const { hashKey } = require('@omega.js/devkit/translate');
const { SRC, stageProject, inProject, MANIFEST } = require('../../utils/package-project.js');

const PUBLISH_TASK_PATH = path.join(SRC, 'gulp', 'tasks', 'publish.js');
const { readBakedBuildJson } = require(path.join(SRC, 'gulp', 'tasks', 'utils', 'build-json.js'));

// Set env vars for one test, restoring exactly what was there (an empty string
// means "declared but empty", the CI-with-no-.env shape) — returns the undo.
//
// OMEGA_ENVIRONMENT is always saved and cleared, whether or not the caller names
// it: it is the ONE environment input
// ([#817](https://github.com/Omega-JS-Stack/omega/issues/817)) and src/build.js
// WRITES it at load from the lane, so a case that flips OMEGA_BUILD_MODE and
// re-enters inProject() would otherwise leave the lane's word behind it.
function withEnv(vars) {
  const previous = { OMEGA_ENVIRONMENT: process.env.OMEGA_ENVIRONMENT };
  delete process.env.OMEGA_ENVIRONMENT;
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// A consumer build hook that records WHICH path the resolver found it at, and
// the SHAPE of the argument it was handed (#591).
const HOOK = (which) => `
import fs from 'node:fs';
import path from 'node:path';

export default async (ctx) => {
  fs.writeFileSync(path.join(process.cwd(), 'hook-ran.json'), JSON.stringify({
    which: '${which}',
    keys: Object.keys(ctx || {}).sort(),
    projectRoot: ctx && ctx.projectRoot,
    mode: ctx && ctx.mode,
    hasBuild: Boolean(ctx && ctx.build && typeof ctx.build.getConfig === 'function'),
  }));
};
`;

// A packageable project carrying the given hook files, so a hook runs where a
// consumer's runs: inside the real package lane.
function stageHookProject(files) {
  return stageProject({
    config: `{ brand: { id: 'staged', name: 'Staged' }, targets: { extension: { type: 'extension' } } }`,
    files: {
      'dist/manifest.json': MANIFEST(`description: 'a packageable extension'`),
      'dist/assets/js/x.js': `globalThis.probe = 1;\n`,
      'dist/_locales/en/messages.json': `{ "appName": { "message": "Staged" } }`,
      ...files,
    },
  });
}

// Run the package lane to its end, answering its failure (undefined when none).
function runPackage(task) {
  return new Promise((resolve) => task.packageFn(resolve));
}

module.exports = defineCases({
  type: 'suite',
  layer: 'build',
  description: 'package task: the one build.js ships, no build.json sidecar, manifest version guard, icon prune',
  tests: [
    {
      name: 'the packaged artifact carries the ONE build.js, and no build.json (#743)',
      run: async (ctx) => {
        // The snapshot is one file at the artifact's root, written by the bundle
        // task and copied here with the rest of dist: the page template loads it
        // with a script tag and background.js with importScripts. The build.json
        // sidecar that used to sit beside it described the same build a second
        // time and is gone.
        const tmp = stageProject({
          config: `{ brand: { id: 'staged', name: 'Staged' }, targets: { extension: { type: 'extension' } } }`,
          files: {
            'dist/manifest.json': MANIFEST(`description: 'a packageable extension'`),
            'dist/build.js': `self.OMEGA_BUILD_JSON = {"config":{"brand":{"id":"staged"}}};\nself.OMEGA_BUILD_JSON.config.dev = null;\n`,
            'dist/assets/js/components/popup.bundle.js': `globalThis.probe = 1;\n`,
            'dist/_locales/en/messages.json': `{ "appName": { "message": "Staged" } }`,
          },
        });
        try {
          await inProject(tmp, async (task) => {
            const failure = await new Promise((resolve) => task.packageFn(resolve));
            ctx.expect(failure).toBe(undefined);

            const raw = path.join(tmp, 'packaged', 'chrome', 'raw');
            // The package lane ran for real: the compiled manifest is there…
            ctx.expect(fs.existsSync(path.join(raw, 'manifest.json'))).toBe(true);
            // …and so is the one snapshot every context loads, unchanged.
            ctx.expect(fs.existsSync(path.join(raw, 'build.js'))).toBe(true);
            ctx.expect(readBakedBuildJson(path.join(raw, 'build.js')).config.brand.id).toBe('staged');
            // The sidecar nothing read is gone.
            ctx.expect(fs.existsSync(path.join(raw, 'build.json'))).toBe(false);
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'the packaged copy ships the bundles without their source maps, which stay in dist',
      run: async (ctx) => {
        const tmp = stageProject({
          config: `{ brand: { id: 'staged', name: 'Staged' }, targets: { extension: { type: 'extension' } } }`,
          files: {
            'dist/manifest.json': MANIFEST(`description: 'a packageable extension'`),
            'dist/assets/js/x.js': `globalThis.probe = 1;\n//# sourceMappingURL=x.js.map\n`,
            'dist/assets/js/x.js.map': `{"version":3,"sources":[],"mappings":""}`,
            'dist/_locales/en/messages.json': `{ "appName": { "message": "Staged" } }`,
          },
        });
        try {
          await inProject(tmp, async (task) => {
            const failure = await new Promise((resolve) => task.packageFn(resolve));
            ctx.expect(failure).toBe(undefined);

            const raw = path.join(tmp, 'packaged', 'chrome', 'raw');
            ctx.expect(fs.existsSync(path.join(raw, 'assets', 'js', 'x.js'))).toBe(true);
            ctx.expect(fs.existsSync(path.join(raw, 'assets', 'js', 'x.js.map'))).toBe(false);
            ctx.expect(fs.existsSync(path.join(tmp, 'dist', 'assets', 'js', 'x.js.map'))).toBe(true);
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'the manifest\'s dev origin is the RESOLVED website origin, never a baked literal (#262)',
      run: async (ctx) => {
        // Same staging as the dev.ports test: a brand with a live website app
        // that published a bumped, https origin beside its port.
        const brand = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-dev-origin-brand-'));
        fs.mkdirSync(path.join(brand, 'config'), { recursive: true });
        fs.writeFileSync(path.join(brand, 'config', 'omega.json5'), `{ brand: { id: 'staged', name: 'Staged' } }`);
        fs.mkdirSync(path.join(brand, 'targets', 'web', '.temp'), { recursive: true });
        fs.writeFileSync(path.join(brand, 'targets', 'web', '.temp', 'ports.json'), JSON.stringify({
          ports: { website: 4001 }, origin: 'https://localhost:4001', pid: process.pid, startedAt: 'x',
        }));

        const app = path.join(brand, 'targets', 'extension');
        fs.mkdirSync(path.join(app, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(app, 'package.json'), `{ "name": "staged-ext", "version": "3.1.4" }`);
        fs.writeFileSync(path.join(app, 'dist', 'manifest.json'), MANIFEST(`description: 'no externally_connectable anywhere'`));

        try {
          await inProject(app, async (task) => {
            const outputDir = path.join(app, 'out');
            await task.compileManifest(outputDir, 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            // Protocol AND port both follow the live dev server — the old bake
            // said http://localhost:4000 while `omega dev` served https
            ctx.expect(m.externally_connectable.matches).toEqual(['https://localhost:4001/*']);
          });
        } finally {
          fs.rmSync(brand, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'a versionless app FAILS the package task (no green build, no raw JSON5 manifest)',
      run: async (ctx) => {
        const tmp = stageProject({
          pkg: `{ "name": "versionless-ext" }`,
          files: {
            'dist/manifest.json': MANIFEST(`description: 'no version anywhere'`),
            'dist/assets/js/placeholder.js': `// keeps the redaction walk happy\n`,
          },
        });
        try {
          await inProject(tmp, async (task) => {
            // Drive the real gulp task: it must hand its `complete` callback an error.
            // (The build-error reporter fires for real here — its notifly note in
            // the log is the failure being reported, not a test problem.)
            const failure = await new Promise((resolve) => task.packageFn(resolve));
            ctx.expect(failure).toBeInstanceOf(Error);
            ctx.expect(failure.message).toMatch(/version/);
            ctx.expect(failure.plugin).toBe('Package');

            // Never compiled: the packaged manifest is still the raw copied source
            const packaged = JSON5.parse(fs.readFileSync(path.join(tmp, 'packaged', 'chrome', 'raw', 'manifest.json'), 'utf8'));
            ctx.expect(packaged.version).toBeUndefined();
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'icon prune: string default_icon is dropped when unminted, kept when minted',
      run: async (ctx) => {
        const icon = 'assets/images/icons/icon-48x.png';
        const staged = (files) => stageProject({
          files: Object.assign({ 'dist/manifest.json': MANIFEST(`action: { default_icon: '${icon}' }`) }, files),
        });

        const missing = staged({});
        const minted  = staged({ [`dist/${icon}`]: 'PNG' });
        try {
          await inProject(missing, async (task) => {
            const outputDir = path.join(missing, 'out');
            await task.compileManifest(outputDir, 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            ctx.expect(m.action.default_icon).toBeUndefined();
            ctx.expect(m.version).toBe('3.1.4');
            // the full default ladder is unminted too, so `icons` goes entirely
            ctx.expect(m.icons).toBeUndefined();
          });

          await inProject(minted, async (task) => {
            const outputDir = path.join(minted, 'out');
            await task.compileManifest(outputDir, 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            ctx.expect(m.action.default_icon).toBe(icon);
            // the 48x default in `icons` survives on the same file
            ctx.expect(m.icons['48']).toBe(icon);
          });
        } finally {
          fs.rmSync(missing, { recursive: true, force: true });
          fs.rmSync(minted,  { recursive: true, force: true });
        }
      },
    },
    {
      name: 'icon prune: object default_icon is pruned PER ENTRY (chrome\'s size→path map)',
      run: async (ctx) => {
        const tmp = stageProject({
          files: {
            'dist/manifest.json': MANIFEST(`action: { default_icon: {
              '48': 'assets/images/icons/icon-48x.png',
              '32': 'assets/images/icons/icon-32x.png',
              '16': 'assets/images/icons/icon-16x.png',
            } }`),
            'dist/assets/images/icons/icon-16x.png': 'PNG',
          },
        });
        try {
          await inProject(tmp, async (task) => {
            const outputDir = path.join(tmp, 'out');
            await task.compileManifest(outputDir, 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            ctx.expect(m.action.default_icon).toEqual({ '16': 'assets/images/icons/icon-16x.png' });
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'icon prune: a fully minted object default_icon is untouched',
      run: async (ctx) => {
        const tmp = stageProject({
          files: {
            'dist/manifest.json': MANIFEST(`action: { default_icon: {
              '32': 'assets/images/icons/icon-32x.png',
              '16': 'assets/images/icons/icon-16x.png',
            } }`),
            'dist/assets/images/icons/icon-32x.png': 'PNG',
            'dist/assets/images/icons/icon-16x.png': 'PNG',
          },
        });
        try {
          await inProject(tmp, async (task) => {
            const outputDir = path.join(tmp, 'out');
            await task.compileManifest(outputDir, 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            ctx.expect(m.action.default_icon).toEqual({
              '32': 'assets/images/icons/icon-32x.png',
              '16': 'assets/images/icons/icon-16x.png',
            });
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'pipeline failures re-throw instead of finishing green (malformed locale)',
      run: async (ctx) => {
        // compileLocales: a locale that is not JSON5 makes the parse throw —
        // before #46 the catch logged and returned green.
        const localeTmp = stageProject({
          files: { 'dist/_locales/en/messages.json': '{ not: valid json5 ][' },
        });
        try {
          await inProject(localeTmp, async (task) => {
            let thrown = null;
            await task.compileLocales(path.join(localeTmp, 'out')).catch((e) => { thrown = e; });
            ctx.expect(thrown).toBeInstanceOf(Error);
          });
        } finally {
          fs.rmSync(localeTmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'externally_connectable: an explicitly EMPTY consumer array ships NO origins (#260)',
      run: async (ctx) => {
        const tmp = stageProject({
          files: { 'dist/manifest.json': MANIFEST(`externally_connectable: { matches: [] }`) },
        });
        try {
          await inProject(tmp, async (task) => {
            const outputDir = path.join(tmp, 'out');
            await task.compileManifest(outputDir, 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            // The dev origin the framework default carries never reaches the artifact
            ctx.expect(m.externally_connectable).toBeUndefined();
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'externally_connectable: a consumer array REPLACES the default, absent keeps it (#260)',
      run: async (ctx) => {
        const declared = stageProject({
          files: { 'dist/manifest.json': MANIFEST(`externally_connectable: { matches: ['https://example.com/*'] }`) },
        });
        const absent = stageProject({
          files: { 'dist/manifest.json': MANIFEST(`description: 'no externally_connectable anywhere'`) },
        });
        try {
          await inProject(declared, async (task) => {
            const outputDir = path.join(declared, 'out');
            await task.compileManifest(outputDir, 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            ctx.expect(m.externally_connectable.matches).toEqual(['https://example.com/*']);
          });

          await inProject(absent, async (task) => {
            const outputDir = path.join(absent, 'out');
            await task.compileManifest(outputDir, 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            // No live website published an origin — the classic assumption, over
            // the protocol `omega dev` speaks by default (#262)
            ctx.expect(m.externally_connectable.matches).toEqual(['https://localhost:4000/*']);
          });
        } finally {
          fs.rmSync(declared, { recursive: true, force: true });
          fs.rmSync(absent, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'background.scripts: a declared consumer array REPLACES the framework bundle entry (#260)',
      run: async (ctx) => {
        const declared = stageProject({
          files: {
            'dist/manifest.json': MANIFEST(`
              background: { scripts: ['assets/js/my-background.js'] },
              browser_specific_settings: { gecko: { id: 'staged@example.com' } },
            `),
          },
        });
        const absent = stageProject({
          files: {
            'dist/manifest.json': MANIFEST(`browser_specific_settings: { gecko: { id: 'staged@example.com' } }`),
          },
        });

        try {
          await inProject(declared, async (task) => {
            const outputDir = path.join(declared, 'out-firefox');
            await task.compileManifest(outputDir, 'firefox');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));

            // The framework's own bundle is NOT unioned back in — a consumer
            // that swaps the background entry ships only what it declared
            ctx.expect(m.background.scripts).toEqual(['assets/js/my-background.js']);
            ctx.expect(m.background.service_worker).toBeUndefined();
          });

          await inProject(absent, async (task) => {
            const outputDir = path.join(absent, 'out-firefox');
            await task.compileManifest(outputDir, 'firefox');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));

            // Declaring nothing still gets the framework bundle
            ctx.expect(m.background.scripts).toEqual(['assets/js/components/background.bundle.js']);
          });
        } finally {
          fs.rmSync(declared, { recursive: true, force: true });
          fs.rmSync(absent, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'gecko.data_collection_permissions.required: a declared consumer array REPLACES the default (#260)',
      run: async (ctx) => {
        const tmp = stageProject({
          files: {
            'dist/manifest.json': MANIFEST(`
              browser_specific_settings: {
                gecko: {
                  id: 'staged@example.com',
                  data_collection_permissions: { required: ['none'] },
                },
              },
            `),
          },
        });

        try {
          await inProject(tmp, async (task) => {
            const outputDir = path.join(tmp, 'out-firefox');
            await task.compileManifest(outputDir, 'firefox');
            const permissions = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'))
              .browser_specific_settings.gecko.data_collection_permissions;

            // Firefox reads `none` as "collects nothing" — unioning the
            // framework's authenticationInfo back in would declare a data
            // collection the extension does not do
            ctx.expect(permissions.required).toEqual(['none']);
            // The key the consumer left alone still carries the default
            ctx.expect(permissions.optional).toEqual(['technicalAndInteraction']);
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'the release upload uploads the zips the package task actually writes (#265)',
      run: async (ctx) => {
        // The upload used to be a shell block in the scaffolded workflow, and it
        // named packaged/extension.zip, a path no build has ever produced, so
        // the composed run died on its last step. It lives in the publish task
        // now (#883), so the two halves are driven for real here: the package
        // task writes the zips, the publish task uploads them, and a drift in
        // either one's path is a failed copy rather than a green build.
        const tmp = stageProject({
          config: `{ brand: { id: 'staged', name: 'Staged' }, targets: { extension: { type: 'extension' } } }`,
          files: {
            'dist/manifest.json': MANIFEST(`description: 'a packageable extension'`),
            'dist/assets/js/components/popup.bundle.js': `globalThis.probe = 1;\n`,
            'dist/_locales/en/messages.json': `{ "appName": { "message": "Staged" } }`,
          },
        });

        try {
          // No YAML names a zip path any more: the workflow calls the task.
          const workflow = fs.readFileSync(path.join(SRC, 'defaults', '.github', 'workflows', 'publish.yml'), 'utf8');
          ctx.expect(workflow).not.toMatch(/packaged\/[^\s"']*\.zip/);

          await inProject(tmp, async (task) => {
            const targets = Object.keys(task.TARGETS);
            ctx.expect(targets.length).toBeGreaterThan(0);

            const failure = await new Promise((resolve) => task.packageFn(resolve));
            ctx.expect(failure).toBe(undefined);

            // The zips are a BUILD-mode artifact, and a build-mode packageFn
            // also zips the source out of git, which a temp project has none of.
            const restore = withEnv({ OMEGA_BUILD_MODE: 'true' });
            try {
              await task.packageZip();
            } finally {
              restore();
            }

            const calls = [];
            const publish = require(PUBLISH_TASK_PATH);
            await publish.publishToGitHubRelease({
              config: { brand: { id: 'acme' }, repo: { provider: 'github', owner: 'Acme-Org' } },
              execFn: (file, args) => {
                calls.push(args);
                if (args[1] === 'view') throw new Error('release not found (HTTP 404)');
                return '';
              },
            });

            const uploaded = calls.filter((args) => args[1] === 'upload').map((args) => args[3]);
            ctx.expect(uploaded.length).toBe(targets.length);

            // Every uploaded asset IS the zip the package task just wrote
            for (const target of targets) {
              const written = path.join(tmp, 'packaged', target, 'extension.zip');
              ctx.expect(fs.existsSync(written)).toBe(true);

              const asset = uploaded.find((file) => path.basename(file) === `extension-${target}.zip`);
              ctx.expect(asset).toBeDefined();
              ctx.expect(fs.readFileSync(asset).equals(fs.readFileSync(written))).toBe(true);
            }
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'firefox: side_panel maps to sidebar_action, every chrome-only permission is dropped, chrome keeps them (#264, #957)',
      run: async (ctx) => {
        const tmp = stageProject({
          files: {
            'dist/manifest.json': MANIFEST(`
              permissions: ['sidePanel', 'offscreen', 'storage'],
              side_panel: { default_path: 'views/sidepanel/index.html' },
              browser_specific_settings: { gecko: { id: 'staged@example.com' } },
            `),
          },
        });
        try {
          await inProject(tmp, async (task) => {
            const firefoxDir = path.join(tmp, 'out-firefox');
            await task.compileManifest(firefoxDir, 'firefox');
            const firefox = JSON.parse(fs.readFileSync(path.join(firefoxDir, 'manifest.json'), 'utf8'));

            // Chrome-only panel keys are gone; firefox's own key carries the panel
            ctx.expect(firefox.side_panel).toBeUndefined();
            ctx.expect(firefox.sidebar_action.default_panel).toBe('views/sidepanel/index.html');
            ctx.expect(firefox.permissions).toEqual(['storage']);
            // The background translation firefox already did stays intact
            ctx.expect(firefox.background.service_worker).toBeUndefined();
            ctx.expect(firefox.background.scripts).toContain('assets/js/components/background.bundle.js');

            const chromeDir = path.join(tmp, 'out-chrome');
            await task.compileManifest(chromeDir, 'chrome');
            const chrome = JSON.parse(fs.readFileSync(path.join(chromeDir, 'manifest.json'), 'utf8'));

            ctx.expect(chrome.side_panel.default_path).toBe('views/sidepanel/index.html');
            ctx.expect(chrome.permissions).toEqual(['sidePanel', 'offscreen', 'storage']);
            ctx.expect(chrome.sidebar_action).toBeUndefined();
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'firefox: a missing browser_specific_settings.gecko.id FAILS the compile (#264)',
      run: async (ctx) => {
        const tmp = stageProject({
          files: { 'dist/manifest.json': MANIFEST(`description: 'no gecko id anywhere'`) },
        });
        try {
          await inProject(tmp, async (task) => {
            let thrown = null;
            await task.compileManifest(path.join(tmp, 'out-firefox'), 'firefox').catch((e) => { thrown = e; });
            ctx.expect(thrown).toBeInstanceOf(Error);
            // Actionable: names the key and what to put in it
            ctx.expect(thrown.message).toMatch(/browser_specific_settings\.gecko\.id/);
            ctx.expect(fs.existsSync(path.join(tmp, 'out-firefox', 'manifest.json'))).toBe(false);

            // The same source still packages for chrome: the gate is firefox's alone
            await task.compileManifest(path.join(tmp, 'out-chrome'), 'chrome');
            ctx.expect(fs.existsSync(path.join(tmp, 'out-chrome', 'manifest.json'))).toBe(true);
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'firefox: a missing gecko id DERIVES from the brand config — url host first, brand id fallback (#264)',
      run: async (ctx) => {
        // A fresh scaffold declares no gecko id but always has brand facts —
        // its first build must produce a working firefox artifact, not a throw.
        const withUrl = stageProject({
          config: `{ brand: { id: 'staged-brand', name: 'Staged', url: 'https://staged.example.com' } }`,
          files: { 'dist/manifest.json': MANIFEST(`description: 'no gecko id declared'`) },
        });
        const idOnly = stageProject({
          config: `{ brand: { id: 'staged-brand', name: 'Staged' } }`,
          files: { 'dist/manifest.json': MANIFEST(`description: 'no gecko id declared'`) },
        });

        try {
          await inProject(withUrl, async (task) => {
            const outputDir = path.join(withUrl, 'out-firefox');
            await task.compileManifest(outputDir, 'firefox');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            ctx.expect(m.browser_specific_settings.gecko.id).toBe('extension@staged.example.com');
          });

          await inProject(idOnly, async (task) => {
            const outputDir = path.join(idOnly, 'out-firefox');
            await task.compileManifest(outputDir, 'firefox');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            ctx.expect(m.browser_specific_settings.gecko.id).toBe('extension@staged-brand.extension');
          });
        } finally {
          fs.rmSync(withUrl, { recursive: true, force: true });
          fs.rmSync(idOnly, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'deriveFirefoxId: the url host first, the brand id next, then nothing (#893)',
      run: (ctx) => {
        // The derivation has ONE home (lib/listings.js), because two readers ask
        // it the same question: the package task, for the gecko id it writes
        // into the manifest, and the local scaffold, which pins that same value
        // into the brand config.
        const { deriveFirefoxId } = require(path.join(SRC, 'lib', 'listings.js'));

        ctx.expect(deriveFirefoxId({ brand: { id: 'staged-brand', url: 'https://staged.example.com/app' } })).toBe('extension@staged.example.com');
        ctx.expect(deriveFirefoxId({ brand: { id: 'staged-brand' } })).toBe('extension@staged-brand.extension');
        ctx.expect(deriveFirefoxId({})).toBe('');
      },
    },
    {
      name: 'firefox: the CONFIG listing id is the gecko id, and a contradicting manifest fails (#893)',
      run: async (ctx) => {
        // One home for the AMO add-on id: a brand declares it in config and the
        // manifest is written from it, so a publish and a package can never
        // address two different add-ons.
        const configured = stageProject({
          config: `{ brand: { id: 'staged-brand', name: 'Staged', url: 'https://staged.example.com' }, targets: { extension: { type: 'extension', listings: { firefox: { id: 'addon@staged.example.com' } } } } }`,
          files: { 'dist/manifest.json': MANIFEST(`description: 'id comes from config'`) },
        });
        const contradicting = stageProject({
          config: `{ brand: { id: 'staged-brand', name: 'Staged' }, targets: { extension: { type: 'extension', listings: { firefox: { id: 'addon@staged.example.com' } } } } }`,
          files: { 'dist/manifest.json': MANIFEST(`browser_specific_settings: { gecko: { id: 'other@staged.example.com' } }`) },
        });

        try {
          await inProject(configured, async (task) => {
            const outputDir = path.join(configured, 'out-firefox');
            await task.compileManifest(outputDir, 'firefox');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            ctx.expect(m.browser_specific_settings.gecko.id).toBe('addon@staged.example.com');
          });

          await inProject(contradicting, async (task) => {
            let thrown = null;
            await task.compileManifest(path.join(contradicting, 'out-firefox'), 'firefox').catch((e) => { thrown = e; });
            ctx.expect(thrown).toBeInstanceOf(Error);
            ctx.expect(thrown.message).toMatch(/other@staged\.example\.com/);
            ctx.expect(thrown.message).toMatch(/addon@staged\.example\.com/);
            ctx.expect(fs.existsSync(path.join(contradicting, 'out-firefox', 'manifest.json'))).toBe(false);
          });
        } finally {
          fs.rmSync(configured, { recursive: true, force: true });
          fs.rmSync(contradicting, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'store description assets ship RENDERED brand tokens — English and translated (#289)',
      run: async (ctx) => {
        // The scaffolded config/description.md is written with `{{ brand.name }}`
        // tokens; copied verbatim they reach the live store listing unrendered.
        const source = `{{ brand.name }} makes browsing better.\nGet it at {{ brand.url }}.`;
        const tmp = stageProject({
          config: `{ brand: { id: 'staged', name: 'Staged Brand', url: 'https://staged.example.com' } }`,
          files: {
            'config/description.md': source,
            // A translated variant carries the same tokens through the translator, saved under its source's hash
            'translations/es/description.json': JSON.stringify({ [hashKey(source)]: `{{ brand.name }} mejora tu navegación.\n` }),
          },
        });
        try {
          await inProject(tmp, async (task) => {
            await task.deployStoreAssets();

            const descDir = path.join(tmp, 'packaged', 'assets', 'description');

            const en = fs.readFileSync(path.join(descDir, 'en.md'), 'utf8');
            ctx.expect(en).toContain('Staged Brand makes browsing better.');
            ctx.expect(en).toContain('Get it at https://staged.example.com.');
            ctx.expect(en).not.toContain('{{');

            const es = fs.readFileSync(path.join(descDir, 'es.md'), 'utf8');
            ctx.expect(es).toContain('Staged Brand mejora tu navegación.');
            ctx.expect(es).not.toContain('{{');
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'homepage_url is baked from brand.url on every target, declared wins, absent ships nothing (#576)',
      run: async (ctx) => {
        const derived = stageProject({
          config: `{ brand: { id: 'staged', name: 'Staged', url: 'https://staged.example.com/extension' } }`,
          files: { 'dist/manifest.json': MANIFEST(`description: 'no homepage_url declared'`) },
        });
        const declared = stageProject({
          config: `{ brand: { id: 'staged', name: 'Staged', url: 'https://staged.example.com' } }`,
          files: { 'dist/manifest.json': MANIFEST(`homepage_url: 'https://staged.example.com/chrome'`) },
        });
        const noBrandUrl = stageProject({
          config: `{ brand: { id: 'staged', name: 'Staged' } }`,
          files: { 'dist/manifest.json': MANIFEST(`browser_specific_settings: { gecko: { id: 'staged@example.com' } }`) },
        });

        try {
          // Chrome and Firefox both link the store listing's developer site from it
          for (const target of ['chrome', 'firefox']) {
            await inProject(derived, async (task) => {
              const outputDir = path.join(derived, `out-${target}`);
              await task.compileManifest(outputDir, target);
              const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
              ctx.expect(m.homepage_url).toBe('https://staged.example.com/extension');
            });
          }

          await inProject(declared, async (task) => {
            const outputDir = path.join(declared, 'out');
            await task.compileManifest(outputDir, 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            ctx.expect(m.homepage_url).toBe('https://staged.example.com/chrome');
          });

          await inProject(noBrandUrl, async (task) => {
            const outputDir = path.join(noBrandUrl, 'out');
            await task.compileManifest(outputDir, 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            ctx.expect(m.homepage_url).toBeUndefined();
          });
        } finally {
          fs.rmSync(derived, { recursive: true, force: true });
          fs.rmSync(declared, { recursive: true, force: true });
          fs.rmSync(noBrandUrl, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'config tokens in the manifest resolve before writing, an unresolved one fails the compile (#958)',
      run: async (ctx) => {
        const config = `{ brand: { id: 'staged', name: 'Staged', url: 'https://staged.example.com' } }`;
        const SCRIPT = (match) => MANIFEST(`content_scripts: [{ matches: ['${match}'], js: ['content.js'] }]`);
        const resolved = stageProject({ config, files: { 'dist/manifest.json': SCRIPT('{{ brand.url }}/*') } });
        const typo = stageProject({ config, files: { 'dist/manifest.json': SCRIPT('{{ brand.uri }}/*') } });

        try {
          await inProject(resolved, async (task) => {
            await task.compileManifest(path.join(resolved, 'out'), 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(resolved, 'out', 'manifest.json'), 'utf8'));
            ctx.expect(m.content_scripts[0].matches).toEqual(['https://staged.example.com/*']);
          });

          // A literal token is a match pattern Chrome refuses to load
          await inProject(typo, async (task) => {
            let thrown = null;
            await task.compileManifest(path.join(typo, 'out'), 'chrome').catch((e) => { thrown = e; });
            ctx.expect(thrown?.message).toContain('{{ brand.uri }}');
            ctx.expect(fs.existsSync(path.join(typo, 'out', 'manifest.json'))).toBe(false);
          });
        } finally {
          fs.rmSync(resolved, { recursive: true, force: true });
          fs.rmSync(typo, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'every manifest match pattern is checked, an illegal one fails the compile naming it (#957)',
      run: async (ctx) => {
        const config = `{ brand: { id: 'staged', name: 'Staged' } }`;
        const LEGAL = ['*://*.example.com/*', 'https://example.com/*', 'http://localhost:*/*', 'file:///*', '<all_urls>'];
        const ILLEGAL = ['htp://example.com/*', 'https://example.com'];
        const list = (patterns) => patterns.map((p) => `'${p}'`).join(', ');
        const HOSTS = (patterns) => MANIFEST(`host_permissions: [${list(patterns)}]`);
        const SCRIPT = (patterns) => MANIFEST(`content_scripts: [{ matches: [${list(patterns)}], js: ['content.js'] }]`);
        const legal = stageProject({
          config,
          files: { 'dist/manifest.json': MANIFEST(`host_permissions: [${list(LEGAL)}], content_scripts: [{ matches: [${list(LEGAL)}], js: ['content.js'] }]`) },
        });
        const illegal = {
          host_permissions: stageProject({ config, files: { 'dist/manifest.json': HOSTS(ILLEGAL) } }),
          'content_scripts[].matches': stageProject({ config, files: { 'dist/manifest.json': SCRIPT(ILLEGAL) } }),
        };

        try {
          await inProject(legal, async (task) => {
            await task.compileManifest(path.join(legal, 'out'), 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(legal, 'out', 'manifest.json'), 'utf8'));
            ctx.expect(m.host_permissions).toEqual(LEGAL);
            ctx.expect(m.content_scripts[0].matches).toEqual(LEGAL);
          });

          // Chrome refuses to load a manifest carrying any of these, so the build stops first
          for (const [where, tmp] of Object.entries(illegal)) {
            await inProject(tmp, async (task) => {
              let thrown = null;
              await task.compileManifest(path.join(tmp, 'out'), 'chrome').catch((e) => { thrown = e; });
              ctx.expect(thrown?.message, where).toContain('illegal match pattern');
              for (const pattern of ILLEGAL) ctx.expect(thrown?.message, where).toContain(pattern);
              ctx.expect(fs.existsSync(path.join(tmp, 'out', 'manifest.json')), where).toBe(false);
            });
          }
        } finally {
          fs.rmSync(legal, { recursive: true, force: true });
          for (const tmp of Object.values(illegal)) fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'the match-pattern check reads every key that carries one, once per distinct pattern',
      run: async (ctx) => {
        const { illegalMatchPatterns } = require(path.join(SRC, 'gulp', 'tasks', 'package.js'));
        const manifest = {
          content_scripts: [{ matches: ['https://a.example/*', 'bad-a'], exclude_matches: ['bad-b', 'bad-a'] }],
          host_permissions: ['<all_urls>', 'bad-c'],
          optional_host_permissions: ['*://*/foo', 'bad-d'],
          web_accessible_resources: [{ resources: ['x.png'], matches: ['file:///*', 'bad-e'] }],
        };

        ctx.expect(illegalMatchPatterns(manifest)).toEqual(['bad-a', 'bad-b', 'bad-c', 'bad-d', 'bad-e']);
        ctx.expect(illegalMatchPatterns({})).toEqual([]);
      },
    },
    {
      name: 'externally_connectable: a build-mode default is the BRAND origin, no dev origin (#583)',
      run: async (ctx) => {
        const tmp = stageProject({
          config: `{ brand: { id: 'staged', name: 'Staged', url: 'https://staged.example.com' } }`,
          files: { 'dist/manifest.json': MANIFEST(`description: 'no externally_connectable anywhere'`) },
        });
        const restore = withEnv({ OMEGA_BUILD_MODE: 'true' });

        try {
          await inProject(tmp, async (task) => {
            const outputDir = path.join(tmp, 'out');
            await task.compileManifest(outputDir, 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));

            // The published extension is reachable from the brand's own site;
            // the localhost dev origin is not in a packaged build
            ctx.expect(m.externally_connectable.matches).toEqual(['https://staged.example.com/*']);
          });
        } finally {
          restore();
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'externally_connectable: a dev default carries the brand origin AND the dev origin (#583)',
      run: async (ctx) => {
        const tmp = stageProject({
          config: `{ brand: { id: 'staged', name: 'Staged', url: 'https://staged.example.com/' } }`,
          files: { 'dist/manifest.json': MANIFEST(`description: 'no externally_connectable anywhere'`) },
        });

        try {
          await inProject(tmp, async (task) => {
            const outputDir = path.join(tmp, 'out');
            await task.compileManifest(outputDir, 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));

            // A trailing slash in brand.url is normalized to a match pattern
            ctx.expect(m.externally_connectable.matches).toEqual([
              'https://staged.example.com/*',
              'https://localhost:4000/*',
            ]);
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'externally_connectable: a DECLARED consumer value still wins in build mode (#583, #260)',
      run: async (ctx) => {
        const declared = stageProject({
          config: `{ brand: { id: 'staged', name: 'Staged', url: 'https://staged.example.com' } }`,
          files: { 'dist/manifest.json': MANIFEST(`externally_connectable: { matches: ['https://partner.example.com/*'] }`) },
        });
        const emptied = stageProject({
          config: `{ brand: { id: 'staged', name: 'Staged', url: 'https://staged.example.com' } }`,
          files: { 'dist/manifest.json': MANIFEST(`externally_connectable: { matches: [] }`) },
        });
        const restore = withEnv({ OMEGA_BUILD_MODE: 'true' });

        try {
          await inProject(declared, async (task) => {
            const outputDir = path.join(declared, 'out');
            await task.compileManifest(outputDir, 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            ctx.expect(m.externally_connectable.matches).toEqual(['https://partner.example.com/*']);
          });

          await inProject(emptied, async (task) => {
            const outputDir = path.join(emptied, 'out');
            await task.compileManifest(outputDir, 'chrome');
            const m = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
            ctx.expect(m.externally_connectable).toBeUndefined();
          });
        } finally {
          restore();
          fs.rmSync(declared, { recursive: true, force: true });
          fs.rmSync(emptied, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'build hooks run from the NESTED hooks/build/pre.js setup migrates to (#571)',
      run: async (ctx) => {
        const tmp = stageHookProject({ 'hooks/build/pre.js': HOOK('nested') });
        try {
          await inProject(tmp, async (task) => {
            ctx.expect(await runPackage(task)).toBe(undefined);
            const ran = JSON.parse(fs.readFileSync(path.join(tmp, 'hook-ran.json'), 'utf8'));
            ctx.expect(ran.which).toBe('nested');
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'a build hook receives the ONE OMEGA ctx shape: { build, projectRoot, mode } (#591)',
      run: async (ctx) => {
        const tmp = stageHookProject({ 'hooks/build/pre.js': HOOK('nested') });
        try {
          await inProject(tmp, async (task) => {
            ctx.expect(await runPackage(task)).toBe(undefined);

            const ran = JSON.parse(fs.readFileSync(path.join(tmp, 'hook-ran.json'), 'utf8'));
            ctx.expect(ran.keys).toEqual(['build', 'mode', 'projectRoot']);
            ctx.expect(ran.projectRoot).toBe(fs.realpathSync(tmp));
            ctx.expect(ran.mode).toBe('development');
            ctx.expect(ran.hasBuild).toBe(true);
          });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'a build hook run under OMEGA_BUILD_MODE gets mode: production (#591)',
      run: async (ctx) => {
        const tmp = stageHookProject({ 'hooks/build/pre.js': HOOK('nested') });
        const restore = withEnv({ OMEGA_BUILD_MODE: 'true' });
        try {
          await inProject(tmp, async (task) => {
            // A build-mode package also zips the source from git, which this temp
            // project has none of; the pre hook runs before that step.
            await runPackage(task);

            const ran = JSON.parse(fs.readFileSync(path.join(tmp, 'hook-ran.json'), 'utf8'));
            ctx.expect(ran.mode).toBe('production');
          });
        } finally {
          restore();
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'a project with no hook at all logs the miss through the framework logger, never a bare console.warn (#571)',
      run: async (ctx) => {
        const tmp = stageHookProject({});
        const warned = [];
        const realWarn = console.warn;
        console.warn = (...args) => warned.push(args.join(' '));
        try {
          await inProject(tmp, async (task) => {
            ctx.expect(await runPackage(task)).toBe(undefined);
          });
          ctx.expect(warned.filter((line) => /hook/i.test(line))).toEqual([]);
        } finally {
          console.warn = realWarn;
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
  ],
});
