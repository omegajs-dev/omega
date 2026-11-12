/**
 * `omega test` at a brand root, C5's brand layer: fan the test run out over
 * the brand's targets, each through its own `npm run test` (the scope and the
 * mode flags after `--`), and then run the brand's OWN e2e lane.
 *
 *   omega test                → every target's PROJECT tests, then test/e2e/
 *   omega test framework:     → every target's framework suite
 *   omega test full:          → both sources, every target
 *   omega test routes/x       → project filter, forwarded to every target
 *                               (a target with no matching tests no-ops; a
 *                                path NO target carries fails the run, #814)
 *   omega test web:pages/     → ONLY the web target — its framework suite, scoped
 *   omega test desktop:       → ONLY the desktop target's framework suite
 *   omega test --target=web,backend  → narrow ANY of the above to those targets
 *   omega test --extended     → fanned out: every target runs its real-service suites
 *   omega test --lane=<name>  → fanned out to the targets that DECLARE that lane
 *   omega test --offline --filter=<x> --layer=<x> ...
 *                             → every other flag, forwarded to every target the run reaches
 *
 * Universal targets (bare paths, `framework:`/`omega:`/`mgr:`, `full:`,
 * `project:`/`brand:`) forward to every target verbatim; per-framework ids
 * (the target-type rows: `web:`, `backend:`, `desktop:`, `extension:`) route to
 * the target owning that framework — the legacy short ids are retired. Unknown
 * prefixes warn and are dropped; if nothing valid remains, every target runs
 * bare (scope.js parity).
 *
 * `--target=<a,b>` is the TARGET picker, and it composes with every scope
 * above rather than replacing any of them: a comma list of target NAMES
 * ('web', 'admin') narrowing which targets the run reaches. A
 * per-framework id already names its target, so an id whose owner the picker
 * excludes is a contradiction, not a narrowing — it refuses by name instead of
 * running the empty intersection.
 *
 * Every flag the root does not consume reaches the targets after `--`, through
 * the `buildForwardedFlags` seam every brand-root fan-out shares: `--extended`,
 * `--offline`, `--filter=<x>`, `--layer=<x>`, `--reporter=<x>` and any other.
 * The root consumes only the picker and the positionals it routes. It also
 * READS `--lane=<name>` ([#775](https://github.com/Omega-JS-Stack/omega/issues/775)):
 * the lane reaches only the targets whose framework DECLARES it in its
 * package.json `omega.testLanes`; a target that declares none prints one line
 * and the run stays green, because an opt-in lane no framework serves is a
 * lane that does not apply there, never a failure. A layer is its framework's
 * word, so a layered run picks its target with `--target=`.
 *
 * The BRAND E2E LANE (the `defineCases` suites under `<brandRoot>/test/e2e/`)
 * runs last, in this process on devkit's runner, when the folder exists: the
 * brand's real pages against its real local stack, a surface no target owns.
 * It hears no scope vocabulary and no flags: a bare run reaches it, and a
 * scoped, picked (`--target=`), laned, filtered or layered run never does.
 *
 * Targets run sequentially with streamed output; any failing target → exit 1.
 */
const fs = require('node:fs');
const path = require('node:path');
const chalk = require('chalk').default;
const attachLogFile = require('@omega.js/devkit/attach-log-file');

const Logger = require('@omega.js/devkit/logger');
const { createRunner } = require('@omega.js/devkit/test/runner');
const { TARGET_TYPE_ROWS } = require('@omega.js/config');
const { UNIVERSAL_FRAMEWORK_ALIASES, PROJECT_ALIASES, FULL_ALIASES, FANOUT_ENV, NO_MATCH_EXIT_CODE, noMatchMessage, parseTestScope, isPathTargeted } = require('@omega.js/devkit/test/scope');
const { resolveBrandRoot, discoverTargets } = require('../lib/brand.js');
const { resolveTargetRun, resolveFrameworkPackage } = require('../lib/framework-bin.js');
const { PICKER_FLAG, assertPickerFlags, assertKnownTargets, parseTargetTokens, targetMatches, buildForwardedFlags } = require('../lib/target-selection.js');
const { runCommand } = require('../lib/run-command.js');

// Prefixes forwarded to every target as-is (each target's own C5 parser interprets them)
const UNIVERSAL_PREFIXES = new Set([
  ...UNIVERSAL_FRAMEWORK_ALIASES,
  ...PROJECT_ALIASES,
  ...FULL_ALIASES,
]);

// id prefix → owning framework package ('desktop' → '@omega.js/desktop', …),
// one per target-type row that has a framework
const ID_TO_FRAMEWORK = Object.fromEntries(
  TARGET_TYPE_ROWS.filter((row) => row.framework).map((row) => [row.id, row.framework])
);

