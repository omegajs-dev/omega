/**
 * Cron: the job runner behind `omega_cronDaily` and `omega_cronFrequent`.
 *
 * Discovers and executes every .js job file of one schedule, the framework's
 * own (`events/cron/<name>/`) first, then the consumer's
 * (`<cwd>/hooks/cron/<name>/`). Each job gets its OWN Context and is called
 * with `{ ctx, omega, context }`; a job that throws is reported and the next
 * one still runs.
 */
const jetpack = require('fs-jetpack');
const Context = require('./context.js');
const { loadHandler } = require('./libraries/load-handler.js');

/**
 * Run every job of one schedule.
 * @param {string} name - Cron schedule name (e.g., 'daily', 'frequent')
 * @param {object} options
 * @param {object} options.omega - the Omega instance
 * @param {object} options.ctx - the schedule's Context
 * @param {object} options.context - Cloud Function context
 */
async function run(name, { omega, ctx, context }) {
  // Set log prefix
  ctx.setLogPrefix(`cron/${name}()`);

  // Log
  ctx.log('Starting...');

  // Load @omega.js/backend jobs
  await loadAndExecuteJobs(name, `${__dirname}/events/cron/${name}`, omega, context);

  // Load custom jobs
  await loadAndExecuteJobs(name, `${omega.cwd}/hooks/cron/${name}`, omega, context);
}

async function loadAndExecuteJobs(name, jobsPath, omega, context) {
  const jobs = jetpack.list(jobsPath) || [];

  // Log
  omega.logger.log(`Located ${jobs.length} jobs @ ${jobsPath}...`);

  for (const job of jobs) {
    // Create new ctx for each job
    const ctx = new Context(omega);

    // Load job
    const jobName = job.replace('.js', '');

    // Set log prefix
    ctx.setLogPrefix(`cron/${name}/${jobName}()`);

    // Log
    ctx.log('Starting...');

    try {
      // Load and execute job
      const handler = loadHandler(`${jobsPath}/${job}`);
      await handler({ ctx, omega, context });

      ctx.log('Completed!');
    } catch (e) {
      ctx.report(`Error executing: ${e}`, { code: 500 });
    }
  }
}

// The call shape a job is invoked with is the whole contract a consumer writes
// against, so the docs' example is proven against THIS function rather than a
// copy of it ([#495](https://github.com/Omega-JS-Stack/omega/issues/495)).
module.exports = { run, loadAndExecuteJobs };
