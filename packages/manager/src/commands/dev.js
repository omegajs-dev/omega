/**
 * `omega dev` (brand root): ONE command boots the local stack: every selected
 * target's own `start` script (`omega dev` in a framework target: the website
 * dev server, the backend emulator suite), each spawned in its own target with
 * its own Node (web/backend pin different majors), output line-prefixed per
 * target, one Ctrl-C killing everything.
 *
 * Target selection (Ian 2026-07-16): the default set is web + backend — the
 * local web loop. GUI/watcher targets (desktop opens an Electron window,
 * extension runs a build watcher) never boot unless asked.
 *   omega dev                        web + backend
 *   omega dev --target=web           one leg (the target NAME)
 *   omega dev --target=web,backend   explicit set
 *   omega dev --all                  every target with a dev leg
 *   omega dev --full                 boot on the WHOLE manage walk, not the lane
 *   omega dev --local                link the brand from the local monorepo first (`omega i local`)
 *   omega dev --target=web --port=3001 --no-https
 *                                    every flag the fan-out does not consume rides each leg's
 *                                    `start` after `--`, so the leg's own dev loop reads it
 *
 * Boot order: the freshness sweep first (one dist check for every lane), then
 * a manage cycle — the boot lane (workspace, assets, disperse: the local
 * redistribution the legs consume), then the legs. See docs/shared/local-dev.md
 * for what refreshes when.
 *
 * Port coordination is already solved (N7): the backend leg publishes its
 * emulator ports; the web leg reads them and bakes dev.ports into pages —
 * order tolerant, but backend boots first here so the fast path wins.
 */

// Libraries
const path = require('node:path');
const { spawn } = require('node:child_process');
const chalk = require('chalk').default;
const attachLogFile = require('@omega.js/devkit/attach-log-file');
const { findTarget } = require('@omega.js/devkit/omega-bin');
const { freshnessSweep, linkLocalPackages, resolveLinkedMonorepo, resolveMonorepoRoot, startMonorepoWatch } = require('@omega.js/devkit/local');
const { mkcertCaRootPem } = require('@omega.js/devkit/local-https');
const { missingMachineTools, machineToolLine } = require('@omega.js/devkit/machine-tools');
const { STOP_SIGNALS } = require('@omega.js/devkit/stop-signals');
const { TARGET_TYPE_ROWS } = require('@omega.js/config');

// Local
const { runManage } = require('../manage.js');
const { resolveBrandRoot, loadBrand, discoverTargets } = require('../lib/brand.js');
const { NO_TARGETS_LINE } = require('../lib/default-targets.js');
const { assertFamilyVersions } = require('../lib/preflight.js');
const { targetScripts } = require('../lib/custom-target.js');
const { resolveTargetNode, nodeEnvFor } = require('../lib/node-version.js');
const { PICKER_FLAG, assertPickerFlags, assertKnownTargets, parseTargetTokens, buildForwardedFlags } = require('../lib/target-selection.js');

// Every target's dev leg is its own `start` script: `omega dev` in a framework
// target, the brand's own command in a custom one
const DEV_LEG = ['npm', 'run', 'start'];

// The flags this fan-out reads itself, beside the CONSUMED_KEYS every fan-out shares
const DEV_CONSUMED = ['all', 'full', 'local', 'execFn'];

/**
 * One leg's command line: the `start` script, then every flag the fan-out did
 * not consume after `--` (`--port=3001`, `--no-https` reach web's dev loop).
 *
 * @param {object} options - the parsed CLI options
 * @returns {string[]} the argv, its command first
 */
function devLeg(options) {
  const forwarded = buildForwardedFlags(options, DEV_CONSUMED);
  return forwarded.length > 0 ? [...DEV_LEG, '--', ...forwarded] : DEV_LEG;
}

/**
 * Stop one dev leg. A leg is a CHAIN (npm run <leg> → the real server), so the
 * SIGTERM goes to the leg's process group — signaling only the direct npm
 * child leaves the grandchild (a firebase emulator) orphaned on pid 1, still
 * holding its ports (#690). The direct kill is the fallback for a leg whose
 * group is already gone.
 */
