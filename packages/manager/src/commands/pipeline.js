/**
 * `omega-manager pipeline` — the brand's full-pipeline LIVE test (Ian:
 * "automate running the manager CLI as the test — the playground exists
 * to shit-test the full pipeline").
 *
 * Spawns the REAL manage cycle with stdin detached, so no prompt can ever
 * fire (isInteractive() reads stdin's TTY) — every answer must already be
 * seeded in its non-interactive home: omega.json5 (choices), the brand
 * .env (secrets), the Google token cache (scopes), state (latches). Then
 * asserts the machine-readable run record (.omega/runs/{ts}.json):
 *
 *  - Any service at status "error" fails the pipeline.
 *  - CORE services (workspace, repo, edge, domain, firebase,
 *    testing) must RUN green (success/warned) — a core skip means a
 *    broken seed (missing token, unconfigured section) and fails.
 *  - Everything else may succeed, warn, or skip; skips are listed with
 *    reasons for visibility, not failure.
 *  - `--require=a,b` promotes more services into the core set (tighten as
 *    seeds land: --require=sendgrid,account,captcha).
 *  - `--service=<name>` narrows the child run to one service; the
 *    core-presence check only applies to full runs.
 *  - `--dry-run` forwards to the child (plan-only pass, still asserted).
 *  - `--deploy=web,backend,desktop,extension` runs the DEPLOY legs after
 *    the service cycle (web = `omega deploy --direct` gh-pages push;
 *    backend = `omega deploy --direct`, a REAL functions deploy from this
 *    machine rather than the CI dispatch its bare verb now takes). Off by
 *    default; each leg lands in
 *    the scorecard as `deploy:<target>` and an exit-nonzero leg fails the
 *    pipeline. desktop/extension are PUBLISH legs (GH release flow / store
 *    CI dispatch — both Ian-gated): without `--publish` they record as a
 *    gated skip instead of running.
 *  - After the deploy legs, the VERIFY sweep runs automatically for whatever
 *    was deployed (web → site + domain + cloudflare), landing as
 *    `verify:<name>` rows — a failed check fails the run exactly like a
 *    failed deploy leg. `--verify` alone runs the sweep without deploying
 *    (the post-hoc "is it still up?" pass); a dry run, a demo-* brand, and a
 *    brand with no cloud project all record gated skips and never touch the
 *    network (lib/verify-live.js).
 *
 * This spends real API calls and reconciles real infrastructure — run it
 * on demand, SPARINGLY. It is deliberately NOT part of `npm test` or CI.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const chalk = require('chalk').default;
const attachLogFile = require('@omega.js/devkit/attach-log-file');

const { resolveBrandRoot, loadBrand, discoverTargets } = require('../lib/brand.js');
const { TARGET_TYPE_ROWS, targetType } = require('@omega.js/config');
const { runVerifyLegs } = require('../lib/verify-live.js');

// A type row's deploy mode → the command run in that target's dir. The pipeline
// proves the brand deploys from THIS machine, so a 'direct' target passes
// `--direct`; a 'verb' target has no deploy script and runs the local bin.
const DEPLOY_COMMANDS = {
  direct: ['npm', 'run', 'deploy', '--', '--direct'],
  verb: ['npx', 'omega', 'deploy'],
};

/**
 * The deploy command a target type runs in its dir, from its row's mode.
 *
 * @param {string} target - A target type (`web`, `desktop`, …).
 * @returns {string[]|null} The argv, or null for a type that has no deploy.
 */
function deployLeg(target) {
  const row = targetType(target);
  return row && row.deploy ? DEPLOY_COMMANDS[row.deploy] : null;
}

// Services that must RUN green on a full pipeline pass — these are the
// provisioning spine; a skip here means a seed is missing, not a choice.
// search/campaigns/account/captcha graduated into the spine once
// their seeds converged (cp116–120): a skip there is a regression now.
const CORE_SERVICES = [
  'workspace', 'repo', 'edge', 'domain', 'cloud', 'testing',
  'search', 'campaigns', 'account', 'captcha',
];

const STATUS_ICONS = { success: chalk.green('✓'), warned: chalk.yellow('⚠'), skipped: chalk.dim('⊘'), error: chalk.red('✗') };

/**
 * Which targets the verify sweep covers: whatever was just deployed, or —
 * with `--verify` and no deploy — every target that HAS a live surface (the
 * post-hoc "is it still up?" check).
 *
 * @param {object} argv - Parsed CLI args.
 * @param {string[]} deployTargets - Targets whose deploy legs just ran.
 * @returns {string[]}
 */
