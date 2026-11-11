/**
 * Ensure @omega.js/backend's custom fields exist on the Beehiiv publication with the
 * right kinds.
 *
 * The field list comes from @omega.js/backend's marketing SSOT, less the
 * provider row's nativeFields (Beehiiv needs first/last name as custom fields,
 * but tracks country and UTM source natively). Beehiiv matches
 * subscriber values by display name, so fields are diffed by `display`. A
 * kind mismatch can't be patched — the field is deleted and recreated.
 * Fields @omega.js/backend doesn't own are never touched.
 */
const chalk = require('chalk').default;
const { emailProviderForRole } = require('@omega.js/config');
const { fieldsFor } = require('../../../lib/backend-marketing.js');
const { dryRunPlan } = require('../../../lib/run-gates.js');

const BEEHIIV_FIELDS = fieldsFor(emailProviderForRole('newsletter').id);

// @omega.js/backend type → Beehiiv kind
const KIND_MAP = { text: 'string', number: 'integer', date: 'datetime' };

module.exports = async function ensureCustomFields(context) {
  const { beehiivApi: api, serviceData, options = {} } = context;

  const publicationId = serviceData.publicationId;
  if (!publicationId) {
    console.log(chalk.dim('      ⊘ No publication yet — nothing to provision fields on'));
    return {};
  }

  const existing = await api.getCustomFields(publicationId);
  const existingByDisplay = Object.fromEntries(existing.map((f) => [f.display, f]));

  const missing = [];
  const mismatched = [];

  for (const field of BEEHIIV_FIELDS) {
    const bhField = existingByDisplay[field.display];

    if (!bhField) {
      missing.push(field);
    } else if (bhField.kind !== KIND_MAP[field.type]) {
      mismatched.push({ ...field, existingId: bhField.id, existingKind: bhField.kind });
    }
  }

  if (missing.length === 0 && mismatched.length === 0) {
    console.log(`      ${chalk.green('✓')} All ${BEEHIIV_FIELDS.length} custom fields exist`);
    return { output: { customFields: { total: BEEHIIV_FIELDS.length, created: 0, recreated: 0 } } };
  }

  if (options.dryRun) {
    const planned = {
      create: missing.map((f) => f.display),
      recreate: mismatched.map((f) => `${f.display} (${f.existingKind} → ${KIND_MAP[f.type]})`),
    };
    return dryRunPlan(`create ${planned.create.length}, recreate ${planned.recreate.length} field(s)`, { output: { customFields: { planned } } });
  }

  // Kind mismatches: delete, then recreate alongside the missing ones
  for (const field of mismatched) {
    await api.deleteCustomField(publicationId, field.existingId);
    console.log(`      ${chalk.yellow('↻')} Deleted ${chalk.cyan(field.display)} ${chalk.dim(`(was ${field.existingKind}, need ${KIND_MAP[field.type]})`)}`);
    missing.push(field);
  }

  for (const field of missing) {
    await api.createCustomField(publicationId, field.name, field.display, KIND_MAP[field.type]);
    console.log(`      ${chalk.green('✓')} Created ${chalk.cyan(field.display)}`);
  }

  // Verify everything actually persisted
  const verify = await api.getCustomFields(publicationId);
  const verifyByDisplay = new Set(verify.map((f) => f.display));
  const stillMissing = BEEHIIV_FIELDS.filter((f) => !verifyByDisplay.has(f.display));

  if (stillMissing.length > 0) {
    console.log(`      ${chalk.yellow('⚠')} ${stillMissing.length} field(s) failed to persist: ${chalk.cyan(stillMissing.map((f) => f.display).join(', '))}`);
    return { status: 'warned', reason: `${stillMissing.length} field(s) failed to persist: ${stillMissing.map((f) => f.display).join(', ')}`, output: { customFields: { total: BEEHIIV_FIELDS.length, failed: stillMissing.map((f) => f.display) } } };
  }

  return {
    output: {
      customFields: {
        total: BEEHIIV_FIELDS.length,
        created: missing.length - mismatched.length,
        recreated: mismatched.length,
      },
    },
  };
};
