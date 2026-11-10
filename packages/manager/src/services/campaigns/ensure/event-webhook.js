/**
 * Ensure the account-global SendGrid Event Webhook points at the parent
 * @omega.js/backend's forwarder with the consent-pipeline events enabled.
 *
 * SendGrid supports ONE Event Webhook per account, so it always targets the
 * parent brand: the RESOLVED `company.url`
 * ([#677](https://github.com/Omega-JS-Stack/omega/issues/677)), which is this
 * brand's own url when it names no company or names itself as one. The parent
 * fans events out to each brand's own /marketing/webhook endpoint. Sibling
 * brands sharing the account all converge on the same URL + toggle set. Only
 * the consent toggles are managed: tracking toggles (open/click/delivered/…)
 * are not ours to touch. Drift is patched with the minimum diff.
 */
const chalk = require('chalk').default;
const { dryRunPlan } = require('../../../lib/run-gates.js');
const { resolveParentHost } = require('../../../lib/company-webhook.js');

// The consent-pipeline events @omega.js/backend must receive
const DESIRED_TOGGLES = {
  bounce: true,
  dropped: true,
  spam_report: true,
  unsubscribe: true,
  group_unsubscribe: true,
};

module.exports = async function ensureEventWebhook(context) {
  const { sendgridApi: api, options = {} } = context;

  // The opt-out, the no-parent refusal and the parent's API address are the
  // shared helper's: the newsletter service's webhook answers them identically.
  const parent = resolveParentHost(context, 'Event Webhook');
  if (parent.skip) {
    return {};
  }

  if (!process.env.OMEGA_WEBHOOK_KEY) {
    // Unreachable by design (#635): the key is OMEGA's own (`generated:` in
    // the env schema) and the campaigns service's setup mints it through the
    // shared contract before any operation runs. Absent here = broken wiring.
    throw new Error('OMEGA_WEBHOOK_KEY absent after the campaigns setup ran — its REQUIRES entry or its requestServiceInput call is missing');
  }

  const { parentApi } = parent;
  const desiredUrl = `${parentApi}/omega/marketing/webhook/forward?provider=sendgrid&key=${process.env.OMEGA_WEBHOOK_KEY}`;

  const current = await api.getEventWebhookSettings();

  const patch = {};
  if (current.url !== desiredUrl) {
    patch.url = desiredUrl;
  }
  if (current.enabled !== true) {
    patch.enabled = true;
  }
  for (const [toggle, value] of Object.entries(DESIRED_TOGGLES)) {
    if (current[toggle] !== value) {
      patch[toggle] = value;
    }
  }

  if (Object.keys(patch).length === 0) {
    console.log(`      ${chalk.green('✓')} Event Webhook up to date`);
    console.log(`      ${chalk.dim('→')} ${chalk.dim(`${parentApi}/omega/marketing/webhook/forward`)}`);
    return { output: { eventWebhook: { url: 'converged' } } };
  }

  if (options.dryRun) {
    return dryRunPlan(`patch: ${Object.keys(patch).join(', ')}`, { output: { eventWebhook: { planned: Object.keys(patch) } } });
  }

  if (patch.url) {
    console.log(`      ${chalk.yellow('↻')} Pointing Event Webhook at ${chalk.cyan(parentApi)}'s forwarder`);
  }
  const enablingToggles = Object.keys(patch).filter((key) => key !== 'url' && key !== 'enabled');
  if (enablingToggles.length > 0) {
    console.log(`      ${chalk.yellow('↻')} Enabling events: ${chalk.cyan(enablingToggles.join(', '))}`);
  }

  await api.updateEventWebhookSettings(patch);
  console.log(`      ${chalk.green('✓')} Event Webhook updated`);

  return { output: { eventWebhook: { updated: Object.keys(patch) } } };
};
