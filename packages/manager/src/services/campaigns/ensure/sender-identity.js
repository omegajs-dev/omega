/**
 * Ensure one verified SendGrid sender per row of @omega.js/backend's SENDERS.
 *
 * Single Sends require a registered sender (not an inline from address), so
 * every sender the backend names gets one: the row's address at the
 * contact-email domain, the row's from name, and the nickname
 * `{brand name} ({key})`. They auto-verify because domain-auth runs first.
 * The backend resolves the sender id at runtime by from_email.
 *
 * CAN-SPAM requires the brand's own physical mailing address (brand.address),
 * asked for once per run and warned about only when nobody can be asked.
 */
const chalk = require('chalk').default;
const { input } = require('@omega.js/devkit/prompt');
const { canPrompt, dryRunPlan } = require('../../../lib/run-gates.js');
const { confirmSetup, landValue } = require('../../../lib/config-flow.js');
const { BACKEND_SENDERS, senderFrom } = require('../../../lib/backend-marketing.js');

// The five fields brand.address carries. Only the three SendGrid cannot
// create a sender without are required: an address with no region or postal
// code is a real address in plenty of countries.
const ADDRESS_FIELDS = [
  { key: 'line1', message: 'Street address:', required: true },
  { key: 'city', message: 'City:', required: true },
  { key: 'region', message: 'State / region:' },
  { key: 'postalCode', message: 'Postal code:' },
  { key: 'country', message: 'Country:', required: true },
];

/**
 * Ask for the brand's mailing address and land it as ONE brand.address object.
 * Five fields behind ONE gate, since asking the Provide / Skip / Disable
 * question per field would be the same question five times. The campaigns
 * service already gated on its API key, so this gate is about the address.
 *
 * @param {Object} context - Handler context.
 * @returns {Promise<Object|null>} The landed address, or null when the user
 *   stepped aside or left a required field empty.
 */
async function askBrandAddress(context) {
  const action = await confirmSetup(context, {
    label: 'Mailing address (CAN-SPAM)',
    instructions: ['Every marketing email must carry a physical mailing address; it lands in brand.address'],
    disablePath: 'marketing.campaigns.enabled',
  });
  if (action !== 'yes') {
    return null;
  }

  const address = {};
  for (const field of ADDRESS_FIELDS) {
    const value = (await input({ message: field.message }) || '').trim();
    if (!value) {
      if (field.required) {
        return null;
      }
      continue;
    }
    address[field.key] = value;
  }

  landValue(context, 'brand.address', address);
  return address;
}

/**
 * Decide one row's action against the account's senders. A verified sender
 * at the row's address is kept whatever its nickname; the nickname is the
 * managed handle (unique per SendGrid account), so a sender holding it at
 * another address is stale (contact.email changed) and would 400 the create.
 *
 * @param {Object} row - `{ key, email, name, nickname }`.
 * @param {Object[]} senders - The account's verified senders.
 * @returns {Object} The row plus its `match`, `stale` and `action`.
 */
function planRow(row, senders) {
  const match = senders.find((s) => s.from_email === row.email);
  const stale = senders.find((s) => s.nickname === row.nickname && s.from_email !== row.email);

  if (match && match.verified !== false) {
    return { ...row, match, action: 'keep' };
  }

  const action = match ? 'recreate-unverified-sender' : stale ? 'replace-stale-nickname-sender' : 'create-sender';
  return { ...row, match, stale, action };
}

/**
 * Make one row's sender: an unverified leftover at its address is deleted and
 * made again, a stale unverified one under its nickname is deleted, and a
 * stale verified one warns for this row only.
 *
 * @param {Object} api - The SendGrid client.
 * @param {Object} plan - A planRow result whose action is not `keep`.
 * @param {Object} brand - `{ brandName, contactEmail, address }`.
 * @returns {Promise<{ identity: Object, reason?: string }>} The row's output and its warn reason.
 */