// The brand's own e2e lane: every suite file in this folder, on devkit's runner.
const BRAND_E2E_DIR = path.join('test', 'e2e');

// The fan-out's own verdict is a log line, not a report row: the report says
// what each target did, this says what the RUN means (#814).
const logger = new Logger('test');

/**
 * Split raw targets into per-target routing: `shared` goes to every target,
 * `perFramework[pkg]` only to the target owning that framework, `invalid`
 * is warned and dropped.
 */
function partitionTargets(rawTargets) {
  const shared = [];
  const perFramework = {};
  const invalid = [];

  for (const raw of rawTargets) {
    const target = String(raw).trim();
    if (!target) continue;

    // Same prefix grammar as scope.js (lowercase-only keeps C:/ paths bare)
    const match = target.match(/^([a-z-]+):/);

    if (!match) {
      shared.push(target);
    } else if (UNIVERSAL_PREFIXES.has(match[1])) {
      shared.push(target);
    } else if (ID_TO_FRAMEWORK[match[1]]) {
      const pkg = ID_TO_FRAMEWORK[match[1]];
      (perFramework[pkg] = perFramework[pkg] || []).push(target);
    } else {
      invalid.push(target);
    }
  }

  return { shared, perFramework, invalid };
}

/**
 * The brand root's targets read through the SAME grammar a target's own runner
 * reads them with, so "did this run name a path?" means one thing everywhere
 * ([#814](https://github.com/Omega-JS-Stack/omega/issues/814)). Every framework
 * id is handed in as an alias, since at this layer they all name a source.
 *
 * @param {string[]} rawTargets - The positional targets, as typed
 * @returns {object} A parseTestScope() result
 */
function namedScope(rawTargets) {
  return parseTestScope(rawTargets, { frameworkAliases: Object.keys(ID_TO_FRAMEWORK) });
}

/**
 * The `--target=` picker: which discovered targets a run may reach.
 * Tokens match a target's NAME through the shared matcher every brand-root
 * picker uses (lib/target-selection.js, which also names the flag: ONE
 * `--target=` on every verb, #780).
 *
 * @param {Array} targets - the discovered target entries
 * @param {string} [picker] - the raw --target value (comma list)
 * @returns {{ tokens: string[], selected: Array }}
 * @throws {Error} when a token matches no target
 */
function pickTargets(targets, picker) {
  const tokens = parseTargetTokens(picker);
  if (tokens.length === 0) {
    return { tokens, selected: targets };
  }

  assertKnownTargets(
    tokens.filter((token) => !targets.some((entry) => targetMatches(entry, token))),
    targets.map((entry) => entry.name),
  );
  const selected = targets.filter((entry) => tokens.some((token) => targetMatches(entry, token)));

  return { tokens, selected };
}

/**
 * Does this target's framework declare `lane`? The framework's package.json
 * `omega.testLanes` is the SSOT — a lane is the framework's to own, and the
 * brand root only needs to know which targets it applies to.
 *
 * @param {object} entry - the discovered target entry
 * @param {string} framework - the framework package name
 * @param {string} lane - the --lane value
 * @returns {boolean}
 */
function declaresLane(entry, framework, lane) {
  const resolved = resolveFrameworkPackage(entry.path, framework);
  const lanes = resolved?.pkg?.omega?.testLanes;
  return Array.isArray(lanes) && lanes.includes(lane);
}

/**
 * Run the brand's e2e suites in this process; the walk's tee already holds
 * `logs/test.log`, so the runner attaches no log of its own.
 *
 * @param {string} brandRoot - The brand root
 * @returns {Promise<{success: boolean, error?: string}>} runCommand's result shape
 */
async function runBrandLane(brandRoot) {
  const runner = createRunner({
    framework: 'node',
    title: BRAND_E2E_DIR,
    projectRoot: brandRoot,
    roots: [{ source: 'project', dir: path.join(brandRoot, BRAND_E2E_DIR) }],
  });
  // A runner throw is this row's failure, never the walk's: the summary still prints.
  let results;
  try {
    results = await runner.run({ targets: [], reporter: 'pretty' });
  } catch (error) {
    console.error(error.stack);
    return { success: false, error: error.message };
  }
  return results.failed > 0 ? { success: false, error: `${results.failed} failing` } : { success: true };
}

/**
 * The run's summary: every target that ran, then every one that stepped aside.
 * It prints on every run, so a run that skipped everything still reports.
 *
 * @param {Array} summary - `{ name, ok, missed, detail }` per target that ran.
 * @param {Array} skipped - `{ name, detail }` per target that stepped aside.
 */
