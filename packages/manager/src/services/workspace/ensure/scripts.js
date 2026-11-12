/**
 * Ensure the brand's package.json scripts convention — the root AND each
 * framework target's (npm scripts put node_modules/.bin on PATH, so plain
 * `omega` resolves there). Script VALUES only — no other key or consumer
 * content is ever touched. Idempotent: a converged file rewrites nothing.
 *
 * Root: `deploy: 'omega deploy'` guaranteed plus the start/manage migration
 * (package-scripts.js). Targets: every script the framework writes (the verb
 * table's `omega <verb>` scripts, its manifest's `projectScripts` merged over
 * them) is FRAMEWORK-owned and is rewritten to the default here, exactly as
 * that framework's ensureTarget does on every verb run:
 * one policy, two writers, so a consumer customizes behavior through hook
 * points and never by editing a standard script. The walk running it at all
 * is the onboard→dev cycle break (#675): the dev fan-out reaches those verbs
 * THROUGH these scripts, so a freshly scaffolded target needs them before any
 * verb has ever run. Keys the consumer added are never touched.
 *
 * The exceptions: a custom TARGET maps to no framework at all (#603), so it
 * is skipped whole; a custom-server backend is skipped PER KEY: the
 * scripts running a verb its mode refuses are the brand's own, named by the
 * framework's scaffold entry (`CUSTOM_OWNED_SCRIPTS`).
 */
const { join } = require('node:path');
const jetpack = require('fs-jetpack');
const chalk = require('chalk').default;

const { projectScripts } = require('@omega.js/devkit/verb-scripts');
const { healPackageScripts, syncTargetScripts } = require('../../../lib/package-scripts.js');
const { resolveFrameworkPackage, resolveTargetCustomOwned } = require('../../../lib/framework-bin.js');
const { targetType } = require('@omega.js/config');
const { dryRunPlan } = require('../../../lib/run-gates.js');
const { writeJson } = require('@omega.js/devkit/write-json');

module.exports = async ({ brandRoot, targets = [], options = {} }) => {
  const pkgPath = join(brandRoot, 'package.json');
  const raw = jetpack.read(pkgPath);
  if (!raw) {
    console.log(`      ${chalk.dim('⊘ no root package.json yet (the structure operation scaffolds it)')}`);
    return { output: { scripts: 'missing' } };
  }

  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (e) {
    console.log(`      ${chalk.yellow('⚠')} Root package.json doesn't parse (${e.message}) — fix it by hand`);
    return { status: 'warned', reason: "root package.json doesn't parse", output: { scripts: 'unparseable' } };
  }

  const { scripts, changes } = healPackageScripts(pkg);
  // What the walk could not read, carried into the run summary below
  const warnings = [];

  const targetWork = [];
  for (const entry of targets) {
    // A custom target's scripts are the brand's own contract (#603) — no
    // framework declares them, so there is nothing to sync against
    if (!entry.target) continue;

    const framework = targetType(entry.target)?.framework;
    const resolved = framework ? resolveFrameworkPackage(entry.path, framework) : null;
    // Not installed yet (pre-`npm install`): nothing to fill from; the next walk heals it
    if (!resolved) continue;

    const manifestPath = join(entry.path, 'package.json');
    const targetRaw = jetpack.read(manifestPath);
    if (!targetRaw) continue;

    let targetPkg;
    try {
      targetPkg = JSON.parse(targetRaw);
    } catch (e) {
      console.log(`      ${chalk.yellow('⚠')} ${entry.dir}/package.json doesn't parse (${e.message}) — fix it by hand`);
      warnings.push(`${entry.dir}/package.json doesn't parse`);
      continue;
    }

    // A custom-server backend owns the keys whose verbs its mode refuses; the
    // framework names WHICH, so no list lives here
    let brandOwnedKeys = [];
    if (entry.projectType === 'custom') {
      const owned = resolveTargetCustomOwned(entry);
      if (owned.kind !== 'framework' || !Array.isArray(owned.CUSTOM_OWNED_SCRIPTS)) {
        const reason = owned.detail || `${owned.framework} names no CUSTOM_OWNED_SCRIPTS`;
        console.log(`      ${chalk.yellow('⚠')} ${entry.dir}: cannot read its brand-owned scripts (${reason}), left untouched`);
        warnings.push(`${entry.dir} brand-owned scripts unreadable`);
        continue;
      }
      brandOwnedKeys = owned.CUSTOM_OWNED_SCRIPTS;
    }

    const synced = syncTargetScripts(targetPkg, projectScripts(resolved.pkg), brandOwnedKeys);
    if (synced.changes.length) targetWork.push({ entry, manifestPath, targetPkg, synced });
  }

  if (!changes.length && !targetWork.length && !warnings.length) {
    console.log(`      ${chalk.green('✓')} Root + target scripts present`);
    return null;
  }

  // A warnings-only run has nothing to plan (a target manifest that will not
  // parse): it falls through to the warned return below, so `--dry-run` reports
  // the same status a real run would.
  if (options.dryRun && (changes.length || targetWork.length)) {
    const parts = [];
    if (changes.length) parts.push(`heal root scripts (${changes.join(', ')})`);
    for (const work of targetWork) {
      parts.push(`sync ${work.entry.dir} scripts (${work.synced.changes.join(', ')})`);
    }
    return dryRunPlan(parts.join('; '), {
      output: {
        ...(changes.length ? { scripts: 'planned' } : {}),
        ...(targetWork.length ? { targetScripts: 'planned' } : {}),
      },
    });
  }

  const output = {};

  if (changes.length) {
    pkg.scripts = scripts;
    writeJson(pkgPath, pkg);
    console.log(`      ${chalk.green('✓')} Healed root scripts \`${changes.join('`, `')}\``);
    output.scripts = { changed: changes };
  }

  for (const work of targetWork) {
    work.targetPkg.scripts = work.synced.scripts;
    writeJson(work.manifestPath, work.targetPkg);
    // The skipped keys are named per key: a custom-server backend's own verbs
    // are absent by design, not by omission
    const brandOwned = work.synced.skipped.length ? chalk.dim(` (brand-owned, untouched: ${work.synced.skipped.join(', ')})`) : '';
    console.log(`      ${chalk.green('✓')} Synced ${work.entry.dir} scripts \`${work.synced.changes.join('`, `')}\`${brandOwned}`);
    output.targetScripts = output.targetScripts || {};
    output.targetScripts[work.entry.name] = work.synced.changes;
  }

  return {
    ...(warnings.length ? { status: 'warned', reason: warnings.join('; ') } : {}),
    output,
  };
};
