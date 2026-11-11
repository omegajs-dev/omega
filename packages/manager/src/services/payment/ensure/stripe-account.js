/**
 * Ensure the Stripe account's business profile matches brand config
 * (name, url, support email, support url). Diff-then-update; account
 * updates aren't supported on every account type (org sub-accounts), so an
 * update failure warns instead of erroring. Disable entirely with
 * payment.providers.stripe.updateAccountInfo = false. A brand on a default
 * Pages host derives no support email from its host: with no
 * brand.contact.email the step skips with the default-address reason.
 */
const chalk = require('chalk').default;
const { defaultAddressReason } = require('@omega.js/config');

/**
 * Build desired account settings from brand config
 */
function buildDesiredAccount(brandConfig) {
  const domain = brandConfig.brand.url.replace(/^https?:\/\//, '');

  return {
    business_profile: {
      name: brandConfig.brand.name,
      url: brandConfig.brand.url,
      support_email: brandConfig.brand.contact?.email || `support@${domain}`,
      support_url: brandConfig.brand.url,
    },
  };
}

/**
 * Diff current account against desired and return updates
 */
function getAccountUpdates(account, desired) {
  const bp = account.business_profile || {};
  const desiredBp = desired.business_profile;

  const bpUpdates = {};
  for (const key of ['name', 'url', 'support_email', 'support_url']) {
    if (bp[key] !== desiredBp[key]) {
      bpUpdates[key] = desiredBp[key];
    }
  }

  return Object.keys(bpUpdates).length > 0 ? { business_profile: bpUpdates } : null;
}

module.exports = async function ensureStripeAccount(context) {
  const { brandConfig, stripeApi: api, options } = context;
  const dryRun = options?.dryRun || false;

  if (!api) {
    console.log(`      ${chalk.dim('⊘ Stripe not configured')}`);
    return {};
  }

  if (brandConfig.payment?.providers?.stripe?.updateAccountInfo === false) {
    console.log(`      ${chalk.dim('⊘ Account updates disabled (updateAccountInfo = false)')}`);
    return {};
  }

  const pagesReason = brandConfig.brand.contact?.email ? null : defaultAddressReason(brandConfig.brand.url);
  if (pagesReason) {
    console.log(`      ${chalk.dim(`⊘ ${pagesReason}`)}`);
    return { output: { stripeAccount: { reason: pagesReason } } };
  }

  let account;
  try {
    account = await api.getAccount();
  } catch (error) {
    console.log(`      ${chalk.yellow('⚠')} Could not read account${chalk.dim(`: ${error.message}`)}`);
    return { status: 'warned', reason: 'could not read the Stripe account', output: { stripeAccount: { error: error.message } } };
  }

  const desired = buildDesiredAccount(brandConfig);
  const updates = getAccountUpdates(account, desired);

  if (!updates) {
    console.log(`      ${chalk.green('✓')} Account settings up to date`);
    return { output: { stripeAccount: { updated: false } } };
  }

  // Log what's changing
  for (const [key, value] of Object.entries(updates.business_profile)) {
    const current = account.business_profile?.[key] || '(none)';
    console.log(`      ${key}: "${current}" ${chalk.dim('→')} "${chalk.cyan(value)}"`);
  }

  if (dryRun) {
    console.log(`      ${chalk.cyan('~')} Would update account settings ${chalk.yellow('[DRY RUN]')}`);
    return { output: { stripeAccount: { planned: 'update' } } };
  }

  try {
    await api.updateAccount(account.id, updates);
    console.log(`      ${chalk.green('✓')} Account settings updated`);
    return { output: { stripeAccount: { updated: true } } };
  } catch (error) {
    // Account updates may not be supported for this account type
    console.log(`      ${chalk.yellow('⚠')} Could not update account${chalk.dim(`: ${error.message}`)}`);
    return { status: 'warned', reason: 'could not update the Stripe account settings', output: { stripeAccount: { error: error.message } } };
  }
};