const stopChild = (child, killGroup = (pid, signal) => process.kill(pid, signal)) => {
  try {
    killGroup(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
};

// Booted without flags: the local web loop, the rows marked devDefault. Matched
// as target NAMES, so a brand that names its web target something else boots
// it with `--target=`.
const DEV_TARGETS = TARGET_TYPE_ROWS.filter((row) => row.devDefault).map((row) => row.id);

/**
 * Pure target selection — which legs boot for a given flag set.
 *
 * Custom targets join the same fan-out and the default set. Whether a
 * picked target has a `start` script to run is the boot's question, not this one.
 *
 * @param {object} input
 * @param {Array<{ name: string, target: string|null }>} input.available - the discovered targets ({ name, target: the TYPE })
 * @param {string[]} [input.custom] - the custom target names
 * @param {string} [input.target] - the --target= comma list: exact set to boot
 * @param {boolean} [input.all] - start every target with a dev leg
 * @returns {{ selected: string[] }}
 * @throws {Error} when a --target= token names no dev leg
 */
function selectDevTargets({ available, custom = [], target, all }) {
  const names = available.map((entry) => entry.name);
  const typeOf = new Map(available.map((entry) => [entry.name, entry.target]));

  // A custom target is a first-class leg: the default set boots it beside web +
  // backend (it is part of the local stack, never an opt-in GUI surface)
  // The vocabulary is the SAME one `test`, `deploy` and `update` take (#886):
  // this brand's declared target NAMES, custom ones included. A type word is
  // only a token when a target answers to it, so `--target=web` on a brand
  // whose web target is named `site` is a typo, never a silent skip.
  const legs = [...new Set([...names, ...custom])];
  const defaults = [...DEV_TARGETS, ...custom].filter((name) => names.includes(name));

  const tokens = parseTargetTokens(target);
  const requested = tokens.length > 0
    ? tokens
    : (all ? legs : defaults);

  // A token naming no leg STOPS the boot (#780) — booting the rest of the set
  // would serve a stack the human did not ask for.
  assertKnownTargets(requested.filter((name) => !legs.includes(name)), legs);

  // Backend first: it publishes the emulator port map the web leg reads. The
  // order is by TYPE (#886), never by the word: a backend NAMED `api` still
  // boots ahead of the legs that read its ports.
  const backendFirst = (name) => (typeOf.get(name) === 'backend' ? -1 : 0);
  const selected = [...requested].sort((a, b) => backendFirst(a) - backendFirst(b));

  return { selected };
}

/**
 * Consecutive-duplicate collapser for ONE leg output stream (#230).
 *
 * The Firebase emulator re-prints its own infra lines once per function
 * instance — "i  functions: Loaded environment variables from .env." dozens of
 * times in a row — which buries the lines a human is actually watching for.
 * Repeats of the line just emitted are swallowed and counted; the count
 * surfaces as ONE note when a different line arrives (or the stream ends, so a
 * leg that goes quiet mid-run never eats the tail). The rule is structural —
 * any consecutive duplicate on any leg — never a list of known noisy strings.
 *
 * Blank lines are exempt: a note standing in for a run of them reads louder
 * than the blanks it replaced.
 *
 * Stateful because a stream is; pure otherwise — lines in, lines out.
 * @returns {{ push: (line: string) => string[], flush: () => string[] }}
 */
function createLineDeduper() {
  let previous = null;
  let repeats = 0;

  const note = () => {
    const pending = repeats > 0 ? [`  (repeated ${repeats}×)`] : [];
    repeats = 0;
    return pending;
  };

  return {
    push(line) {
      if (line === previous && line.trim() !== '') {
        repeats += 1;
        return [];
      }
      const out = note();
      previous = line;
      out.push(line);
      return out;
    },
    flush() {
      previous = null;
      return note();
    },
  };
}

module.exports = async (options = {}) => {
  assertPickerFlags(options);

  const brandRoot = resolveBrandRoot(process.cwd());
  if (!brandRoot) {
    console.error(chalk.red('✖ omega dev: no brand root found (looked for config/omega.json5 walking up from here)'));
    process.exit(1);
  }

  // A brand may declare no targets at all: nothing to boot is a clean answer
  const brand = loadBrand(brandRoot);
  if (!brand.configError && brand.enabledTargets.length === 0) {
    console.log(NO_TARGETS_LINE);
    return;
  }

  // Tee the brand-level fan-out — the boot manage cycle AND every leg's
  // prefixed output — to <brandRoot>/logs/dev.log (#197), its OWN file: a boot
  // used to truncate logs/manage.log and take the last service walk's record
  // with it, and the two are read for different questions (#231).
  attachLogFile(path.join(brandRoot, 'logs', 'dev.log'));

  // A custom target joins the fan-out under its own NAME; like every
  // target, it boots only when its package.json declares a `start` script.
  const discovered = discoverTargets(brandRoot);

  // `--local` links the whole brand from the monorepo before anything reads what is installed,
  // so the monorepo watch below starts on the fresh link
  if (options.local) {
    const logger = { log: (line) => console.log(chalk.dim(`   ${line}`)), warn: (line) => console.log(chalk.yellow(`   ${line}`)) };
    await linkLocalPackages({ dir: brandRoot, monorepoRoot: resolveMonorepoRoot(), logger });
  }

  // Lockstep (#794): the same gate the manage walk opens with, run here too —
  // before the freshness sweep and before any leg spawns. A boot on a brand
  // whose targets carry different @omega.js versions would serve two copies of
  // the client and validate one omega.json5 with two validators; nothing
  // downstream can see it, so the refusal belongs at the door.
  assertFamilyVersions({ brandRoot, targets: discovered });

  const targets = discovered.filter((entry) => entry.target || entry.custom);
  const custom = targets.filter((entry) => entry.custom).map((entry) => entry.name);

  // A --target= token is the target NAME (#886), the one word every
  // brand-root verb takes, so the picker passes straight through: a token
  // that names nothing reaches the selector, which refuses it.
  const { selected: picked } = selectDevTargets({
    available: targets,
    custom,
    target: options[PICKER_FLAG],
    all: options.all,
  });

  console.log(chalk.bold(`🚀 omega dev — booting ${picked.join(' + ')} ${chalk.dim(`(${brandRoot})`)}`));
  if (!options[PICKER_FLAG] && !options.all) {
    console.log(chalk.dim('   default set is web + backend — `--target=`, `--all` pick it'));
  }

  // Dist freshness is checked ONCE, here, for every lane at once (#340). Each
  // lane's CLI boot checks itself too — but a heal runs `npm run prepare`,
  // which PURGES dist before recopying, and a framework bin opens by requiring
  // its own `../dist/` entry. Unsynchronized, one lane's purge window is the
  // sibling lane's require: the backend leg died MODULE_NOT_FOUND dispatching
  // through the web package the web leg was mid-rebuild on. Swept first, every
  // lane's own check is a no-op.
  const hosts = [];
  for (const name of picked) {
    const entry = targets.find((item) => item.name === name);
    const found = findTarget(entry.path);
    if (found && found.kind === 'framework') {
      hosts.push({ packageName: found.name, fromDir: found.dir });
    }
  }
  const sweep = freshnessSweep({ hosts });
  if (sweep.healed.length > 0) {
    console.log(chalk.dim(`   ✔ rebuilt ${sweep.healed.join(', ')} before booting — the legs start on a complete dist`));
  }
  if (sweep.staleLinked.length > 0) {
    // The monorepo watch owns those dists (#281) — the sweep printed what is
    // unbuilt and what to start; nothing boots on top of it.
    throw new Error(`omega dev: ${sweep.staleLinked.map((entry) => entry.packageName).join(', ')} — see above; nothing booted`);
  }
  if (sweep.healFailed.length > 0) {
    // The watch is down and the sweep's own rebuild broke (#398) — the sweep
    // printed the prepare to run by hand; no leg boots on a dist nobody built.
    throw new Error(`omega dev: ${sweep.healFailed.map((entry) => entry.packageName).join(', ')} — see above; nothing booted`);
  }

  // Boot opens with a full manage cycle (#44): the target watchers see only
  // their own target, so brand-level sources — assets/logo/brandmark.svg, .env,
  // certs — reach the targets ONLY through the service walk. Without this, a
  // brand edit sits invisible until someone remembers to run `npm run manage`.
  // A broken brand fails the boot instead of serving stale output.
  // …and it never blocks on a human (#228): the boot walk runs headless, so
  // console confirms, consent flows and secret pastes step aside into the run
  // summary's ⚑ pending list instead of stalling the stack. `npm run manage`
  // keeps the full interactive walk. The switch is restored before any leg
  // spawns — the web dev server and the emulator ARE interactive surfaces.
  //
  // …and it walks only the BOOT LANE (#228): workspace + assets + disperse,
  // the local redistribution the legs actually consume. The cloud services
  // and the rebuild lane cost a minute-plus and nothing downstream of them
  // reaches a dev leg, so they belong to `npm run manage` — or `--full` here.
  const priorNonInteractive = process.env.OMEGA_NON_INTERACTIVE;
  process.env.OMEGA_NON_INTERACTIVE = '1';
  let report;
  try {
    report = await runManage(brandRoot, options.full ? {} : { lane: 'boot' });
  } finally {
    if (priorNonInteractive === undefined) {
      delete process.env.OMEGA_NON_INTERACTIVE;
    } else {
      process.env.OMEGA_NON_INTERACTIVE = priorNonInteractive;
    }
  }
  if (report.hasErrors) {
    throw new Error('omega dev: the manage cycle reported errors — fix them (see the run summary above), then boot again');
  }

  if (!options.full) {
    console.log(chalk.dim('   ⚑ boot ran the local lane only — `npm run manage` runs the full setup (or `omega dev --full`)'));
  }

  // The one-terminal rule covers FRAMEWORK edits too (#587). A brand whose
  // @omega.js deps resolve into a monorepo checkout has no src→dist rebuild
  // without that monorepo's watch, so this boot starts it as a session child —
  // the same mechanism the website target's `--local` prelude uses, one
  // implementation in devkit. Lock-aware: a watch already running is reused.
  // AFTER the sweep on purpose: the sweep's verdict depends on whether a watch
  // holds the lock (#281/#398), so starting one first would change the answer
  // it just gave.
  const linkedMonorepo = resolveLinkedMonorepo(brandRoot);
  if (linkedMonorepo) {
    const watch = startMonorepoWatch({ monorepoRoot: linkedMonorepo, logger: { log: (line) => console.log(chalk.dim(`   ${line}`)) } });

    // A watch's prepare rewrites every package's dist, and a target booting
    // into that rewrite loads a half-written CLI (#670). The legs wait for the
    // pass to land — a FRESH watch's initial one, and an ALREADY-RUNNING
    // watch's, which is the branch a brand normally takes (Ian keeps the root
    // `npm start` up) and the one that skipped the wait entirely (#622).
    const outcome = await watch.ready;
    if (outcome === 'ready') {
      console.log(chalk.dim(`   monorepo watch: ${watch.alreadyRunning ? 'nothing in flight' : 'initial prepare done'}`));
    }
  } else {
    console.log(chalk.dim('   ⚑ frameworks come from the registry — no monorepo watch to run (a linked brand starts one here)'));
  }

  // The local certificate's root, resolved ONCE for every leg (#795): a leg
  // that never speaks TLS ignores it, and this is verification rather than a
  // bypass, so Node prints no warning. A shell-set value wins verbatim.
  const caPem = process.env.NODE_EXTRA_CA_CERTS || mkcertCaRootPem();

  // A target missing a machine tool, or with no `start` script, has no dev leg:
  // it steps aside, loudly. Read after the manage cycle, which writes a fresh
  // target's scripts.
  const misses = missingMachineTools(picked.map((name) => {
    const entry = targets.find((item) => item.name === name);
    return { name, type: entry.target, projectType: entry.projectType };
  }), { execFn: options.execFn });
  const selected = picked.filter((name) => {
    const entry = targets.find((item) => item.name === name);
    const missed = misses.filter((miss) => miss.target === name);
    missed.forEach((miss) => console.log(chalk.yellow(`   ⊘ ${name}: ${machineToolLine(miss)}`)));
    if (missed.length > 0) return false;
    if (targetScripts(entry.path).start) return true;
    console.log(chalk.yellow(`   ⊘ ${name}: no \`start\` script in ${entry.dir}/package.json, no dev leg`));
    return false;
  });

  if (selected.length === 0) {
    console.error(chalk.red('✖ omega dev: nothing to boot (every selected target stepped aside, see above)'));
    process.exit(1);
  }

  const pad = Math.max(...selected.map((name) => name.length));
  const leg = devLeg(options);
  const children = [];
  let shuttingDown = false;

  // One deduper per stream, so the legs never collapse against each other.
  // Terminal and file see the SAME collapsed stream: the tee patches this
  // process' writers (#197), so there is one stream to dedup, not two.
  const forward = (stream, log, name) => {
    let buffer = '';
    const deduper = createLineDeduper();
    const emit = (lines) => lines.forEach((line) => log(`${chalk.dim(`[${name.padEnd(pad)}]`)} ${line}`));
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach((line) => emit(deduper.push(line)));
    });
    stream.on('end', () => emit(deduper.flush()));
  };

  for (const name of selected) {
    const entry = targets.find((item) => item.name === name);
    const node = resolveTargetNode(entry.path);
    if (node?.error) {
      console.log(chalk.yellow(`   ⚠ ${name}: ${node.error}, using the inherited node`));
    }

    console.log(chalk.dim(`   ${name.padEnd(pad)} → ${leg.join(' ')} in ${entry.dir}${node ? ` (node ${node.major})` : ''}`));

    const child = spawn(leg[0], leg.slice(1), {
      cwd: entry.path,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Legs pipe their output — keep chalk colors when the parent's terminal
      // has them (the log tee strips ANSI either way)
      env: {
        ...process.env,
        ...nodeEnvFor(node),
        FORCE_COLOR: process.stdout.isTTY ? '1' : process.env.FORCE_COLOR || '0',
        ...(caPem ? { NODE_EXTRA_CA_CERTS: caPem } : {}),
      },
      // Own process group per leg (#690): a leg is a chain (npm run <leg> →
      // the real server), and shutdown signals the GROUP — a same-group leg
      // would get only npm killed, orphaning the emulator on its ports.
      detached: true,
    });
    forward(child.stdout, console.log, name);
    forward(child.stderr, console.error, name);
    child.on('close', (code) => {
      if (shuttingDown) return;
      console.error(chalk.red(`✖ ${name} exited (code ${code}): siblings stay up; Ctrl-C stops everything`));
    });
    children.push(child);
  }

  // The legs are detached (their own process groups), so the terminal's own
  // Ctrl-C never reaches them — every escalation is this process' to deliver.
  const forceKill = () => {
    children.forEach((child) => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    });
    process.exit(0);
  };
  const shutdown = () => {
    if (shuttingDown) return forceKill(); // second Ctrl-C = force kill
    shuttingDown = true;
    console.log(chalk.dim('\n⏹ omega dev: stopping all targets… (Ctrl-C again to force kill)'));
    children.forEach((child) => stopChild(child));
    // Exit only when every leg is GONE: the backend leg's own teardown (the
    // emulator group-kill + orphan sweep, seconds of work) logs through this
    // process' pipes, and exiting under it cuts the sweep off mid-run (#690).
    // The cap matches the 20s the journey/e2e harnesses allow that teardown,
    // and expiry escalates so a wedged leg cannot keep its ports.
    const cap = setTimeout(forceKill, 20000);
    Promise.all(children.map((child) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      child.once('close', resolve);
    }))).then(() => {
      clearTimeout(cap);
      process.exit(0);
    });
  };
  // Every way this run is asked to stop takes the SAME teardown, off the ONE
  // devkit list ([#629](https://github.com/Omega-JS-Stack/omega/issues/629)).
  // SIGHUP was missing: a closed terminal killed the orchestrator outright and
  // the legs, spawned DETACHED so a group signal cannot reach them, orphaned
  // with the emulator tree behind them.
  STOP_SIGNALS.forEach((signal) => process.on(signal, shutdown));

  // Keep the orchestrator alive while any child runs
  await new Promise(() => {});
};

module.exports.selectDevTargets = selectDevTargets;
module.exports.createLineDeduper = createLineDeduper;
module.exports.stopChild = stopChild;
module.exports.DEV_LEG = DEV_LEG;
