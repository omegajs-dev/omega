/**
 * `omega deploy` at a brand root — D13's brand layer: fan the DELIBERATE
 * publish out over the brand's targets, each in its own framework's hands
 * (each target's own `omega deploy` verb — web sync/dispatch or direct lane,
 * backend `firebase deploy`, desktop release, extension publish; the full
 * per-target contract is docs/shared/deploys.md).
 *
 *   omega deploy                       → every target, backend first
 *   omega deploy --target=backend      → one target (target key or dir name)
 *   omega deploy --target=web,backend  → explicit set
 *   omega deploy --dry-run             → forwarded — each target prints its plan
 *
 * ORDER (#901): the DELIVERY lane first (#678), the same `BOOT_SERVICES` walk
 * an `omega dev` boot runs, so config, assets and certs reach the targets
 * before anything publishes them; then every selected target's own scaffold,
 * called in-process (the workflows it composes have to exist before the
 * snapshot carries them); then the run's ONE delivery; then
 * BACKEND alone; then web, desktop, extension and any custom target
 * CONCURRENTLY. Backend is the only dependency anything has (the site points at
 * its API), and the rest depend on nothing, so they publish together. Every
 * flag but --target= forwards verbatim to each target's framework deploy
 * (--dry-run, --direct, --platforms, …). A failing BACKEND stops the
 * run before the group unless --continue-on-error; inside the group every
 * target runs to completion and the run then exits 1 naming the failed ones. A
 * --target= token matching nothing is an error, never a deploy-everything
 * fallback, and deploys stay deliberate: nothing invokes this command but the
 * human-typed verb (D13).
 *
 * ONE DELIVERY per run (#901): a lane's delivery used to run once per TARGET,
 * which is what kept the targets in single file. It runs HERE now, once: the
 * one lane (#915) pushes this run's snapshot (chained on the previous one) to
 * `omega-deploy`, and every target verb is handed `--snapshot=<sha>` so it
 * dispatches against that very commit instead of overwriting it under its
 * siblings.
 */
const path = require('node:path');
const chalk = require('chalk').default;
const attachLogFile = require('@omega.js/devkit/attach-log-file');
const { resolveDeployLane, dispatchRepo, resolveToken, deliverLane } = require('@omega.js/devkit/deploy');
const { shortSha } = require('@omega.js/devkit/deploy-snapshot');

const { runManage } = require('../manage.js');
const { resolveBrandRoot, discoverTargets, loadBrand } = require('../lib/brand.js');
const { resolveTargetRun, resolveTargetScaffold } = require('../lib/framework-bin.js');
const { runCommand } = require('../lib/run-command.js');
const { PICKER_FLAG, assertPickerFlags, selectTargets, buildForwardedFlags } = require('../lib/target-selection.js');

/**
 * The run's ONE delivery (#901): the lane resolved once at the brand root, and
 * devkit's `deliverLane` run once for the whole fan-out.
 *
 * It refuses a checkout behind the repo's default branch, pushes the composed
 * workflow files there when they differ, packs the brand's linked frameworks,
 * pushes this run's snapshot (chained on the previous one) to `omega-deploy`
 * and puts the tree back
 * ([#915](https://github.com/Omega-JS-Stack/omega/issues/915)); the sha it
 * returns is what every target verb of this run dispatches against.
 *
 * @param {object} options - Options.
 * @param {string} options.brandRoot - The brand root being deployed.
 * @param {string} options.dir - A selected target's dir: the lane is the
 *   brand's, and this is where the resolution starts from.
 * @returns {Promise<{ lane: object, sha: string|null }>} the lane this run took
 *   and the sha it snapshotted to, null when the brand has no repo to snapshot
 */
async function deliverRunLane({ brandRoot, dir }) {
  const lane = resolveDeployLane({ dir });
  const logger = { log: (line) => console.log(chalk.dim(`  ${line}`)) };

  // The snapshot's address is the BRAND's repo, from its config; a brand
  // outside git delivers nothing at all, so it needs neither address nor token.
  //
  // Read for PRODUCTION (#856), like every target's dispatch: the snapshot is a
  // production artifact, and composing this machine's environment instead would
  // push it at whatever repo a `development` overlay names.
  const snapshot = lane.mode === 'snapshot';
  const { owner, repo } = snapshot ? dispatchRepo(loadBrand(brandRoot, { environment: 'production' }).config) : {};

  const { sha } = await deliverLane({
    lane,
    owner,
    repo,
    ref: lane.ref,
    token: snapshot ? resolveToken() : undefined,
    logger,
  });

  if (sha) {
    console.log(chalk.dim(`  Snapshot pushed: ${owner}/${repo} ${lane.ref} @ ${shortSha(sha)}`));
  }

  return { lane, sha };
}

