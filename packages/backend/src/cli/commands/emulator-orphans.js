/**
 * The machine-wide orphan reap every emulator boot runs before it claims a port
 * ([#781](https://github.com/Omega-JS-Stack/omega/issues/781)).
 *
 * Emulator processes outlive the run that started them whenever the parent is
 * killed by pid, force-killed, or torn down with its shell: firebase-tools puts
 * each emulator in its own process group, so the survivors reparent to PID 1
 * and hold memory and ports until somebody notices. Found on a real machine:
 * ~100 `functionsEmulatorRuntime` workers from a node version that machine no
 * longer runs, plus a hub on a BUMPED port with three java jars, parent gone
 * for hours.
 *
 * The two reapers this file joins could reach none of it. The port-driven one
 * only ever looked at the ports THIS run wants, and the record-driven one only
 * at pids a record still names — a hub on 4402 belonging to a legacy run is
 * outside both by construction.
 *
 * **The verdict is parentage AND a strict family match, both required, and no
 * ownership proof at all.** An orphan of the emulator family is NOBODY's: it is
 * reaped whatever project it names (Ian 2026-09-03, docs/shared/rulings.md),
 * which supersedes the [#293](https://github.com/Omega-JS-Stack/omega/issues/293)
 * line that another brand's orphans stay. The #293 lesson survives as the
 * FAMILY half: a name matching `/emulator|firebase/i` killed another session's
 * reload watcher, so nothing here matches on a name, on a port, or on the words
 * `node`, `java`, `firebase` or `firebase-functions` alone — only on the exact
 * command shapes below: the hub, the functions runtime worker, the functions
 * discovery server, an emulator jar out of the firebase cache, and puppeteer's
 * headless browser.
 *
 * Everything the sweep reads or does goes through a seam, so its verdicts are
 * testable against real `ps` rows without a single live process.
 */

// Libraries
const powertools = require('node-powertools');
const { isPortFree } = require('@omega.js/config');
// ONE snapshot of every process on the machine, read once: two `ps` calls describe
// two moments. STOP_GRACE_MS lives in devkit's process-tree, where the emulator command reads it too,
// so both grant SIGTERM the same grace.
const { readProcessTableText, parseProcessTable, STOP_GRACE_MS } = require('@omega.js/devkit/process-tree');

const DEFAULT_PORT_RELEASE_TIMEOUT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 100;

// The hub: `firebase emulators:start` (or `:exec`), reached either through the
// bin on PATH or through firebase-tools' own entry file. The VERB is what makes
// it the hub — `firebase deploy` is a live publish and never matches.
const HUB_BIN = /(^|\/)firebase(\.js)?\s+(emulators:start|emulators:exec)\b/;
const HUB_TOOLS_ENTRY = /firebase-tools\/lib\/bin\/firebase\.js\b/;
const HUB_VERB = /\bemulators:(start|exec)\b/;

// The functions worker, by the module path firebase-tools runs it as. No node
// version and no install prefix is part of it: the pile found on the machine
// came from a node v22 install beside a v24 one.
const FUNCTIONS_WORKER = /firebase-tools\/lib\/emulator\/functionsEmulatorRuntime\b/;

// The functions DISCOVERY server: firebase-tools runs the functions source's
// own `firebase-functions` bin to read the manifest off a random port, then
// asks it to quit — so a hub that dies inside that window leaves it holding the
// port forever ([#805](https://github.com/Omega-JS-Stack/omega/issues/805)).
// A node RUNNING one of its two entry paths is the whole match: the words
// `firebase-functions` in an argv are somebody reading the package, not it. The
// path is reached from a space as well as a slash — a hub started inside the
// functions source spawns it with a bare-relative path and nothing before it.
const NODE_BIN = /(^|\/)node\s/;
const FUNCTIONS_DISCOVERY_BIN = /(^|[\s/])node_modules\/\.bin\/firebase-functions(\s|$)/;
const FUNCTIONS_DISCOVERY_ENTRY = /(^|[\s/])firebase-functions\/lib\/bin\/firebase-functions\.js(\s|$)/;

