/**
 * The build's config contract: a FATAL config-validation finding stops
 * `omega build`, and the process it ran in exits NON-ZERO. A retired key is
 * the canonical fatal — renamed outright, so nothing reads the old name and
 * the settings under it are silently lost — and a build that printed the
 * findings, produced no usable output and still exited 0 reads as SUCCESS to
 * CI and to every scripted caller
 * ([#426](https://github.com/Omega-JS-Stack/omega/issues/426)).
 *
 * Driven against a real temp consumer with the real command, and once through
 * the real bin as its own process — the exit code IS the contract, and only a
 * spawned process can prove it.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const defineCases = require('@omega.js/devkit/test/define-cases');

// Every temp consumer's config load records its brand: keep that off the real ~/.omega
require('@omega.js/devkit/test/temp-home');

const build = require('../src/commands/build.js');

const PKG = path.resolve(__dirname, '..');

// A temp consumer whose config carries ONE retired key (payment.processors was
// renamed to payment.providers in #428) — the rest of the tree is a valid
// consumer, so nothing but that finding can fail the build. The package.json
// declares the framework so the bin dispatches straight to this one.
function consumer(t, extraFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-web-build-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const files = {
    'config/omega.json5': `{
  brand: { id: 'fixture', name: 'Fixture', url: 'https://fixture.example.com' },
  payment: { processors: { stripe: {} } },
  targets: { web: { type: 'web' } },
}`,
    'package.json': JSON.stringify({
      name: 'fixture-website',
      private: true,
      dependencies: { '@omega.js/web': '*' },
    }),
    'src/index.md': '# home',
  };

  for (const [relative, contents] of Object.entries({ ...files, ...extraFiles })) {
    const abs = path.join(root, relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  return root;
}

module.exports = defineCases({
  type: 'group',
  description: 'build-config-fatal',
  tests: [
    {
      name: 'build: a retired config key is fatal — the command refuses, it never warns and builds',
      run: async (ctx) => {
        const root = consumer(ctx);
        const previous = process.cwd();
        process.chdir(root);
        ctx.after(() => process.chdir(previous));

        await ctx.expect(build({ logFile: false }), 'the finding comes back as a thrown fatal, not a printed warning').rejects.toThrow(/config\/omega\.json5 is invalid:[\s\S]*payment\.processors\.stripe is not a key the schema declares/);

        ctx.expect(fs.existsSync(path.join(root, 'dist')), 'a refused build writes no output').toBe(false);
      },
    },

    {
      name: 'bin: `omega build` exits non-zero on a fatal config finding (real process, real bin)',
      run: (ctx) => {
        const root = consumer(ctx);

        const run = spawnSync(process.execPath, [path.join(PKG, 'bin', 'omega'), 'build'], {
          cwd: root,
          stdio: 'pipe',
          encoding: 'utf8',
        });

        const output = `${run.stdout}${run.stderr}`;
        ctx.expect(output, 'the finding is printed').toMatch(/payment\.processors\.stripe is not a key the schema declares/);
        ctx.expect(run.status, 'CI and scripted callers must read the run as a failure').not.toBe(0);
        ctx.expect(fs.existsSync(path.join(root, 'dist')), 'a refused build writes no output').toBe(false);
      },
    },

    /**
     * The environment overlay is part of the build's config
     * ([#856](https://github.com/Omega-JS-Stack/omega/issues/856)): `omega build`
     * IS the production build, so it names `production` and the
     * `config/omega.production.json5` beside the base composes, on a machine whose
     * own ambient answer is `development`. Proven the way this file proves
     * everything else about the build's config: a retired key in the file that
     * composes is fatal, and the base here is clean, so only the overlay can throw.
     */
    {
      name: 'build: the PRODUCTION overlay composes, never the machine ambient one (#856)',
      run: async (ctx) => {
        const root = consumer(ctx, {
          'config/omega.json5': `{
  brand: { id: 'fixture', name: 'Fixture', url: 'https://fixture.example.com' },
  targets: { web: { type: 'web' } },
}`,
          'config/omega.production.json5': `{ payment: { processors: { stripe: {} } } }`,
          'config/omega.development.json5': `{ theme: { id: 'classy' } }`,
        });
        const previous = process.cwd();
        process.chdir(root);
        ctx.after(() => process.chdir(previous));

        // This machine says `development`, the way a terminal running a local build
        // does. The lane still builds for production, which is the whole point.
        const saved = [['ENVIRONMENT', process.env.ENVIRONMENT], ['OMEGA_ENVIRONMENT', process.env.OMEGA_ENVIRONMENT]];
        delete process.env.OMEGA_ENVIRONMENT;
        process.env.ENVIRONMENT = 'development';
        ctx.after(() => {
          for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        });

        await ctx.expect(build({ logFile: false }), 'the production overlay is a layer of the build config, so its retired key refuses the build').rejects.toThrow(/config\/omega\.json5 is invalid:[\s\S]*payment\.processors\.stripe is not a key the schema declares/);
      },
    },
  ],
});