function resolveVerifyTargets(argv, deployTargets) {
  if (deployTargets.length > 0) {
    return deployTargets;
  }
  return argv.verify ? TARGET_TYPE_ROWS.filter((row) => row.verify.length > 0).map((row) => row.id) : [];
}

/**
 * Judge one run record against the pipeline policy.
 *
 * @param {object} runRecord - Parsed .omega/runs/{ts}.json ({ services: [{ service, status, reason?, error? }] }).
 * @param {object} [options] - { require: string[] (extra core services), scoped: boolean (single-service child run) }.
 * @returns {{ pass: boolean, failures: string[], skips: string[], rows: object[] }}
 */
function evaluatePipeline(runRecord, options = {}) {
  const services = runRecord?.services || [];
  const core = new Set([...CORE_SERVICES, ...(options.require || [])]);
  const failures = [];
  const skips = [];
  const rows = [];

  const byName = new Map(services.map((entry) => [entry.service, entry]));

  for (const entry of services) {
    rows.push(entry);

    if (entry.status === 'error') {
      failures.push(`${entry.service}: error${entry.error ? ` — ${entry.error}` : ''}`);
    } else if (entry.status === 'skipped') {
      if (core.has(entry.service)) {
        failures.push(`${entry.service}: CORE service skipped${entry.reason ? ` — ${entry.reason}` : ''} (seed missing)`);
      } else {
        skips.push(`${entry.service}${entry.reason ? ` — ${entry.reason}` : ''}`);
      }
    }
  }

  // Full runs must actually contain every core service
  if (!options.scoped) {
    for (const name of core) {
      if (!byName.has(name)) {
        failures.push(`${name}: CORE service missing from the run record`);
      }
    }
  }

  return { pass: failures.length === 0, failures, skips, rows };
}

/**
 * Newest run record written at/after `since` for the brand.
 *
 * @param {string} brandRoot - Brand root directory.
 * @param {number} since - ms timestamp; records older than this are ignored.
 * @returns {{ file: string, record: object }|null}
 */