// An emulator jar, by all four parts together: a java binary, a `-jar`, the
// firebase emulator cache the jar was downloaded into, and a `.jar`. A jar
// somewhere else on disk is somebody's application.
const JAVA_BIN = /(^|\/)java\s/;
const JAR_FLAG = /\s-jar\s/;
const JAR_PATH = /-jar\s+(\S*\/firebase\/emulators\/\S*\.jar)\b/;

// Puppeteer's browser, by the temp profile it is launched with. Only puppeteer
// ever creates a `puppeteer_dev_chrome_profile-` directory, so the flag alone
// separates a lane's headless Chrome from the one a user opened from Finder.
const PUPPETEER_PROFILE = /--user-data-dir=\S*puppeteer_dev_chrome_profile-/;

// Which emulator a jar is, decided on the JAR PATH rather than the argv: the
// firestore jar is launched with `--database-edition standard`, so reading the
// whole command line calls it the database emulator. First match wins.
const JAR_NAMES = [
  { pattern: /firestore/i, label: 'firestore jar' },
  { pattern: /pubsub/i, label: 'pubsub jar' },
  { pattern: /database/i, label: 'database jar' },
  { pattern: /storage/i, label: 'storage jar' },
];

/**
 * Which emulator jar a java command line is running, by its jar path.
 * @param {string} command - Full command line from ps.
 * @returns {string} The short label; `emulator jar` for one the cache grows later.
 */
function describeJar(command) {
  const jar = JAR_PATH.exec(command);
  const named = JAR_NAMES.find((entry) => entry.pattern.test(jar ? jar[1] : ''));

  return named ? named.label : 'emulator jar';
}

/**
 * Does this command line run the firebase emulator hub?
 * @param {string} command - Full command line from ps.
 * @returns {boolean}
 */
function isEmulatorHub(command) {
  return HUB_BIN.test(command) || (HUB_TOOLS_ENTRY.test(command) && HUB_VERB.test(command));
}

/**
 * Does this command line run the functions discovery server?
 * @param {string} command - Full command line from ps.
 * @returns {boolean}
 */
function isFunctionsDiscovery(command) {
  return NODE_BIN.test(command)
    && (FUNCTIONS_DISCOVERY_BIN.test(command) || FUNCTIONS_DISCOVERY_ENTRY.test(command));
}

/**
 * Does this command line run an emulator jar out of the firebase cache?
 * @param {string} command - Full command line from ps.
 * @returns {boolean}
 */
function isEmulatorJar(command) {
  return JAVA_BIN.test(command) && JAR_FLAG.test(command) && JAR_PATH.test(command);
}

// The WHOLE family, as one table: the shapes and their short names have a
// single home, so the verdict and the log line can never come to disagree.
const FAMILY_SHAPES = [
  { matches: isEmulatorHub, label: () => 'firebase hub' },
  { matches: (command) => FUNCTIONS_WORKER.test(command), label: () => 'functions worker' },
  { matches: isFunctionsDiscovery, label: () => 'functions discovery server' },
  { matches: (command) => PUPPETEER_PROFILE.test(command), label: () => 'puppeteer chrome' },
  { matches: isEmulatorJar, label: describeJar },
];

/**
 * The short name for a family member's command line, for the boot's one line.
 * @param {string} command - Full command line from ps.
 * @returns {string|null} The label, or null when the command is not family.
 */
function describeFamilyMember(command) {
  const text = String(command || '');
  const shape = FAMILY_SHAPES.find((entry) => entry.matches(text));

  return shape ? shape.label(text) : null;
}

/**
 * Is this row an ORPHANED emulator-family process of THIS user?
 *
 * Three things, all required, and no ownership proof among them:
 *
 *   1. ORPHANED — `ppid === 1`. A live `omega dev`, a hand-run
 *      `firebase emulators:start`, a second brand's stack and another agent
 *      session all keep a live parent, so none of them is ever a candidate.
 *   2. OURS TO SIGNAL — the row's uid is this user's. Missing uid evidence
 *      proves nothing and reads as "not a candidate".
 *   3. FAMILY — one of the exact command shapes above. This is the half that
 *      keeps the reload watcher alive: nodemon runs at PID 1 with a live
 *      session behind it and names firebase paths in its argv.
 * @param {{pid: number|string, ppid: number|string, uid: number|string, command: string}} row - One ps row.
 * @param {number} uid - This user's uid (`process.getuid()`).
 * @returns {boolean}
 */
