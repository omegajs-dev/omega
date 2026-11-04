/**
 * deploy-follow: follow a dispatched GitHub Actions run to its verdict
 * ([#873](https://github.com/Omega-JS-Stack/omega/issues/873)).
 *
 * A dispatch used to end at the runs page URL: the verb printed a link and
 * exited 0 while the run it had just started went red a few minutes later. So
 * every dispatched deploy follows its run instead, through this ONE follower
 * (it was desktop's alone, inside `omega release`, on `@octokit/rest`): the run
 * and its jobs are polled, each job's log is streamed with its name in front,
 * and the verb's exit code is the run's conclusion.
 *
 * Why poll instead of stream? GitHub Actions exposes no live stdout: a job's
 * log is fetchable only as each STEP closes, so "streaming" is a polite fiction
 * where every tick re-fetches each job's log and prints the bytes it has not
 * printed yet.
 *
 * A poll failure is an expected external condition, never a verdict: a connect
 * timeout on one tick used to mark a deploy failed on the laptop and stop a
 * brand fan-out while the run went green. MAX_TRANSIENT_POLLS failures IN A ROW
 * rethrow; anything short of that waits and polls again.
 *
 * Everything prints through the caller's logger, so the lines carry that verb's
 * tag and land in whatever file the verb teed (`logs/deploy.log`:
 * [docs/shared/logging.md](../../../docs/shared/logging.md)).
 */

// Libraries
const { setTimeout: delay } = require('node:timers/promises');
const { ghHeaders, shortSha } = require('./deploy-snapshot.js');

// Constants
const API_BASE = 'https://api.github.com';
// One tick of the follow. Job logs only change as steps close, so a faster tick
// buys nothing but rate limit.
const POLL_INTERVAL_MS = 5000;
// GitHub registers a dispatched run a few seconds after it accepts the
// dispatch: a minute of 2s looks, then a loud failure naming the workflow.
const RUN_LOOKUP_MS = 60_000;
const RUN_LOOKUP_INTERVAL_MS = 2000;
// Consecutive polls the network may fail before the follower gives up: a minute
// of 5s ticks. The runner keeps building whether or not this laptop can reach
// api.github.com for one tick, so one timeout must never end the follow.
const MAX_TRANSIENT_POLLS = 12;

/**
 * A job's verdict as one character. A SKIPPED job is not a failed one: a run
 * that ships two of three platforms skips the legs its `platforms` input left
 * out, and the signing leg skips with them, so a cross there reads as three
 * failures beside a green run.
 *
 * @param {object} job - The job, as GitHub reports it (`status`, `conclusion`).
 * @returns {string} The symbol for the banner.
 */
function jobSymbol(job) {
  if (job.status === 'completed') {
    if (job.conclusion === 'success') return '✓';
    return job.conclusion === 'skipped' ? '⊘' : '✗';
  }
  if (job.status === 'in_progress') return '…';
  if (job.status === 'queued') return '·';
  return '?';
}

/**
 * The one-line status banner: the run's state and every job's symbol. Printed
 * only when it CHANGES, so a poll that found nothing new says nothing.
 *
 * @param {object} run - The run state.
 * @param {object[]} jobs - Its jobs.
 * @returns {string} The banner line.
 */
function statusBanner(run, jobs) {
  const parts = jobs.map((job) => `${jobSymbol(job)} ${job.name}`);

  return `-- ${run.status}${run.conclusion ? ` (${run.conclusion})` : ''} -- ${parts.join('  |  ')}`;
}

/** One GET against the API, as JSON. Throws on any non-200, for the caller's transient count. */
async function getJson(url, { token, fetchFn }) {
  const response = await fetchFn(url, { headers: ghHeaders(token) });

  if (response.status !== 200) {
    throw new Error(`GET ${url} answered ${response.status}`);
  }

  return response.json();
}

/**
 * The run this dispatch started: the newest `workflow_dispatch` run of that
 * workflow created at or after the dispatch (less a second of clock skew).
 *
 * @param {object} options - Options.
 * @param {string} options.owner - The repo owner.
 * @param {string} options.repo - The repo's bare name.
 * @param {string} options.workflow - The workflow file the dispatch named.
 * @param {number} options.sinceMs - The instant read before the dispatch.
 * @param {string} options.token - The GitHub token.
 * @param {Function} options.fetchFn - The fetch seam.
 * @param {Function} options.sleepFn - The wait seam.
 * @param {number} options.deadlineMs - How long to look for it.
 * @returns {Promise<object>} The run.
 * @throws {Error} When no run appears in the budget.
 */
async function findRun(options) {
  const { owner, repo, workflow, sinceMs, token, fetchFn, sleepFn, deadlineMs } = options;
  const url = `${API_BASE}/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=5`;
  const deadline = Date.now() + deadlineMs;

  while (true) {
    let runs = [];
    try {
      runs = (await getJson(url, { token, fetchFn })).workflow_runs || [];
    } catch (e) {
      // The listing is as transient as any other poll: the run that was just
      // dispatched is worth the rest of the budget.
      runs = [];
    }

    // The NEWEST match, never the first one listed: an older run of the same
    // workflow is exactly what a dispatch lands beside.
    const fresh = runs
      .filter((run) => new Date(run.created_at).getTime() >= sinceMs - 1000)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

    if (fresh) return fresh;

    if (Date.now() >= deadline) {
      throw new Error(`${workflow} was dispatched on ${owner}/${repo} but no run appeared within ${Math.round(deadlineMs / 1000)}s. Check https://github.com/${owner}/${repo}/actions/workflows/${workflow}`);
    }

    await sleepFn(RUN_LOOKUP_INTERVAL_MS);
  }
}

