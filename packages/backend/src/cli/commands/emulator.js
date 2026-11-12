const BaseCommand = require('./base-command');
const path = require('path');
const fs = require('fs');
const { spawnShell } = require('../utils/spawn-shell');
const chalk = require('chalk').default;
const jetpack = require('fs-jetpack');
const JSON5 = require('json5');
const powertools = require('node-powertools');
const WatchCommand = require('./watch');
const { loadEmulatorPorts } = require('./setup-tests/emulator-config');
const { resolvePorts, writePortsFile, clearPortsFile, portsToEnv, isPortFree, CLASSIC_PORTS } = require('@omega.js/config');
const { EXTENDED_MODE_WARNING } = require('../../test/extended-mode-lines.js');
const { writeTestMode, captureSyncedEnv } = require('../../test/utils/test-mode-file');
const { seedProject } = require('../../test/seed.js');
const { createChildLog } = require('../utils/attach-log-file');
const { refuseWhenCustom, refuseWhenToolsMissing } = require('../utils/project-type');
const emulatorOrphans = require('./emulator-orphans');
const { writeJson } = require('@omega.js/devkit/write-json');
const { STOP_SIGNALS } = require('@omega.js/devkit/stop-signals');
// STOP_GRACE_MS is the orphan sweep's grace too, so both grant SIGTERM the same wait.
const { readProcessTable, descendantsOf, STOP_GRACE_MS } = require('@omega.js/devkit/process-tree');

// Used by both `npx omega emulator` and `npx omega test` auto-start path.
// Note: `emulators:start` enables the UI by default (controlled by firebase.json's
// `emulators.ui.enabled`), so no `--ui` flag here — that flag only exists on `:exec`.
const EMULATOR_FLAGS = '--only functions,firestore,auth,database,hosting,pubsub';

// The pid record this run writes when its stack is up — the sweep's primary
// ownership proof ([#274](https://github.com/Omega-JS-Stack/omega/issues/274)).
const PID_RECORD_FILE = 'emulator-pids.json';

// How long a recorded pid stays evidence. The record is rewritten at boot and
// again at shutdown, so a live run's is always seconds old; anything older
// belongs to a run that died without teardown. Pids get RECYCLED, and a
// recorded pid is a kill order the sweep acts on without further proof — past
// this bound the number is no longer known to name the process it named.
const PID_RECORD_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// A command line that belongs to emulator machinery. Deliberately broad: it
// only ever narrows a candidate that ALREADY named this project id.
const EMULATOR_COMMAND = /emulator|firebase/i;

// How long the port→pid lookup gets to answer before a sweep gives up on it.
// lsof stats every mounted filesystem first, so a machine with a network mount
// pays for the walk on every call — measured at ~90ms a call here, and a stall
// on the smbfs volume runs to MINUTES
// ([#332](https://github.com/Omega-JS-Stack/omega/issues/332)). The call is
// synchronous, so an unbounded one freezes the whole run: the boot path
// absorbed that in its ready window, and the stop path simply sat there until
// a ship gate's lane budget was gone
// ([#459](https://github.com/Omega-JS-Stack/omega/issues/459)). This is ~50x a
// healthy answer, and the same window the port verdict already waits.
const PORT_LOOKUP_TIMEOUT_MS = 5000;

/**
 * Does this command line name the given project as an ARGUMENT?
 *
 * Substring matching would be wrong twice over: `demo-x` appears inside
 * `demo-x-staging` (a different project), and a repo path containing the brand
 * name is not a project id at all. Only `--project <id>` / `--project_id <id>`
 * (space or `=`) counts — the form the firestore emulator actually publishes.
 * @param {string} command - Full command line from ps.
 * @param {string} projectId - The project id to look for.
 * @returns {boolean}
 */
function commandNamesProject(command, projectId) {
  const escaped = projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return new RegExp(`--project(?:_id)?[= ]${escaped}(?:\\s|$)`).test(command);
}

/**
 * The project a command line names as an argument, or null when it names none.
 *
 * Same argument form as commandNamesProject(), read the other way round: not
 * "is it this project" but "which project does it say it is". A jar that names
 * one is self-identifying evidence that outranks a recorded pid number.
 * @param {string} command - Full command line from ps.
 * @returns {string|null}
 */
function commandProjectId(command) {
  const match = /--project(?:_id)?[= ](\S+)/.exec(String(command || ''));

  return match ? match[1] : null;
}

// How long a boot may take before the run declares it dead and shuts the
// partial stack down. The default absorbs a slow port sweep — lsof stalling on
// a network mount takes a real boot past the old 60s cap, which failed every
// self-booting lane on such a machine
// ([#332](https://github.com/Omega-JS-Stack/omega/issues/332)).
const DEFAULT_READY_TIMEOUT_MS = 180000;

/**
 * Resolve the emulator ready deadline from the environment.
 * @param {string} [raw] - The OMEGA_EMULATOR_READY_TIMEOUT value, in ms.
 * @returns {number} The deadline in milliseconds.
 */
function resolveReadyTimeout(raw) {
  if (raw === undefined || raw === '') {
    return DEFAULT_READY_TIMEOUT_MS;
  }

  const parsed = Number(raw);

  // A junk override fails loudly instead of silently racing an unknown
  // deadline — the same rule the #211 lane multiplier follows.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`OMEGA_EMULATOR_READY_TIMEOUT must be a positive number of milliseconds, got "${raw}"`);
  }

  return parsed;
}

/**
 * The subset of `ports` something is actually listening on.
 *
 * The sweeps below need a port to name a pid, and `lsof` is the only tool that
 * maps one. It stats every mounted filesystem before it answers, so a machine
 * with a network mount (an smbfs Time Machine volume) pays seconds per call,
 * and a boot ran one call per port whether or not anything was there: ~96s of
 * pure waste on a run with every port free, which pushed boot past the ready
 * deadline ([#332](https://github.com/Omega-JS-Stack/omega/issues/332)).
 *
 * A port nothing holds cannot have a holder to name, so its lookup could only
 * ever come back empty. Probe first with the same bind primitive the allocator
 * uses (in-process, no shell, no filesystem walk) and look up only the ports
 * that answer. Same ports considered, same decisions, minus the empty calls.
 * @param {number[]} ports - The ports a sweep is about to consider.
 * @param {(port: number) => Promise<boolean>} [isFree] - The probe (injectable).
 * @returns {Promise<number[]>} The held subset, deduped.
 */
async function heldPorts(ports, isFree = isPortFree) {
  const unique = [...new Set(ports || [])].filter((port) => Number.isInteger(port));
  const free = await Promise.all(unique.map((port) => isFree(port)));

  return unique.filter((port, index) => !free[index]);
}

/**
 * The pids LISTENING on a port.
 *
 * The one step with no Node primitive: only lsof maps a port to a process. It
 * is reached solely for a port heldPorts() already proved is held, so a normal
 * boot never shells here at all.
 *
 * And it is BOUNDED, because the tool can stall indefinitely on a network
 * mount (PORT_LOOKUP_TIMEOUT_MS). A lookup that overruns names nobody, which
 * is what every caller already does with a port whose holder it cannot
 * identify: report it, leave it running. The bound can only ever spare a
 * process, never take one.
 * @param {number} port - A port something is known to hold.
 * @returns {string[]} The listening pids, or [] when the read fails or overruns.
 */
