/**
 * The parent forwarder's API address, and the reasons a marketing webhook is
 * not configured at all: the ONE copy both provider services read
 * ([#677](https://github.com/Omega-JS-Stack/omega/issues/677)).
 *
 * Every provider webhook OMEGA manages points at the parent @omega.js/backend's
 * `/omega/marketing/webhook/forward` endpoint, on the `apiAddress` of the
 * RESOLVED `company.url` (this brand's own url when it names no company). So the
 * opt-out, the no-parent refusal and the address are one decision, made here,
 * and a provider service only spells its own provider and its own payload.
 */
const chalk = require('chalk').default;
const { apiAddress, defaultAddressReason } = require('@omega.js/config');

/**
 * The parent's Firebase project id: the brand's own when the brand IS its
 * parent (no company, or `self`), else the company layer's.
 * @param {object} context - The service context (`brandConfig`, `companyConfig`).
 * @returns {string|undefined}
 */
function parentProjectId(context) {
  const { brandConfig, companyConfig } = context;
  const id = brandConfig.company?.id;
  const own = !id || id === 'self' ? brandConfig.cloud?.config?.projectId : undefined;

  return companyConfig?.cloud?.config?.projectId || own;
}

/**
 * Resolve the parent API address a managed webhook points at. Prints the skip
 * lines itself, so both services say the same thing the same way.
 *
 * @param {object} context - The service context: its `brandConfig` (the
 *   RESOLVED `company` may be absent) and `companyConfig` (the company layer).
 * @param {string} what - What is being configured, for the lines ('webhook',
 *   'Event Webhook').
 * @returns {{ skip: string }|{ parentApi: string }} `skip` names the reason
 *   ('opted-out', 'no-url', or the default-address reason); otherwise the
 *   parent's `apiAddress`.
 */
function resolveParentHost(context, what) {
  const company = context.brandConfig.company;

  // The provider ACCOUNT can be somebody else's, which nothing in the company
  // TOPOLOGY says: the playground's SendGrid account is ITW's, and repointing
  // that account's one Event Webhook would break a production forwarder.
  // `company: { webhooks: false }` is how a brand says so.
  if (company?.webhooks === false) {
    console.log(chalk.dim(`      ⊘ company.webhooks = false: ${what} opted out`));
    return { skip: 'opted-out' };
  }

  const resolved = company || {};

  if (!resolved.url) {
    console.log(chalk.dim(`      ⊘ The company (${resolved.id || 'none'}) resolved no url: nothing to point the ${what} at`));
    console.log(chalk.dim("      → Name it with company: { id: '<parent brand.id>' } in omega.json5, and clone the parent on this machine"));
    return { skip: 'no-url' };
  }

  // The company's own API: its url IS this brand's when it names no company,
  // which is what the old `parent: 'self'` spelled by hand. A Pages-hosted
  // parent with no project id has no API address to point at.
  const parentApi = apiAddress(resolved.url, parentProjectId(context));
  if (!parentApi) {
    const reason = defaultAddressReason(resolved.url);
    console.log(chalk.dim(`      ⊘ ${reason}`));
    return { skip: reason };
  }

  return { parentApi };
}

module.exports = { resolveParentHost };
