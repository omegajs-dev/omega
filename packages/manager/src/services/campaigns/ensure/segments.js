/**
 * Ensure @omega.js/backend's segments exist in SendGrid with the right query_dsl.
 *
 * The segment list comes from @omega.js/backend's marketing SSOT; each one's
 * query_dsl is rebuilt from its conditions and compared against the live
 * segment (the list endpoint omits query_dsl, so present segments cost one
 * detail read each). Stale segments are PATCHed in place, falling back to
 * delete + recreate when SendGrid rejects the PATCH. Orphaned `__temp_`
 * segments (leaked by @omega.js/backend's brand-scoped campaign sends on crash) are swept.
 * Segments @omega.js/backend doesn't own are never touched.
 */
const chalk = require('chalk').default;
const { emailProviderForRole } = require('@omega.js/config');
const { segmentsFor } = require('../../../lib/backend-marketing.js');
const { buildQueryDsl } = require('../lib/segment-query.js');
const { dryRunPlan } = require('../../../lib/run-gates.js');

const SENDGRID_SEGMENTS = segmentsFor(emailProviderForRole('campaigns').id);

module.exports = async function ensureSegments(context) {
  const { sendgridApi: api, options = {} } = context;

  const existing = await api.getSegments();

  const orphans = existing.filter((s) => s.name.startsWith('__temp_'));
  const existingByName = Object.fromEntries(
    existing.filter((s) => !s.name.startsWith('__temp_')).map((s) => [s.name, s]),
  );

  // Rebuild every segment's query and diff against the live detail
  const missing = [];
  const stale = [];

  for (const segment of SENDGRID_SEGMENTS) {
    const queryDsl = buildQueryDsl(segment.conditions, segment.logic);
    const sgSegment = existingByName[segment.name];

    if (!sgSegment) {
      missing.push({ ...segment, queryDsl });
      continue;
    }

    const full = await api.getSegment(sgSegment.id);
    if (full.query_dsl !== queryDsl) {
      stale.push({ ...segment, queryDsl, existingId: sgSegment.id });
    }
  }

  if (orphans.length === 0 && missing.length === 0 && stale.length === 0) {
    console.log(`      ${chalk.green('✓')} All ${SENDGRID_SEGMENTS.length} segments exist`);
    return { output: { segments: { total: SENDGRID_SEGMENTS.length, created: 0, updated: 0, orphansSwept: 0 } } };
  }

  if (options.dryRun) {
    const planned = {
      create: missing.map((s) => s.name),
      update: stale.map((s) => s.name),
      sweepOrphans: orphans.length,
    };
    return dryRunPlan(`create ${planned.create.length}, update ${planned.update.length}, sweep ${planned.sweepOrphans} orphan(s)`, { output: { segments: { planned } } });
  }

  // Sweep leaked __temp_ segments
  for (const orphan of orphans) {
    await api.deleteSegment(orphan.id);
  }
  if (orphans.length > 0) {
    console.log(`      ${chalk.yellow('↻')} Swept ${orphans.length} orphaned __temp_ segment(s)`);
  }

  // Stale: PATCH in place, fall back to delete + recreate
  let updated = 0;
  for (const segment of stale) {
    try {
      await api.updateSegment(segment.existingId, segment.name, segment.queryDsl);
      console.log(`      ${chalk.green('↻')} Updated ${chalk.cyan(segment.display)} in place`);
      updated += 1;
    } catch (patchError) {
      await api.deleteSegment(segment.existingId);
      missing.push(segment);
      console.log(`      ${chalk.yellow('↻')} Recreating ${chalk.cyan(segment.display)} ${chalk.dim(`(PATCH rejected: ${patchError.message})`)}`);
    }
  }

  for (const segment of missing) {
    const created = await api.createSegment(segment.name, segment.queryDsl);
    console.log(`      ${chalk.green('✓')} Created ${chalk.cyan(segment.display)} ${chalk.dim(`(${created.id})`)}`);
  }

  // Verify everything actually persisted
  const verify = await api.getSegments();
  const verifyByName = new Set(verify.map((s) => s.name));
  const stillMissing = SENDGRID_SEGMENTS.filter((s) => !verifyByName.has(s.name));

  if (stillMissing.length > 0) {
    console.log(`      ${chalk.yellow('⚠')} ${stillMissing.length} segment(s) failed to persist: ${chalk.cyan(stillMissing.map((s) => s.display).join(', '))}`);
    return { status: 'warned', reason: `${stillMissing.length} segment(s) failed to persist: ${stillMissing.map((s) => s.name).join(', ')}`, output: { segments: { total: SENDGRID_SEGMENTS.length, failed: stillMissing.map((s) => s.name) } } };
  }

  return {
    output: {
      segments: {
        total: SENDGRID_SEGMENTS.length,
        created: missing.length,
        updated,
        orphansSwept: orphans.length,
      },
    },
  };
};
