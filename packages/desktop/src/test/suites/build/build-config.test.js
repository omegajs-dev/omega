// Build-layer tests for gulp/tasks/build-config.js — verify the object generation
// from @omega.js/desktop defaults + consumer config + override merging.

const path = require('path');
const fs = require('fs');
const os = require('os');
const jetpack = require('fs-jetpack');
const yaml = require('js-yaml');
const sharp = require('sharp');
const defineCases = require('@omega.js/devkit/test/define-cases');
const { toSiteGlobal } = require('@omega.js/config/site-global');
const { copyDefaults } = require('../../../commands/lib/ensure-target.js');

const QUIET = { log() {}, warn() {}, error() {} };
const SNAP_LOGIN = { SNAPCRAFT_STORE_CREDENTIALS: 'fake-creds-blob' };
const TASKS = path.join(__dirname, '..', '..', '..', 'gulp', 'tasks');

/**
 * Run `fn` as a process on `platform`, in `cwd`, with `env` laid over process.env
 * (undefined unsets a name), then put all of it back. The tasks read the host
 * platform, the cwd's config and process.env, and take no seam for any of them.
 * @param {{ platform: string, cwd?: string, env: object }} host - Node's platform word, the cwd, the variables.
 * @param {function} fn - The body, sync or async.
 * @returns {Promise<*>} What `fn` returns.
 */
async function inProcess({ platform, cwd, env }, fn) {
  const saved = { cwd: process.cwd(), platform: Object.getOwnPropertyDescriptor(process, 'platform') };
  const savedEnv = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  const setEnv = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  if (cwd) process.chdir(cwd);
  Object.defineProperty(process, 'platform', { ...saved.platform, value: platform });
  setEnv(env);
  try {
    return await fn();
  } finally {
    setEnv(savedEnv);
    Object.defineProperty(process, 'platform', saved.platform);
    process.chdir(saved.cwd);
  }
}

/**
 * Run one gulp task's own entry in a scratch desktop project on `platform`.
 * Only electron-builder's `build` is replaced: it would package for real.
 * @param {string} task - The task file's name under gulp/tasks.
 * @param {{ platform: string, login: boolean, snap?: object|false }} world - Node's platform word,
 *   whether SNAPCRAFT_STORE_CREDENTIALS is set, and the snap format's declaration.
 * @returns {Promise<{ error: Error|null, built: object[] }>} What the task ended with, and each build it asked for.
 */