function listListeningPids(port) {
  const { execFileSync } = require('child_process');

  try {
    // No shell: the bound has to land on lsof ITSELF, and an `sh -c` wrapper
    // is one more process for the kill to hit instead. stderr is dropped by
    // the stdio map, which is all the old `2>/dev/null` was doing. SIGKILL
    // because a process wedged in a filesystem call is exactly the one that
    // would ignore a polite signal and hold the run past its own timeout.
    return execFileSync('lsof', ['-ti', `TCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PORT_LOOKUP_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }).trim().split('\n').filter(Boolean);
  } catch (error) {
    return [];
  }
}

/**
 * Every port the firebase config tells the emulator child to bind.
 *
 * Read from the config, never hard-coded: a brand may declare emulators this
 * CLI's allocator knows nothing about (eventarc, tasks), and those are exactly
 * the ones a boot cannot relocate.
 * @param {object} firebaseConfig - The parsed firebase config the child reads.
 * @returns {object} name to port, for every emulator that names a port.
 */
function declaredEmulatorPorts(firebaseConfig) {
  const declared = {};

  for (const [name, entry] of Object.entries(firebaseConfig?.emulators || {})) {
    if (Number.isInteger(entry?.port)) {
      declared[name] = entry.port;
    }
  }

  return declared;
}

/**
 * The boot's port plan: what the emulator child is about to bind.
 *
 * The resolved map wins over the declared value, because a bumped port is what
 * the child actually receives (via firebase.resolved.json). `https` is left
 * out: that is THIS process's TLS proxy, not the child's listener.
 * @param {object} declared - name to port, from the firebase config.
 * @param {object} resolved - This run's allocated map (already bumped).
 * @returns {Array<{name: string, port: number}>}
 */
function plannedEmulatorPorts(declared, resolved) {
  const plan = [];

  for (const [name, port] of Object.entries({ ...declared, ...resolved })) {
    if (name === 'https') {
      continue;
    }

    plan.push({ name: name, port: port });
  }

  return plan;
}

/**
 * The fail-fast report for a boot whose plan cannot work.
 * @param {Array<{name: string, port: number}>} blocked - The held planned ports.
 * @returns {string}
 */
function formatPortPreflightFailure(blocked) {
  const named = blocked.map(({ name, port }) => `port ${port} (${name})`).join(', ');
  const numbers = blocked.map(({ port }) => port).join(', ');

  return [
    `Port preflight failed: this emulator must bind ${named}, and something already holds ${blocked.length > 1 ? 'them' : 'it'}.`,
    'Another dev stack is in the way: a tower app on that port, another brand\'s `omega dev`, or an emulator a crashed run left behind.',
    `Stop whatever holds ${numbers} and run this again. Nothing was spawned, so there is no partial stack to clean up.`,
  ].join('\n  ');
}

/**
 * Stop the boot BEFORE firebase is spawned when the plan cannot work.
 *
 * The allocator already relocates around a busy port (N7 bump-if-taken), so a
 * plan that still names a held port names one this run cannot move off. Left
 * to firebase, that boot never prints its ready marker and the run burns the
 * whole ready deadline before anything says why
 * ([#332](https://github.com/Omega-JS-Stack/omega/issues/332)).
 * @param {Array<{name: string, port: number}>} planned - What the child will bind.
 * @param {(port: number) => Promise<boolean>} [isFree] - The probe (injectable).
 * @returns {Promise<void>} Rejects with the report when a planned port is held.
 */
async function assertPlannedPortsFree(planned, isFree = isPortFree) {
  const held = await heldPorts(planned.map(({ port }) => port), isFree);

  if (held.length === 0) {
    return;
  }

  throw new Error(formatPortPreflightFailure(planned.filter(({ port }) => held.includes(port))));
}

/**
 * The allocated port firebase-tools just failed to bind, or null.
 *
 * The probe and the bind are two moments, and on a machine running a second
 * brand's stack a foreign listener can take a port between them, and the boot
 * then dies on a port the allocator read as free seconds earlier
 * ([#778](https://github.com/Omega-JS-Stack/omega/issues/778)). The child says
 * so in one line, and the port is read out of it by matching against THIS
 * run's allocation rather than by parsing an address shape: node writes the
 * same failure as `127.0.0.1:9099`, `:::9099` and `port 9099` depending on
 * which layer reports it, and only a number this run actually asked for can be
 * the one it could not bind. firebase-tools' own pre-bind check says the same
 * as `Port N is not open`, ahead of a `port taken` line that names no port.
 * @param {string} text - A chunk of the child's output.
 * @param {number[]} ports - This attempt's allocated ports.
 * @returns {number|null}
 */
function addressInUsePort(text, ports) {
  const allocated = new Set(ports);

  for (const line of String(text || '').split('\n')) {
    if (!/EADDRINUSE|Port \d+ is not open/i.test(line)) {
      continue;
    }

    for (const [number] of line.matchAll(/\d+/g)) {
      if (allocated.has(Number(number))) {
        return Number(number);
      }
    }
  }

  return null;
}

/**
 * The report for a boot whose retry hit the same wall (#778).
 *
 * The holder is NAMED, never signalled: it is another session's live stack,
 * and this run has no proof of ownership over it, which is the same bar every
 * sweep in this file clears before it sends a signal.
 * @param {{port: number, name: string|null}} failed - The port the retry could not bind.
 * @param {Array<{pid: number, command: string}>} holders - Who holds it now.
 * @returns {string}
 */
function formatAddressInUseFailure(failed, holders) {
  const named = `port ${failed.port}${failed.name ? ` (${failed.name})` : ''}`;
  const report = [`Emulator boot failed: ${named} was taken while the stack was coming up, and the bumped retry hit the same wall.`];

  for (const { pid, command } of holders) {
    report.push(`Port ${failed.port} is held by pid ${pid}${command ? `: ${command}` : ''}.`);
  }

  if (holders.length === 0) {
    report.push(`Nothing answers for port ${failed.port} now: whatever took it came and went inside this boot.`);
  }

  report.push(`Stop whatever keeps taking ${failed.port} and run this again. This run's stack was shut down; nothing of it is left running.`);

  return report.join('\n  ');
}

/**
 * The allocation's name for a port ('auth' for 9099), or null.
 * @param {object} ports - The resolved name to port map.
 * @param {number} port - The port to name.
 * @returns {string|null}
 */
function portName(ports, port) {
  const found = Object.entries(ports || {}).find(([, value]) => value === port);

  return found ? found[0] : null;
}

/**
 * Can this process be PROVEN to be an emulator process of THIS project?
 *
 * The sweep used to signal whatever was listening on its ports, which
 * terminated another project's live emulator sharing the hub/storage ports
 * ([#274](https://github.com/Omega-JS-Stack/omega/issues/274)). Occupying a
 * port is not ownership; only these two proofs are:
 *
 *   1. The pid record this run wrote when it spawned the stack. Primary,
 *      because the java emulators name no project on their own — and they
 *      reparent to PID 1 when orphaned, so the record made while they were
 *      still attached is the only surviving link.
 *   2. A command line that is emulator machinery AND names this project id
 *      (the firestore emulator's `--project_id`), which covers a leftover from
 *      an earlier run of the same project that no live record mentions.
 *
 * Anything else is somebody else's process and is left running.
 * @param {object} candidate - { pid, command } as read from ps.
 * @param {object} [ownership] - { pids: number[], projectId: string|null }.
 * @returns {boolean}
 */
function isOwnedEmulatorProcess(candidate, ownership) {
  const pid = Number(candidate?.pid);
  const command = String(candidate?.command || '');

  // PID 1 is init, and a non-numeric row is a parse failure — never candidates.
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }

  if ((ownership?.pids || []).some((recorded) => Number(recorded) === pid)) {
    return true;
  }

  const projectId = ownership?.projectId;

  if (!projectId) {
    return false;
  }

  return EMULATOR_COMMAND.test(command) && commandNamesProject(command, projectId);
}

/**
 * Should the STOP path signal this recorded process?
 *
 * The stop path has no port to narrow by — it walks the record itself — so the
 * recorded pid alone would be the whole proof, and pids get RECYCLED. The live
 * command line is the second half: a recorded number that now names something
 * that is not emulator machinery is a stranger the OS handed our pid to, and
 * it is left running ([#274](https://github.com/Omega-JS-Stack/omega/issues/274)).
 *
 * Recycling inside the SAME machinery is the harder half: a recorded number
 * that now runs the neighbouring brand's firestore jar reads as ours on the pid
 * alone. A jar that names a project id names it truthfully, so when this run
 * knows its own project id and the live command line disagrees, the number is
 * recycled and the process is left running. A jar that names none (the pubsub
 * emulator) is decided by the record, as before.
 * @param {{pid: number|string, command: string}} candidate - One ps row.
 * @param {{pids: number[], projectId: string|null}} ownership - This run's record.
 * @returns {boolean}
 */
function isStoppableEmulatorProcess(candidate, ownership) {
  const command = String(candidate?.command || '');

  if (!EMULATOR_COMMAND.test(command)) {
    return false;
  }

  const named = commandProjectId(command);

  if (named && ownership?.projectId && named !== ownership.projectId) {
    return false;
  }

  return isOwnedEmulatorProcess(candidate, ownership);
}

/**
 * Should the STALE-RECORD reap signal this recorded process?
 *
 * The stop path's bar first (isStoppableEmulatorProcess): emulator machinery
 * that does not name a different project. That bar decides a jar naming NO
 * project — the pubsub emulator — on record membership alone, and a record is a
 * list of NUMBERS: a recycled number now running the NEIGHBOUR brand's pubsub
 * jar reads exactly like our own leftover
 * ([#730](https://github.com/Omega-JS-Stack/omega/issues/730)).
 *
 * So the live PARENT is the second proof, and it is only ever asked of a record
 * whose root is already proven dead. A dead run's survivors are reparented (PID
 * 1, where every orphan lands) or still hang off another member of that same
 * dead run — the firebase parent that outlived the `sh` root, say. A number
 * handed to somebody else's LIVE stack has a live parent that this record has
 * never heard of, and it is left running.
 * @param {{pid: number|string, ppid: number|string, command: string}} candidate - One ps row.
 * @param {{pids: number[], projectId: string|null, rootPid: number|null}} ownership - The PREVIOUS record.
 * @returns {boolean}
 */
function isReapableRecordedProcess(candidate, ownership) {
  if (!isStoppableEmulatorProcess(candidate, ownership)) {
    return false;
  }

  const parent = Number(candidate?.ppid);

  if (parent === 1 || parent === Number(ownership?.rootPid)) {
    return true;
  }

  return (ownership?.pids || []).some((recorded) => Number(recorded) === parent);
}

/**
 * The ownership a pid record still supports, given its age.
 *
 * The pids are only evidence while they are known to name the processes they
 * named at spawn: the record is never deleted, so a run days later reads the
 * last one, and by then the OS may have handed those numbers to anything. The
 * project id is not pid-based — a command line naming this project proves
 * itself at any age — so it survives an expiry.
 *
 * The ports ride with the pids: they are the map the recorded run bound, and
 * they are only ever read to settle ports those very pids just released.
 * @param {object|null} record - The parsed pid-record file.
 * @param {number} [now] - Epoch ms to age against (defaults to Date.now()).
 * @returns {{pids: number[], projectId: string|null, rootPid: number|null, ports: object}}
 */
function ownershipFromRecord(record, now) {
  const startedAt = Date.parse(record?.startedAt);
  const fresh = Number.isFinite(startedAt) && (now || Date.now()) - startedAt < PID_RECORD_MAX_AGE_MS;

  return {
    pids: fresh && Array.isArray(record?.pids) ? record.pids : [],
    projectId: record?.projectId || null,
    rootPid: record?.rootPid || null,
    ports: fresh && record?.ports ? record.ports : {},
  };
}

/**
 * The command line a pid is running right now, or '' when it is gone.
 * @param {number|string} pid - The pid to read.
 * @returns {string}
 */
function readProcessCommand(pid) {
  const { execSync } = require('child_process');

  try {
    return execSync(`ps -o command= -p ${Number(pid)} 2>/dev/null`, { encoding: 'utf8' }).trim();
  } catch (error) {
    return '';
  }
}

/**
 * The command line a pid is running right now AND who forked it, or null when
 * it is gone.
 *
 * The parent is half of the stale reap's identity proof, and it is only
 * readable in the same breath as the command line: two `ps` calls describe two
 * moments, and a number that changed hands between them reads as one process
 * that never existed ([#730](https://github.com/Omega-JS-Stack/omega/issues/730)).
 * @param {number|string} pid - The pid to read.
 * @returns {{ppid: number, command: string}|null}
 */
function readProcessInfo(pid) {
  const { execSync } = require('child_process');

  try {
    const row = execSync(`ps -o ppid=,command= -p ${Number(pid)} 2>/dev/null`, { encoding: 'utf8' }).trim();
    const match = row.match(/^\s*(\d+)\s+(.*)$/s);

    return match ? { ppid: Number(match[1]), command: match[2] } : null;
  } catch (error) {
    // `ps` exiting 1 is the one provable answer: the pid does not exist. Any
    // other failure (fork pressure, a spawn error) proves NOTHING — and it
    // must read as alive-but-unprovable, never as gone, because the reap's
    // root gate turns "gone" into a kill order. The sentinel is truthy (the
    // root gate leaves the record alone) and matches no identity proof (a
    // member read spares the pid) ([#730](https://github.com/Omega-JS-Stack/omega/issues/730)).
    if (error.status === 1) {
      return null;
    }

    return { ppid: -1, command: '' };
  }
}

/**
 * Every descendant pid of `rootPid`, from one ps snapshot.
 *
 * Taken while the stack is UP: firebase-tools puts each java emulator in its
 * own process group and they reparent to PID 1 once orphaned, so neither the
 * group nor the parent link survives the moment the sweep needs it.
 * @param {number} rootPid - The spawned child's pid.
 * @returns {number[]} rootPid plus every descendant, deduped.
 */
function collectDescendantPids(rootPid) {
  return [rootPid, ...descendantsOf(readProcessTable(), rootPid)];
}

class EmulatorCommand extends BaseCommand {
  async execute() {
    // Custom-server mode exports no Cloud Functions to emulate (#584)
    if (refuseWhenCustom(this.main.firebaseProjectPath, 'emulator')) return;
    if (refuseWhenToolsMissing(this.main.firebaseProjectPath, 'emulator', ['java', 'firebase'])) return;

    // The emulator IS the backend's dev leg under brand-root `omega dev`, so it
    // shares the dev-log lane with `omega serve` (they never run together — same
    // ports). The firebase CHILD keeps its own dist/emulator.log (#197).
    this.attachVerbLog('dev');

    this.log(chalk.cyan('\n  Starting Firebase emulator (keep-alive mode)...\n'));
    this.log(chalk.gray('  Emulator will stay running until you press Ctrl+C\n'));

    // Boot-time: seed the shared state file with whatever this emulator was
    // started with. Two flows are supported:
    //   - Recommended: start emulator without the flag, set TEST_EXTENDED_MODE
    //     on `npx omega test` instead. The test command writes the file; the
    //     emulator's function workers watch it and flip live.
    //   - Also supported: start emulator with TEST_EXTENDED_MODE=true. We
    //     write the file here as a boot default. Useful for inspecting the
    //     emulator before any tests fire. Note: the next `npx omega test`
    //     overwrites the file regardless of how the emulator booted.
    {
      const projectDir = this.main.firebaseProjectPath;
      const envSubset = captureSyncedEnv(process.env);
      writeTestMode(projectDir, envSubset);
    }

    // Show the standard warning if the emulator boots in extended mode.
    if (process.env.TEST_EXTENDED_MODE) {
      this.log(chalk.yellow.bold(`\n  ${EXTENDED_MODE_WARNING[0]}`));
      EXTENDED_MODE_WARNING.slice(1).forEach((line) => this.log(chalk.yellow(`  ${line}`)));
      this.log(chalk.gray(`  (Tip: you can also flip mode per-run by setting TEST_EXTENDED_MODE on \`npx omega test\`.)`));
      this.log('');
    }

    // Start @omega.js/backend watcher in background. Keep the child handle —
    // interactive Ctrl+C kills it via the terminal process group, but a
    // PROGRAMMATIC signal to this process alone (e2e harness, kill -INT)
    // doesn't, leaving an immortal nodemon re-creating the reload trigger
    // (found live by the cp88 two-emulator proof).
    const watcher = new WatchCommand(this.main);
    const watcherChild = watcher.startBackground();

    // The watcher hangs off THIS process, not off the emulator child, so the pid
    // record's descendant walk from the emulator's root pid cannot see it — name
    // it for the record explicitly, or a run that dies without teardown leaves a
    // nodemon no later stop path can even name
    // ([#629](https://github.com/Omega-JS-Stack/omega/issues/629)).
    this.backgroundWatcherPid = watcherChild ? watcherChild.pid : null;

    // Keep-alive: boot emulators and wait for Ctrl+C. No "command" subprocess —
    // the emulator child IS the foreground process from the user's perspective.
    // HTTPS default-on for the interactive command (--no-https disables); the
    // `omega test` auto-start path never passes it — the harness talks plain
    // http to hosting directly.
    // Kept outside the try so the failure path below can stop whatever came up.
    let started = null;

    try {
      started = await this.startEmulators({
        https: this.argv.https !== false,
      });
      const { shutdown, emulatorPorts, exitPromise } = started;

      // Start Stripe webhook forwarding in background — AFTER boot so it
      // targets the RESOLVED hosting port, not a classic that may have bumped
      this.startStripeWebhookForwarding(emulatorPorts.hosting);

      // Seed personas unless --no-seed was passed (the parse's negation rule:
      // `--no-seed` parses as argv.seed === false). seedPersonas is fully
      // non-fatal — any failure logs a warning and the emulator keeps running.
      if (this.argv.seed !== false) {
        await this.seedPersonas(emulatorPorts);
      }

      // NOTE: this line is a readiness MARKER for external drivers (the devkit
      // e2e harness waits for it) — it must print AFTER seeding so drivers
      // don't race the seed wipe. Change the text in lockstep with
      // @omega.js/devkit/test/e2e-harness.js.
      this.log(chalk.gray('\n  Emulator ready. Press Ctrl+C to shut down...\n'));

      // Synchronous stop handler — must NOT be async. In Node, registering a
      // listener for one of these signals suppresses the default "exit on signal"
      // behavior, but only if the listener is present when the signal fires. An
      // async handler loses the race: Node starts it, doesn't await it, and the
      // process dies mid-shutdown. So: set a flag synchronously, kick off shutdown
      // (no await), and let the main `await exitPromise` below resolve naturally
      // once shutdown kills the child.
      let stopCount = 0;
      // The handler cannot await, but the run must not exit ahead of the
      // shutdown it started: the jar reap runs AFTER the child is gone, and
      // process.exit() below would cut it off mid-signal
      // ([#304](https://github.com/Omega-JS-Stack/omega/issues/304)). Keep the
      // promise and join it once the child has exited.
      let shutdownRun = null;
      const onStopSignal = () => {
        stopCount++;
        if (stopCount === 1) {
          this.log(chalk.gray('\n  Shutting down emulator... (Ctrl+C again to force kill)'));
          shutdownRun = shutdown();
        } else {
          this.log(chalk.gray('  Force killing emulator...'));
          shutdownRun = shutdown();
        }
      };
      // ONE handler, three signals: the stop path is the same whether the ask is
      // Ctrl+C, `omega dev`'s SIGTERM, or the SIGHUP of a closed terminal
      // ([#629](https://github.com/Omega-JS-Stack/omega/issues/629)).
      STOP_SIGNALS.forEach((signal) => process.on(signal, onStopSignal));

      // Resolve when the emulator exits (via shutdown or crash)
      await exitPromise;
      // A child that exited on its own (a crash, firebase-tools stopping
      // itself) started no shutdown — run one anyway, so the same reap covers
      // both ways this line is reached. shutdown() owns the whole teardown now:
      // the recorded jars, the orphan sweep, and the port verdict. The stop
      // listeners stay active across it so Ctrl+C spam can't cut it short.
      await (shutdownRun || shutdown());
      // Reap the background watcher — it is NOT in the firebase child's
      // process group, so nothing else kills it on a programmatic shutdown.
      if (watcherChild) {
        try { watcherChild.kill('SIGTERM'); } catch (e) { /* already gone */ }
      }
      STOP_SIGNALS.forEach((signal) => process.removeListener(signal, onStopSignal));
      this.log(chalk.gray('  Emulator stopped.\n'));
      if (stopCount > 0) {
        process.exit(0);
      }
    } catch (error) {
      this.logError(`Emulator error: ${error.message || error}`);
      // A failed boot spawned things too: the stack (startEmulators stops its
      // own before it throws) and this frame's background watcher, which
      // nothing else signals — exiting here left an immortal nodemon behind
      // ([#304](https://github.com/Omega-JS-Stack/omega/issues/304)). Anything
      // that got as far as a handle gets the same stop path.
      if (started) {
        try { await started.shutdown(); } catch (e) { /* the stop path already reported */ }
      }
      if (watcherChild) {
        try { watcherChild.kill('SIGTERM'); } catch (e) { /* already gone */ }
      }
      process.exit(1);
    }
  }

  /**
   * Seed the running emulator with test personas so a developer can sign in
   * manually on any emulator-connected dev site (email + TEST_ACCOUNT_PASSWORD).
   * Fully non-fatal — the ENTIRE body is guarded; any failure (config load,
   * firebase-admin init, account creation) logs a warning and the emulator
   * keeps running. execute()'s catch would otherwise process.exit(1).
   */
  async seedPersonas(emulatorPorts) {
    try {
      this.log(chalk.cyan('\n  Seeding test personas...\n'));

      const projectDir = this.main.firebaseProjectPath;
      const functionsDir = path.join(projectDir, 'dist');

      // Load project config (same pattern as test.js loadProjectConfig)
      const { hasOmegaConfig, loadConfig, loadEnv, resolvedBrandHost } = require('@omega.js/config');
      loadEnv(functionsDir);

      let config = {};
      let domain = '';
      if (hasOmegaConfig(functionsDir)) {
        config = loadConfig(functionsDir, 'backend').config;
        // A persona lives on the brand's HOST — the one derivation, shared with
        // the dev palette that signs in as one
        // ([#708](https://github.com/Omega-JS-Stack/omega/issues/708)). The
        // brand's contact address is a support inbox — often on the apex while
        // the site is a subdomain of it — so it shapes no persona identity.
        domain = resolvedBrandHost(config);
      }

      // Persona emails are `_test.<id>@{domain}` — without a domain every
      // createUser call fails with an invalid email. Skip cleanly instead.
      if (!domain) {
        this.logWarning('Skipping persona seeding: no brand.url in config/omega.json5 (personas are seeded on the brand host)');
        return;
      }

      // Point firebase-admin at the emulators. Set AFTER the firebase child was
      // spawned, so only THIS process (and the seed module's emulator-only
      // guards) see them — the emulator child's env is unaffected.
      process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${emulatorPorts.firestore}`;
      process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${emulatorPorts.auth}`;
      process.env.GCLOUD_PROJECT = config.cloud?.config?.projectId || 'demo-test';

      const firebaseAdmin = require('firebase-admin');
      if (firebaseAdmin.apps.length === 0) {
        firebaseAdmin.initializeApp({
          projectId: process.env.GCLOUD_PROJECT,
        });
      }

      const { TEST_ACCOUNT_PASSWORD } = require('../../test/test-accounts.js');
      const result = await seedProject({
        admin: firebaseAdmin,
        domain,
        config,
        projectDir,
      });

      if (result.accounts) {
        this.log(chalk.green(`\n  ✓ Personas seeded (${result.created} accounts)`));
        this.log(chalk.gray(`    Sign in on any emulator-connected dev site with email + password: ${TEST_ACCOUNT_PASSWORD}\n`));
      } else {
        this.logWarning('Persona seeding completed with errors (see above)');
      }
    } catch (e) {
      this.logWarning(`Persona seeding failed: ${e.message}`);
      this.log(chalk.gray('    The emulator is still running — seeding is non-fatal. Re-run with --no-seed to skip.\n'));
    }
  }

  /**
   * Boot Firebase emulators as a long-running child process.
   * Stdout/stderr are teed to console + emulator.log.
   * Resolves once the emulator hub is listening (i.e., emulators are ready).
   * Caller is responsible for calling shutdown() to send SIGTERM and wait for exit.
   *
   * @param {object} [options]
   * @param {boolean} [options.https] - Front the public hosting port with the
   *   shared mkcert TLS proxy (interactive `omega emulator` default)
   * @param {string} [options.environment] - The environment the stage composes
   *   dist/.env for (#586). Omitted = `development`, the local lane's pin —
   *   never the shell's answer, so an exported ENVIRONMENT can't stage
   *   production credentials into a local boot. `omega test`'s auto-start
   *   names `testing`.
   *
   *   The STAGED overlay and the emulator RUNTIME's own environment answer
   *   differ on purpose: functions running under the emulator report `testing`
   *   (OMEGA_ENVIRONMENT=testing), while the artifact they read was composed from
   *   `.env.development` — the file lane is the developer's local credentials,
   *   the runtime lane is "don't do real side effects".
   * @returns {Promise<{ child: ChildProcess, shutdown: () => Promise<void>, emulatorPorts: object }>}
   */
  async startEmulators(options) {
    const projectDir = this.main.firebaseProjectPath;

    // dist/ is staged output (src/dist pillar): stage fresh (including
    // dist/public/ for hosting), then keep it fresh — the emulator watches
    // dist/ natively, so a re-stage IS the hot reload. The watcher belongs to
    // the boot ATTEMPT below, which dies with the emulator child it feeds.
    // The local lane's pin (#586): a boot nobody named an environment for is
    // `development`, so the composed dist/.env can never follow the shell.
    const environment = options?.environment || 'development';
    await this.ensureStaged({ environment });

    // N7 port allocation: firebase.json values (classic defaults) when free,
    // bump-if-taken — a second brand's stack relocates instead of the old
    // behavior of KILLING the incumbent. Explicit config `ports` pins never
    // bump (busy pin = hard error).
    const wanted = loadEmulatorPorts(projectDir);

    // HTTPS (the classic https://localhost:5002 contract, shared with `omega
    // serve` + web's `omega dev` via @omega.js/devkit/local-https): the PUBLIC
    // hosting port speaks TLS through the mkcert proxy; hosting itself moves
    // to an internal plain-http port. No mkcert → plain http on the classic
    // port, same fallback as serve.
    let httpsCerts = null;
    if (options?.https) {
      const { ensureLocalHttpsCerts, mkcertInstallHint } = require('@omega.js/devkit/local-https');
      httpsCerts = await ensureLocalHttpsCerts({
        certsDir: path.join(this.getTempPath(), 'certs'),
        log: (line) => this.log(chalk.gray(`  ${line}`)),
      });

      if (httpsCerts) {
        wanted.https = wanted.hosting;
        wanted.hosting = 5443;
      } else {
        this.log(chalk.yellow('  HTTPS disabled — could not obtain certificates.'));
        this.log(chalk.yellow(`  Install mkcert for trusted local HTTPS: ${mkcertInstallHint()}\n`));
      }
    }

    // Crash leftovers first, MACHINE-WIDE: a run that died without teardown
    // leaves java emulator grandchildren and functions workers squatting
    // FOREVER, and the port-driven reaper that used to stand here could only
    // ever see the ports THIS run wants and only what it could prove was this
    // project's. A hub on a bumped port, a legacy install's workers, another
    // brand's leftovers: all invisible, all still holding memory and ports. An
    // ORPHAN of the emulator family is nobody's, so it goes whatever project it
    // names ([#781](https://github.com/Omega-JS-Stack/omega/issues/781)). The
    // strict command-shape match is what survives of
    // [#293](https://github.com/Omega-JS-Stack/omega/issues/293): live stacks,
    // reload watchers and other users' processes are never candidates.
    await this.reapMachineOrphans();

    // Then the leftovers no ORPHAN test can reach: a dead run's members that
    // still hang off another member of that same dead run. The record naming
    // them is about to be overwritten by this boot — read it while it still
    // exists ([#721](https://github.com/Omega-JS-Stack/omega/issues/721)).
    const recorded = this.readEmulatorOwnership();
    const ownership = {
      pids: recorded.pids,
      projectId: this.loadProjectId(projectDir) || recorded.projectId,
      rootPid: recorded.rootPid,
      ports: recorded.ports,
    };
    await this.reapStaleRecordedProcesses(ownership);

    // ONE bump-and-retry (#778): the allocator probed these ports seconds ago,
    // and on a machine that shares them with another brand's session a foreign
    // listener can take one between that probe and firebase-tools' bind. The
    // port the child could not bind is marked claimed, so the next allocation
    // moves that name off it, republishes the map, and boots again. A second
    // failure is no longer a race: something is sitting on that port, and the
    // report names it (and never signals it).
    const taken = new Set();

    try {
      return await this.bootEmulatorStack({ projectDir, environment, wanted, httpsCerts, taken });
    } catch (error) {
      if (!error?.addressInUsePort) {
        throw error;
      }

      taken.add(error.addressInUsePort);
      this.log(chalk.yellow(`  Port ${error.addressInUsePort}${error.addressInUseName ? ` (${error.addressInUseName})` : ''} was taken while the stack came up; reallocating around it and booting once more.`));

      try {
        return await this.bootEmulatorStack({ projectDir, environment, wanted, httpsCerts, taken });
      } catch (retryError) {
        if (!retryError?.addressInUsePort) {
          throw retryError;
        }

        throw new Error(formatAddressInUseFailure(
          { port: retryError.addressInUsePort, name: retryError.addressInUseName },
          this.describePortHolders(retryError.addressInUsePort),
        ));
      }
    }
  }

  /**
   * ONE boot attempt: allocate the ports, publish them, spawn firebase-tools,
   * and wait for the ready marker.
   *
   * Each attempt owns its stage watcher, because the watcher is torn down with
   * the emulator child (exitPromise below), so a failed attempt takes its
   * watcher with it and the retry starts a fresh one, instead of hot-reloading
   * into a stack that no longer exists (#778).
   * @param {object} attempt
   * @param {string} attempt.projectDir - The firebase project directory.
   * @param {string} attempt.environment - The environment each re-stage composes for.
   * @param {object} attempt.wanted - The wanted name to port map (firebase.json + https).
   * @param {object|null} attempt.httpsCerts - The mkcert pair, when HTTPS is on.
   * @param {Set<number>} attempt.taken - Ports this attempt may not allocate:
   *   the ones a previous attempt proved something else is holding.
   * @returns {Promise<{ child: ChildProcess, shutdown: () => Promise<void>, emulatorPorts: object, bumped: string[], exitPromise: Promise<object> }>}
   */
  async bootEmulatorStack({ projectDir, environment, wanted, httpsCerts, taken }) {
    // The stamp for THIS attempt, and the newest one owns the shared artifacts.
    // A first attempt's child can close LATE: after shutdown's SIGTERM/SIGKILL
    // races gave up on it, and after the retry published its own map. Both
    // attempts stamp the same process.pid, so the pid cannot tell them apart
    // ([#778](https://github.com/Omega-JS-Stack/omega/issues/778)).
    const attempt = this.activeAttempt = (this.activeAttempt || 0) + 1;
    const stageWatch = this.startStageWatch({ environment });

    const { ports: emulatorPorts, bumped } = await resolvePorts({
      wanted,
      pins: this.loadPortPins(projectDir),
      // A FRESH claimed set per attempt: the allocator claims every port it
      // hands out into it, so carrying one over would bump the whole map. The
      // only thing an attempt inherits is what the last one proved is taken.
      claimed: new Set(taken),
    });

    // Preflight: the allocator has relocated around every busy port it owns,
    // so anything still held is a port this run cannot move off. Report it now,
    // by name, instead of spawning a stack that never comes up and burning the
    // whole ready deadline first
    // ([#332](https://github.com/Omega-JS-Stack/omega/issues/332)).
    try {
      await this.preflightEmulatorPorts(projectDir, emulatorPorts);
    } catch (error) {
      // Nothing is spawned yet, but the stage watcher is: it is normally torn
      // down with the emulator child, and this boot will never have one.
      stageWatch.close();
      throw error;
    }

    // Bumped ports can't ride the committed firebase.json — materialize a
    // patched copy NEXT TO it (same dir, so relative paths keep resolving)
    // and boot with --config. The https flip ALWAYS materializes (hosting
    // moved to the internal port). Defaults-free runs spawn exactly as always.
    let configFlag = '';
    if (bumped.length > 0 || httpsCerts) {
      const resolvedName = 'firebase.resolved.json';
      const firebaseConfig = JSON5.parse(jetpack.read(path.join(projectDir, 'firebase.json')));
      for (const [name, port] of Object.entries(emulatorPorts)) {
        if (firebaseConfig.emulators?.[name]) {
          firebaseConfig.emulators[name].port = port;
        }
      }
      writeJson(path.join(projectDir, resolvedName), firebaseConfig);
      configFlag = ` --config ${resolvedName}`;
      if (bumped.length > 0) {
        this.log(chalk.yellow(`  Ports in use — bumped: ${bumped.map((name) => `${name}→${emulatorPorts[name]}`).join(', ')} (booting via ${resolvedName})`));
      }
      if (httpsCerts) {
        this.log(chalk.gray(`  Hosting moves to internal :${emulatorPorts.hosting} under the HTTPS proxy on :${emulatorPorts.https} (booting via ${resolvedName})`));
      }
    }

    // Publish the resolved map: env for our own children (functions workers
    // inherit through the firebase spawn; URL getters read OMEGA_*_PORT) and
    // the ports file for sibling processes of this brand (`omega test`
    // against a running emulator, `omega dev`, the e2e harness).
    Object.assign(process.env, portsToEnv(emulatorPorts));
    writePortsFile(projectDir, emulatorPorts);

    // Start the TLS terminator now — requests 502 until hosting is up, then
    // https://localhost:<https> serves the whole surface. Torn down with the
    // emulator child (close handler below).
    let httpsProxy = null;
    if (httpsCerts) {
      const { startLocalHttpsProxy } = require('@omega.js/devkit/local-https');
      httpsProxy = startLocalHttpsProxy({
        port: emulatorPorts.https,
        targetPort: emulatorPorts.hosting,
        certs: httpsCerts,
        log: (line) => this.log(chalk.green(`  ${line}`)),
      });
    }

    // Wipe stale firebase-tools debug logs + any leftover @omega.js/backend logs from older versions.
    this.sweepStaleLogs();

    // The emulator child's own log, beside firebase-tools' *-debug.log files.
    // The reset sentinel lets `omega test` ask this long-lived log for a fresh
    // slate mid-run; the poll + roll live in the shared child-log sink.
    const logPath = this.getLogsPath('emulator.log');
    const childLog = createChildLog({
      logPath,
      resetPath: this.getTempPath('emulator.log.reset'),
    });

    // Write pre-emulator info to log file
    if (process.env.TEST_EXTENDED_MODE) {
      EXTENDED_MODE_WARNING.forEach((line) => childLog.write(`${line}\n`));
      childLog.write('\n');
    }

    this.log(chalk.gray(`  Logs saving to: ${logPath}`));

    // OMEGA_ENVIRONMENT=testing is passed so Functions skip external API calls (emails, SendGrid)
    // hosting is included so localhost:5002 rewrites work (e.g., /omega -> omega_api)
    // pubsub is included so scheduled functions (omega_cronDaily) can be triggered in tests
    const env = {
      ...process.env,
      FORCE_COLOR: '1',
      OMEGA_ENVIRONMENT: 'testing',
    };

    // Internal calls (omega.getApiUrl) loop through the HTTPS proxy under the
    // local mkcert certificate. The child TRUSTS that root (#795) instead of
    // switching verification off wholesale — same handoff as `omega serve` and
    // `omega dev`'s legs, and Node prints no warning for it. A shell-set value
    // wins verbatim; only a host whose mkcert root vanished under existing
    // certs still takes the old bypass.
    if (httpsCerts) {
      const { mkcertCaRootPem } = require('@omega.js/devkit/local-https');
      const caPem = process.env.NODE_EXTRA_CA_CERTS || mkcertCaRootPem();

      if (caPem) {
        env.NODE_EXTRA_CA_CERTS = caPem;
      } else {
        env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        this.log(chalk.yellow('  mkcert root CA not found — internal calls fall back to NODE_TLS_REJECT_UNAUTHORIZED=0 (Node will warn)'));
      }
    }

    // Spawn `firebase emulators:start` as a background child through the host's
    // own shell (spawnShell owns which shell that is), so its PATH resolves
    // `firebase` the way the interactive shell does.
    //
    // `detached: true` puts the child into its own process group. We need this so that
    // shutdown() can kill the entire group (sh → firebase → java emulators) by
    // signalling the negative pgid. Without it, SIGTERM to the shell doesn't propagate
    // to firebase or its java grandchildren, leaving orphan firestore/pubsub processes.
    const child = spawnShell(`firebase emulators:start ${EMULATOR_FLAGS}${configFlag}`, {
      cwd: projectDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    // Wire readiness detection into the stdout/stderr handlers.
    //
    // We watch for firebase-tools' explicit "All emulators ready!" line — that's the
    // signal that function discovery + load is complete and the runtime can serve HTTP.
    // Port-listening alone isn't enough: firebase-tools binds the functions socket
    // ~5-10s before user functions are actually loadable, so HTTP requests fail with
    // ECONNREFUSED / "fetch failed" if we proceed when only the port is open.
    let readyResolve;
    let readyReject;
    const readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    let ready = false;
    const READY_MARKER = /All emulators ready/i;

    // The other end a boot can come to: firebase-tools failing to bind a port
    // the allocator handed it, because something took it in between (#778).
    // Read here rather than left to the ready deadline, so the retry starts in
    // the second the child gave up instead of three minutes later, and TAGGED,
    // so the caller retries this failure and no other.
    let inUsePort = null;
    const noteAddressInUse = (text) => {
      if (ready || inUsePort) {
        return;
      }

      const port = addressInUsePort(text, Object.values(emulatorPorts));

      if (!port) {
        return;
      }

      inUsePort = port;
      const name = portName(emulatorPorts, port);

      readyReject(Object.assign(
        new Error(`Emulator could not bind port ${port}${name ? ` (${name})` : ''}: something took it between the port probe and the bind`),
        { addressInUsePort: port, addressInUseName: name },
      ));
    };

    child.stdout.on('data', (data) => {
      const text = data.toString();
      process.stdout.write(data);
      childLog.write(data);
      if (!ready && READY_MARKER.test(text)) {
        ready = true;
        readyResolve();
      }
      noteAddressInUse(text);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      process.stderr.write(data);
      childLog.write(data);
      // firebase-tools prints the ready line to stderr sometimes — watch both.
      if (!ready && READY_MARKER.test(text)) {
        ready = true;
        readyResolve();
      }
      noteAddressInUse(text);
    });

    // Track exit state so shutdown() can resolve when the process is gone
    let exitPromiseResolve;
    const exitPromise = new Promise((resolve) => {
      exitPromiseResolve = resolve;
    });

    child.on('close', (code, signal) => {
      childLog.close();
      // The TLS proxy lives in THIS process — release the public port with
      // the stack (and drop any keep-alive sockets holding it open). Never
      // gated on the attempt: this handle is the attempt's OWN server, it can
      // reach no other attempt's proxy, and a retry that found this port still
      // held simply allocated around it. Skipping the close would strand the
      // port for the life of the CLI process (#778).
      if (httpsProxy) {
        httpsProxy.close();
        httpsProxy.closeAllConnections?.();
      }
      // Retract the published port map (clean shutdown). The resolved
      // firebase config is per-run scratch — remove it too.
      //
      // Both are shared BY NAME (one of each per project), and a retried boot
      // has already replaced both by the time a late first attempt closes:
      // retracting them here would unpublish the stack that is actually up and
      // delete the config it is running on. Only the attempt still in charge
      // cleans up (#778).
      if (this.activeAttempt === attempt) {
        clearPortsFile(projectDir);
        try { fs.unlinkSync(path.join(projectDir, 'firebase.resolved.json')); } catch (e) { /* not a bumped run */ }
      }
      exitPromiseResolve({ code, signal });
      // If we exited before becoming ready, fail the readiness wait too
      if (!ready) {
        readyReject(new Error(`Emulator child exited before ready (code=${code}, signal=${signal})`));
      }
    });

    // The stage watcher lives exactly as long as the emulator child — bound
    // here, before the readiness wait, so a boot that never comes up takes it
    // down too ([#304](https://github.com/Omega-JS-Stack/omega/issues/304)).
    exitPromise.then(() => stageWatch.close());

    // shutdown() signals the entire emulator process group (sh + firebase + java
    // grandchildren), waits up to 10s for clean exit, then escalates to SIGKILL.
    //
    // We use `process.kill(-pgid, ...)` instead of `child.kill(...)` because firebase
    // tools spawns several Java subprocesses (firestore + pubsub) that survive if
    // only the sh wrapper is killed. The negative PID targets the whole process group
    // (made possible by `detached: true` above).
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch (e) {
        // ESRCH = group already dead. EPERM = macOS kill(2) quirk when the
        // group's remaining members are zombies awaiting reap. Either way the
        // group is unreachable — and killGroup must NEVER throw out of
        // shutdown(): the un-awaited shutdown() in the SIGINT handlers turns
        // a throw into an unhandled rejection that crashes the CLI BEFORE
        // the orphan sweep + ports-file cleanup run (this exact crash leaked
        // 3 java emulators per e2e run). The port-based sweep after shutdown
        // is the safety net for anything a failed signal left behind.
        if (e.code !== 'ESRCH' && e.code !== 'EPERM') {
          this.log(chalk.yellow(`  killGroup(${signal}) failed: ${e.message} — relying on the orphan sweep`));
        }
      }
    };

    let shutdownDone = false;
    const shutdown = async () => {
      if (shutdownDone) {
        return;
      }

      // 0. Re-record the pid set while the tree is still attached. The boot
      // snapshot misses anything spawned since (function runtime workers come
      // and go), and once the parent is gone the descendants reparent to PID 1
      // — this is the last moment ownership is readable
      // ([#274](https://github.com/Omega-JS-Stack/omega/issues/274)).
      try {
        this.writeEmulatorPidRecord(child.pid, this.loadProjectId(projectDir), emulatorPorts);
      } catch (error) { /* the boot record still stands */ }

      // 1. Signal the process group (sh + firebase + direct children)
      if (child.exitCode === null && child.signalCode === null) {
        killGroup('SIGTERM');

        // Wait up to 5s for clean exit, then SIGKILL the group
        const exited = await Promise.race([
          exitPromise.then(() => true),
          new Promise((r) => setTimeout(() => r(false), 5000)),
        ]);

        if (!exited) {
          killGroup('SIGKILL');
          await Promise.race([
            exitPromise.then(() => true),
            new Promise((r) => setTimeout(() => r(false), 3000)),
          ]);
        }
      }

      // 2. Take the jars the group signal cannot reach, by pid, sweep whatever
      // orphaned outside the record, and prove the ports came back
      // ([#304](https://github.com/Omega-JS-Stack/omega/issues/304)). The
      // shared hub/storage ports belong to this run only when nothing bumped.
      await this.terminateRecordedEmulatorProcesses(emulatorPorts, { sweepShared: bumped.length === 0 });

      shutdownDone = true;
    };

    // Race the readiness marker against a deadline. A boot that never comes
    // up has still spawned: the shell, firebase, and any jar it got as far as.
    // Throwing straight out of here left them running and handed the caller no
    // handle to stop them, so a failed boot takes the same stop path a normal
    // one does before it propagates
    // ([#304](https://github.com/Omega-JS-Stack/omega/issues/304)). The
    // deadline is env-tunable and defaults high enough to absorb a slow port
    // sweep ([#332](https://github.com/Omega-JS-Stack/omega/issues/332)).
    const readyTimeoutMs = resolveReadyTimeout(process.env.OMEGA_EMULATOR_READY_TIMEOUT);
    try {
      await Promise.race([
        readyPromise,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`Emulator did not print "All emulators ready" within ${readyTimeoutMs}ms`)),
          readyTimeoutMs,
        )),
      ]);
    } catch (error) {
      await shutdown();
      throw error;
    }

    // The stack is UP and every java emulator exists — record the pids now, so
    // the post-shutdown sweep can prove which orphans are its own instead of
    // signaling whatever holds a port
    // ([#274](https://github.com/Omega-JS-Stack/omega/issues/274)). Non-fatal:
    // without a record the sweep falls back to command-line proof and spares
    // anything it cannot place.
    try {
      this.writeEmulatorPidRecord(child.pid, this.loadProjectId(projectDir), emulatorPorts);
    } catch (error) {
      this.logWarning(`Could not record emulator pids (${error.message}) — the orphan sweep will only spare, never over-reach`);
    }

    return { child, shutdown, emulatorPorts, bumped, exitPromise };
  }

  /**
   * Boot emulators and run a single command against them. Sends SIGTERM to the emulator
   * when the command exits (or this process is interrupted) and waits for clean shutdown.
   *
   * No current caller — `npx omega emulator`'s keep-alive flow boots through
   * execute() now; kept for programmatic embedding.
   * `npx omega test`'s auto-start path uses startEmulators() directly, so the runner
   * child's output rides the verb's own tee (`logs/test.log`), apart from emulator.log.
   *
   * @param {string} command - shell command to run while emulators are up
   */
  async runWithEmulator(command) {
    // shutdown() carries the whole teardown (recorded jars, orphan sweep, port
    // verdict), so both paths below just join it.
    const { shutdown, exitPromise } = await this.startEmulators();

    // Same synchronous handler and same three signals as execute() — see the
    // comment there.
    let stopCount = 0;
    const onStopSignal = () => {
      stopCount++;
      shutdown();
    };
    STOP_SIGNALS.forEach((signal) => process.on(signal, onStopSignal));

    try {
      // Run the user command; when it exits we tear down the emulator.
      const cmdChild = spawnShell(command, {
        cwd: this.main.firebaseProjectPath,
        env: { ...process.env, FORCE_COLOR: '1' },
        stdio: 'inherit',
      });

      const cmdExit = await new Promise((resolve) => {
        cmdChild.on('close', (code, signal) => resolve({ code, signal }));
      });

      STOP_SIGNALS.forEach((signal) => process.removeListener(signal, onStopSignal));
      await shutdown();
      await exitPromise;

      if (cmdExit.code !== 0) {
        throw Object.assign(new Error(`Command exited with code ${cmdExit.code}`), { code: cmdExit.code });
      }
    } catch (e) {
      STOP_SIGNALS.forEach((signal) => process.removeListener(signal, onStopSignal));
      await shutdown();
      throw e;
    }
  }

  /**
   * Sweep the ports this boot is about to bind and fail fast when one is held.
   *
   * The set is read from the firebase config, never hard-coded: the resolved
   * map covers everything the allocator owns, and the config's own `emulators`
   * block covers anything it does not (an eventarc or tasks port a brand
   * declared), which is the half that cannot bump. A lenient read matches
   * loadPortPins(): an unreadable config means no extra ports, never a boot
   * failure on its own.
   * @param {string} projectDir - The firebase project directory.
   * @param {object} emulatorPorts - This run's resolved port map.
   * @param {Function} [isFree] - Port probe (injectable).
   * @returns {Promise<Array<{name: string, port: number}>>} The plan that cleared.
   */
  async preflightEmulatorPorts(projectDir, emulatorPorts, isFree = isPortFree) {
    let declared = {};

    try {
      declared = declaredEmulatorPorts(JSON5.parse(jetpack.read(path.join(projectDir, 'firebase.json'))));
    } catch (error) { /* no readable config, so the resolved map is the whole plan */ }

    const planned = plannedEmulatorPorts(declared, emulatorPorts);
    await assertPlannedPortsFree(planned, isFree);

    return planned;
  }

  /**
   * Who is listening on a port right now: pid and command line, for a report.
   *
   * READ ONLY, deliberately: a port this run could not bind is held by someone
   * else's live process, and nothing in this file signals a process it cannot
   * prove is its own ([#274](https://github.com/Omega-JS-Stack/omega/issues/274),
   * [#778](https://github.com/Omega-JS-Stack/omega/issues/778)).
   * @param {number} port - The port to name a holder for.
   * @param {object} [seams]
   * @param {Function} [seams.listPids] - Port to pid lookup (injectable).
   * @param {Function} [seams.readCommand] - The `ps` read (injectable).
   * @returns {Array<{pid: number, command: string}>}
   */
  describePortHolders(port, { listPids = listListeningPids, readCommand = readProcessCommand } = {}) {
    return listPids(port).map((pid) => ({ pid: Number(pid), command: readCommand(pid) }));
  }

  /**
   * Read explicit port pins from the brand config's `ports` section (N7).
   * Lenient — a missing/broken config means no pins, never a boot failure.
   */
  loadPortPins(projectDir) {
    try {
      const { hasOmegaConfig, loadConfig } = require('@omega.js/config');
      const functionsDir = path.join(projectDir, 'dist');
      if (!hasOmegaConfig(functionsDir)) {
        return {};
      }
      const config = loadConfig(functionsDir, 'backend').config;
      return config.ports && typeof config.ports === 'object' ? config.ports : {};
    } catch (error) {
      return {};
    }
  }

  /**
   * The project this stack serves, read from the brand config. Lenient like
   * loadPortPins() — a missing/broken config means no project id, which the
   * ownership matcher treats as "no evidence", never a boot failure.
   */
  loadProjectId(projectDir) {
    try {
      const { hasOmegaConfig, loadConfig } = require('@omega.js/config');
      const functionsDir = path.join(projectDir, 'dist');
      if (!hasOmegaConfig(functionsDir)) {
        return null;
      }
      return loadConfig(functionsDir, 'backend').config.cloud?.config?.projectId || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * The ownership evidence this run can offer the sweep: the pids it recorded
   * when its stack came up, and the project it belongs to. Recorded pids age
   * out — see ownershipFromRecord().
   * @returns {{pids: number[], projectId: string|null, rootPid: number|null}}
   */
  readEmulatorOwnership() {
    return ownershipFromRecord(jetpack.read(this.getTempPath(PID_RECORD_FILE), 'json'));
  }

  /**
   * Record the stack's pids while it is UP, so the post-shutdown sweep can
   * prove which orphans are its own
   * ([#274](https://github.com/Omega-JS-Stack/omega/issues/274)).
   *
   * The emulator child's descendants cover firebase-tools' own tree — the java
   * emulators and every functions runtime worker it forks. The background
   * watcher is the one member that hangs off the CLI process instead, so it is
   * named separately ([#629](https://github.com/Omega-JS-Stack/omega/issues/629)).
   * The resolved port map rides along: it is what the NEXT boot's stale reap
   * waits on after it takes these pids down, since a pid it killed names no
   * port of its own ([#730](https://github.com/Omega-JS-Stack/omega/issues/730)).
   * @param {number} rootPid - The spawned child's pid.
   * @param {string|null} projectId - The project this stack serves.
   * @param {object} [ports] - This run's resolved port map.
   */
  writeEmulatorPidRecord(rootPid, projectId, ports) {
    const existing = this.readEmulatorOwnership();

    // UNION with what this run already recorded: a later snapshot can only see
    // what is still attached, and a child that orphaned in between is exactly
    // the one the sweep exists for. Pids of processes that have since exited
    // cost nothing — signaling one is a caught ESRCH.
    const previous = existing.pids.length > 0 && existing.rootPid === rootPid ? existing.pids : [];
    // NAME DEPENDENCY: if this record misses the watcher, the command-line fallback
    // (EMULATOR_COMMAND, /emulator|firebase/i) only catches it because watch.js bakes
    // the `emulator.log.reset` sentinel PATH into nodemon's --exec argv. Rename that
    // sentinel and the watcher stops matching — spared by every stop path, immortal.
    const watcher = this.backgroundWatcherPid ? collectDescendantPids(this.backgroundWatcherPid) : [];
    const pids = [...new Set([...previous, ...collectDescendantPids(rootPid), ...watcher])];

    writeJson(this.getTempPath(PID_RECORD_FILE), {
      pids: pids,
      projectId: projectId || null,
      rootPid: rootPid,
      ports: ports || {},
      startedAt: new Date().toISOString(),
    });

    return pids;
  }

  /**
   * Terminate the stack this run RECORDED, then prove its ports came back.
   *
   * The group signal in shutdown() reaches `sh`/firebase and its direct
   * children only: firebase-tools starts each java emulator in its OWN process
   * group, so the jars never see it, and they reparent to PID 1 the moment
   * their parent goes. A stop that escalates to SIGKILL (a firestore emulator
   * that does not finish its graceful stop inside the grace window) therefore
   * leaves the jars running, and the next brand's boot bumps around a squatter
   * that answers on the classic ports forever
   * ([#304](https://github.com/Omega-JS-Stack/omega/issues/304)). The pid
   * record written while the tree was still attached is the only surviving
   * link to them, so the stop path signals what it names, BY PID.
   *
   * Ownership stays proven per process — a recorded number whose live command
   * line is not emulator machinery is a recycled pid, never our jar — and the
   * port check only REPORTS: nothing is signaled for occupying a port
   * ([#274](https://github.com/Omega-JS-Stack/omega/issues/274)).
   *
   * The owned-orphan sweep runs BEFORE that check, because it can still free a
   * port: a jar the record never named (spawned after the last snapshot, then
   * reparented to PID 1) is the sweep's case, not the record's. Verifying
   * first spent the whole release window on a port the next step was about to
   * clear, then reported it as somebody else's.
   *
   * @param {object} emulatorPorts - This run's resolved port map.
   * @param {object} [options]
   * @param {boolean} [options.sweepShared] - Look at the shared hub/storage
   *   ports too (a defaults run owns them; a bumped run does not).
   */
  async terminateRecordedEmulatorProcesses(emulatorPorts, { sweepShared = true } = {}) {
    const ownership = this.readEmulatorOwnership();
    const targets = [];

    for (const recorded of ownership.pids) {
      const pid = Number(recorded);
      const command = readProcessCommand(pid);

      // Gone already (the group signal took it) or not ours anymore.
      if (!command || !isStoppableEmulatorProcess({ pid: pid, command: command }, ownership)) {
        continue;
      }

      targets.push(pid);
    }

    for (const pid of targets) {
      try { process.kill(pid, 'SIGTERM'); } catch (e) { /* exited between the read and the signal */ }
    }

    // Give them the grace window, then take whatever is still standing.
    const survivors = await this.waitForProcessesToExit(targets, STOP_GRACE_MS);

    for (const pid of survivors) {
      try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone in the meantime */ }
    }

    if (targets.length > 0) {
      this.log(chalk.gray(`  Stopped ${targets.length} recorded emulator process${targets.length > 1 ? 'es' : ''}${survivors.length > 0 ? ` (${survivors.length} needed SIGKILL)` : ''}.`));
    }

    // Anything of ours the record could not name is the sweep's to take, and
    // it runs while the ports still matter — before the verdict below.
    await this.terminateOrphanedEmulatorProcesses(emulatorPorts, { sweepShared: sweepShared });

    // The ports are the only proof that matters to the NEXT boot.
    const { https: _httpsPort, ...checkable } = emulatorPorts || {};
    const held = await emulatorOrphans.waitForPortsReleased(Object.values(checkable));

    if (held.length > 0) {
      this.logWarning(`Emulator ports still in use after shutdown: ${held.join(', ')} (everything this run could prove it owns is stopped; whatever holds them did not prove to be ours)`);
    }
  }

  /**
   * Poll a pid set until every one is gone or the window closes.
   * @param {number[]} pids - The pids to watch.
   * @param {number} timeoutMs - How long to wait in total.
   * @param {object} [seams]
   * @param {Function} [seams.readCommand] - The `ps` read (injectable).
   * @returns {Promise<number[]>} The pids still alive when the window closed.
   */
  async waitForProcessesToExit(pids, timeoutMs, { readCommand = readProcessCommand } = {}) {
    const deadline = Date.now() + timeoutMs;
    let alive = pids;

    while (alive.length > 0 && Date.now() < deadline) {
      await powertools.wait(emulatorOrphans.DEFAULT_POLL_INTERVAL_MS);
      alive = alive.filter((pid) => !!readCommand(pid));
    }

    return alive;
  }

  /**
   * Terminate processes still listening on THIS RUN's emulator ports after
   * shutdown. Firebase-tools spawns Java emulators (Firestore, Database,
   * PubSub) that often survive SIGTERM/SIGKILL of the firebase node process.
   * This sweep runs AFTER the main child exits, so anything still on these
   * ports is orphaned.
   *
   * Ownership is PROVEN per process, never inferred from the port: the sweep
   * used to signal whatever was listening and took down another project's live
   * emulator on the shared hub/storage ports
   * ([#274](https://github.com/Omega-JS-Stack/omega/issues/274)). A port only
   * decides where to LOOK; isOwnedEmulatorProcess() decides what to signal.
   *
   * N7: the sweep takes the RESOLVED port map — no map → no sweep. The shared
   * hub (4400) + storage (9199) ports are looked at only on a defaults run
   * (`sweepShared`); on a bumped run they belong to the incumbent.
   * @param {object} emulatorPorts - This run's resolved port map.
   * @param {object} [options]
   * @param {boolean} [options.sweepShared] - Include the shared hub/storage ports.
   * @param {Function} [options.isFree] - Port probe (injectable).
   * @param {Function} [options.listPids] - Port to pid lookup (injectable).
   */
  async terminateOrphanedEmulatorProcesses(emulatorPorts, { sweepShared = true, isFree = isPortFree, listPids = listListeningPids } = {}) {
    if (!emulatorPorts) {
      return;
    }

    // `https` is OUR in-process TLS proxy (closed with the child), never an
    // orphaned java emulator — sweeping it would signal this very process
    // on a close-timing race.
    const { https: _httpsPort, ...sweepable } = emulatorPorts;
    const ports = Object.values(sweepable);
    if (sweepShared) {
      ports.push(CLASSIC_PORTS.hub, CLASSIC_PORTS.storage);
    }

    const ownership = this.readEmulatorOwnership();

    // The probe is the only await, and it runs before a single signal is sent.
    // The kill loop itself stays synchronous, so Ctrl+C spam cannot land
    // between two signals of the same sweep.
    const { execSync } = require('child_process');
    let terminated = 0;
    let spared = 0;

    for (const port of await heldPorts(ports, isFree)) {
      for (const pid of listPids(port)) {
        try {
          const command = execSync(`ps -o command= -p ${pid} 2>/dev/null`, { encoding: 'utf8' }).trim();

          if (!isOwnedEmulatorProcess({ pid: pid, command: command }, ownership)) {
            spared++;
            continue;
          }

          process.kill(Number(pid), 'SIGKILL');
          terminated++;
        } catch (e) { /* vanished mid-check, or already gone */ }
      }
    }

    if (terminated > 0) {
      this.log(chalk.gray(`  Cleaned up ${terminated} orphaned emulator process${terminated > 1 ? 'es' : ''}.`));
    }

    if (spared > 0) {
      this.log(chalk.gray(`  Left ${spared} process${spared > 1 ? 'es' : ''} on these ports alone — not this project's emulator.`));
    }
  }

  /**
   * Pre-boot reap of every ORPHANED emulator-family process on the MACHINE
   * ([#781](https://github.com/Omega-JS-Stack/omega/issues/781)).
   *
   * The verdict, the escalation and the settle wait all live in
   * cli/commands/emulator-orphans.js, which reads the world through seams; this
   * is the wiring: the boot's own settle windows and the boot's voice.
   * @param {object} [seams] - The sweep's seams (tests state a process table here).
   */
  async reapMachineOrphans(seams) {
    await emulatorOrphans.reapMachineOrphans({
      graceMs: STOP_GRACE_MS,
      log: (message) => this.log(chalk.gray(`  ${message}`)),
      ...seams,
    });
  }

  /**
   * Pre-boot reap of a STALE pid record: the leftovers of a previous run that
   * died without teardown, taken BY PID, before this boot overwrites the file
   * that names them ([#721](https://github.com/Omega-JS-Stack/omega/issues/721)).
   *
   * The sibling sweep above only ever considers an ORPHAN, so it cannot reach a
   * dead run's member that still hangs off another member of that same dead run
   * — the reload watcher's usual shape while its root is unwinding — and
   * writeEmulatorPidRecord drops the previous record the moment a new root pid
   * appears. Between the two, a dead boot's nodemon survived every stop path
   * this framework has, forever.
   *
   * STALE is the first proof: the record's ROOT pid is gone, so the run that
   * wrote it is not around to own its own processes. A live root means a LIVE
   * record — this boot is a second stack beside a running one — and nothing in
   * it is anyone's to reap. A record that names no usable root at all proves
   * neither, and an unprovable root is not a kill order.
   *
   * IDENTITY is the second, and it is the whole safety story. A record is a
   * list of NUMBERS, the OS recycles numbers, and the run that could vouch for
   * them is by definition gone. So nothing is signalled on the number: the LIVE
   * row must still read as emulator machinery of this project AND hang off the
   * dead run itself (isReapableRecordedProcess). A pid whose row cannot be read
   * has no identity to prove and is never signalled. The escalation re-proves
   * it, because the grace window is long enough for a number to be freed and
   * handed out again — and there is no apologising to a SIGKILL.
   *
   * @param {{pids: number[], projectId: string|null, rootPid: number|null, ports: object}} ownership - The PREVIOUS record.
   * @param {object} [seams]
   * @param {Function} [seams.readProcess] - The `ps -o ppid=,command=` read (injectable).
   * @param {Function} [seams.kill] - The signal (injectable).
   * @param {Function} [seams.isFree] - Port probe for the settle wait (injectable).
   */
  async reapStaleRecordedProcesses(ownership, { readProcess = readProcessInfo, kill = process.kill, isFree = isPortFree } = {}) {
    const rootPid = Number(ownership?.rootPid);

    // Staleness is proved BY the root, so a record that names no usable one
    // proves nothing — and an unprovable root is not a kill order. Read the
    // other way ("no root answering"), a record written without a rootPid over
    // a LIVE stack of this same project reads as pure leftovers and the reap
    // takes the running firebase parent with it.
    if (!Number.isInteger(rootPid) || rootPid <= 1) {
      return;
    }

    // A root still answering is a run still up. A root whose number was
    // recycled onto a stranger reads the same and is also left alone: erring
    // toward "somebody is using this" is the only safe direction here.
    if (readProcess(rootPid)) {
      return;
    }

    const targets = [];
    let spared = 0;

    for (const recorded of ownership?.pids || []) {
      const pid = Number(recorded);

      // Never this run or its parent. `omega emulator` matches the machinery
      // signature by NAME, so a recorded number recycled onto this very process
      // would otherwise make the boot signal itself.
      if (pid === process.pid || pid === process.ppid) {
        continue;
      }

      const live = readProcess(pid);

      // Gone (nothing to do) or unreadable (no proof, so no kill order).
      if (!live) {
        continue;
      }

      if (!isReapableRecordedProcess({ pid: pid, ppid: live.ppid, command: live.command }, ownership)) {
        spared++;
        continue;
      }

      targets.push(pid);
    }

    for (const pid of targets) {
      try { kill(pid, 'SIGTERM'); } catch (e) { /* exited between the read and the signal */ }
    }

    // The exit watch reads through the same `ps` seam the identity proof does.
    const readCommand = (pid) => {
      const live = readProcess(pid);
      return live ? live.command : '';
    };

    const survivors = await this.waitForProcessesToExit(targets, STOP_GRACE_MS, { readCommand: readCommand });
    const killed = [];

    for (const pid of survivors) {
      const live = readProcess(pid);

      if (!live || !isReapableRecordedProcess({ pid: pid, ppid: live.ppid, command: live.command }, ownership)) {
        spared++;
        continue;
      }

      try {
        kill(pid, 'SIGKILL');
        killed.push(pid);
      } catch (e) { /* gone in the meantime */ }
    }

    // Only what actually went down: a target that outlived the grace window and
    // came back as somebody else's number is spared, so counting the kill
    // ORDERS would report it reaped and left alone in the same breath.
    const downed = targets.length - survivors.length + killed.length;

    if (downed > 0) {
      this.log(chalk.gray(`  Reaped ${downed} recorded process${downed > 1 ? 'es' : ''} left by a previous run${killed.length > 0 ? ` (${killed.length} needed SIGKILL)` : ''}.`));

      // A signal is not an exit: kill() returns while the kernel is still
      // unwinding the process, so a probe in the same tick asks about a
      // shutdown that has not happened yet, and a jar mid-unwind can answer
      // FREE on a port it is about to keep holding, which is exactly the
      // "probed free, then failed to bind" the retry above exists to catch.
      // The numbers go first, THEN the ports are asked
      // ([#778](https://github.com/Omega-JS-Stack/omega/issues/778)).
      const lingering = await this.waitForProcessesToExit(killed, STOP_GRACE_MS, { readCommand: readCommand });

      if (lingering.length > 0) {
        this.logWarning(`Pid${lingering.length > 1 ? 's' : ''} ${lingering.join(', ')} outlived SIGKILL; the port check below is the last word on ${lingering.length > 1 ? 'them' : 'it'}`);
      }

      // Same race the port-driven reaper answers above: a SIGKILLed JVM holds
      // its listener for a moment after the process is gone, and the allocator
      // probes these very ports a few lines later. A reap here is BY PID, so
      // nothing says which port each one held — the record's own map is the
      // set, and the worst case is the release window spent on a port a live
      // neighbour took over, which the log names before the allocator bumps
      // around it. `https` is not in it: that port belonged to the dead run's
      // in-process TLS proxy, never to a jar this reap could take.
      const { https: _httpsPort, ...settleable } = ownership?.ports || {};

      if (Object.keys(settleable).length === 0) {
        this.log(chalk.gray('  The record named no ports, so nothing was waited on; the allocation probe is the only check on what this reap just freed.'));
      }

      const held = await emulatorOrphans.waitForPortsReleased(Object.values(settleable), { isFree });

      if (held.length > 0) {
        this.log(chalk.gray(`  Port${held.length > 1 ? 's' : ''} ${held.join(', ')} still closing after the reap; the allocator will bump around ${held.length > 1 ? 'them' : 'it'}.`));
      }
    }

    if (spared > 0) {
      this.log(chalk.gray(`  Left ${spared} recorded pid${spared > 1 ? 's' : ''} alone — the number is no longer this project's emulator.`));
    }
  }
}

// Static, alongside the pipeline's precedent — the ownership decision is pure,
// so tests exercise it directly with real `ps` rows instead of live processes.
EmulatorCommand.resolveReadyTimeout = resolveReadyTimeout;
EmulatorCommand.heldPorts = heldPorts;
EmulatorCommand.listListeningPids = listListeningPids;
EmulatorCommand.PORT_LOOKUP_TIMEOUT_MS = PORT_LOOKUP_TIMEOUT_MS;
EmulatorCommand.plannedEmulatorPorts = plannedEmulatorPorts;
EmulatorCommand.assertPlannedPortsFree = assertPlannedPortsFree;
EmulatorCommand.addressInUsePort = addressInUsePort;
EmulatorCommand.isOwnedEmulatorProcess = isOwnedEmulatorProcess;
EmulatorCommand.isStoppableEmulatorProcess = isStoppableEmulatorProcess;
EmulatorCommand.isReapableRecordedProcess = isReapableRecordedProcess;
EmulatorCommand.readProcessInfo = readProcessInfo;
EmulatorCommand.ownershipFromRecord = ownershipFromRecord;
EmulatorCommand.collectDescendantPids = collectDescendantPids;

module.exports = EmulatorCommand;