function printSummary(summary, skipped) {
  console.log(chalk.bold('\nTest summary'));
  for (const entry of summary) {
    if (entry.missed) {
      console.log(`  ${chalk.dim('⊘')} ${entry.name} ${chalk.dim(`(${entry.detail})`)}`);
      continue;
    }
    console.log(entry.ok
      ? `  ${chalk.green('✓')} ${entry.name}`
      : `  ${chalk.red('✗')} ${entry.name} ${chalk.dim(`(${entry.detail})`)}`);
  }
  for (const entry of skipped) {
    console.log(`  ${chalk.dim('⊘')} ${entry.name} ${chalk.dim(`(skipped: ${entry.detail})`)}`);
  }
}

module.exports = async (options) => {
  assertPickerFlags(options);

  const brandRoot = resolveBrandRoot(process.cwd());
  if (!brandRoot) {
    console.error(chalk.red(`✗ Not inside a brand monorepo (no config/omega.json5 up the tree): run it at a brand root, with --${PICKER_FLAG}=<name> to pick targets.`));
    process.exitCode = 1;
    return;
  }

  // Tee the whole fan-out to <brandRoot>/logs/test.log (#623) — which target
  // ran which scope, and the aggregate verdict (each target's own suite output
  // stays in targets/<target>/logs/test.log).
  attachLogFile(path.join(brandRoot, 'logs', 'test.log'));

  // Positional targets — tolerate both `omega-manager test x` (command token
  // present) and flag-alias entry (`--test x`, no token).
  const rawTargets = (options._ || []).map(String);
  if (rawTargets[0] === 'test') rawTargets.shift();

  const { shared, perFramework, invalid } = partitionTargets(rawTargets);
  for (const bad of invalid) {
    console.log(chalk.yellow(`  ⚠ Unknown test scope prefix ignored: ${bad}`));
  }

  // Nothing valid → every target runs bare (its project tests), scope.js parity.
  const runAllBare = shared.length === 0 && Object.keys(perFramework).length === 0;
  const lane = options.lane ? String(options.lane) : null;
  const filter = options.filter ? String(options.filter) : null;
  const layer = options.layer ? String(options.layer) : null;
  const flags = buildForwardedFlags(options);

  const discovered = discoverTargets(brandRoot).filter((entry) => entry.target || entry.custom);
  if (discovered.length === 0) {
    console.log(chalk.yellow('⚠ No target-mapped dirs under targets/ — nothing to test.'));
    return;
  }

  const picked = pickTargets(discovered, options[PICKER_FLAG]);

  console.log(chalk.bold(`\nOMEGA brand tests — ${path.basename(brandRoot)}`));

  // ─── Plan: which targets run, with which forwarded ids ────────────────────
  const runs = [];
  // The targets that stepped aside, so the summary reports them even when nothing ran
  const skipped = [];

  // Resolved ONCE per target: the plan below and the --target/id contradiction
  // check both need to know which framework owns which target.
  const resolvedRuns = discovered.map((entry) => ({ entry, run: resolveTargetRun(entry, 'test') }));

  // A per-framework id names its target; a picker that excludes that target
  // contradicts it. Refuse by name rather than run the empty intersection —
  // silently testing nothing is the outcome a green exit must never mean.
  for (const [pkg, ids] of Object.entries(perFramework)) {
    const owner = resolvedRuns.find((item) => item.run.framework === pkg);
    if (!owner || picked.selected.includes(owner.entry)) continue;

    const error = new Error(
      `omega test: refusing --${PICKER_FLAG}=${picked.tokens.join(',')} beside the "${ids[0]}" scope — `
      + `${owner.entry.dir} owns that framework and --${PICKER_FLAG} excludes it. Nothing ran.\n`
      + 'Name the same target on both, or drop one of them.',
    );
    error.refusal = true;
    throw error;
  }

  for (const { entry, run } of resolvedRuns) {
    if (!picked.selected.includes(entry)) continue;

    if (run.kind === 'error') {
      // Only an error if this target was (or would be) addressed
      if (runAllBare || shared.length > 0) {
        runs.push({ entry, error: run.detail });
      }
      continue;
    }

    // A brand-owned script (a custom target's, a custom-mode backend's) never
    // hears the scope vocabulary: it is the frameworks', and a lane is scope too,
    // so only a bare, unlaned run addresses one. A missing script is the brand's
    // only on a custom target.
    const brandOwned = run.kind === 'skip' ? !run.framework : !run.frameworkScript;
    if (brandOwned && (!runAllBare || lane)) continue;

    // An opt-in lane reaches only the frameworks that serve it; the rest say
    // so in one line and the run stays green (#775).
    if (!brandOwned && lane && !declaresLane(entry, run.framework, lane)) {
      console.log(chalk.dim(`  ⊘ ${entry.name}: no "${lane}" lane in ${run.framework}: skipped`));
      skipped.push({ name: entry.name, detail: `no "${lane}" lane` });
      continue;
    }

    const args = brandOwned ? [] : [...shared, ...(perFramework[run.framework] || [])];
    if (!runAllBare && args.length === 0) continue; // targeted run, not addressed to this target

    // An addressed target with no `test` script has nothing to run and nothing broken
    if (run.kind === 'skip') {
      console.log(chalk.dim(`  ⊘ ${entry.name}: ${run.detail}: skipped`));
      skipped.push({ name: entry.name, detail: run.detail });
      continue;
    }

    // The flags and the scope ride the same `forwarded` seam every other
    // brand-root fan-out uses (commands/deploy.js, lib/verb-fanout.js), so they
    // land after the script's `--`. Re-resolved only when there IS something to
    // forward: a bare run keeps its first resolution.
    const forwarded = [...flags, ...args];
    const flagged = forwarded.length ? resolveTargetRun(entry, 'test', forwarded) : run;

    runs.push({
      entry,
      framework: flagged.framework || 'custom',
      command: flagged.command,
      args: flagged.args,
      label: flagged.label,
      // This target is being ASKED, not chosen: a path it does not carry is a
      // no-op here, and the signal is what lets its CLI say so with a code of
      // its own instead of failing the whole brand run (#814).
      env: { [FANOUT_ENV]: '1' },
    });
  }

  // ─── The brand's own e2e lane, after the targets ───────────────────────────
  // A bare run only: the lane hears no scope vocabulary and no flags, so a
  // scoped, picked, laned, filtered or layered run is asking for something else.
  if (runAllBare && !lane && !filter && !layer && picked.tokens.length === 0 && fs.existsSync(path.join(brandRoot, BRAND_E2E_DIR))) {
    runs.push({
      entry: { name: BRAND_E2E_DIR, path: brandRoot },
      framework: 'brand',
      inProcess: true,
      label: 'its suites, in this process',
    });
  }

  if (runs.length === 0) {
    console.log(chalk.yellow('⚠ No target matches the requested scope — nothing ran.'));
    printSummary([], skipped);

    // Nothing ran AND a path was named: the brand carries no target that could
    // even be asked for it, which is the same typo the target-level rule
    // catches, so it fails here too ([#814](https://github.com/Omega-JS-Stack/omega/issues/814)).
    // A bare prefix (`desktop:` with no path) names no file, so it keeps the
    // warning above and an exit 0.
    if (isPathTargeted(namedScope(rawTargets))) {
      logger.error(noMatchMessage(rawTargets.join(' ')));
      process.exitCode = 1;
    }
    return;
  }

  // ─── Execute sequentially, streaming each target's output ─────────────────
  const summary = [];
  let failed = false;

  for (const [index, run] of runs.entries()) {
    const label = `[${index + 1}/${runs.length}] ${run.entry.name}`;

    if (run.error) {
      console.log(chalk.red(`\n✗ ${label}: ${run.error}`));
      summary.push({ name: run.entry.name, ok: false, detail: run.error });
      failed = true;
      continue;
    }

    console.log(chalk.cyan(`${`\n─── ${label} ${chalk.dim(`(${run.framework})`)} — ${run.label}`.trimEnd()} ───`));
    const result = run.inProcess
      ? await runBrandLane(brandRoot)
      : await runCommand(run.command, run.args, run.entry.path, run.env);

    // The distinct no-match code (#814): this target does not carry the path
    // the brand root forwarded, which is a no-op here, not a failure. The run
    // as a whole still has to answer for it below.
    const missed = !result.success && result.code === NO_MATCH_EXIT_CODE;

    summary.push({ name: run.entry.name, ok: result.success, missed, detail: missed ? 'no test file matches' : result.error });
    if (!result.success && !missed) failed = true;
  }

  // ─── Summary + aggregate exit ──────────────────────────────────────────────
  printSummary(summary, skipped);

  // Every target missed: the path exists nowhere in this brand, so the run
  // tested nothing at all. One target carrying it is enough to be a real run
  // (#814) — silently testing nothing is the outcome a green exit must never
  // mean.
  const misses = summary.filter((entry) => entry.missed);
  if (!failed && misses.length > 0 && misses.length === summary.length) {
    logger.error(noMatchMessage(rawTargets.join(' ')));
    failed = true;
  }

  if (failed) {
    process.exitCode = 1;
  }
};
