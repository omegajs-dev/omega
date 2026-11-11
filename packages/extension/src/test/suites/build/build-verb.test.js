// Build-layer tests for the canonical `build` verb ([#81](https://github.com/Omega-JS-Stack/omega/issues/81)
// parity sweep — desktop had the verb, extension only had the npm script).
// The synced projectScripts `build` is the thin `omega build` alias, so the
// verb must run the pipeline ITSELF — clean, then the gulp build task under
// OMEGA_BUILD_MODE — and never shell back to `npm run build` (that would
// recurse forever). Mirrors desktop's build-verbs.test.js.

const path = require('path');
const fs   = require('fs');
const defineCases = require('@omega.js/devkit/test/define-cases');

const SRC          = path.join(__dirname, '..', '..', '..');
const CLI_PATH     = path.join(SRC, 'cli.js');
const COMMANDS_DIR = path.join(SRC, 'commands');

const build = require(path.join(COMMANDS_DIR, 'build.js'));

// Record the steps a plan runs, in order, without executing anything real.
// The step implementations are the seam runPlan already takes as an argument —
// nothing is faked, we just hand it a recorder instead of the real runners (a
// real gulp package build has no place in a unit test).
function recorder(log) {
  const record = (type) => (options, step) => { log.push(step.task ? `${type}:${step.task}` : type); };
  return { clean: record('clean'), gulp: record('gulp') };
}

function stubCommand(name, fn) {
  const file = path.join(COMMANDS_DIR, `${name}.js`);
  require.cache[file] = { id: file, filename: file, loaded: true, children: [], paths: [], exports: fn };
}

function unstub(name) {
  delete require.cache[path.join(COMMANDS_DIR, `${name}.js`)];
}

function freshCli() {
  delete require.cache[CLI_PATH];
  return require(CLI_PATH);
}

// OMEGA_ENVIRONMENT rides the list because it is the ONE environment input
// ([#817](https://github.com/Omega-JS-Stack/omega/issues/817)) and src/build.js
// WRITES it at load from the lane, so clearing the build-mode flag and
// re-requiring the CLI without clearing it leaves the previous lane's word in
// the process, for this case and for the next suite.
async function withEnv(run) {
  const keys = ['OMEGA_ENVIRONMENT', 'OMEGA_BUILD_MODE'];
  const previous = keys.map((key) => [key, process.env[key]]);
  keys.forEach((key) => delete process.env[key]);
  try {
    return await run();
  } finally {
    previous.forEach(([key, value]) => {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    });
  }
}

module.exports = defineCases({
  type: 'suite',
  layer: 'build',
  description: 'build verb — the CLI owns the pipeline and its build-mode flag',
  tests: [
    {
      name: 'positional "build" routes to commands/build.js',
      run: async (ctx) => {
        let invoked = false;
        stubCommand('build', async () => { invoked = true; });
        try {
          const Main = freshCli();
          await new Main().process({ _: ['build'] });
          ctx.expect(invoked).toBe(true);
        } finally {
          unstub('build');
        }
      },
    },
    {
      name: 'alias "-b" routes to the build command, like every sibling CLI',
      run: async (ctx) => {
        let invoked = false;
        stubCommand('build', async () => { invoked = true; });
        try {
          const Main = freshCli();
          await new Main().process({ _: [], b: true });
          ctx.expect(invoked).toBe(true);
        } finally {
          unstub('build');
        }

        const { aliases } = freshCli().config;
        ctx.expect(aliases.build.includes('-b')).toBe(true);
        ctx.expect(aliases.build.includes('--build')).toBe(true);
      },
    },
    {
      name: 'build: OMEGA_BUILD_MODE + clean → gulp build',
      run: (ctx) => {
        const plan = build.plan({});
        ctx.expect(plan.env.OMEGA_BUILD_MODE).toBe('true');
        ctx.expect(plan.steps.map((s) => (s.task ? `${s.type}:${s.task}` : s.type)))
          .toEqual(['clean', 'gulp:build']);
      },
    },
    {
      name: 'runPlan sets the env flag and runs the steps in order',
      run: async (ctx) => {
        const log = [];
        await withEnv(async () => {
          await build.runPlan(build.plan({}), {}, recorder(log));
          ctx.expect(process.env.OMEGA_BUILD_MODE).toBe('true');
        });
        ctx.expect(log).toEqual(['clean', 'gulp:build']);
      },
    },
    {
      name: 'build --cached-only hands the flag to the gulp lane, and a plain build does not',
      run: async (ctx) => {
        const lanes = [];
        const runners = { clean: () => {}, gulp: (options, step) => { lanes.push([step.task, ...step.args]); } };

        await withEnv(async () => {
          await build.runPlan(build.plan({ 'cached-only': true, cachedOnly: true }), {}, runners);
          await build.runPlan(build.plan({}), {}, runners);
        });

        // The translate task reads the flag off the gulp lane's own command line
        ctx.expect(lanes).toEqual([['build', '--cached-only'], ['build']]);
      },
    },
    {
      name: 'every plan step type has a runner in the RUNNERS table',
      run: (ctx) => {
        const known = Object.keys(build.RUNNERS);
        for (const step of build.plan({}).steps) {
          ctx.expect(known.includes(step.type)).toBe(true);
        }
      },
    },
    {
      name: 'the verb never shells back to `npm run build` (the recursion the alias would cause)',
      run: (ctx) => {
        // Comments may NAME the forbidden command (the header documents the
        // recursion rule) — the guard polices code only.
        const source = fs.readFileSync(path.join(COMMANDS_DIR, 'build.js'), 'utf8')
          .replace(/\/\/[^\n]*/g, '')
          .replace(/\/\*[\s\S]*?\*\//g, '');
        ctx.expect(/npm run build/.test(source)).toBe(false);
        ctx.expect(source.includes('npm run gulp -- ')).toBe(true);
      },
    },
    {
      name: 'the scaffolded build script is the thin `omega build` alias the verb table derives',
      run: (ctx) => {
        const pkg = JSON.parse(fs.readFileSync(path.join(SRC, '..', 'package.json'), 'utf8'));
        ctx.expect(require('@omega.js/devkit/verb-scripts').projectScripts(pkg).build).toBe('omega build');
      },
    },
  ],
});
