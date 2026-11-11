/**
 * Update service tests — the REAL install/build handler against temp brand
 * monorepos, with real `npm run build` spawns (a one-liner that appends to
 * dist/, so every run is counted on disk). What they pin is the incremental
 * contract (#445): the two fingerprints — the target's own files and its
 * installed `@omega.js/*` frameworks, in both the npm-install and the
 * local-link lane — the converged skip that follows when neither moved, the
 * `--force` override, and the missing/corrupt cache falling back to a full
 * run that rewrites the file.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jetpack = require('fs-jetpack');

const { recordBrand } = require('@omega.js/config');

// The machine registry is per-machine state: this file's fixtures write into a
// temp home, never the developer's ~/.omega (#677).
require('@omega.js/devkit/test/temp-home');

const targets = require('../src/services/update/write/targets.js');

// Counted on disk: dist/ is excluded from the fingerprint sweep, so the build
// recording itself never dirties the target's own input set.
const BUILD_SCRIPT = "node -e \"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.appendFileSync('dist/builds.txt','x')\"";

/**
 * Stage a brand root with one web target that declares @omega.js/web, plus the
 * installed framework it resolves to (a plain directory = the npm-install
 * lane; `linked` symlinks it from outside the brand = the local-link lane).
 */
function stageBrand({ linked = false, version = '0.1.0' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-update-test-')));
  const targetPath = path.join(root, 'targets', 'website');

  jetpack.write(path.join(targetPath, 'package.json'), {
    name: 'website',
    private: true,
    scripts: { build: BUILD_SCRIPT },
    dependencies: { '@omega.js/web': `^${version}` },
  });
  jetpack.write(path.join(targetPath, 'src', 'index.md'), '# home\n');

  // The merge-chain layers above the target — part of the build's input set
  jetpack.write(path.join(root, 'config', 'omega.json5'), `{ brand: { id: 'fixture', name: 'Fixture' } }`);
  jetpack.write(path.join(root, '.env'), 'KEY="value"\n');

  const installedPath = path.join(root, 'node_modules', '@omega.js', 'web');
  const frameworkPath = linked ? path.join(root, '..', `${path.basename(root)}-framework`) : installedPath;

  jetpack.write(path.join(frameworkPath, 'package.json'), { name: '@omega.js/web', version });
  jetpack.write(path.join(frameworkPath, 'dist', 'build.js'), 'module.exports = 1;\n');

  if (linked) {
    jetpack.dir(path.dirname(installedPath));
    fs.symlinkSync(path.resolve(frameworkPath), installedPath);
  }

  return { root, targetPath, frameworkPath };
}

/** Run the update service's write handler over the staged brand. */
function run(root, targetPath, options = {}) {
  return targets({
    brandRoot: root,
    targets: [{ name: 'website', path: targetPath, target: 'web' }],
    options,
  });
}

/** How many times the target's build script has run. */
function buildCount(targetPath) {
  return (jetpack.read(path.join(targetPath, 'dist', 'builds.txt')) || '').length;
}

function readCacheFile(root) {
  return jetpack.read(path.join(root, '.omega', 'cache', 'update.json'), 'json');
}

/** The one build step the handler records for the target. */
function buildStep(result) {
  return result.output.results.website.steps.find((step) => step.phase === 'build');
}

module.exports = defineCases({
  type: 'group',
  description: 'update',
  tests: [
    // ─── Converged skip ──────────────────────────────────────────────────────────

    {
      name: 'an unchanged target skips its build and the cache records both fingerprints',
      run: async (ctx) => {
        const { root, targetPath } = stageBrand();

        const first = await run(root, targetPath);
        ctx.expect(buildCount(targetPath), 'first run builds').toBe(1);
        ctx.expect(buildStep(first).skipped, 'first run really built').toBe(undefined);

        const second = await run(root, targetPath);
        ctx.expect(buildCount(targetPath), 'converged rerun builds nothing').toBe(1);
        ctx.expect({ skipped: buildStep(second).skipped, reason: buildStep(second).reason, success: buildStep(second).success }).toEqual({ skipped: true, reason: 'converged', success: true });

        const cache = readCacheFile(root);
        ctx.expect(cache.version).toBe(2); // v2: the per-target map key is `targets` (#455)
        ctx.expect(cache.targets.website.files, 'target-file fingerprint cached').toBeTruthy();
        ctx.expect(cache.targets.website.frameworks, 'framework fingerprint cached').toBeTruthy();
        ctx.expect(cache.targets.website.updatedAt, 'stamped').toBeTruthy();
      },
    },

    // ─── Target files ────────────────────────────────────────────────────────────

    {
      name: 'a changed target source file triggers the build again',
      run: async (ctx) => {
        const { root, targetPath } = stageBrand();

        await run(root, targetPath);
        jetpack.write(path.join(targetPath, 'src', 'index.md'), '# home, edited\n');
        await run(root, targetPath);

        ctx.expect(buildCount(targetPath), 'a source edit is fresh input').toBe(2);
      },
    },

    {
      name: 'build output, logs and machinery dirs never count as target input',
      run: async (ctx) => {
        const { root, targetPath } = stageBrand();

        await run(root, targetPath);
        jetpack.write(path.join(targetPath, 'dist', 'index.html'), '<html></html>');
        jetpack.write(path.join(targetPath, '.temp', 'scratch.json'), { a: 1 });
        jetpack.write(path.join(targetPath, 'logs', 'website.log'), 'noise');
        jetpack.write(path.join(targetPath, 'firebase-debug.log'), 'noise');
        jetpack.write(path.join(targetPath, 'node_modules', 'left-pad', 'index.js'), '//');
        await run(root, targetPath);

        ctx.expect(buildCount(targetPath), 'excluded paths leave the target converged').toBe(1);
      },
    },

    {
      name: 'a brand-level config or .env edit triggers the build again',
      run: async (ctx) => {
        const { root, targetPath } = stageBrand();

        await run(root, targetPath);
        jetpack.write(path.join(root, 'config', 'omega.json5'), `{ brand: { id: 'fixture', name: 'Fixture, renamed' } }`);
        await run(root, targetPath);
        ctx.expect(buildCount(targetPath), 'a brand config edit is fresh input').toBe(2);

        jetpack.write(path.join(root, '.env'), 'KEY="changed value"\n');
        await run(root, targetPath);
        ctx.expect(buildCount(targetPath), 'a brand .env edit is fresh input').toBe(3);
      },
    },

    {
      name: '#681: a brand `.env.<environment>` overlay edit triggers the build again',
      run: async (ctx) => {
        const { root, targetPath } = stageBrand();

        await run(root, targetPath);

        // The overlay is a real layer of the cascade (#586) and it carries the values
        // that DIFFER per environment, which is exactly what a build bakes in. The
        // chain fingerprinted the base `.env` by exact path only, so editing the
        // overlay left the target converged and the build served the old key.
        jetpack.write(path.join(root, '.env.development'), 'KEY="from the overlay"\n');
        await run(root, targetPath);
        ctx.expect(buildCount(targetPath), 'a new brand overlay is fresh input').toBe(2);

        jetpack.write(path.join(root, '.env.development'), 'KEY="edited in the overlay"\n');
        await run(root, targetPath);
        ctx.expect(buildCount(targetPath), 'a brand overlay edit is fresh input').toBe(3);

        await run(root, targetPath);
        ctx.expect(buildCount(targetPath), 'an untouched overlay leaves the target converged').toBe(3);
      },
    },

    // #677: the company layer is part of a build's input set too, and it resolves
    // through the ONE rule: the same relative path inside the company tree.
    {
      name: 'a company config or .env edit triggers the build again',
      run: async (ctx) => {
        const { root, targetPath } = stageBrand();

        const companyBrandRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-update-company-'));
        jetpack.write(path.join(companyBrandRoot, 'company', 'config', 'omega.json5'), '{ monitoring: { providers: { sentry: { org: "fixture-co" } } } }');
        jetpack.write(path.join(companyBrandRoot, 'company', '.env'), 'COMPANY_KEY="value"\n');
        recordBrand({ id: 'fixture-co', root: companyBrandRoot, name: 'Fixture Co', url: 'https://fixture-co.test' });
        jetpack.write(path.join(root, 'config', 'omega.json5'), `{ brand: { id: 'fixture', name: 'Fixture' }, company: { id: 'fixture-co' } }`);

        await run(root, targetPath);

        jetpack.write(path.join(companyBrandRoot, 'company', 'config', 'omega.json5'), '{ monitoring: { providers: { sentry: { org: "fixture-co-renamed" } } } }');
        await run(root, targetPath);
        ctx.expect(buildCount(targetPath), 'a company config edit is fresh input').toBe(2);

        jetpack.write(path.join(companyBrandRoot, 'company', '.env'), 'COMPANY_KEY="changed value"\n');
        await run(root, targetPath);
        ctx.expect(buildCount(targetPath), 'a company .env edit is fresh input').toBe(3);

        jetpack.write(path.join(companyBrandRoot, 'company', '.env.development'), 'COMPANY_KEY="from the overlay"\n');
        await run(root, targetPath);
        ctx.expect(buildCount(targetPath), 'a company overlay is fresh input').toBe(4);

        await run(root, targetPath);
        ctx.expect(buildCount(targetPath), 'an untouched company layer leaves the target converged').toBe(4);
      },
    },

    // ─── Frameworks ──────────────────────────────────────────────────────────────

    {
      name: 'an installed framework version bump triggers the build again',
      run: async (ctx) => {
        const { root, targetPath, frameworkPath } = stageBrand();

        await run(root, targetPath);
        jetpack.write(path.join(frameworkPath, 'package.json'), { name: '@omega.js/web', version: '0.2.0' });
        await run(root, targetPath);

        ctx.expect(buildCount(targetPath), 'a new installed version is fresh input').toBe(2);
      },
    },

    {
      name: 'a locally linked framework rebuild triggers the build again',
      run: async (ctx) => {
        const { root, targetPath, frameworkPath } = stageBrand({ linked: true });

        await run(root, targetPath);
        await run(root, targetPath);
        ctx.expect(buildCount(targetPath), 'a link with untouched dist stays converged').toBe(1);

        jetpack.write(path.join(frameworkPath, 'dist', 'build.js'), 'module.exports = 2; // rebuilt\n');
        await run(root, targetPath);

        ctx.expect(buildCount(targetPath), "the link target's build output is fresh input").toBe(2);
      },
    },

    // ─── Overrides ───────────────────────────────────────────────────────────────

    {
      name: '--force rebuilds a converged target',
      run: async (ctx) => {
        const { root, targetPath } = stageBrand();

        await run(root, targetPath);
        const forced = await run(root, targetPath, { force: true });

        ctx.expect(buildCount(targetPath), 'force ignores the cache').toBe(2);
        ctx.expect(buildStep(forced).skipped, 'forced run really built').toBe(undefined);
      },
    },

    {
      name: 'a corrupt cache is treated as fresh and rewritten',
      run: async (ctx) => {
        const { root, targetPath } = stageBrand();

        await run(root, targetPath);
        jetpack.write(path.join(root, '.omega', 'cache', 'update.json'), '{ not json');
        await run(root, targetPath);

        ctx.expect(buildCount(targetPath), 'an unreadable cache means a full run').toBe(2);
        ctx.expect(readCacheFile(root).targets.website.files, 'and the file is rebuilt').toBeTruthy();
      },
    },

    {
      name: 'a dry run neither builds nor writes the cache',
      run: async (ctx) => {
        const { root, targetPath } = stageBrand();

        const result = await run(root, targetPath, { dryRun: true });

        ctx.expect(buildCount(targetPath), 'dry run builds nothing').toBe(0);
        ctx.expect(buildStep(result).dryRun).toBe(true);
        ctx.expect(jetpack.exists(path.join(root, '.omega', 'cache', 'update.json')), 'no cache written').toBe(false);
      },
    },

    // ─── Translation ─────────────────────────────────────────────────────────────

    {
      name: 'a non-interactive update builds the web and the extension target cache-only, and a type that translates nothing with no flag',
      run: async (ctx) => {
        // Each build records the arguments npm handed its script (a file, so node never reads them as its own options)
        const ARGS_SCRIPT = 'node record-args.js';
        const RECORD = "const fs = require('fs');\nfs.mkdirSync('dist', { recursive: true });\nfs.writeFileSync('dist/args.json', JSON.stringify(process.argv.slice(2)));\n";
        const { root, targetPath: webPath } = stageBrand();
        const extensionPath = path.join(root, 'targets', 'extension');
        jetpack.write(path.join(webPath, 'package.json'), { ...jetpack.read(path.join(webPath, 'package.json'), 'json'), scripts: { build: ARGS_SCRIPT } });
        jetpack.write(path.join(webPath, 'record-args.js'), RECORD);
        jetpack.write(path.join(extensionPath, 'record-args.js'), RECORD);
        jetpack.write(path.join(extensionPath, 'package.json'), {
          name: 'extension',
          private: true,
          scripts: { build: ARGS_SCRIPT },
          dependencies: { '@omega.js/extension': '^0.1.0' },
        });
        jetpack.write(path.join(root, 'node_modules', '@omega.js', 'extension', 'package.json'), { name: '@omega.js/extension', version: '0.1.0' });
        // desktop's row says translates: false
        const desktopPath = path.join(root, 'targets', 'desktop');
        jetpack.write(path.join(desktopPath, 'record-args.js'), RECORD);
        jetpack.write(path.join(desktopPath, 'package.json'), {
          name: 'desktop',
          private: true,
          scripts: { build: ARGS_SCRIPT },
          dependencies: { '@omega.js/desktop': '^0.1.0' },
        });
        jetpack.write(path.join(root, 'node_modules', '@omega.js', 'desktop', 'package.json'), { name: '@omega.js/desktop', version: '0.1.0' });

        const previous = process.env.OMEGA_NON_INTERACTIVE;
        process.env.OMEGA_NON_INTERACTIVE = '1';
        try {
          await targets({
            brandRoot: root,
            targets: [
              { name: 'website', path: webPath, target: 'web' },
              { name: 'extension', path: extensionPath, target: 'extension' },
              { name: 'desktop', path: desktopPath, target: 'desktop' },
            ],
            options: {},
          });
        } finally {
          if (previous === undefined) delete process.env.OMEGA_NON_INTERACTIVE;
          else process.env.OMEGA_NON_INTERACTIVE = previous;
        }

        ctx.expect(jetpack.read(path.join(webPath, 'dist', 'args.json'), 'json'), 'web').toEqual(['--cached-only']);
        ctx.expect(jetpack.read(path.join(extensionPath, 'dist', 'args.json'), 'json'), 'extension').toEqual(['--cached-only']);
        ctx.expect(jetpack.read(path.join(desktopPath, 'dist', 'args.json'), 'json'), 'desktop').toEqual([]);
      },
    },
  ],
});