async function driveTask(task, { platform, login, snap = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-snap-task-'));
  const desktop = { type: 'desktop', platforms: { linux: { formats: { snap } } } };
  jetpack.write(path.join(root, 'config', 'omega.json5'), JSON.stringify({ brand: { id: 'acme-app', name: 'Acme' }, targets: { desktop } }, null, 2));
  jetpack.write(path.join(root, 'dist', 'electron-builder.yml'), 'appId: dev.acme.app\nproductName: Acme\n');

  // The same module record the task's own require('electron-builder') answers from
  const resolved = require.resolve('electron-builder', { paths: [TASKS] });
  require(resolved);
  const entry = require.cache[resolved];
  const realExports = entry.exports;
  const built = [];
  entry.exports = { ...realExports, build: async (options) => { built.push(options); return []; } };

  const env = { SNAPCRAFT_STORE_CREDENTIALS: login ? SNAP_LOGIN.SNAPCRAFT_STORE_CREDENTIALS : undefined, OMEGA_BUILD_OUTPUT: undefined };
  try {
    return await inProcess({ platform, cwd: root, env }, async () => {
      const error = await new Promise((resolve) => require(path.join(TASKS, `${task}.js`))((ended) => resolve(ended || null)));
      return { error, built };
    });
  } finally {
    entry.exports = realExports;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// electron-builder names the snap after the Linux executable: linux.executableName,
// else executableName, else the app's package name, which extraMetadata.name overrides
const builtSnapName = (out) => String(out.linux.executableName ?? out.executableName ?? out.extraMetadata?.name ?? '').toLowerCase();

module.exports = defineCases({
  type: 'suite',
  layer: 'build',
  description: 'build-config — generate electron-builder.yml from omega.json5',
  tests: [
    {
      name: 'task module exports a function plus baseConfig + deepMerge',
      run: (ctx) => {
        const mod = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        ctx.expect(typeof mod).toBe('function');
        ctx.expect(typeof mod.baseConfig).toBe('function');
        ctx.expect(typeof mod.deepMerge).toBe('function');
      },
    },
    {
      name: 'shouldInjectLSUIElement: hidden mode OR hidden login launch → true; everything else → false',
      run: (ctx) => {
        const { shouldInjectLSUIElement } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));

        // Hidden startup mode — the tray-only app case.
        ctx.expect(shouldInjectLSUIElement({ startup: { mode: 'hidden' } })).toBe(true);

        // Normal app whose LOGIN launch is hidden — without the plist key the
        // login launch flashes the dock before applyEarly() can hide it.
        ctx.expect(shouldInjectLSUIElement({ startup: { mode: 'normal', openAtLogin: { enabled: true, mode: 'hidden' } } })).toBe(true);

        // Plain normal apps never get the key.
        ctx.expect(shouldInjectLSUIElement({ startup: { mode: 'normal' } })).toBe(false);
        ctx.expect(shouldInjectLSUIElement({ startup: { mode: 'normal', openAtLogin: { enabled: true, mode: 'normal' } } })).toBe(false);
        ctx.expect(shouldInjectLSUIElement({})).toBe(false);
        ctx.expect(shouldInjectLSUIElement(undefined)).toBe(false);
      },
    },
    {
      name: 'baseConfig: applies appId/productName/copyright from consumer config',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = baseConfig({
          app: { appId: 'com.itwcreativeworks.somiibo', productName: 'Somiibo', copyright: '© Somiibo' },
        });
        ctx.expect(out.appId).toBe('com.itwcreativeworks.somiibo');
        ctx.expect(out.productName).toBe('Somiibo');
        ctx.expect(out.copyright).toBe('© Somiibo');
      },
    },
    {
      name: 'baseConfig: ships @omega.js/desktop defaults for mac/win/linux targets',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = baseConfig({});
        // Mac: dmg + zip, universal arch (one binary that runs on both Intel + Apple Silicon).
        ctx.expect(out.mac.target.find((t) => t.target === 'dmg')).toBeDefined();
        ctx.expect(out.mac.target.find((t) => t.target === 'zip')).toBeDefined();
        ctx.expect(out.mac.target[0].arch).toEqual(['universal']);
        // Win: nsis x64 + ia32 (multi-arch single installer).
        ctx.expect(out.win.target[0].target).toBe('nsis');
        ctx.expect(out.win.target[0].arch).toEqual(['x64', 'ia32']);
        // Linux: deb + AppImage, both x64. No i386.
        const linuxTargets = out.linux.target.map((t) => t.target);
        ctx.expect(linuxTargets).toContain('deb');
        ctx.expect(linuxTargets).toContain('AppImage');
        for (const t of out.linux.target) {
          ctx.expect(t.arch).toEqual(['x64']);
        }
      },
    },
    {
      name: 'baseConfig: files never pack the target\'s scratch and state dirs (#866)',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const files = baseConfig({}).files;
        // The boot runner stages .omega/test-app with symlinks into the target and the
        // packager followed them (dangling after a folder rename); none of these dirs
        // is app content anyway.
        for (const dir of ['.omega', '.claude', '.temp', '.cache', '.gh-runners', 'test']) {
          ctx.expect(files).toContain(`!${dir}/**`);
        }
        // src/ stays: the runtime reads src/integrations/* from the app root.
        ctx.expect(files.includes('!src/**')).toBe(false);
      },
    },
    {
      name: 'baseConfig: the DMG is signed with the Developer ID identity (#891)',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = baseConfig({ app: { productName: 'Deployment Playground' } });

        // Gatekeeper assesses a downloaded image by its OWN signature
        // (`--context context:primary-signature`), and electron-builder leaves
        // the image unsigned unless told: run 34735658588 notarized and stapled
        // the DMG, then spctl refused it for the missing signature.
        ctx.expect(out.dmg.sign).toBe(true);
      },
    },
    {
      name: 'notarizeHooks: the DMG is proved per artifact, BEFORE its upload (#891)',
      run: (ctx) => {
        const { notarizeHooks } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const hooks = notarizeHooks();

        // electron-builder awaits `artifactBuildCompleted` before it emits the
        // `artifactCreated` the publisher uploads on; `afterAllArtifactBuild`
        // runs after every upload is queued. Run 34738410986 published a signed
        // and notarized DMG with no staple because the proof ran there.
        ctx.expect(hooks.afterSign).toContain(path.join('hooks', 'notarize.js'));
        ctx.expect(hooks.artifactBuildCompleted).toContain(path.join('hooks', 'notarize-artifacts.js'));
        ctx.expect(hooks.afterAllArtifactBuild).toBeUndefined();
      },
    },
    {
      name: 'baseConfig: artifact names carry NO version, from @omega.js/config\'s ONE rule (#620)',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const { desktopArtifactNames } = require('@omega.js/config');
        const out = baseConfig({ app: { productName: 'Deployment Playground' } });
        const names = desktopArtifactNames('Deployment Playground');

        // Versionless names are what makes
        // github.com/<org>/<repo>/releases/latest/download/<asset> a stable
        // direct-download URL — the site derives its buttons from THESE names,
        // so a second spelling here is a dead download button.
        // The segment is the FORMAT (#867), the same word the site's
        // /download/<platform>/<format> link carries.
        ctx.expect(out.dmg.artifactName).toBe(names.mac.dmg);
        ctx.expect(out.nsis.artifactName).toBe(names.windows.nsis);
        ctx.expect(out.deb.artifactName).toBe(names.linux.deb);
        ctx.expect(out.appImage.artifactName).toBe(names.linux.appimage);
        ctx.expect(out.dmg.artifactName).toBe('Deployment-Playground-mac-dmg.dmg');
        ctx.expect(out.nsis.artifactName).toBe('Deployment-Playground-windows-nsis.exe');

        // The mac FALLBACK is the auto-update zip's, the one mac artifact that
        // is not a declared format: nobody links it, the feed names it.
        ctx.expect(out.mac.artifactName).toBe('Deployment-Playground-mac.${ext}');
        ctx.expect(out.mac.artifactName.replace('${ext}', 'zip')).toBe('Deployment-Playground-mac.zip');

        // Nothing keeps a ${version} token — every name is stable across releases.
        for (const template of [out.mac.artifactName, out.dmg.artifactName, out.nsis.artifactName, out.deb.artifactName, out.appImage.artifactName, out.linux.artifactName]) {
          ctx.expect(template.includes('${version}')).toBe(false);
        }
      },
    },
    {
      name: 'baseConfig: an arch the versionless names cannot spell REFUSES the build (#620)',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const quiet = { log() {}, warn() {}, error() {} };
        const build = { mode: { build: true }, logger: quiet };

        // Two linux archs share ONE deb name and ONE AppImage name — the
        // second arch's artifact overwrites the first's.
        let onLinux = null;
        try {
          baseConfig({ platforms: { linux: { arch: ['x64', 'arm64'] } } }, build);
        } catch (e) {
          onLinux = e;
        }
        ctx.expect(onLinux === null).toBe(false);
        ctx.expect(onLinux.message).toContain('platforms.linux.arch');

        // A non-universal mac build would ship under the name `-mac-universal`.
        let onMac = null;
        try {
          baseConfig({ platforms: { mac: { arch: ['arm64'] } } }, build);
        } catch (e) {
          onMac = e;
        }
        ctx.expect(onMac === null).toBe(false);
        ctx.expect(onMac.message).toContain('platforms.mac.arch');

        // A publish run is a build for this purpose.
        let onPublish = null;
        try {
          baseConfig({ platforms: { mac: { arch: ['arm64'] } } }, { mode: { publish: true }, logger: quiet });
        } catch (e) {
          onPublish = e;
        }
        ctx.expect(onPublish === null).toBe(false);

        // Development warns and keeps going — the collision only lands when a
        // build actually publishes those files.
        const said = [];
        const loud = { log() {}, warn: (m) => said.push(m), error() {} };
        const out = baseConfig({ platforms: { mac: { arch: ['arm64'] } } }, { mode: { build: false, publish: false }, logger: loud });
        ctx.expect(out.mac.target[0].arch).toEqual(['arm64']);
        ctx.expect(said.join('\n')).toContain('platforms.mac.arch');
      },
    },
    {
      name: 'baseConfig: the shippable arch sets pass — universal mac, single-arch linux, multi-arch windows',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const quiet = { log() {}, warn() {}, error() {} };
        const build = { mode: { build: true }, logger: quiet };

        // The defaults are what every brand ships: nothing to refuse.
        const defaults = baseConfig({}, build);
        ctx.expect(defaults.mac.target[0].arch).toEqual(['universal']);
        ctx.expect(defaults.linux.target[0].arch).toEqual(['x64']);

        // NSIS merges every arch into ONE installer, so windows is genuinely
        // safe — its multi-arch default is never refused.
        ctx.expect(baseConfig({ platforms: { windows: { arch: ['x64', 'ia32', 'arm64'] } } }, build).win.target[0].arch)
          .toEqual(['x64', 'ia32', 'arm64']);

        // One linux arch names one deb: an arm64-only brand ships fine.
        ctx.expect(baseConfig({ platforms: { linux: { arch: ['arm64'] } } }, build).linux.target[0].arch).toEqual(['arm64']);
      },
    },
    {
      name: 'baseConfig: notarize is false (notarization runs via afterSign hook)',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = baseConfig({});
        ctx.expect(out.mac.notarize).toBe(false);
        ctx.expect(out.mac.hardenedRuntime).toBe(true);
      },
    },
    {
      name: 'deepMerge: arrays in override REPLACE (not concat) defaults',
      run: (ctx) => {
        const { deepMerge } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = deepMerge(
          { mac: { target: [{ target: 'dmg' }, { target: 'zip' }] } },
          { mac: { target: [{ target: 'dmg', arch: ['x64'] }] } },
        );
        ctx.expect(out.mac.target.length).toBe(1);
        ctx.expect(out.mac.target[0].arch).toEqual(['x64']);
      },
    },
    {
      name: 'deepMerge: nested objects merge per-key',
      run: (ctx) => {
        const { deepMerge } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = deepMerge(
          { mac: { hardenedRuntime: true, gatekeeperAssess: false } },
          { mac: { gatekeeperAssess: true } },
        );
        ctx.expect(out.mac.hardenedRuntime).toBe(true);
        ctx.expect(out.mac.gatekeeperAssess).toBe(true);
      },
    },
    {
      name: 'deepMerge: top-level keys from override added to base',
      run: (ctx) => {
        const { deepMerge } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = deepMerge(
          { appId: 'a', mac: {} },
          { extraField: 'hello' },
        );
        ctx.expect(out.appId).toBe('a');
        ctx.expect(out.extraField).toBe('hello');
      },
    },
    {
      name: 'baseConfig: falls back to safe defaults when consumer config is empty',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = baseConfig({});
        ctx.expect(out.appId).toBeTruthy();
        ctx.expect(out.productName).toBeTruthy();
        ctx.expect(out.directories.output).toBe('release');
      },
    },
    {
      name: 'expandYear: substitutes {YEAR} with current year',
      run: (ctx) => {
        const { expandYear } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const year = new Date().getFullYear();
        ctx.expect(expandYear('© {YEAR}, Somiibo')).toBe(`© ${year}, Somiibo`);
        ctx.expect(expandYear('no token here')).toBe('no token here');
        ctx.expect(expandYear(null)).toBe(null);
      },
    },
    {
      name: 'baseConfig: copyright derives from brand.name, never a hardcoded company (friction #18)',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const year = new Date().getFullYear();
        ctx.expect(baseConfig({ brand: { name: 'Somiibo' } }).copyright).toBe(`© ${year}, Somiibo`);
        ctx.expect(baseConfig({}).copyright).toBe(`© ${year}`);
      },
    },
    {
      name: 'baseConfig: copyright {YEAR} token expanded when consumer overrides',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const year = new Date().getFullYear();
        const out = baseConfig({ app: { copyright: '© {YEAR}, MyCompany' } });
        ctx.expect(out.copyright).toBe(`© ${year}, MyCompany`);
      },
    },
    {
      name: 'baseConfig: app.category maps to per-platform values',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = baseConfig({ app: { category: 'developer-tools' } });
        ctx.expect(out.mac.category).toBe('public.app-category.developer-tools');
        ctx.expect(out.linux.category).toBe('Development');
      },
    },
    {
      name: 'baseConfig: unknown app.category falls back to productivity',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = baseConfig({ app: { category: 'made-up-thing' } });
        ctx.expect(out.mac.category).toBe('public.app-category.productivity');
        ctx.expect(out.linux.category).toBe('Utility');
      },
    },
    {
      name: 'baseConfig: NSIS defaults to oneClick + shortcuts on',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = baseConfig({});
        ctx.expect(out.nsis.oneClick).toBe(true);
        ctx.expect(out.nsis.createDesktopShortcut).toBe('always');
        ctx.expect(out.nsis.createStartMenuShortcut).toBe(true);
        ctx.expect(out.nsis.runAfterFinish).toBe(true);
        ctx.expect(out.nsis.perMachine).toBe(false);
      },
    },
    {
      name: 'baseConfig: platforms.windows.oneClick: false produces wizard installer',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = baseConfig({ platforms: { windows: { oneClick: false } } });
        ctx.expect(out.nsis.oneClick).toBe(false);
        ctx.expect(out.nsis.allowToChangeInstallationDirectory).toBe(true);
      },
    },
    {
      name: 'baseConfig: a config that declares no platforms ships every format, snap included (#867)',
      run: (ctx) => {
        // Presence is the switch and every format defaults ON, so a caller that
        // declares nothing gets the framework's whole shipping set. The snap's
        // second gate is its credentials, which is what keeps a brand that has
        // not run the Snap ask yet from failing CI.
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const saved = process.env.SNAPCRAFT_STORE_CREDENTIALS;
        process.env.SNAPCRAFT_STORE_CREDENTIALS = 'fake-creds-blob';
        try {
          const out = baseConfig({});
          ctx.expect(out.linux.target.map((t) => t.target)).toEqual(['deb', 'AppImage', 'snap']);
          ctx.expect(out.snap).toBeDefined();
        } finally {
          if (saved === undefined) delete process.env.SNAPCRAFT_STORE_CREDENTIALS;
          else process.env.SNAPCRAFT_STORE_CREDENTIALS = saved;
        }
      },
    },
    {
      name: 'baseConfig: the snap is named brand.id, the same name the Snap Store link ends in',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        // No name or product name spells the id, so only brand.id can answer it
        const brand = { id: 'acme-app', name: 'Zephyr' };
        const app = { productName: 'Zephyr Studio' };

        const out = baseConfig({ brand, app }, { logger: QUIET });
        const site = toSiteGlobal({ brand, repo: { owner: 'Acme-Org' }, targets: { desktop: { type: 'desktop', app, releases: {} } } });

        ctx.expect(builtSnapName(out)).toBe('acme-app');
        ctx.expect(site.targets.desktop.downloads.linux.snap.endsWith('/acme-app')).toBe(true);
      },
    },
    {
      name: 'baseConfig: a Linux build in build mode with the snap on and no snap login goes on',
      run: async (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));

        // Build mode as the real getMode() reads it, the way `omega build` and the boot runner set it
        const env = { OMEGA_BUILD_MODE: 'true', OMEGA_IS_PUBLISH: undefined, SNAPCRAFT_STORE_CREDENTIALS: undefined };
        const out = await inProcess({ platform: 'linux', env }, () => baseConfig({}, { logger: QUIET }));

        ctx.expect(out.linux.target.map((t) => t.target)).toContain('deb');
      },
    },
    {
      name: 'baseConfig: a Linux build with the snap dropped by `false` builds deb and AppImage',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = baseConfig({ platforms: { linux: { formats: { snap: false } } } }, { logger: QUIET });

        ctx.expect(out.linux.target.map((t) => t.target)).toEqual(['deb', 'AppImage']);
        ctx.expect(out.snap).toBeUndefined();
      },
    },
    {
      name: 'the package task on Linux refuses the snap with no snap login, naming the format and the key, and packages with it',
      run: async (ctx) => {
        const refused = await driveTask('package', { platform: 'linux', login: false });
        ctx.expect(refused.error === null, 'no login: refused').toBe(false);
        ctx.expect(refused.error.message).toContain('platforms.linux.formats.snap');
        ctx.expect(refused.error.message).toContain('SNAPCRAFT_STORE_CREDENTIALS');
        ctx.expect(refused.built, 'nothing was packaged').toEqual([]);

        const packaged = await driveTask('package', { platform: 'linux', login: true });
        ctx.expect(packaged.error).toBe(null);
        ctx.expect(packaged.built.length).toBe(1);
      },
    },
    {
      name: 'the package task goes on with no snap login on mac and Windows, and on Linux with the snap dropped by `false`',
      run: async (ctx) => {
        for (const world of [{ platform: 'darwin' }, { platform: 'win32' }, { platform: 'linux', snap: false }]) {
          const { error, built } = await driveTask('package', { ...world, login: false });
          ctx.expect(error, JSON.stringify(world)).toBe(null);
          ctx.expect(built.length, JSON.stringify(world)).toBe(1);
        }
      },
    },
    {
      name: 'the release task on Linux refuses the snap with no snap login, naming the format and the key, and releases with it',
      run: async (ctx) => {
        const refused = await driveTask('release', { platform: 'linux', login: false });
        ctx.expect(refused.error === null, 'no login: refused').toBe(false);
        ctx.expect(refused.error.message).toContain('platforms.linux.formats.snap');
        ctx.expect(refused.error.message).toContain('SNAPCRAFT_STORE_CREDENTIALS');
        ctx.expect(refused.built, 'nothing was released').toEqual([]);

        const released = await driveTask('release', { platform: 'linux', login: true });
        ctx.expect(released.error).toBe(null);
        ctx.expect(released.built.length).toBe(1);
      },
    },
    {
      name: 'the package-quick task on Linux with the snap on and no snap login does not refuse',
      run: async (ctx) => {
        const { error, built } = await driveTask('package-quick', { platform: 'linux', login: false });

        ctx.expect(error).toBe(null);
        ctx.expect(built.length).toBe(1);
      },
    },
    {
      name: 'the generated build workflow installs snapcraft on the Linux job',
      run: async (ctx) => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-snap-workflow-'));
        try {
          await copyDefaults(tmp);
          const workflow = yaml.load(jetpack.read(path.join(tmp, '.github', 'workflows', 'build.yml')));

          const installs = Object.values(workflow.jobs).flatMap((job) => (job.steps || [])
            .filter((step) => /snap install snapcraft/.test(step.run || '') || /snapcraft/i.test(step.uses || ''))
            .map((step) => ({ job, step })));
          ctx.expect(installs.length).toBe(1);
          const { job, step } = installs[0];
          ctx.expect(`${job.if || ''} ${step.if || ''} ${JSON.stringify(job['runs-on'])}`).toMatch(/linux|ubuntu/i);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'baseConfig: snap dropped with `false`, no snap target regardless of creds',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const saved = process.env.SNAPCRAFT_STORE_CREDENTIALS;
        process.env.SNAPCRAFT_STORE_CREDENTIALS = 'fake-creds-blob';
        try {
          const out = baseConfig({ platforms: { linux: { formats: { snap: false } } } });
          ctx.expect(out.linux.target.find((t) => t.target === 'snap')).toBeUndefined();
          ctx.expect(out.snap).toBeUndefined();
        } finally {
          if (saved === undefined) delete process.env.SNAPCRAFT_STORE_CREDENTIALS;
          else process.env.SNAPCRAFT_STORE_CREDENTIALS = saved;
        }
      },
    },
    {
      name: 'baseConfig: snap declared + creds present emits snap target + snap publish block',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const saved = process.env.SNAPCRAFT_STORE_CREDENTIALS;
        process.env.SNAPCRAFT_STORE_CREDENTIALS = 'fake-creds-blob';
        try {
          const out = baseConfig({ platforms: { linux: { formats: { snap: { channels: ['edge'] } } } } });
          ctx.expect(out.linux.target.find((t) => t.target === 'snap')).toBeDefined();
          ctx.expect(out.snap).toBeDefined();
          ctx.expect(out.snap.confinement).toBe('strict');
          ctx.expect(out.snap.publish.provider).toBe('snapStore');
          ctx.expect(out.snap.publish.channels).toEqual(['edge'], 'the format\'s own settings ride inside it');
        } finally {
          if (saved === undefined) delete process.env.SNAPCRAFT_STORE_CREDENTIALS;
          else process.env.SNAPCRAFT_STORE_CREDENTIALS = saved;
        }
      },
    },
    {
      name: 'baseConfig: platforms.<plat>.arch overrides apply per-platform',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = baseConfig({
          platforms: {
            mac:     { arch: ['arm64'] },
            windows: { arch: ['x64'] },
            linux:   { arch: ['arm64'] },
          },
        });
        ctx.expect(out.mac.target[0].arch).toEqual(['arm64']);
        ctx.expect(out.win.target[0].arch).toEqual(['x64']);
        ctx.expect(out.linux.target[0].arch).toEqual(['arm64']);
      },
    },
    {
      name: 'baseConfig: app.languages applied as mac.electronLanguages',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = baseConfig({ app: { languages: ['en', 'es', 'fr'] } });
        ctx.expect(out.mac.electronLanguages).toEqual(['en', 'es', 'fr']);
      },
    },
    {
      name: 'baseConfig: app.darkModeSupport defaults to true; can be disabled',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        ctx.expect(baseConfig({}).mac.darkModeSupport).toBe(true);
        ctx.expect(baseConfig({ app: { darkModeSupport: false } }).mac.darkModeSupport).toBe(false);
      },
    },
    {
      name: 'baseConfig: fileAssociations + protocols passthrough when set',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = baseConfig({
          fileAssociations: [{ name: 'Foo', ext: 'foo' }],
          protocols:        [{ name: 'CustomScheme', schemes: ['custom'] }],
        });
        ctx.expect(out.fileAssociations).toEqual([{ name: 'Foo', ext: 'foo' }]);
        ctx.expect(out.protocols).toEqual([{ name: 'CustomScheme', schemes: ['custom'] }]);
      },
    },
    {
      name: 'publishConfig: the auto-update feed is the config\'s releases repo, never the git remote (#799)',
      run: (ctx) => {
        const { publishConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));

        // A brand nested in another repo (the playground inside this monorepo)
        // resolves to its OWN releases repo: the git remote here is the
        // framework monorepo, and a feed baked from it would 404 forever.
        ctx.expect(publishConfig({
          brand: { id: 'omega-playground' },
          repo: { provider: 'github', owner: 'Omega-JS-Stack' },
          releases: {},
        })).toEqual({
          provider:    'github',
          owner:       'Omega-JS-Stack',
          repo:        'omega-playground-releases',
          releaseType: 'release',
        });

        // #883: `releases` is a presence switch and nothing more. The owner
        // and repo overrides are retired, so the feed can only ever be the
        // brand's one derived releases repo.
        ctx.expect(publishConfig({
          brand: { id: 'acme' },
          repo: { provider: 'github', owner: 'Acme-Org' },
          releases: {},
        })).toEqual({
          provider:    'github',
          owner:       'Acme-Org',
          repo:        'acme-releases',
          releaseType: 'release',
        });
      },
    },
    {
      name: 'publishConfig: releases.enabled false publishes nowhere, and an unaddressable repo emits no block',
      run: (ctx) => {
        const { publishConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));

        ctx.expect(publishConfig({
          brand: { id: 'acme' },
          repo: { provider: 'github', owner: 'Acme-Org' },
          releases: { enabled: false },
        })).toBe(null);

        // No owner anywhere: half an address addresses nothing.
        ctx.expect(publishConfig({ brand: { id: 'acme' }, releases: {} })).toBe(null);
      },
    },
    {
      name: 'baseConfig: empty fileAssociations + protocols arrays NOT emitted',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const out = baseConfig({});
        ctx.expect(out.fileAssociations).toBeUndefined();
        ctx.expect(out.protocols).toBeUndefined();
      },
    },
    // The .deb target's two metadata facts (#872). electron-builder reads the
    // homepage off the app package.json (`extraMetadata` is what it merges in) and
    // the maintainer off `linux.maintainer`; without them the deb build dies at
    // PACKAGE time, after the AppImage of the same run has already uploaded.
    {
      name: 'baseConfig: the brand url and support email become the deb metadata (#872)',
      run: (ctx) => {
        const { baseConfig } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));
        const yaml = require('js-yaml');

        const out = baseConfig({
          brand: {
            name: 'OMEGA Playground',
            url: 'https://playground.omegajs.dev',
            contact: { email: 'support@playground.omegajs.dev' },
          },
        });

        ctx.expect(out.extraMetadata.homepage).toBe('https://playground.omegajs.dev');
        ctx.expect(out.linux.maintainer).toBe('OMEGA Playground <support@playground.omegajs.dev>');

        // And they survive into the file that is actually written.
        const written = yaml.load(yaml.dump(out, { lineWidth: -1, noRefs: true }));
        ctx.expect(written.extraMetadata.homepage).toBe('https://playground.omegajs.dev');
        ctx.expect(written.linux.maintainer).toBe('OMEGA Playground <support@playground.omegajs.dev>');
      },
    },
    {
      name: 'assertLinuxPackageMetadata: an absent value names its config key and never writes an empty one',
      run: async (ctx) => {
        const { baseConfig, assertLinuxPackageMetadata } = require(path.join(__dirname, '..', '..', '..', 'gulp', 'tasks', 'build-config.js'));

        const bare = baseConfig({});
        // Nothing to derive, so nothing is emitted: no `maintainer: ''` in the yml.
        ctx.expect('extraMetadata' in bare).toBe(false);
        ctx.expect('maintainer' in bare.linux).toBe(false);

        await ctx.expect(() => assertLinuxPackageMetadata(bare)).toThrow(/brand\.url/);
        await ctx.expect(() => assertLinuxPackageMetadata(bare)).toThrow(/brand\.contact\.email/);

        // Only the missing half is named.
        const noEmail = baseConfig({ brand: { name: 'App', url: 'https://app.example.com' } });
        await ctx.expect(() => assertLinuxPackageMetadata(noEmail)).toThrow(/brand\.contact\.email/);
        ctx.expect(noEmail.extraMetadata.homepage).toBe('https://app.example.com');

        // A consumer override of `linux.maintainer` satisfies it, which is why the
        // assert runs after the electronBuilder merge and not inside baseConfig.
        const overridden = baseConfig({ brand: { name: 'App', url: 'https://app.example.com' } });
        overridden.linux.maintainer = 'App Team <team@app.example.com>';
        assertLinuxPackageMetadata(overridden);

        // And a build with no deb target has nothing to check.
        const noDeb = baseConfig({});
        noDeb.linux.target = [{ target: 'AppImage', arch: ['x64'] }];
        assertLinuxPackageMetadata(noDeb);
      },
    },
    {
      name: 'the build-config task in a brand target with no app icon of its own ships the brand brandmark as the app icon',
      run: async (ctx) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-brand-icon-'));
        const projectRoot = path.join(root, 'targets', 'desktop');
        const brand = { id: 'acme-app', name: 'Acme', url: 'https://acme.example.com', contact: { email: 'support@acme.example.com' } };
        jetpack.write(path.join(root, 'config', 'omega.json5'), JSON.stringify({ brand, targets: { desktop: { type: 'desktop' } } }, null, 2));
        // Red edge to edge, where the bundled default icon is white at its centre
        jetpack.write(path.join(root, 'assets', 'logo', 'brandmark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="#ff0000"/></svg>');
        jetpack.write(path.join(projectRoot, 'package.json'), '{ "name": "acme-desktop", "version": "1.0.0" }');

        const env = { OMEGA_BUILD_OUTPUT: undefined, OMEGA_HOME: path.join(root, 'home') };
        try {
          const error = await inProcess({ platform: 'darwin', cwd: projectRoot, env }, () => new Promise((resolve) => {
            require(path.join(TASKS, 'build-config.js'))((ended) => resolve(ended || null));
          }));

          ctx.expect(error).toBe(null);
          for (const platform of ['mac', 'windows', 'linux']) {
            const icon = path.join(projectRoot, 'dist', 'config', 'icons', platform, 'icon.png');
            const { width, height } = await sharp(icon).metadata();
            const centre = await sharp(icon).extract({ left: width / 2, top: height / 2, width: 1, height: 1 }).ensureAlpha().raw().toBuffer();
            ctx.expect([...centre], `${platform} app icon is the red brandmark`).toEqual([255, 0, 0, 255]);
          }
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
  ],
});