function isOrphanedEmulatorFamily(row, uid) {
  const pid = Number(row?.pid);
  const owner = Number(uid);

  // PID 1 is init, and a non-numeric row is a parse failure — never candidates.
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }

  if (Number(row?.ppid) !== 1) {
    return false;
  }

  if (!Number.isInteger(owner) || Number(row?.uid) !== owner) {
    return false;
  }

  return describeFamilyMember(row?.command) !== null;
}

/**
 * Every port a command line publishes (`--port 9152`, `--port=8085`,
 * `--websocket_port 9150`).
 *
 * A reap is BY PID, so nothing else says which ports the process held — and a
 * SIGKILLed JVM keeps its listener for a moment after the process is gone,
 * which is exactly the "probed free, then failed to bind" race the boot's retry
 * exists to catch ([#778](https://github.com/Omega-JS-Stack/omega/issues/778)).
 * @param {string} command - Full command line from ps.
 * @returns {number[]}
 */
function publishedPorts(command) {
  return [...String(command || '').matchAll(/--[\w-]*port[=\s](\d+)/g)].map((match) => Number(match[1]));
}

/**
 * One pid's row right now, for the re-read that precedes a SIGKILL.
 * @param {number|string} pid - The pid to read.
 * @returns {{pid: number, ppid: number, uid: number, command: string}|null}
 */
function readProcessRow(pid) {
  const { execSync } = require('child_process');

  try {
    const text = execSync(`ps -o pid=,ppid=,uid=,command= -p ${Number(pid)} 2>/dev/null`, { encoding: 'utf8' });

    return parseProcessTable(text)[0] || null;
  } catch (error) {
    // Unreadable is not "gone": the escalation re-proves identity from this
    // row, and no row is no proof, so the pid is spared either way.
    return null;
  }
}

/**
 * Poll a pid set until every one is gone or the window closes.
 *
 * ONE snapshot per pass, indexed by pid, rather than a `ps` per pid: the pile
 * this sweep exists for was ~100 processes deep, and a per-pid read would fork
 * a hundred times every 100ms for the whole grace window.
 * @param {number[]} pids - The pids to watch.
 * @param {number} timeoutMs - How long to wait in total.
 * @param {Function} readTable - The `ps -A` snapshot seam.
 * @param {number} pollIntervalMs - How often to look.
 * @returns {Promise<number[]>} The pids still alive when the window closed.
 */
async function waitForExit(pids, timeoutMs, readTable, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  let alive = pids;

  while (alive.length > 0 && Date.now() < deadline) {
    await powertools.wait(pollIntervalMs);

    const running = new Set(parseProcessTable(readTable()).map((row) => row.pid));

    alive = alive.filter((pid) => running.has(Number(pid)));
  }

  return alive;
}

/**
 * Poll a port set until nothing is listening or the window closes.
 * @param {number[]} ports - The ports to watch.
 * @param {object} [options]
 * @param {Function} [options.isFree] - The port probe seam.
 * @param {number} [options.timeoutMs] - How long to wait in total.
 * @param {number} [options.pollIntervalMs] - How often to look.
 * @returns {Promise<number[]>} The ports still held when the window closed.
 */
