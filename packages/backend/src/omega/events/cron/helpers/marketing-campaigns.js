/**
 * The marketing campaigns cron's tuning and its generator table
 * (events/cron/frequent/marketing-campaigns.js), one home for the job and its
 * tests. It lives outside the schedule's folder, whose every file the cron
 * runner runs as a job.
 */

// How long a 'processing' lease is honored before the campaign of a crashed or
// timed-out run is reclaimed for retry. Must comfortably exceed the function
// timeout so an in-flight run is never reclaimed out from under itself.
const PROCESSING_LEASE_SECONDS = 30 * 60;

// How many times a generator campaign may yield nothing before its occurrence
// is skipped (recurring) or the campaign is failed (one-off). At the 10-minute
// cron cadence this is ~6 hours of retries.
const GENERATOR_MAX_ATTEMPTS = 36;

/**
 * The content generators a generator campaign may name, keyed by name.
 * Required at call time, so each run reads the copy the require cache holds
 * then; an `import()` from the job would hold its first copy for the process.
 * @returns {Object<string, object>} Each generator's module.
 */
function loadGenerators() {
  return {
    newsletter: require('../../../libraries/email/generators/newsletter.js'),
  };
}

module.exports = { PROCESSING_LEASE_SECONDS, GENERATOR_MAX_ATTEMPTS, loadGenerators };