function findRunRecord(brandRoot, since) {
  const runsDir = path.join(brandRoot, '.omega', 'runs');
  if (!fs.existsSync(runsDir)) {
    return null;
  }

  const candidates = fs.readdirSync(runsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(runsDir, name)).mtimeMs }))
    .filter((entry) => entry.mtime >= since)
    .sort((a, b) => b.mtime - a.mtime);

  if (candidates.length === 0) {
    return null;
  }

  const file = path.join(runsDir, candidates[0].name);
  return { file, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

/**
 * The manage child's argv: the VERB first (#229 — a bare CLI prints help and
 * walks nothing, which would leave the pipeline with no run record), then the
 * run flags the pipeline always imposes.
 *
 * @param {object} [argv] - The pipeline's own options.
 * @returns {string[]} The child invocation's arguments.
 */
function buildChildArgs(argv = {}) {
  const args = ['manage', '--continue-on-error'];

  if (argv.service) {
    args.push(`--service=${argv.service}`);
  }
  if (argv.dryRun || argv['dry-run']) {
    args.push('--dry-run');
  }

  return args;
}

module.exports = async (argv = {}) => {
  const brandRoot = resolveBrandRoot(process.cwd());
  if (!brandRoot) {
    console.error(chalk.red('✗ Not inside a brand (no config/omega.json5 found walking up)'));
    process.exitCode = 1;
    return;
  }

  // Tee the run to <brandRoot>/logs/pipeline.log (#623) — the scorecard is the
  // verdict worth keeping; the children spawn with stdio inherit, so each leg's
  // own output stays in its own log.
  attachLogFile(path.join(brandRoot, 'logs', 'pipeline.log'));

  const requireExtra = String(argv.require || '').split(',').map((s) => s.trim()).filter(Boolean);
  const childArgs = buildChildArgs(argv);

  console.log(chalk.bold('\n🧪 Pipeline — live full-cycle test (non-interactive by construction)\n'));
  console.log(`  Brand:   ${chalk.cyan(brandRoot)}`);
  console.log(`  Child:   omega ${childArgs.join(' ')}`);
  console.log(`  Core:    ${[...CORE_SERVICES, ...requireExtra].join(', ')}\n`);

  const started = Date.now();
  // cli-run.js self-executes when spawned as main — spawning it directly
  // deliberately bypasses the bin's dispatcher (#276): this child must run
  // THIS manager, never re-dispatch on the child's cwd.
  const bin = path.join(__dirname, '..', 'cli-run.js');

  // Non-interactive by construction: stdin detached AND the explicit env
  // switch (google-auth counts stdout-TTY as a watching human — the env
  // beats it, so consent flows fail fast instead of opening browsers).
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...childArgs], {
      cwd: brandRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, OMEGA_NON_INTERACTIVE: '1' },
    });
    child.on('close', (code) => resolve(code ?? 1));
  });

  const found = findRunRecord(brandRoot, started);
  if (!found) {
    console.error(chalk.red(`\n✗ PIPELINE FAIL — no run record appeared in .omega/runs/ (child exit ${exitCode})`));
    process.exitCode = 1;
    return;
  }

  // Deploy legs — spawned in the owning target's dir, same non-interactive
  // construction; results join the record as deploy:<target> rows so the
  // evaluator's any-error rule covers them
  const deployTargets = String(argv.deploy || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const target of deployTargets) {
    const leg = deployLeg(target);
    const entry = discoverTargets(brandRoot).find((item) => item.target === target);

    if (!leg || !entry) {
      const deployable = TARGET_TYPE_ROWS.filter((row) => row.deploy).map((row) => row.id);
      found.record.services.push({
        service: `deploy:${target}`,
        status: 'error',
        output: null,
        error: leg ? `no ${target} dir in this brand` : `unknown deploy target (${deployable.join(', ')})`,
      });
      continue;
    }

    // A leg that publishes (desktop: the GH release flow, extension: the store
    // CI dispatch) stays behind its own flag: both are gated until Ian opens them.
    if (targetType(target).publishes && !argv.publish) {
      console.log(chalk.yellow(`\n⊘ Deploy leg ${target}: publish leg gated — pass --publish to run it (releases/dispatches are gated)`));
      found.record.services.push({
        service: `deploy:${target}`,
        status: 'skipped',
        output: null,
        error: null,
        reason: 'publish leg gated — pass --publish (releases/dispatches are gated)',
      });
      continue;
    }

    console.log(chalk.bold(`\n🧪 Deploy leg: ${target} ${chalk.dim(`(${leg.join(' ')} in ${entry.dir})`)}`));
    const legExit = await new Promise((resolve) => {
      const child = spawn(leg[0], leg.slice(1), {
        cwd: entry.path,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, OMEGA_NON_INTERACTIVE: '1' },
      });
      child.on('close', (code) => resolve(code ?? 1));
    });

    found.record.services.push({
      service: `deploy:${target}`,
      status: legExit === 0 ? 'success' : 'error',
      output: null,
      error: legExit === 0 ? null : `exit ${legExit}`,
    });
  }

  // Verify sweep — the last mile: the deploy legs pushed, these prove the
  // launch surface answers. Rows join the record as verify:<name> so a
  // failed check fails the pipeline exactly like a failed deploy leg.
  const verifyTargets = resolveVerifyTargets(argv, deployTargets).filter((target) => targetType(target)?.verify.length > 0);
  if (verifyTargets.length > 0) {
    const dryRun = Boolean(argv.dryRun || argv['dry-run']);
    console.log(chalk.bold(`\n🧪 Verify sweep: ${verifyTargets.join(', ')}${dryRun ? chalk.dim(' (dry run — plan only)') : ''}`));
    found.record.services.push(...await runVerifyLegs(verifyTargets, loadBrand(brandRoot).config, {}, { dryRun }));
  }

  const verdict = evaluatePipeline(found.record, { require: requireExtra, scoped: Boolean(argv.service) });

  console.log(chalk.bold('\n🧪 Pipeline scorecard'));
  console.log(`  ${chalk.dim(`record: ${path.basename(found.file)}`)}`);
  for (const row of verdict.rows) {
    const icon = STATUS_ICONS[row.status] || chalk.dim('·');
    console.log(`  ${icon} ${row.service}${row.status === 'skipped' && row.reason ? chalk.dim(` — ${row.reason}`) : ''}`);
  }

  if (verdict.skips.length > 0) {
    console.log(`\n  ${chalk.dim(`⊘ acceptable skips: ${verdict.skips.length} (listed above)`)}`);
  }

  if (verdict.pass) {
    console.log(chalk.green.bold('\n✅ PIPELINE PASS\n'));
    return;
  }

  console.log(chalk.red.bold('\n❌ PIPELINE FAIL'));
  for (const failure of verdict.failures) {
    console.log(`  ${chalk.red('✗')} ${failure}`);
  }
  console.log('');
  process.exitCode = 1;
};

module.exports.evaluatePipeline = evaluatePipeline;
module.exports.findRunRecord = findRunRecord;
module.exports.resolveVerifyTargets = resolveVerifyTargets;
module.exports.buildChildArgs = buildChildArgs;
module.exports.CORE_SERVICES = CORE_SERVICES;
module.exports.deployLeg = deployLeg;
