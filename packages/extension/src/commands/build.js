// Libraries
const { execute } = require('node-powertools');
const build = require('../build.js');
const logger = build.logger('build');
const { ensureTarget } = require('./lib/ensure-target.js');

// The consumer's `build` script is `omega build` — this verb owns the pipeline
// and the build-mode flag; it must never shell back to that script (that would
// recurse). `npm run gulp -- <task>` is the one safe shell-out: the consumer's
// `gulp` script is bare `gulp`, so there's no alias to recurse through. The
// gulp `build` series does no cleaning of its own, so the verb owns that step
// too. Desktop runs the same model through utils/build-pipeline.js because
// three verbs share it there; extension has two plans (this and dev) and both run through runPlan here.
function plan(options = {}) {
  return {
    env: { OMEGA_BUILD_MODE: 'true' },
    steps: [
      { type: 'clean' },
      // `--cached-only` rides to the gulp lane, whose translate task reads it
      { type: 'gulp', task: 'build', args: options.cachedOnly ? ['--cached-only'] : [] },
    ],
  };
}

function gulpCommand(task, args = []) {
  return `npm run gulp -- ${[task, ...args].join(' ')}`;
}

// Step implementations — the seam runPlan takes as an argument, so a test can
// record the order without running a real gulp build.
const RUNNERS = {
  clean: (options) => require('./clean.js')(options),
  gulp: (options, step) => execute(gulpCommand(step.task, step.args), { log: true }),
};

async function runPlan(plan, options, runners) {
  options = options || {};
  runners = runners || RUNNERS;

  // Set in-process so every child (gulp → esbuild → the packager) inherits them.
  Object.entries(plan.env || {}).forEach(([key, value]) => {
    process.env[key] = value;
  });

  for (const step of plan.steps) {
    const runner = runners[step.type];

    // The plan is authored in this file alongside the runner table — an unknown
    // step type is a programmer error, never consumer input.
    if (!runner) {
      throw new Error(`Unknown pipeline step type: ${step.type}`);
    }

    await runner(options, step);
  }
}

module.exports = async function (options) {
  // Log
  logger.log('Running production build...');

  // The local scaffold BEFORE the pipeline (#675): the gulp `defaults` task
  // ensures too, but gulp itself is one of the peer deps the ensure installs,
  // so a fresh consumer outside any node_modules hoist never reaches it.
  await ensureTarget({ log: (line) => logger.log(line), warn: (line) => logger.warn(line) });

  await runPlan(plan(options), options);
};

module.exports.plan = plan;
module.exports.runPlan = runPlan;
module.exports.gulpCommand = gulpCommand;
module.exports.RUNNERS = RUNNERS;