module.exports = async (options = {}) => {
  assertPickerFlags(options);

  const brandRoot = resolveBrandRoot(process.cwd());
  if (!brandRoot) {
    console.error(chalk.red(`✗ Not inside a brand monorepo (no config/omega.json5 up the tree): run it at a brand root, with --${PICKER_FLAG}=<name> to pick targets.`));
    process.exitCode = 1;
    return;
  }

  // Tee the whole fan-out — delivery lane included — to
  // <brandRoot>/logs/deploy.log (#623): the publish verdict on disk. Only the
  // backend keeps its own dist/deploy.log; this file is the one full record.
  attachLogFile(path.join(brandRoot, 'logs', 'deploy.log'));

  const targets = discoverTargets(brandRoot).filter((entry) => entry.target || entry.custom);
  const { selected } = selectTargets({ targets, target: options[PICKER_FLAG] });

  if (selected.length === 0) {
    // Only an empty brand reaches here: a picker token that named nothing
    // already stopped the run in the selector (#780).
    console.error(chalk.red('✗ This brand has no targets under targets/ — nothing deployed.'));
    process.exitCode = 1;
    return;
  }

  const forwarded = buildForwardedFlags(options);
  const continueOnError = !!(options['continue-on-error'] || options.continueOnError);
  const dryRun = !!(options['dry-run'] || options.dryRun);

  console.log(chalk.bold(`\nOMEGA brand deploy: ${path.basename(brandRoot)} ${chalk.dim(`(${selected.map((entry) => entry.name).join(' → ')})`)}`));

  // ─── Delivery lane, once, before the fan-out ───────────────────────────────
  // Brand inputs (config, assets, certs) reach a target through ONE step
  // (#678), and a deploy is one of its two triggers: the lane `omega dev`
  // boots is asked for BY NAME here, so the service list can only ever be
  // config.js's BOOT_SERVICES — never a second copy that drifts from it. A
  // publish must not ship inputs a manage run happened to be current on.
  console.log(chalk.cyan(`\n─── delivery lane ${chalk.dim('(brand inputs → targets)')} ───`));
  const delivery = await runManage(brandRoot, { lane: 'boot', dryRun });
  if (delivery.hasErrors) {
    console.error(chalk.red('\n✗ The delivery lane reported errors — nothing deployed (fix them above, then deploy again).'));
    process.exitCode = 1;
    return;
  }

  // ─── Scaffold every selected target, before the delivery (#901) ───────────
  // A target's scaffold (its framework's `ensureTarget`, called HERE in-process
  // through the `./ensure-target` subpath every framework exposes) is what
  // COMPOSES that target's workflow into the brand root, and the snapshot below
  // is what carries the brand folder to the runner. Scaffolding only inside
  // each target's own deploy verb put it after the push: a workflow re-rendered
  // this run would not ride this run's snapshot, and a target's FIRST deploy
  // would find no workflow on the mirror at all. There is no verb and no flag
  // for it: a deploy always scaffolds first. Sequential, in TARGET_ORDER, and
  // short. The target verbs scaffold again on their way past (idempotent),
  // which is why the push lane takes this same flow rather than a branch of its
  // own.
  console.log(chalk.cyan(`\n─── scaffold ${chalk.dim('(targets → brand root)')} ───`));
  for (const entry of selected) {
    const run = resolveTargetScaffold(entry);

    // A custom target has no framework scaffold: not a failure, and no reason
    // to hold up the push.
    if (run.kind === 'skip') {
      console.log(chalk.dim(`⊘ ${entry.name}: ${run.detail}`));
      continue;
    }

    // A dry run scaffolds for real: every verb does, and the scaffold writes
    // nothing a deploy would not have written anyway.
    let result;
    try {
      if (run.kind === 'error') throw new Error(run.detail);

      result = await run.ensureTarget({
        projectDir: entry.path,
        log: (line) => console.log(chalk.dim(`  [${entry.name}] ${line}`)),
        warn: (line) => console.warn(chalk.yellow(`  [${entry.name}] ${line}`)),
      });
    } catch (error) {
      console.error(chalk.red(`\n✗ ${entry.name} scaffold failed (${error.message}): nothing was pushed and nothing deployed.`));
      process.exitCode = 1;
      return;
    }

    // The ensure prints what it healed, so a run that healed something has said
    // it already; a run that changed nothing would otherwise print nothing.
    if (result.written.length + result.merged.length + result.changed.length === 0) {
      console.log(chalk.dim(`  [${entry.name}] scaffold up to date`));
    }
  }

  // ─── The run's ONE delivery, before any target (#901) ──────────────────
  // A dry run and a --direct run both deliver nothing: the first promises to
  // send nothing at all, and the second publishes from this machine without
  // ever dispatching, so neither has code to carry to GitHub for the targets.
  const runDelivery = dryRun || options.direct
    ? { lane: null, sha: null }
    : await deliverRunLane({ brandRoot, dir: selected[0].path });

  const targetFlags = [...forwarded];
  if (runDelivery.sha) {
    // The delivery just ran, once, above. `--snapshot=<sha>` is the root's word
    // to each target verb that the push is done: left to themselves the group's
    // targets would each push a snapshot of their own (chained on the previous
    // one) to `omega-deploy` while their siblings dispatch against it. Nobody
    // types it.
    targetFlags.push(`--snapshot=${runDelivery.sha}`);
  }

  // ─── Execute: backend alone, then the rest together ────────────────────
  const summary = [];
  let failed = false;

  /**
   * Run one target's deploy and report what it did. A prefixed run pipes the
   * child's output behind `[<target>] `, which is how the concurrent group
   * stays readable.
   *
   * @param {object} entry - The discovered target.
   * @param {boolean} prefixed - Whether this run is part of the group.
   * @returns {Promise<object>} its summary row, flagged `skipped` when it stepped aside
   */
  const runTarget = async (entry, prefixed) => {
    const label = `[${selected.indexOf(entry) + 1}/${selected.length}] ${entry.name}`;
    const run = resolveTargetRun(entry, 'deploy', targetFlags, { dryRun });

    // A custom target that declares no deploy script steps aside loudly —
    // there is nothing to publish and nothing broken (#603)
    if (run.kind === 'skip') {
      console.log(chalk.dim(`\n⊘ ${label}: ${run.detail} — skipped`));
      return { name: entry.name, ok: true, skipped: true, detail: run.detail };
    }

    // Its script cannot be handed --dry-run, so the dry run stops at the plan
    if (run.kind === 'plan') {
      console.log(chalk.dim(`\n⊘ ${label}: dry run — ${run.detail}`));
      return { name: entry.name, ok: true, skipped: true, detail: run.detail };
    }

    if (run.kind === 'error') {
      console.log(chalk.red(`\n✗ ${label}: ${run.detail}`));
      return { name: entry.name, ok: false, detail: run.detail };
    }

    console.log(chalk.cyan(`${`\n─── ${label} ${chalk.dim(`(${run.framework || 'custom'})`)} — ${run.label}`.trimEnd()} ───`));
    const result = await runCommand(run.command, run.args, entry.path, undefined, prefixed ? { prefix: entry.name } : {});

    return { name: entry.name, ok: result.success, detail: result.error };
  };

  // The API goes live before the surfaces that call it, and a broken one is no
  // base for them: a failing backend stops the run before the group.
  const gate = selected.filter((entry) => entry.target === 'backend');
  const group = selected.filter((entry) => entry.target !== 'backend');
  let stopped = false;

  for (const entry of gate) {
    const record = await runTarget(entry, false);
    summary.push(record);
    if (!record.ok) {
      failed = true;
      if (!continueOnError) {
        console.error(chalk.red(`\n✗ ${entry.name} deploy failed: stopping before the rest (the surfaces point at this API; --continue-on-error overrides)`));
        stopped = true;
        break;
      }
    }
  }

  // Web, desktop, extension and any custom target depend on nothing but the
  // backend, so they publish TOGETHER (#901), each line of their output behind
  // the name of the target it came from. Every one of them runs to completion:
  // a sibling's failure never leaves another target half published.
  if (!stopped && group.length > 0) {
    console.log(chalk.cyan(`\n─── ${group.length > 1 ? `${group.map((entry) => entry.name).join(', ')} deploy together` : `${group[0].name} deploys`} ───`));
    const records = await Promise.all(group.map((entry) => runTarget(entry, true)));

    for (const record of records) {
      summary.push(record);
      if (!record.ok) failed = true;
    }

    const fell = records.filter((record) => !record.ok).map((record) => record.name);
    if (fell.length > 0) {
      console.error(chalk.red(`\n✗ ${fell.join(', ')} failed: every other target of the group still ran to the end`));
    }
  }

  // ─── Summary + aggregate exit ──────────────────────────────────────────────
  console.log(chalk.bold('\nDeploy summary'));
  for (const entry of summary) {
    if (entry.skipped) {
      console.log(chalk.dim(`  ⊘ ${entry.name}: ${entry.detail}`));
      continue;
    }
    console.log(entry.ok
      ? `  ${chalk.green('✓')} ${entry.name}`
      : `  ${chalk.red('✗')} ${entry.name} ${chalk.dim(`— ${entry.detail}`)}`);
  }
  const unattempted = stopped ? selected.length - summary.length : 0;
  if (unattempted > 0) {
    console.log(chalk.dim(`  ⊘ ${unattempted} target${unattempted === 1 ? '' : 's'} not attempted after the failure`));
  }

  if (failed) {
    process.exitCode = 1;
  }
};

// Re-exported for readers that came to the deploy command for them — the one
// home is lib/target-selection.js.
module.exports.selectTargets = selectTargets;
module.exports.buildForwardedFlags = buildForwardedFlags;
