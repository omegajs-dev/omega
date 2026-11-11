/**
 * Ensure @omega.js/backend's segments exist on the Beehiiv publication.
 *
 * Beehiiv has NO segment-create API — the read side lists what exists,
 * and creation happens through the dashboard UI. Interactive runs offer
 * to drive that UI via the OMEGA Companion extension (trusted-event
 * browser automation; see lib/segment-automation.js) or to open the
 * dashboard for manual creation, then RE-verify against the API so
 * "created" means Beehiiv says so. Non-interactive and dry runs never
 * mutate: missing segments warn with human-readable conditions.
 */
const chalk = require('chalk').default;
const { emailProviderForRole } = require('@omega.js/config');
const { select } = require('@omega.js/devkit/prompt');
const { openBrowserAndPoll } = require('@omega.js/devkit/flows');
const { segmentsFor } = require('../../../lib/backend-marketing.js');
const { AutomationClient } = require('../../../lib/automation-client.js');
const { formatCondition, automateCreateSegment } = require('../lib/segment-automation.js');
const { canPrompt } = require('../../../lib/run-gates.js');

const BEEHIIV_SEGMENTS = segmentsFor(emailProviderForRole('newsletter').id);
const SEGMENTS_URL = 'https://app.beehiiv.com/segments';

/** Names of the @omega.js/backend segments missing from the publication. */
async function listMissing(api, publicationId) {
  const existing = await api.getSegments(publicationId);
  const existingByName = new Set(existing.map((s) => s.name));
  return BEEHIIV_SEGMENTS.filter((s) => !existingByName.has(s.name));
}

module.exports = async function ensureSegments(context) {
  const { beehiivApi: api, serviceData, options = {} } = context;

  const publicationId = serviceData.publicationId;
  if (!publicationId) {
    console.log(chalk.dim('      ⊘ No publication yet — nothing to verify segments on'));
    return {};
  }

  const missing = await listMissing(api, publicationId);

  if (missing.length === 0) {
    console.log(`      ${chalk.green('✓')} All ${BEEHIIV_SEGMENTS.length} segments exist`);
    return { output: { segments: { total: BEEHIIV_SEGMENTS.length, missing: [] } } };
  }

  console.log(`      ${chalk.yellow('⚠')} ${missing.length} segment(s) missing — Beehiiv has no segment-create API:`);
  for (const segment of missing) {
    const joiner = segment.logic === 'or' ? ' OR ' : ' AND ';
    const criteria = segment.conditions.map((c) => formatCondition(c)).join(joiner);
    console.log(`        ${chalk.dim('•')} ${chalk.cyan(segment.display)} ${chalk.dim(`(${segment.name})`)}`);
    console.log(`          ${chalk.dim('→')} ${criteria}`);
  }

  const warned = (created = []) => ({
    status: 'warned',
    reason: `${missing.length} segment(s) missing: ${missing.map((s) => s.name).join(', ')}`,
    output: { segments: { total: BEEHIIV_SEGMENTS.length, missing: missing.map((s) => s.name), ...(created.length ? { created } : {}) } },
  });

  // Headless/dry runs stop at the instructions (build them at SEGMENTS_URL)
  if (!canPrompt(options)) {
    console.log(`        ${chalk.dim(`→ Build them at ${SEGMENTS_URL}`)}`);
    return warned();
  }

  const action = await select({
    message: 'Create missing segments?',
    choices: [
      { name: 'Automate via extension', value: 'automate' },
      { name: 'Open dashboard (manual)', value: 'manual' },
      { name: 'Skip', value: 'skip' },
    ],
    default: 'automate',
  });

  if (action === 'skip') {
    return warned();
  }

  const created = [];

  if (action === 'manual') {
    await openBrowserAndPoll({
      url: SEGMENTS_URL,
      label: 'the Beehiiv segments page',
      promptMessage: `Create ${missing.length} missing segment(s) in Beehiiv`,
      waitMessage: 'Press ENTER when done',
      manualOnly: true,
    });
  } else {
    // Automate via extension — open the dashboard first so the user can
    // select the right publication before the automation drives the UI
    await openBrowserAndPoll({
      url: SEGMENTS_URL,
      label: 'the Beehiiv segments page',
      promptMessage: 'Select the correct publication in Beehiiv, then confirm to start automation',
      waitMessage: 'Press ENTER when ready',
      manualOnly: true,
    });

    console.log(`      ${chalk.dim('Connecting to extension...')}`);
    const client = new AutomationClient();

    try {
      await client.connect();
      console.log(`      ${chalk.dim('→')} Extension connected`);

      for (const segment of missing) {
        try {
          console.log(`      ${chalk.dim(`Creating ${segment.display}...`)}`);
          await automateCreateSegment(client, segment);
          console.log(`      ${chalk.green('✓')} Created ${chalk.cyan(segment.display)}`);
          created.push(segment.name);
        } catch (e) {
          console.log(`      ${chalk.red('✗')} Failed to create ${chalk.cyan(segment.display)}: ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`      ${chalk.red('✗')} Automation failed: ${e.message}`);
    } finally {
      await client.disconnect();
    }
  }

  // Re-verify — "created" is what Beehiiv reports, not what the automation
  // believes it did
  const remaining = await listMissing(api, publicationId);

  if (remaining.length === 0) {
    console.log(`      ${chalk.green('✓')} All ${BEEHIIV_SEGMENTS.length} segments exist`);
    return { output: { segments: { total: BEEHIIV_SEGMENTS.length, missing: [], ...(created.length ? { created } : {}) } } };
  }

  console.log(`      ${chalk.yellow('⚠')} ${remaining.length} segment(s) still missing: ${remaining.map((s) => s.name).join(', ')}`);
  return {
    status: 'warned',
    reason: `${remaining.length} segment(s) still missing: ${remaining.map((s) => s.name).join(', ')}`,
    output: { segments: { total: BEEHIIV_SEGMENTS.length, missing: remaining.map((s) => s.name), ...(created.length ? { created } : {}) } },
  };
};