async function waitForPortsReleased(ports, {
  isFree = isPortFree,
  timeoutMs = DEFAULT_PORT_RELEASE_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let held = [...new Set(ports)];

  while (held.length > 0 && Date.now() < deadline) {
    const free = await Promise.all(held.map((port) => isFree(port)));
    held = held.filter((port, index) => !free[index]);

    if (held.length > 0) {
      await powertools.wait(pollIntervalMs);
    }
  }

  return held;
}

/**
 * The boot's one line, when anything went down.
 * @param {Array<{pid: number, label: string}>} reaped - What went down.
 * @param {number[]} killed - Which of them needed SIGKILL.
 * @returns {string}
 */
function formatReapLine(reaped, killed) {
  const plural = reaped.length > 1 ? 'es' : '';
  const escalated = killed.length > 0 ? ` (${killed.length} needed SIGKILL)` : '';
  const named = reaped.map((entry) => `${entry.pid} ${entry.label}`).join(', ');

  return `Reaped ${reaped.length} orphaned emulator process${plural} left by earlier runs${escalated}: ${named}.`;
}

/**
 * Reap every ORPHANED emulator-family process on the machine.
 *
 * SIGTERM to every match, the grace window, then SIGKILL to whatever is still
 * standing — and the survivor's row is READ AGAIN first, because the window is
 * long enough for a number to be freed and handed out again, and there is no
 * apologising to a SIGKILL. Then the ports those rows published are waited on,
 * so the allocator that probes them moments later is not racing a JVM that is
 * still unwinding.
 * @param {object} [options]
 * @param {number} [options.uid] - This user's uid.
 * @param {Function} [options.readTable] - The `ps -A` snapshot seam.
 * @param {Function} [options.readProcess] - The per-pid `ps` seam.
 * @param {Function} [options.kill] - The signal seam.
 * @param {Function} [options.isFree] - The port probe seam.
 * @param {Function} [options.log] - Where the one line goes (silent by default).
 * @param {number} [options.graceMs] - How long a SIGTERM gets before SIGKILL.
 * @param {number} [options.portReleaseTimeoutMs] - How long a freed port gets to come back.
 * @param {number} [options.pollIntervalMs] - How often either wait looks.
 * @returns {Promise<{reaped: Array<{pid: number, label: string}>, killed: number[]}>}
 */
async function reapMachineOrphans({
  // A host with no `process.getuid` (Windows) hands the verdict no uid, and
  // "no uid proves nothing" turns the whole sweep into a silent no-op there —
  // which is the right answer on the one platform these emulators do not
  // reparent to PID 1 on.
  uid = typeof process.getuid === 'function' ? process.getuid() : undefined,
  readTable = readProcessTableText,
  readProcess = readProcessRow,
  kill = process.kill,
  isFree = isPortFree,
  log = () => {},
  graceMs = STOP_GRACE_MS,
  portReleaseTimeoutMs = DEFAULT_PORT_RELEASE_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  const targets = parseProcessTable(readTable())
    .filter((row) => isOrphanedEmulatorFamily(row, uid))
    // The sweep is the only signaller here with no ownership proof at all, so
    // the two numbers it must never send a signal to are named outright.
    .filter((row) => row.pid !== process.pid && row.pid !== process.ppid);

  if (targets.length === 0) {
    return { reaped: [], killed: [] };
  }

  for (const target of targets) {
    try { kill(target.pid, 'SIGTERM'); } catch (e) { /* exited between the read and the signal */ }
  }

  const survivors = await waitForExit(targets.map((target) => target.pid), graceMs, readTable, pollIntervalMs);
  const killed = [];

  for (const pid of survivors) {
    const live = readProcess(pid);

    if (!isOrphanedEmulatorFamily(live, uid)) {
      continue;
    }

    try {
      kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch (e) { /* gone in the meantime */ }
  }

  await waitForExit(killed, graceMs, readTable, pollIntervalMs);

  // Only what actually went down: a target that outlived the grace window and
  // came back as somebody else's number was spared, and reporting it reaped
  // would name a pid this sweep never took.
  const spared = survivors.filter((pid) => !killed.includes(pid));
  const reaped = targets
    .filter((target) => !spared.includes(target.pid))
    .map((target) => ({ pid: target.pid, label: describeFamilyMember(target.command) }));

  if (reaped.length > 0) {
    log(formatReapLine(reaped, killed));

    const ports = targets
      .filter((target) => !spared.includes(target.pid))
      .flatMap((target) => publishedPorts(target.command));

    await waitForPortsReleased(ports, { isFree: isFree, timeoutMs: portReleaseTimeoutMs, pollIntervalMs: pollIntervalMs });
  }

  return { reaped: reaped, killed: killed };
}

module.exports = {
  parseProcessTable: parseProcessTable,
  isOrphanedEmulatorFamily: isOrphanedEmulatorFamily,
  describeFamilyMember: describeFamilyMember,
  reapMachineOrphans: reapMachineOrphans,
  waitForPortsReleased: waitForPortsReleased,
  readProcessTableText: readProcessTableText,
  readProcessRow: readProcessRow,
  DEFAULT_POLL_INTERVAL_MS: DEFAULT_POLL_INTERVAL_MS,
};
