// Unit tests for tools/vendor.js — vendoring @omega.js packages (devkit, account, ...)
// into a host framework's dist, for both CommonJS requires and ESM imports.
//
// Fixtures are built under packages/devkit/.temp/ (gitignored) rather than os.tmpdir()
// ON PURPOSE: the runtime-load assertion requires that vendored modules can resolve
// their deps (chalk, node-powertools) by walking up to the monorepo root node_modules —
// which only works for paths inside the repo tree.

const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vendorDevkit = require('../tools/vendor');

const TEMP_ROOT = path.join(__dirname, '..', '.temp');

// Build a minimal host-framework fixture and return its root.
function makeFixture(name, { packageJSON, files }) {
  const root = path.join(TEMP_ROOT, `${name}-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const abs = path.join(root, relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJSON, null, 2));
  return root;
}

// Every file under dir as relative path → contents, for identity assertions.
function snapshot(dir) {
  const files = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      files[path.relative(dir, abs)] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(dir);
  return files;
}

const HOST_DEPS = { chalk: '*', 'node-powertools': '*' };

// The self-containment gate's shape, read from the tool: a package NAME in prose
// or in a log tag (every vendored logger.js carries its own) is not a reference.
const RAW_PRIVATE_REF = vendorDevkit.PRIVATE_REFERENCE;

module.exports = defineCases({
  type: 'group',
  description: 'vendor',
  tests: [
    {
      name: 'copies devkit into dist/vendor, rewrites requires, and the result loads + runs',
      run: (ctx) => {
        const root = makeFixture('vendor-ok', {
          packageJSON: { name: 'fixture-host', version: '1.0.0', dependencies: HOST_DEPS },
          files: {
            'dist/lib/thing.js': [
              `const Logger = require('@omega.js/devkit/logger');`,
              `const { safeInstall } = require('@omega.js/devkit/safe-install');`,
              `const devkit = require("@omega.js/devkit");`,
              `module.exports = { Logger, safeInstall, devkit };`,
            ].join('\n'),
            'dist/untouched.js': `module.exports = 42;`,
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        const result = vendorDevkit({ cwd: root });

        // Vendored modules exist — index.js pulls the other three via its relative requires
        for (const file of ['index.js', 'logger.js', 'safe-install.js', 'attach-log-file.js']) {
          ctx.expect(fs.existsSync(path.join(root, 'dist', 'vendor', 'devkit', file)), `missing vendored ${file}`).toBeTruthy();
        }
        // Selective: unused modules (e.g. the test runner) are NOT vendored
        ctx.expect(!fs.existsSync(path.join(root, 'dist', 'vendor', 'devkit', 'test')), 'test/ should not be vendored').toBeTruthy();

        // Requires rewritten to relative paths, both quote styles, no @omega.js refs left
        const rewritten = fs.readFileSync(path.join(root, 'dist', 'lib', 'thing.js'), 'utf8');
        ctx.expect(rewritten).toMatch(/require\('\.\.\/vendor\/devkit\/logger\.js'\)/);
        ctx.expect(rewritten).toMatch(/require\("\.\.\/vendor\/devkit\/index\.js"\)/);
        ctx.expect(!rewritten.includes('@omega.js')).toBeTruthy();
        ctx.expect(result.rewritten).toBe(1); // untouched.js stays untouched

        // The rewritten file actually loads and works (deps resolve up the monorepo tree)
        const thing = require(path.join(root, 'dist', 'lib', 'thing.js'));
        const logger = new thing.Logger('fixture');
        ctx.expect(typeof logger.log).toBe('function');
        ctx.expect(typeof thing.safeInstall).toBe('function');
        ctx.expect(thing.devkit.Logger).toBe(thing.Logger);
      },
    },

    {
      name: 'dist/defaults is consumer-template content: never scanned, rewritten, or vendored',
      run: (ctx) => {
        const root = makeFixture('vendor-defaults', {
          packageJSON: { name: '@omega.js/fixture-fw', version: '2.0.0', dependencies: HOST_DEPS },
          files: {
            'dist/lib/thing.js': `const Logger = require('@omega.js/devkit/logger');\nmodule.exports = Logger;`,
            // A framework's defaults reference the framework itself — scanning them
            // would try to vendor the host into itself (unresolvable and wrong)
            'dist/defaults/src/component.js': `import Manager from '@omega.js/fixture-fw/background';\nexport default Manager;`,
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        const result = vendorDevkit({ cwd: root }); // must NOT throw about @omega.js/fixture-fw

        // The consumer template keeps its package specifier verbatim
        const template = fs.readFileSync(path.join(root, 'dist', 'defaults', 'src', 'component.js'), 'utf8');
        ctx.expect(template.includes(`'@omega.js/fixture-fw/background'`)).toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(root, 'dist', 'vendor', 'fixture-fw'))).toBeTruthy();

        // Host code is still vendored + rewritten as usual
        ctx.expect(result.rewritten).toBe(1);
        ctx.expect(fs.existsSync(path.join(root, 'dist', 'vendor', 'devkit', 'logger.js'))).toBeTruthy();
      },
    },

    {
      name: "the host's own name is never vendored or rewritten (boot harnesses + fixtures reference it at consumer runtime)",
      run: (ctx) => {
        // The real case: @omega.js/desktop's boot harness requires
        // '@omega.js/desktop/renderer' and its bundled consumer fixture requires
        // '@omega.js/desktop/main' — both resolve via the CONSUMER's node_modules
        // (the boot runner symlinks them). Collecting the host's own name would
        // fold the host into itself; rewriting would break the consumer-side walk.
        const root = makeFixture('vendor-self', {
          packageJSON: { name: '@omega.js/fixture-self', version: '2.0.0', dependencies: HOST_DEPS },
          files: {
            'dist/test/harness/preload.js': `const R = require('@omega.js/fixture-self/renderer');\nconst L = require('@omega.js/devkit/logger');\nmodule.exports = { R, L };`,
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        const result = vendorDevkit({ cwd: root }); // must NOT throw about @omega.js/fixture-self

        // Self-reference survives verbatim; the sibling ref is still rewritten
        const harness = fs.readFileSync(path.join(root, 'dist', 'test', 'harness', 'preload.js'), 'utf8');
        ctx.expect(harness.includes(`'@omega.js/fixture-self/renderer'`)).toBeTruthy();
        ctx.expect(!harness.includes(`'@omega.js/devkit/logger'`)).toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(root, 'dist', 'vendor', 'fixture-self'))).toBeTruthy();
        ctx.expect(fs.existsSync(path.join(root, 'dist', 'vendor', 'devkit', 'logger.js'))).toBeTruthy();
        ctx.expect(result.rewritten).toBe(1);
      },
    },

    {
      name: 'dep-guard ignores comment prose that reads like an ESM from-clause',
      run: (ctx) => {
        // The real case: @omega.js/config's edit.js has JSDoc prose "('brand' from
        // brand, 'a b' from 'a b')" — the guard reported a phantom host dep 'a b'.
        const root = makeFixture('vendor-prose', {
          packageJSON: { name: 'fixture-prose', version: '1.0.0', dependencies: { json5: '*', dotenv: '*', chalk: '*', 'fs-jetpack': '*' } }, // dotenv: config's env.js rides along; chalk: its company.js logs through the devkit logger; fs-jetpack: its writes go through devkit's writeJson
          files: {
            'dist/lib/uses-config.js': `const config = require('@omega.js/config');\nmodule.exports = config;`,
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        vendorDevkit({ cwd: root }); // must NOT throw about a phantom 'a b' dep

        ctx.expect(fs.existsSync(path.join(root, 'dist', 'vendor', 'config', 'edit.js'))).toBeTruthy();
      },
    },

    {
      name: 'the closure walk ignores relative requires inside comments (#354)',
      run: (ctx) => {
        // The real case: a JSDoc @example in packages/devkit/src/local.js quoted
        // require('../dist/…'); the walk chased it as a real module and killed
        // @omega.js/backend's prepare mid-session. The vendorable package is a
        // stand-in resolved from the host's own node_modules, so the fixture owns
        // exactly what the walk reads.
        const root = makeFixture('vendor-comment-walk', {
          packageJSON: { name: 'fixture-comment-walk', version: '1.0.0', dependencies: HOST_DEPS },
          files: {
            'dist/a.js': `module.exports = require('@omega.js/account');`,
            'node_modules/@omega.js/account/package.json': JSON.stringify({ name: '@omega.js/account', version: '0.0.1', main: './src/index.js' }),
            'node_modules/@omega.js/account/src/index.js': [
              `// require('./line-comment-only.js')`,
              `/**`,
              ` * @example`,
              ` *   const dist = require('../dist/block-comment-only.js');`,
              ` */`,
              `module.exports = require('./real.js'); // require('./trailing-comment-only.js')`,
            ].join('\n'),
            'node_modules/@omega.js/account/src/real.js': `module.exports = 'real';`,
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        // Used to throw: "'@omega.js/account' has no module '../dist/block-comment-only.js'"
        const result = vendorDevkit({ cwd: root });

        // Only the real require walks — the commented paths never become dependencies
        ctx.expect(result.vendored).toEqual({ account: ['index.js', 'real.js'] });
        ctx.expect(require(path.join(root, 'dist', 'a.js'))).toBe('real');
      },
    },

    {
      name: 'the comment strip is string-literal aware: // and /* inside strings hide nothing (#354)',
      run: (ctx) => {
        const root = makeFixture('vendor-comment-strings', {
          packageJSON: { name: 'fixture-comment-strings', version: '1.0.0', dependencies: HOST_DEPS },
          files: {
            'dist/a.js': `module.exports = require('@omega.js/account');`,
            'node_modules/@omega.js/account/package.json': JSON.stringify({ name: '@omega.js/account', version: '0.0.1', main: './src/index.js' }),
            'node_modules/@omega.js/account/src/index.js': [
              `const sep = '//';`,
              `const marker = 'a // b'; const inline = require('./inline.js');`,
              `const tmpl = \`x // y\`; const templated = require('./templated.js');`,
              // A naive block strip runs from this '/*' to the '*/' two lines down,
              // swallowing the requires in between
              `const open = '/*'; const opener = require('./opener.js');`,
              `const close = '*/'; const closer = require('./closer.js');`,
              `module.exports = { sep, marker, tmpl, open, close, inline, templated, opener, closer };`,
            ].join('\n'),
            'node_modules/@omega.js/account/src/inline.js': `module.exports = 'inline';`,
            'node_modules/@omega.js/account/src/templated.js': `module.exports = 'templated';`,
            'node_modules/@omega.js/account/src/opener.js': `module.exports = 'opener';`,
            'node_modules/@omega.js/account/src/closer.js': `module.exports = 'closer';`,
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        const result = vendorDevkit({ cwd: root });

        ctx.expect(result.vendored).toEqual({ account: ['closer.js', 'index.js', 'inline.js', 'opener.js', 'templated.js'] });
        const loaded = require(path.join(root, 'dist', 'a.js'));
        ctx.expect(loaded.sep).toBe('//');
        ctx.expect(loaded.inline).toBe('inline');
        ctx.expect(loaded.closer).toBe('closer');
      },
    },

    {
      name: 'a .json subpath vendors that file, and the rewritten require loads it',
      run: (ctx) => {
        // A fixture's package.json is data, not a module: mapping it to `package.json.js`
        // walked into the file as if it were a folder and killed prepare with ENOTDIR.
        const root = makeFixture('vendor-json-subpath', {
          packageJSON: { name: 'fixture-json-subpath', version: '1.0.0', dependencies: HOST_DEPS },
          files: {
            'dist/a.js': `module.exports = require('@omega.js/account/fixtures/package.json');`,
            'node_modules/@omega.js/account/package.json': JSON.stringify({ name: '@omega.js/account', version: '0.0.1', main: './src/index.js' }),
            'node_modules/@omega.js/account/src/index.js': `module.exports = 'index';`,
            'node_modules/@omega.js/account/src/fixtures/package.json': JSON.stringify({ name: 'stand-in', version: '9.9.9' }),
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        vendorDevkit({ cwd: root });

        ctx.expect(require(path.join(root, 'dist', 'a.js'))).toEqual({ name: 'stand-in', version: '9.9.9' });
      },
    },

    {
      name: "a vendored module's relative .json require vendors that file, and the host loads it",
      run: (ctx) => {
        const root = makeFixture('vendor-json-relative', {
          packageJSON: { name: 'fixture-json-relative', version: '1.0.0', dependencies: HOST_DEPS },
          files: {
            'dist/a.js': `module.exports = require('@omega.js/account');`,
            'node_modules/@omega.js/account/package.json': JSON.stringify({ name: '@omega.js/account', version: '0.0.1', main: './src/index.js' }),
            'node_modules/@omega.js/account/src/index.js': `module.exports = require('./data.json');`,
            'node_modules/@omega.js/account/src/data.json': JSON.stringify({ name: 'stand-in', version: '9.9.9' }),
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        vendorDevkit({ cwd: root });

        ctx.expect(require(path.join(root, 'dist', 'a.js'))).toEqual({ name: 'stand-in', version: '9.9.9' });
      },
    },

    {
      name: 'is idempotent: running twice leaves dist identical, dist/vendor included (#393)',
      run: (ctx) => {
        // The real case: the after-hook run standalone (node -e
        // "require('@omega.js/devkit/vendor')()") against an ALREADY-prepared dist.
        // The scan finds zero raw @omega.js specifiers — they were rewritten by the
        // first run — and the tool used to remove dist/vendor wholesale, leaving
        // every rewritten dist file importing from a directory that no longer
        // exists (@omega.js/client, 2026-08-20).
        const root = makeFixture('vendor-idem', {
          packageJSON: { name: 'fixture-idem', version: '1.0.0', dependencies: HOST_DEPS, preparePackage: { output: './dist' } },
          files: { 'dist/a.js': `module.exports = require('@omega.js/devkit/logger');` },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        vendorDevkit({ cwd: root });
        const first = snapshot(path.join(root, 'dist'));
        const second = vendorDevkit({ cwd: root });

        ctx.expect(snapshot(path.join(root, 'dist')), 'the whole dist, vendored modules included, survives byte-identical').toEqual(first);
        ctx.expect(second.rewritten).toBe(0);
        // And it still loads: the rewritten require resolves to a vendored file
        ctx.expect(typeof require(path.join(root, 'dist', 'a.js'))).toBe('function');
      },
    },

    {
      name: 'a MIXED dist (one watch-mode raw specifier beside rewritten files) keeps the already-vendored modules (#393)',
      run: (ctx) => {
        // Watch mode's single-file copies skip hooks, so a freshly-saved file lands in
        // an already-rewritten dist carrying a RAW @omega.js specifier. The standalone
        // hook then sees one seed — enough to look like work to do — and the full
        // vendor reset used to wipe the modules every ALREADY-rewritten file imports.
        const root = makeFixture('vendor-mixed', {
          packageJSON: { name: 'fixture-mixed', version: '1.0.0', dependencies: HOST_DEPS, preparePackage: { output: './dist' } },
          files: { 'dist/a.js': `module.exports = require('@omega.js/devkit/logger');` },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        vendorDevkit({ cwd: root });

        // The watch-mode copy: raw specifier, no hook run for it
        fs.writeFileSync(path.join(root, 'dist', 'b.js'), `module.exports = require('@omega.js/devkit/safe-install');`);
        vendorDevkit({ cwd: root });

        // Both the pre-existing vendored module and the new seed survive
        ctx.expect(fs.existsSync(path.join(root, 'dist', 'vendor', 'devkit', 'logger.js')), 'the already-vendored logger was wiped').toBeTruthy();
        ctx.expect(fs.existsSync(path.join(root, 'dist', 'vendor', 'devkit', 'safe-install.js')), 'the new seed was not vendored').toBeTruthy();

        // And both dist files load: neither require dangles
        ctx.expect(typeof require(path.join(root, 'dist', 'a.js'))).toBe('function');
        ctx.expect(typeof require(path.join(root, 'dist', 'b.js')).safeInstall).toBe('function');
      },
    },

    {
      name: 'throws when the host is missing a runtime dep the vendored modules need',
      run: (ctx) => {
        const root = makeFixture('vendor-missing-dep', {
          packageJSON: { name: 'fixture-missing', version: '1.0.0', dependencies: { chalk: '*' } }, // no node-powertools
          files: { 'dist/a.js': `module.exports = require('@omega.js/devkit/safe-install');` },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        ctx.expect(() => vendorDevkit({ cwd: root })).toThrow(/node-powertools/);

        // Transactional: the after-hook runner can't block prepare, so a guard
        // failure must leave ZERO half-state — dist JS unrewritten, vendor dir gone
        ctx.expect(fs.readFileSync(path.join(root, 'dist', 'a.js'), 'utf8'), 'dist stays exactly as prepare wrote it').toBe(`module.exports = require('@omega.js/devkit/safe-install');`);
        ctx.expect(!fs.existsSync(path.join(root, 'dist', 'vendor')), 'no orphaned vendor dir').toBeTruthy();
      },
    },

    {
      name: 'throws on a require of a devkit module that does not exist',
      run: (ctx) => {
        const root = makeFixture('vendor-bad-subpath', {
          packageJSON: { name: 'fixture-bad', version: '1.0.0', dependencies: HOST_DEPS },
          files: { 'dist/a.js': `module.exports = require('@omega.js/devkit/nope');` },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        ctx.expect(() => vendorDevkit({ cwd: root })).toThrow(/has no module/);
      },
    },

    {
      name: 'rewrites require.resolve() forms too (used to inline devkit module source)',
      run: (ctx) => {
        const root = makeFixture('vendor-resolve', {
          packageJSON: { name: 'fixture-resolve', version: '1.0.0', dependencies: HOST_DEPS },
          files: { 'dist/deep/reader.js': `module.exports = require.resolve('@omega.js/devkit/logger');` },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        vendorDevkit({ cwd: root });
        const rewritten = fs.readFileSync(path.join(root, 'dist', 'deep', 'reader.js'), 'utf8');
        ctx.expect(rewritten).toMatch(/require\.resolve\('\.\.\/vendor\/devkit\/logger\.js'\)/);
        // And the resolved path actually points at a real vendored file
        const resolved = require(path.join(root, 'dist', 'deep', 'reader.js'));
        ctx.expect(fs.existsSync(resolved)).toBeTruthy();
      },
    },

    {
      name: 'vendors selectively: a safe-install-only host ships one module and needs only its deps',
      run: (ctx) => {
        const root = makeFixture('vendor-selective', {
          packageJSON: { name: 'fixture-selective', version: '1.0.0', dependencies: { 'node-powertools': '*' } }, // no chalk!
          files: { 'dist/a.js': `module.exports = require('@omega.js/devkit/safe-install');` },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        const result = vendorDevkit({ cwd: root }); // must NOT throw about chalk/glob/fs-jetpack
        ctx.expect(result.vendored).toEqual({ devkit: ['safe-install.js'] });
        ctx.expect(!fs.existsSync(path.join(root, 'dist', 'vendor', 'devkit', 'logger.js'))).toBeTruthy();
      },
    },

    {
      name: 'rewrites ESM import forms and vendors multiple packages (devkit + account)',
      run: async (ctx) => {
        const root = makeFixture('vendor-esm', {
          packageJSON: { name: 'fixture-esm', version: '1.0.0', dependencies: HOST_DEPS },
          files: {
            'dist/module.js': [
              `import { resolveAccount, resolveSubscription } from '@omega.js/account';`,
              `import Logger from '@omega.js/devkit/logger';`,
              `export { default as engineExports } from '@omega.js/account/engine';`,
              `import '@omega.js/account/subscription';`,
              `const schema = await import('@omega.js/account/schema');`,
              `export const account = resolveAccount({});`,
              `export const resolved = resolveSubscription(account);`,
              `export const hasAuthBranch = !!schema.default.auth;`,
              `export const logger = new Logger('esm-fixture');`,
            ].join('\n'),
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        const result = vendorDevkit({ cwd: root });

        // Every ESM reference form rewritten, nothing @omega.js left behind
        const rewritten = fs.readFileSync(path.join(root, 'dist', 'module.js'), 'utf8');
        ctx.expect(rewritten).toMatch(/from '\.\/vendor\/account\/index\.js'/);
        ctx.expect(rewritten).toMatch(/from '\.\/vendor\/devkit\/logger\.js'/);
        ctx.expect(rewritten).toMatch(/from '\.\/vendor\/account\/engine\.js'/);
        ctx.expect(rewritten).toMatch(/import '\.\/vendor\/account\/subscription\.js'/);
        ctx.expect(rewritten).toMatch(/import\('\.\/vendor\/account\/schema\.js'\)/);
        ctx.expect(!rewritten.includes('@omega.js')).toBeTruthy();
        ctx.expect(Object.keys(result.vendored).sort()).toEqual(['account', 'devkit']);

        // The rewritten ESM file actually loads — named imports from the vendored
        // CommonJS account modules must work through Node's CJS/ESM interop
        const mod = await import(pathToFileURL(path.join(root, 'dist', 'module.js')));
        ctx.expect(mod.account.subscription.product.id).toBe('basic');
        ctx.expect(mod.resolved.everPaid).toBe(false);
        ctx.expect(mod.hasAuthBranch).toBe(true);
        ctx.expect(typeof mod.logger.log).toBe('function');
      },
    },

    {
      name: 'host scan skips node_modules and never follows symlinks (@omega.js/backend fixture tree)',
      run: (ctx) => {
        const root = makeFixture('vendor-symlink', {
          packageJSON: { name: 'fixture-symlink', version: '1.0.0', dependencies: HOST_DEPS },
          files: {
            'dist/lib/uses.js': `module.exports = require('@omega.js/devkit/logger');`,
            // A consumer-fixture dependency inside dist — its @omega.js reference is
            // NOT host code and must be neither vendored-for nor rewritten
            'dist/test/fixtures/project/node_modules/dep/index.js': `module.exports = require('@omega.js/devkit/safe-install');`,
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        // @omega.js/backend's self-test fixture ships a circular self-symlink (@omega.js/backend -> package root)
        fs.symlinkSync(root, path.join(root, 'dist', 'test', 'fixtures', 'project', 'node_modules', 'circular'));

        const result = vendorDevkit({ cwd: root }); // used to die with ENAMETOOLONG

        ctx.expect(result.vendored).toEqual({ devkit: ['logger.js'] }); // fixture dep's safe-install ref NOT honored
        ctx.expect(result.rewritten).toBe(1);
        const untouched = fs.readFileSync(path.join(root, 'dist', 'test', 'fixtures', 'project', 'node_modules', 'dep', 'index.js'), 'utf8');
        ctx.expect(untouched.includes(`require('@omega.js/devkit/safe-install')`), 'node_modules content must not be rewritten').toBeTruthy();
      },
    },

    {
      name: 'throws when dist does not exist yet',
      run: (ctx) => {
        const root = makeFixture('vendor-no-dist', {
          packageJSON: { name: 'fixture-no-dist', version: '1.0.0', dependencies: HOST_DEPS },
          files: {},
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        ctx.expect(() => vendorDevkit({ cwd: root })).toThrow(/run prepare first/);
      },
    },

    {
      name: 'omega.vendorAssets copies declared cross-package assets into dist (with or without JS refs)',
      run: (ctx) => {
        const root = makeFixture('vendor-assets', {
          packageJSON: {
            name: 'fixture-assets-host',
            version: '1.0.0',
            dependencies: HOST_DEPS,
            omega: {
              vendorAssets: [
                { package: '@omega.js/fakeweb', from: 'core/css/tokens/_index.scss', to: 'assets/css/tokens/_index.scss' },
              ],
            },
          },
          files: {
            // No dist JS references @omega.js at all — assets must still copy
            'dist/untouched.js': `module.exports = 1;`,
            // The source package, resolvable from the host via its own node_modules
            'node_modules/@omega.js/fakeweb/package.json': JSON.stringify({ name: '@omega.js/fakeweb', version: '0.0.1', main: './src/index.js' }),
            'node_modules/@omega.js/fakeweb/src/index.js': `module.exports = {};`,
            'node_modules/@omega.js/fakeweb/core/css/tokens/_index.scss': `:root { --omega-fixture: 1; }`,
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        const result = vendorDevkit({ cwd: root });

        const copied = path.join(root, 'dist', 'assets', 'css', 'tokens', '_index.scss');
        ctx.expect(fs.existsSync(copied), 'declared asset copied into dist').toBeTruthy();
        ctx.expect(fs.readFileSync(copied, 'utf8'), 'byte-identical to the source').toBe(`:root { --omega-fixture: 1; }`);
        ctx.expect(result.assets.length).toBe(1);
        ctx.expect(result.rewritten).toBe(0);
      },
    },

    {
      name: 'omega.vendorAssets resolves a source package whose own dist is not built yet',
      run: (ctx) => {
        // A fresh tree prepares packages in whatever order npm picks, so desktop's
        // prepare can run before web has written dist/index.js. The assets come from
        // web's sources, so a missing entry must not stop the copy.
        const root = makeFixture('vendor-assets-unbuilt', {
          packageJSON: {
            name: 'fixture-assets-unbuilt-host',
            version: '1.0.0',
            dependencies: HOST_DEPS,
            omega: {
              vendorAssets: [
                { package: '@omega.js/fakeweb', from: 'core/css/tokens/_index.scss', to: 'assets/css/tokens/_index.scss' },
              ],
            },
          },
          files: {
            'dist/untouched.js': `module.exports = 1;`,
            // `main` names a file that does not exist: the package has not been prepared
            'node_modules/@omega.js/fakeweb/package.json': JSON.stringify({ name: '@omega.js/fakeweb', version: '0.0.1', main: './dist/index.js' }),
            'node_modules/@omega.js/fakeweb/core/css/tokens/_index.scss': `:root { --omega-unbuilt: 1; }`,
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        const result = vendorDevkit({ cwd: root });

        const copied = path.join(root, 'dist', 'assets', 'css', 'tokens', '_index.scss');
        ctx.expect(fs.readFileSync(copied, 'utf8'), 'copied from the unbuilt package').toBe(`:root { --omega-unbuilt: 1; }`);
        ctx.expect(result.assets.length).toBe(1);
      },
    },

    {
      name: 'omega.vendorAssets fails loud on a missing source and on dist-escaping targets',
      run: (ctx) => {
        const host = (vendorAssets) => makeFixture('vendor-assets-bad', {
          packageJSON: { name: 'fixture-assets-bad', version: '1.0.0', dependencies: HOST_DEPS, omega: { vendorAssets } },
          files: {
            'dist/untouched.js': `module.exports = 1;`,
            'node_modules/@omega.js/fakeweb/package.json': JSON.stringify({ name: '@omega.js/fakeweb', version: '0.0.1', main: './src/index.js' }),
            'node_modules/@omega.js/fakeweb/src/index.js': `module.exports = {};`,
          },
        });

        const missing = host([{ package: '@omega.js/fakeweb', from: 'core/css/nope.scss', to: 'assets/x.scss' }]);
        ctx.after(() => fs.rmSync(missing, { recursive: true, force: true }));
        ctx.expect(() => vendorDevkit({ cwd: missing })).toThrow(/Asset source not found/);

        const escaping = host([{ package: '@omega.js/fakeweb', from: 'src/index.js', to: '../outside.js' }]);
        ctx.after(() => fs.rmSync(escaping, { recursive: true, force: true }));
        ctx.expect(() => vendorDevkit({ cwd: escaping })).toThrow(/must stay inside the output dir/);
      },
    },

    {
      name: 'a dist reference to a publishable @omega.js package (not a runtime dep) fails loud',
      run: (ctx) => {
        const root = makeFixture('vendor-publishable', {
          packageJSON: { name: 'fixture-publishable', version: '1.0.0', dependencies: HOST_DEPS },
          files: {
            'dist/lib/uses.js': `module.exports = require.resolve('@omega.js/web');`,
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        ctx.expect(() => vendorDevkit({ cwd: root })).toThrow(/not a vendorable private utility.*declare it as a runtime dependency/);
      },
    },

    {
      name: 'template-kit vendors private-clean',
      run: (ctx) => {
        const root = makeFixture('vendor-template-kit', {
          packageJSON: {
            name: 'fixture-web-host',
            version: '1.0.0',
            dependencies: { ...HOST_DEPS, '@omega.js/client': '^0.1.0' },
          },
          files: {
            'dist/lib/render.js': [
              `const { registerLiquid } = require('@omega.js/template-kit/register-liquid');`,
              `const filters = require('@omega.js/template-kit/filters');`,
              `const tags = require('@omega.js/template-kit/tags');`,
              `module.exports = { registerLiquid, filters, tags };`,
            ].join('\n'),
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        vendorDevkit({ cwd: root });

        // Requires rewritten to the vendored copies (tags is a directory module —
        // exports "./tags" → src/tags/index.js, the subpath→file mapping's job)
        const rewritten = fs.readFileSync(path.join(root, 'dist', 'lib', 'render.js'), 'utf8');
        ctx.expect(rewritten).toMatch(/require\('\.\.\/vendor\/template-kit\/register-liquid\.js'\)/);
        ctx.expect(rewritten).toMatch(/require\('\.\.\/vendor\/template-kit\/filters\.js'\)/);
        ctx.expect(!rewritten.includes('@omega.js/template-kit')).toBeTruthy();

        // The vendored closure carries no raw reference to a private package. (It
        // carries none to @omega.js/client either since #619 moved icon-core's
        // build-side reads to @omega.js/devkit — a client reference here would
        // survive as a PACKAGE require, client being a published runtime dep of
        // every host, but template-kit no longer makes one.)
        const vendorRoot = path.join(root, 'dist', 'vendor', 'template-kit');
        ctx.expect(fs.existsSync(vendorRoot), 'missing vendored template-kit tree').toBeTruthy();
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(abs);
              continue;
            }
            const contents = fs.readFileSync(abs, 'utf8');
            ctx.expect(!RAW_PRIVATE_REF.test(contents), `raw private ref left in ${abs}`).toBeTruthy();
          }
        };
        walk(vendorRoot);
      },
    },

    {
      name: '#713: the self-containment scan covers EVERY vendorable — a planted analytics require is detected',
      run: (ctx) => {
        // analytics and monitoring joined VENDORABLE_PACKAGES after the scan's
        // alternation was written, so a raw require of either could have ridden a
        // published dist out undetected and broken the install on `npm i`.
        for (const name of vendorDevkit.VENDORABLE_PACKAGES) {
          ctx.expect(`const x = require('@omega.js/${name}');`, `${name} is invisible to the scan`).toMatch(RAW_PRIVATE_REF);
        }

        // And the real lane: a dist that references analytics vendors private-clean.
        const root = makeFixture('vendor-analytics', {
          packageJSON: {
            name: 'fixture-analytics-host',
            version: '1.0.0',
            // The vendored closures' own runtime deps — the host-dependency guard
            // demands them declared before it will fold these trees in.
            dependencies: { ...HOST_DEPS, uuid: '*', '@sentry/node': '*' },
          },
          files: {
            'dist/lib/track.js': [
              `const analytics = require('@omega.js/analytics');`,
              `const monitoring = require('@omega.js/monitoring/node');`,
              `module.exports = { analytics, monitoring };`,
            ].join('\n'),
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        const planted = fs.readFileSync(path.join(root, 'dist', 'lib', 'track.js'), 'utf8');
        ctx.expect(planted, 'the planted raw reference is what the gate must catch').toMatch(RAW_PRIVATE_REF);

        vendorDevkit({ cwd: root });

        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(abs);
              continue;
            }
            ctx.expect(!RAW_PRIVATE_REF.test(fs.readFileSync(abs, 'utf8')), `raw private ref left in ${abs}`).toBeTruthy();
          }
        };
        walk(path.join(root, 'dist'));

        // The shipped copy loads on what was vendored beside it, one adapter per provider row
        const { ANALYTICS_PROVIDERS } = require('@omega.js/config');
        const vendored = require(path.join(root, 'dist', 'vendor', 'analytics', 'index.js'));
        ctx.expect(Object.keys(vendored.adapters).sort()).toEqual(Object.values(ANALYTICS_PROVIDERS).map((row) => row.id).sort());
      },
    },

    {
      name: '#739: cross-vendor requires INSIDE dist/vendor are rewritten, and a vendorable only a vendored file needs is vendored too',
      run: (ctx) => {
        // The real case: every framework vendored devkit's target-secrets.js and
        // license.js verbatim, so the copies kept requiring '@omega.js/config',
        // '@omega.js/config/env-delivery' and '@omega.js/account'. Those resolved in
        // the monorepo through the workspace symlinks and threw MODULE_NOT_FOUND in a
        // published tarball, the private packages never shipping. The host here
        // references devkit ALONE — config and account arrive purely through the
        // vendored files' own requires.
        const root = makeFixture('vendor-cross', {
          packageJSON: {
            name: 'fixture-cross-host',
            version: '1.0.0',
            // The vendored closures' runtime deps — the host-dependency guard demands
            // them declared before it will fold these trees in.
            dependencies: {
              ...HOST_DEPS,
              json5: '*',
              dotenv: '*',
              'fs-jetpack': '*',
            },
          },
          files: {
            'dist/lib/secrets.js': [
              `const { publishTargetSecrets } = require('@omega.js/devkit/target-secrets');`,
              `const { resolveLicenseVerdict } = require('@omega.js/devkit/license');`,
              `module.exports = { publishTargetSecrets, resolveLicenseVerdict };`,
            ].join('\n'),
          },
        });
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        const result = vendorDevkit({ cwd: root });

        // Closure: neither package is referenced by the host, both ship anyway
        ctx.expect(result.vendored.config, 'config was never vendored').toBeTruthy();
        ctx.expect(result.vendored.account, 'account was never vendored').toBeTruthy();

        // The vendored devkit copies point at their siblings, subpath preserved
        const vendorDevkitDir = path.join(root, 'dist', 'vendor', 'devkit');
        const secrets = fs.readFileSync(path.join(vendorDevkitDir, 'target-secrets.js'), 'utf8');
        ctx.expect(secrets).toMatch(/require\('\.\.\/config\/index\.js'\)/);
        ctx.expect(secrets).toMatch(/require\('\.\.\/config\/env-delivery\.js'\)/);
        const license = fs.readFileSync(path.join(vendorDevkitDir, 'license.js'), 'utf8');
        ctx.expect(license).toMatch(/require\('\.\.\/config\/index\.js'\)/);
        ctx.expect(license).toMatch(/require\('\.\.\/account\/index\.js'\)/);

        // Those relative paths resolve from the vendored file's own directory
        for (const specifier of ['../config/index.js', '../config/env-delivery.js', '../account/index.js']) {
          ctx.expect(require.resolve(specifier, { paths: [vendorDevkitDir] }), `${specifier} does not resolve`).toBeTruthy();
        }

        // And the vendored module actually loads through them
        const loaded = require(path.join(vendorDevkitDir, 'license.js'));
        ctx.expect(typeof loaded.resolveLicenseVerdict).toBe('function');

        // Nothing raw survives anywhere in the shipped tree
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(abs);
              continue;
            }
            ctx.expect(!RAW_PRIVATE_REF.test(fs.readFileSync(abs, 'utf8')), `raw private ref left in ${abs}`).toBeTruthy();
          }
        };
        walk(path.join(root, 'dist'));
      },
    },
  ],
});
