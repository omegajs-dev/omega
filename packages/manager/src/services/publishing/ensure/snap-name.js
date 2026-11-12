/**
 * The Snap Store name `brand.id` (snapName), registered for a brand that ships
 * the snap: the build pins it and the site links it, so the store must hold it
 * before the first upload. The names the account holds are read first, so a
 * second run registers nothing. snapcraft logs in with the env's
 * SNAPCRAFT_STORE_CREDENTIALS, which the `keys` step already refused without.
 *
 * No snapcraft, or a login it rejects, gets the login page behind an Enter
 * prompt and the manual step, and the step FAILS until it is done. Every call
 * goes through `options.execFn` (execFileSync by default) and every prompt
 * through `options.prompt` (over devkit/prompt), so a test stands in for both.
 */
const { execFileSync } = require('node:child_process');
const chalk = require('chalk').default;
const { FORMATS, snapName } = require('@omega.js/config');
const { formatShips } = require('@omega.js/config/env-when');
const { SNAPCRAFT, missingTool, machineToolLine } = require('@omega.js/devkit/machine-tools');
const { PUBLISHING_WALK } = require('@omega.js/devkit/ship-plan');

const { dryRunPlan } = require('../../../lib/run-gates.js');

// The snap's row: the store's label and the page a human logs in on
const SNAP = FORMATS.desktop.linux.snap;

// What `snapcraft names` prints, in any format, for an account with no names
const NO_NAMES = 'No registered snaps';

/**
 * Run `snapcraft` on the injected runner.
 *
 * @param {Function} execFn - The runner: `(file, args, options) => stdout`
 * @param {string[]} args - Arguments after `snapcraft`
 * @returns {string} stdout
 */
function snapcraft(execFn, args) {
  return String(execFn('snapcraft', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

/**
 * The names the logged-in account holds, off `snapcraft names --format json`
 * (`{ snaps: [{ name, since, visibility, notes }] }`). An account that holds
 * none gets snapcraft's plain sentence instead of JSON; anything else that is
 * not JSON throws.
 *
 * @param {Function} execFn - The runner
 * @returns {string[]}
 */
function heldNames(execFn) {
  const out = snapcraft(execFn, ['names', '--format', 'json']).trim();
  if (out === NO_NAMES) return [];

  return JSON.parse(out).snaps.map((snap) => snap.name);
}

/**
 * The failed return a missing tool or login earns: the login page behind an
 * Enter prompt (a dry run only prints it), then the manual step.
 *
 * @param {object} options - The run options (`dryRun`)
 * @param {object} prompt - devkit/prompt, with the run's stand-ins over it
 * @param {string} name - The snap name
 * @param {string} problem - What is missing, one sentence
 * @returns {Promise<object>} A `{ status: 'error' }` handler return
 */
async function manualStep(options, prompt, name, problem) {
  if (!options.dryRun) {
    await prompt.pressEnterToOpen(SNAP.console, `the ${SNAP.label} login`);
  }

  const step = `${problem} Log in at ${SNAP.console} (\`snapcraft export-login -\` mints SNAPCRAFT_STORE_CREDENTIALS), `
    + `then run \`snapcraft register ${name}\` or re-run \`${PUBLISHING_WALK}\`.`;
  console.log(`      ${chalk.red('✗')} ${step}`);

  return { status: 'error', error: step, output: { snapName: { name, registered: false } } };
}

module.exports = async (context) => {
  const options = context.options || {};
  const execFn = options.execFn || execFileSync;
  const prompt = { ...require('@omega.js/devkit/prompt'), ...options.prompt };

  const snapTargets = context.shipping
    .filter((target) => target.type === 'desktop' && formatShips(context.brandConfig.targets[target.name], 'linux', 'snap'));

  if (snapTargets.length === 0) {
    console.log(`      ${chalk.dim('⊘ no target ships the snap')}`);
    return null;
  }

  const name = snapName(context.brandConfig);

  // snapcraft is this step's tool alone: no target needs it to run
  const missing = missingTool(SNAPCRAFT, snapTargets[0], { execFn });
  if (missing) {
    return manualStep(options, prompt, name, `${machineToolLine(missing)}.`);
  }

  try {
    snapcraft(execFn, ['whoami']);
  } catch {
    return manualStep(options, prompt, name, `snapcraft is not logged in to the ${SNAP.label}.`);
  }

  if (heldNames(execFn).includes(name)) {
    console.log(`      ${chalk.green('✓')} Snap name ${chalk.cyan(name)} ${chalk.dim('(held by this account)')}`);
    return { output: { snapName: { name, registered: false } } };
  }

  if (options.dryRun) {
    return dryRunPlan(`register the snap name ${name}`, { output: { snapName: { name, registered: false } } });
  }

  try {
    snapcraft(execFn, ['register', name, '--yes']);
  } catch (error) {
    const reason = String(error?.stderr || error?.message || '').trim();
    return { status: 'error', error: `The ${SNAP.label} refused to register ${name}: ${reason}` };
  }

  console.log(`      ${chalk.green('✓')} Registered snap name ${chalk.cyan(name)}`);

  return { output: { snapName: { name, registered: true } } };
};