/**
 * Follow a dispatched run to its conclusion: print each job's log as it
 * arrives, a banner on every transition, and the verdict at the end.
 *
 * @param {object} options - Options.
 * @param {string} options.owner - The repo owner.
 * @param {string} options.repo - The repo's bare name.
 * @param {string} options.workflow - The workflow file the dispatch named.
 * @param {Date|number|string} options.since - The instant read BEFORE the dispatch.
 * @param {string} options.token - The GitHub token.
 * @param {string} [options.headSha] - The sha this deploy pushed: a run whose
 *   head is anything else is REFUSED
 *   ([#902](https://github.com/Omega-JS-Stack/omega/issues/902)). Omitted on a
 *   push lane, whose run head is the developer's own commit.
 * @param {object} [options.logger] - Logger with `log`/`warn` (silent when omitted).
 * @param {Function} [options.fetchFn] - The fetch seam (tests).
 * @param {Function} [options.sleepFn] - The wait seam (tests).
 * @param {number} [options.pollMs] - The tick between polls.
 * @param {number} [options.lookupMs] - How long to look for the run.
 * @returns {Promise<{ run: object, conclusion: string }>} The completed run and its conclusion.
 * @throws {Error} When no run appears, when the run found is building another
 *   tree than `headSha`, when the network fails MAX_TRANSIENT_POLLS times in a
 *   row, or when the run concludes as anything but success.
 */
async function followRun(options) {
  const {
    owner,
    repo,
    workflow,
    since,
    token,
    headSha,
    logger,
    fetchFn = fetch,
    sleepFn = delay,
    pollMs = POLL_INTERVAL_MS,
    lookupMs = RUN_LOOKUP_MS,
  } = options;

  const log = (line) => { if (logger) logger.log(line); };
  const sinceMs = new Date(since).getTime();

  const found = await findRun({ owner, repo, workflow, sinceMs, token, fetchFn, sleepFn, deadlineMs: lookupMs });

  // The run has to be building the tree this deploy pushed (#902). GitHub
  // resolves the dispatch's ref on its own side, so a run started in the same
  // second as the push can carry the PREVIOUS snapshot, publish the
  // version before this one, and conclude green with nothing in its log saying
  // so. Following it at all would report that as this deploy's verdict.
  if (headSha && found.head_sha !== headSha) {
    throw new Error(`${workflow} started a run on ${shortSha(found.head_sha)}, but this deploy pushed ${shortSha(headSha)}: the run is building a tree this deploy did not push, so its result is not this deploy's. ${found.html_url}`);
  }

  log(`Run started: ${found.html_url}${headSha ? ` (head ${shortSha(headSha)})` : ''}`);

  const runUrl = `${API_BASE}/repos/${owner}/${repo}/actions/runs/${found.id}`;
  const jobsUrl = `${runUrl}/jobs?per_page=100`;
  // How much of each job's log has been printed, so a re-fetch prints only what
  // the last one did not have.
  const printedByJob = new Map();
  let failures = 0;
  let lastBanner = '';

  while (true) {
    let state = null;
    let jobs = [];

    try {
      state = await getJson(runUrl, { token, fetchFn });
      jobs = (await getJson(jobsUrl, { token, fetchFn })).jobs || [];
      failures = 0;
    } catch (error) {
      // Never a verdict on the run: the runner is building either way.
      failures += 1;
      if (failures > MAX_TRANSIENT_POLLS) {
        throw error;
      }
      if (logger) {
        logger.warn(`Poll failed (${failures}/${MAX_TRANSIENT_POLLS}, retrying): ${error.message}`);
      }
      await sleepFn(pollMs);
      continue;
    }

    for (const job of jobs) {
      // A queued job has no log yet, and asking for one is a 404 per tick.
      if (job.status === 'queued') continue;

      const text = await readJobLog({ owner, repo, jobId: job.id, token, fetchFn });
      if (text === null) continue;

      const printed = printedByJob.get(job.id) || 0;
      if (text.length > printed) {
        for (const line of text.slice(printed).split('\n')) {
          if (!line) continue;
          log(`[${job.name}] ${line}`);
        }
        printedByJob.set(job.id, text.length);
      }
    }

    const banner = statusBanner(state, jobs);
    if (banner !== lastBanner) {
      log(banner);
      lastBanner = banner;
    }

    if (state.status === 'completed') {
      const conclusion = state.conclusion;
      const success = conclusion === 'success';
      log(`${success ? '✓' : '✗'} Run ${conclusion}: ${state.html_url}`);

      if (!success) {
        throw new Error(`${workflow} concluded ${conclusion}: ${state.html_url}`);
      }

      return { run: state, conclusion };
    }

    await sleepFn(pollMs);
  }
}

/**
 * One job's log so far, or null when there is none to read yet. A job's log is
 * 404 until its first step closes, and it arrives in chunks after that, so a
 * miss is the ordinary case rather than a failure.
 *
 * @param {object} options - Options.
 * @param {string} options.owner - The repo owner.
 * @param {string} options.repo - The repo's bare name.
 * @param {number} options.jobId - The job.
 * @param {string} options.token - The GitHub token.
 * @param {Function} options.fetchFn - The fetch seam.
 * @returns {Promise<string|null>} The log text, or null.
 */
async function readJobLog(options) {
  const { owner, repo, jobId, token, fetchFn } = options;

  try {
    const response = await fetchFn(`${API_BASE}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
      headers: ghHeaders(token),
    });

    if (response.status !== 200) return null;

    return await response.text();
  } catch (e) {
    // A log this tick could not read is a log the next tick reads: the run's
    // own state is what the poll above answers for.
    return null;
  }
}

module.exports = {
  followRun,
  findRun,
  jobSymbol,
  statusBanner,
  MAX_TRANSIENT_POLLS,
  POLL_INTERVAL_MS,
};
