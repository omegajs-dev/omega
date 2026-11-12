/**
 * Ensure @omega.js/backend's custom fields exist in SendGrid with the right types.
 *
 * The field list comes from @omega.js/backend's marketing SSOT — its OWN
 * per-provider view of the catalog (#695), the same derivation the backend's
 * contact sync writes through, so what is provisioned here and what is sent
 * there are one list (SendGrid has first/last name built in: its row's
 * nativeFields, left out on both sides). A type mismatch can't be patched in SendGrid, so
 * the field is deleted and recreated. Fields @omega.js/backend doesn't own are
 * never touched.
 */
const chalk = require('chalk').default;
const { emailProviderForRole } = require('@omega.js/config');
const { fieldsFor } = require('../../../lib/backend-marketing.js');
const { dryRunPlan } = require('../../../lib/run-gates.js');

const SENDGRID_FIELDS = fieldsFor(emailProviderForRole('campaigns').id);

// @omega.js/backend type → SendGrid field_type
const TYPE_MAP = { text: 'Text', number: 'Number', date: 'Date' };

module.exports = async function ensureCustomFields(context) {
  const { sendgridApi: api, options = {} } = context;

  const existing = await api.getCustomFields();
  const existingByName = Object.fromEntries(existing.map((f) => [f.name, f]));

  const missing = [];
  const mismatched = [];

  for (const field of SENDGRID_FIELDS) {
    const sgField = existingByName[field.name];

    if (!sgField) {
      missing.push(field);
    } else if (sgField.field_type !== TYPE_MAP[field.type]) {
      mismatched.push({ ...field, existingId: sgField.id, existingType: sgField.field_type });
    }
  }

  if (missing.length === 0 && mismatched.length === 0) {
    console.log(`      ${chalk.green('✓')} All ${SENDGRID_FIELDS.length} custom fields exist`);
    return { output: { customFields: { total: SENDGRID_FIELDS.length, created: 0, recreated: 0 } } };
  }

  if (options.dryRun) {
    const planned = {
      create: missing.map((f) => f.name),
      recreate: mismatched.map((f) => `${f.name} (${f.existingType} → ${TYPE_MAP[f.type]})`),
    };
    return dryRunPlan(`create ${planned.create.length}, recreate ${planned.recreate.length} field(s)`, { output: { customFields: { planned } } });
  }

  // Type mismatches: delete, then recreate alongside the missing ones
  for (const field of mismatched) {
    await api.deleteCustomField(field.existingId);
    console.log(`      ${chalk.yellow('↻')} Deleted ${chalk.cyan(field.name)} ${chalk.dim(`(was ${field.existingType}, need ${TYPE_MAP[field.type]})`)}`);
    missing.push(field);
  }

  for (const field of missing) {
    const created = await api.createCustomField(field.name, TYPE_MAP[field.type]);
    console.log(`      ${chalk.green('✓')} Created ${chalk.cyan(field.name)} ${chalk.dim(`(${created.id})`)}`);
  }

  // Verify everything actually persisted
  const verify = await api.getCustomFields();
  const verifyByName = new Set(verify.map((f) => f.name));
  const stillMissing = SENDGRID_FIELDS.filter((f) => !verifyByName.has(f.name));

  if (stillMissing.length > 0) {
    console.log(`      ${chalk.yellow('⚠')} ${stillMissing.length} field(s) failed to persist: ${chalk.cyan(stillMissing.map((f) => f.name).join(', '))}`);
    return { status: 'warned', reason: `${stillMissing.length} field(s) failed to persist: ${stillMissing.map((f) => f.name).join(', ')}`, output: { customFields: { total: SENDGRID_FIELDS.length, failed: stillMissing.map((f) => f.name) } } };
  }

  return {
    output: {
      customFields: {
        total: SENDGRID_FIELDS.length,
        created: missing.length - mismatched.length,
        recreated: mismatched.length,
      },
    },
  };
};