async function ensureRow(api, plan, { brandName, contactEmail, address }) {
  if (plan.match) {
    await api.deleteVerifiedSender(plan.match.id);
    console.log(`      ${chalk.yellow('↻')} Deleted unverified sender ${chalk.cyan(plan.email)} for recreation`);
  }

  if (plan.stale) {
    if (plan.stale.verified !== false) {
      console.log(`      ${chalk.yellow('⚠')} Verified sender ${chalk.cyan(plan.stale.from_email)} already uses the nickname ${chalk.cyan(plan.nickname)}: delete it in SendGrid or align brand.contact.email, then rerun`);
      return { identity: { fromEmail: plan.email, staleNickname: plan.stale.from_email }, reason: 'a verified sender already uses its nickname' };
    }
    await api.deleteVerifiedSender(plan.stale.id);
    console.log(`      ${chalk.yellow('↻')} Deleted stale unverified sender ${chalk.cyan(plan.stale.from_email)}: the contact domain changed`);
  }

  const sender = await api.createVerifiedSender({
    nickname: plan.nickname,
    fromEmail: plan.email,
    fromName: plan.name,
    replyToEmail: contactEmail,
    replyToName: brandName,
    address: {
      street: address.line1,
      street2: address.line2 || '',
      city: address.city,
      state: address.region,
      zip: address.postalCode,
      country: address.country,
    },
  });

  if (sender.verified === false) {
    console.log(`      ${chalk.yellow('⚠')} Created sender ${chalk.cyan(plan.email)} but it did not auto-verify: ensure domain authentication is valid, then rerun`);
    return { identity: { id: sender.id, fromEmail: plan.email, verified: false }, reason: 'the created sender did not auto-verify' };
  }

  console.log(`      ${chalk.green('✓')} Created verified sender ${chalk.cyan(plan.email)} ${chalk.dim(`(id: ${sender.id})`)}`);
  return { identity: { id: sender.id, fromEmail: plan.email, verified: true } };
}

module.exports = async function ensureSenderIdentity(context) {
  const { sendgridApi: api, brandConfig, options = {} } = context;

  const brandName = brandConfig.brand.name;
  const contactEmail = brandConfig.brand?.contact?.email;
  const contactDomain = contactEmail?.split('@')[1];

  if (!contactDomain) {
    console.log(chalk.dim('      ⊘ No brand.contact.email configured: nothing to register'));
    return {};
  }

  const senders = await api.getVerifiedSenders();
  const plans = BACKEND_SENDERS.map((key) => planRow({
    key,
    ...senderFrom(key, { brandName, domain: contactDomain }),
    nickname: `${brandName} (${key})`,
  }, senders));

  const senderIdentities = {};
  for (const plan of plans.filter((p) => p.action === 'keep')) {
    console.log(`      ${chalk.green('✓')} Verified sender ${chalk.cyan(plan.email)} ${chalk.dim(`(id: ${plan.match.id})`)}`);
    senderIdentities[plan.key] = { id: plan.match.id, fromEmail: plan.email, verified: true };
  }

  const pending = plans.filter((p) => p.action !== 'keep');
  if (!pending.length) {
    return { output: { senderIdentities } };
  }

  // The address is the brand's own (no company default to fall back on), so
  // a run that can ask ASKS for it here, once for every row it makes.
  const complete = (candidate) => Boolean(candidate?.line1 && candidate?.city && candidate?.country);

  let address = brandConfig.brand?.address;
  if (!complete(address) && canPrompt(options)) {
    address = await askBrandAddress(context);
  }

  if (!complete(address)) {
    const emails = pending.map((plan) => plan.email).join(', ');
    console.log(`      ${chalk.yellow('⚠')} No sender ${chalk.cyan(emails)} yet, and CAN-SPAM requires a physical mailing address`);
    console.log(`      ${chalk.dim('→')} Set brand.address (line1, city, region, postalCode, country) in omega.json5, then rerun`);
    pending.forEach((plan) => {
      senderIdentities[plan.key] = { fromEmail: plan.email, missingAddress: true };
    });
    return { status: 'warned', reason: 'no sender yet: brand.address is required by CAN-SPAM', output: { senderIdentities } };
  }

  if (options.dryRun) {
    pending.forEach((plan) => {
      dryRunPlan(`${plan.action} (${plan.email})`);
      senderIdentities[plan.key] = { planned: plan.action, fromEmail: plan.email };
    });
    return { output: { senderIdentities } };
  }

  const reasons = [];
  for (const plan of pending) {
    const { identity, reason } = await ensureRow(api, plan, { brandName, contactEmail, address });
    senderIdentities[plan.key] = identity;
    if (reason) {
      reasons.push(`${plan.key}: ${reason}`);
    }
  }

  if (reasons.length) {
    return { status: 'warned', reason: reasons.join('; '), output: { senderIdentities } };
  }
  return { output: { senderIdentities } };
};
