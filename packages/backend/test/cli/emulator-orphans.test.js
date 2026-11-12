/**
 * Test: every emulator boot reaps the machine's ORPHANED emulator-family
 * processes before it claims a port
 * ([#781](https://github.com/Omega-JS-Stack/omega/issues/781)).
 *
 * Found on a real machine: ~100 `functionsEmulatorRuntime` workers from a
 * legacy node v22 firebase-tools, plus a hub on a bumped port with three java
 * jars, all reparented to PID 1 with their parents gone for hours. Nothing in
 * this framework could see any of it: the port-driven reaper only looked at
 * the ports THIS run wanted and only signalled what it could prove was this
 * project's, and the record-driven reap only reaches pids a record still names.
 *
 * Run: npx omega test backend:cli/emulator-orphans
 *
 * The verdict is pure (a ps row in, a boolean out) and the sweep reads the
 * world through seams, so every case below states a process table and reads
 * back exactly what would have been signalled — nothing real is touched. The
 * rows are copied from `ps -A -o pid=,ppid=,uid=,command=` on the machine that
 * reported this, except the rows marked BUILT below: shapes firebase-tools
 * launches that were not running when the snapshot was taken.
 *
 * The one exception is the real-process drill at the bottom, which spawns its
 * own idle node, orphans it, and runs the REAL sweep against the REAL `ps`.
 * Its `kill` seam forwards the signal only for the pids this file spawned and
 * merely RECORDS anything else the sweep matched: the sweep is machine-wide by
 * design, and a test run is not the place to exercise that half.
 */

// Libraries
const os = require('os');
const net = require('net');
const path = require('path');
const childProcess = require('child_process');
const jetpack = require('fs-jetpack');

const EmulatorCommand = require('../../dist/cli/commands/emulator.js');
const orphans = require('../../dist/cli/commands/emulator-orphans.js');
const { CLASSIC_PORTS, isPortFree } = require('../../dist/vendor/config/ports.js');
const { writeJson } = require('../../dist/vendor/devkit/write-json.js');
const { STOP_GRACE_MS } = require('../../dist/vendor/devkit/process-tree.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

const { parseProcessTable, isOrphanedEmulatorFamily, describeFamilyMember, reapMachineOrphans } = orphans;

// This user, and somebody else (root owns half the rows in any snapshot).
const UID = 501;
const OTHER_UID = 0;

// Where an orphan lands, and two live parents: this session's own boot, and a
// terminal a developer typed `firebase emulators:start` into.
const ORPHANED = 1;

// Every temp root the drill writes carries this, and it is the ONLY thing the
// drill will send a real signal to.
const DRILL_MARKER = 'omega-orphan-drill-';
const OUR_BOOT = 34965;
const A_TERMINAL = 51900;

// ─── REAL rows (2026-09-03, ppid varies per case) ───

// The hub, both shapes: the bin on PATH, and (BUILT) firebase-tools' own entry
// file, the form an `emulators:exec` lane runs.
const HUB = 'node /Users/ian/.nvm/versions/node/v24.15.0/bin/firebase emulators:start --only functions,firestore,auth,database,hosting,pubsub';
const HUB_TOOLS_ENTRY = 'node /Users/ian/.nvm/versions/node/v22.22.1/lib/node_modules/firebase-tools/lib/bin/firebase.js emulators:exec --project demo-other-brand npm test';

// The functions worker — the shape that piled up ~100 deep, from the LEGACY
// node v22 install, which is why no path or version can be part of the match.
const WORKER = '/Users/ian/.nvm/versions/node/v22.22.1/bin/node /Users/ian/.nvm/versions/node/v22.22.1/lib/node_modules/firebase-tools/lib/emulator/functionsEmulatorRuntime';

// The functions DISCOVERY server: firebase-tools spawns the functions source's
// own `firebase-functions` bin with a random 8000-8999 PORT, reads the manifest
// off it, then asks it to quit. A hub killed inside that window leaves it with
// no parent and no timer. Real row, found on switchboard 2026-09-06: started
// two days earlier, ppid 1, still holding port 8615
// ([#805](https://github.com/Omega-JS-Stack/omega/issues/805)).
const DISCOVERY = 'node targets/backend/node_modules/.bin/firebase-functions targets/backend/dist';
// BUILT: the file that bin is a symlink to, the form a run through the entry
// file itself prints.
const DISCOVERY_ENTRY = '/Users/ian/.nvm/versions/node/v24.15.0/bin/node /Users/ian/Developer/Repositories/StreamForge-App/switchboard/targets/backend/node_modules/firebase-functions/lib/bin/firebase-functions.js /Users/ian/Developer/Repositories/StreamForge-App/switchboard/targets/backend/dist';
// BUILT: the same spawn from a backend target that IS the cwd, so firebase-tools
// hands it a bare-relative source dir and nothing precedes `node_modules`.
const DISCOVERY_RELATIVE = 'node node_modules/.bin/firebase-functions dist';

// The jars, from the hub that survived on port 4402. The firestore one carries
// `--database-edition standard`, so a naive name match calls it the database.
const FIRESTORE_JAR = 'java -Dgoogle.cloud_firestore.debug_log_level=FINE -Duser.language=en -jar /Users/ian/.cache/firebase/emulators/cloud-firestore-emulator-v1.21.0.jar --host 127.0.0.1 --port 9152 --websocket_port 9150 --database-edition standard --project_id demo-other-brand --single_project_mode true';
const DATABASE_JAR = 'java -Duser.language=en -jar /Users/ian/.cache/firebase/emulators/firebase-database-emulator-v4.11.2.jar --host 127.0.0.1 --port 9153 --functions_emulator_port 9155';
const PUBSUB_JAR = 'java -jar /Users/ian/.cache/firebase/emulators/pubsub-emulator-0.8.34/pubsub-emulator/lib/cloud-pubsub-emulator-0.8.34-all.jar --host=127.0.0.1 --port=9154';
// BUILT: the storage rules runtime, and a jar the emulator cache grows later.
const STORAGE_JAR = 'java -jar /Users/ian/.cache/firebase/emulators/cloud-storage-rules-runtime-v1.1.3.jar';
const UNKNOWN_JAR = 'java -jar /Users/ian/.cache/firebase/emulators/some-future-emulator-v1.0.0.jar --port 9160';

// Puppeteer's browser: the temp profile name is the whole signal — only
// puppeteer ever creates a `puppeteer_dev_chrome_profile-` directory.
const PUPPETEER_CHROME = '/Users/ian/.cache/puppeteer/chrome/mac_arm-140.0.7339.80/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --allow-pre-commit-input --disable-background-networking --headless=new --user-data-dir=/var/folders/gx/7g25kfls0c96yfb6nt3bsg1m0000gn/T/puppeteer_dev_chrome_profile-a1B2c3 --remote-debugging-port=0';

// ─── REAL rows that must survive, even at PID 1 ───

const USER_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// BUILT. devkit's port-hold and boot-child are LIBRARY modules a lane requires
// in-process — they are never a spawned argv, so a command line naming one is
// always somebody else reading the file (an editor, a grep, a node -e).
const EDITOR_ON_PORT_HOLD = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron /Users/ian/Developer/Repositories/Omega/omega/packages/devkit/src/test/port-hold.js';
// BUILT. An editor sitting on the discovery server's own bin file, and one on a
// source file of the same package: a command line that NAMES `firebase-functions`
// is not a node running it.
const EDITOR_ON_DISCOVERY_BIN = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron /Users/ian/Developer/Repositories/StreamForge-App/switchboard/targets/backend/node_modules/firebase-functions/lib/bin/firebase-functions.js';
const EDITOR_ON_FUNCTIONS_SOURCE = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron /Users/ian/Developer/Repositories/StreamForge-App/switchboard/targets/backend/node_modules/firebase-functions/lib/common/providers/https.js';
const OMEGA_CLI = 'node /Users/ian/Developer/Repositories/Omega/omega/node_modules/.bin/omega emulator';
const MGR_CLI = 'node /Users/ian/Developer/Repositories/Omega/omega/node_modules/.bin/mgr dev';
const FIREBASE_DEPLOY = 'node /Users/ian/.nvm/versions/node/v24.15.0/bin/firebase deploy --only functions --project omegajs';
// The reload watcher: it runs with PPID 1 while its session is very much alive,
// and its argv names firebase paths — the row the loose name regex killed
// ([#293](https://github.com/Omega-JS-Stack/omega/issues/293)).
const RELOAD_WATCHER = 'node /Users/ian/.nvm/versions/node/v22.22.1/bin/nodemon --on-change-only --delay 1 --watch /Users/ian/Developer/Repositories/Omega/omega/packages/backend/src --ext js,json --exec node -e "fs.writeFileSync(\'/Users/ian/Developer/Repositories/Omega/omega/brands/sandbox-brand/targets/backend/.temp/emulator.log.reset\',\'\')"';

/**
 * A fixture process table plus the seams the sweep reads the world through.
 *
 * `readTable` renders the rows exactly as `ps -A -o pid=,ppid=,uid=,command=`
 * does, `readProcess` is the per-pid re-read the escalation proves itself with,
 * `kill` is the signal, and `isFree` is the port probe — so a case states what
 * is running and reads back what would have been signalled. Nothing leaves this
 * process.
 * @param {object} table - pid → { ppid, uid, command } as ps would report it.
 * @param {object} [options]
 * @param {Function} [options.afterTerm] - What SIGTERM does (default: it exits).
 * @param {number[]} [options.busyPorts] - Ports the probe reports as still held.
 */
function processTable(table, { afterTerm, busyPorts = [] } = {}) {
  const live = new Map(Object.entries(table).map(([pid, row]) => [Number(pid), { uid: UID, ...row }]));
  const signals = [];
  const probed = [];

  return {
    signals: signals,
    probed: probed,
    live: live,
    signalled: (pid) => signals.filter((entry) => entry.pid === Number(pid)).map((entry) => entry.signal),
    seams: {
      uid: UID,
      graceMs: 50,
      readTable: () => [...live.entries()].map(([pid, row]) => `  ${pid}  ${row.ppid}  ${row.uid} ${row.command}`).join('\n'),
      readProcess: (pid) => {
        const row = live.get(Number(pid));

        return row ? { pid: Number(pid), ppid: row.ppid, uid: row.uid, command: row.command } : null;
      },
      kill: (pid, signal) => {
        signals.push({ pid: Number(pid), signal: signal });

        if (signal === 'SIGTERM') {
          (afterTerm || ((target, rows) => rows.delete(target)))(Number(pid), live);
        } else {
          live.delete(Number(pid));
        }
      },
      isFree: async (port) => {
        probed.push(port);

        return !busyPorts.includes(port);
      },
    },
  };
}

/** A row as ps prints it, for the pure-verdict cases. */
function row(pid, ppid, command, uid = UID) {
  return { pid: pid, ppid: ppid, uid: uid, command: command };
}

/**
 * The idle stand-in for a functions worker: a real node process whose argv path
 * is the family shape, so the REAL matcher sees a REAL row for it.
 * @param {string} dir - The temp root to write it under.
 * @returns {string} The script path.
 */
function writeWorkerScript(dir) {
  const script = path.join(dir, 'firebase-tools', 'lib', 'emulator', 'functionsEmulatorRuntime.js');

  jetpack.write(script, 'setInterval(() => {}, 1000);\n');

  return script;
}

/**
 * Poll `probe` until it answers truthy or the window closes.
 * @param {Function} probe - Returns the answer, or a falsy value to keep waiting.
 * @param {number} timeoutMs - How long to keep asking.
 * @returns {Promise<*>} The answer, or null when the window closed.
 */
async function until(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const answer = probe();

    if (answer) {
      return answer;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return null;
}

/** Every live pid whose command line contains `needle`, from the real `ps`. */
function livePidsRunning(needle) {
  return parseProcessTable(orphans.readProcessTableText())
    .filter((entry) => entry.command.includes(needle))
    .map((entry) => entry.pid);
}

module.exports = defineCases({
  description: 'machine-wide reap of orphaned emulator-family processes (#781)',
  type: 'group',
  timeout: 60000,

  tests: [
    // ─── the snapshot ───

    {
      name: 'a-real-ps-snapshot-parses-into-rows',
      async run({ expect }) {
        const text = [
          `    1     0     0 /sbin/launchd`,
          `73529     1   501 ${FIRESTORE_JAR}`,
          `74155   ${OUR_BOOT}   501 ${PUBSUB_JAR}`,
          ``,
          `garbage line with no numbers`,
        ].join('\n');

        const rows = parseProcessTable(text);

        expect(rows.length, 'blank and unparseable lines are dropped, never guessed at').toBe(3);
        expect(rows[0]).toEqual({ pid: 1, ppid: 0, uid: 0, command: '/sbin/launchd' });
        expect(rows[1].pid).toBe(73529);
        expect(rows[1].ppid).toBe(1);
        expect(rows[1].uid).toBe(501);
        expect(rows[1].command, 'the command keeps every flag and space it was printed with').toBe(FIRESTORE_JAR);
        expect(rows[2].ppid).toBe(OUR_BOOT);
        expect(parseProcessTable('')).toEqual([]);
        expect(parseProcessTable(null)).toEqual([]);
      },
    },

    // ─── the two proofs: orphaned AND family ───

    {
      name: 'this-sessions-live-stack-is-untouched',
      async run({ expect }) {
        // Every member of a LIVE stack hangs off the boot that spawned it, so
        // the sweep never considers it — the boot cannot eat its own tail.
        expect(isOrphanedEmulatorFamily(row(37088, OUR_BOOT, FIRESTORE_JAR), UID)).toBe(false);
        expect(isOrphanedEmulatorFamily(row(37360, OUR_BOOT, PUBSUB_JAR), UID)).toBe(false);
        expect(isOrphanedEmulatorFamily(row(37361, OUR_BOOT, WORKER), UID)).toBe(false);
      },
    },

    {
      name: 'a-hand-run-hub-in-a-terminal-is-untouched',
      async run({ expect }) {
        // A developer typed `firebase emulators:start` in a shell that is still
        // open: the shell is its parent, so it is nobody's leftover.
        expect(isOrphanedEmulatorFamily(row(51901, A_TERMINAL, HUB), UID)).toBe(false);
      },
    },

    {
      name: 'another-uid-is-never-a-candidate',
      async run({ expect }) {
        // Same row, same PID 1, a different owner. Signalling it would fail
        // anyway — but the verdict is the gate, not the OS's refusal.
        expect(isOrphanedEmulatorFamily(row(73529, ORPHANED, FIRESTORE_JAR, OTHER_UID), UID)).toBe(false);
        expect(isOrphanedEmulatorFamily(row(73529, ORPHANED, FIRESTORE_JAR), undefined), 'no uid of our own proves nothing').toBe(false);
      },
    },

    {
      name: 'a-legacy-workers-orphan-is-reaped-whatever-node-installed-it',
      async run({ expect }) {
        // The ~100-deep pile: a firebase-tools from a node version this machine
        // no longer even runs. No path and no version is part of the match.
        expect(isOrphanedEmulatorFamily(row(38483, ORPHANED, WORKER), UID)).toBe(true);
      },
    },

    {
      name: 'the-discovery-servers-orphan-is-reaped-in-both-its-shapes',
      async run({ expect }) {
        // The row that outlived two boots on switchboard: the hub that spawned
        // it went down inside its 10s quit window, so nothing was left to ask
        // it to leave and nothing but this sweep can reach it (#805).
        expect(isOrphanedEmulatorFamily(row(38500, ORPHANED, DISCOVERY), UID)).toBe(true);
        expect(isOrphanedEmulatorFamily(row(38501, ORPHANED, DISCOVERY_ENTRY), UID)).toBe(true);
        expect(isOrphanedEmulatorFamily(row(38504, ORPHANED, DISCOVERY_RELATIVE), UID), 'a bare-relative source dir puts nothing at all before `node_modules`').toBe(true);
      },
    },

    {
      name: 'a-discovery-server-under-a-living-hub-is-untouched',
      async run({ expect }) {
        // Same parentage rule as the worker: while the hub that spawned it is
        // alive, the hub owns its teardown and the sweep never considers it.
        expect(isOrphanedEmulatorFamily(row(38502, OUR_BOOT, DISCOVERY), UID)).toBe(false);
        expect(isOrphanedEmulatorFamily(row(38503, A_TERMINAL, DISCOVERY_ENTRY), UID)).toBe(false);
      },
    },

    {
      name: 'a-command-that-merely-names-firebase-functions-survives-the-sweep',
      async run({ expect }) {
        // The #293 lesson on the newest shape: the match is a node RUNNING the
        // bin, so an editor holding that very file open is not family, and
        // neither is anything else naming the package.
        expect(isOrphanedEmulatorFamily(row(60009, ORPHANED, EDITOR_ON_DISCOVERY_BIN), UID)).toBe(false);
        expect(isOrphanedEmulatorFamily(row(60010, ORPHANED, EDITOR_ON_FUNCTIONS_SOURCE), UID)).toBe(false);
        expect(describeFamilyMember(EDITOR_ON_DISCOVERY_BIN)).toBe(null);
        expect(describeFamilyMember(EDITOR_ON_FUNCTIONS_SOURCE)).toBe(null);
      },
    },

    {
      name: 'a-bumped-port-hub-and-every-jar-under-it-are-reaped',
      async run({ expect }) {
        // The hub sat on 4402, so no port this run wants could ever reach it,
        // and it named another brand's project — which stops mattering the
        // moment its parent is gone (#781 supersedes #293 on that point).
        expect(isOrphanedEmulatorFamily(row(38400, ORPHANED, HUB), UID)).toBe(true);
        expect(isOrphanedEmulatorFamily(row(38401, ORPHANED, HUB_TOOLS_ENTRY), UID)).toBe(true);
        expect(isOrphanedEmulatorFamily(row(73529, ORPHANED, FIRESTORE_JAR), UID)).toBe(true);
        expect(isOrphanedEmulatorFamily(row(73530, ORPHANED, DATABASE_JAR), UID)).toBe(true);
        expect(isOrphanedEmulatorFamily(row(74155, ORPHANED, PUBSUB_JAR), UID)).toBe(true);
        expect(isOrphanedEmulatorFamily(row(74156, ORPHANED, STORAGE_JAR), UID)).toBe(true);
      },
    },

    {
      name: 'puppeteers-headless-browser-is-family',
      async run({ expect }) {
        // A lane's chrome outlives the lane exactly as the jars do, and its
        // throwaway profile directory is the only thing that says so.
        expect(isOrphanedEmulatorFamily(row(41003, ORPHANED, PUPPETEER_CHROME), UID)).toBe(true);
      },
    },

    {
      name: 'the-reload-watcher-survives-the-sweep',
      async run({ expect }) {
        // nodemon runs at PID 1 with a LIVE session behind it, and its argv
        // names firebase paths. The strict family match is the whole reason it
        // lives: it is not a hub, a worker, a jar, a helper or a browser.
        expect(isOrphanedEmulatorFamily(row(60001, ORPHANED, RELOAD_WATCHER), UID)).toBe(false);
        expect(describeFamilyMember(RELOAD_WATCHER)).toBe(null);
      },
    },

    {
      name: 'the-cli-a-deploy-and-a-users-browser-survive-the-sweep',
      async run({ expect }) {
        // `omega emulator` is the process running this very sweep; `firebase
        // deploy` is a live publish; a Chrome launched from Finder has PID 1
        // for a parent and no puppeteer profile.
        expect(isOrphanedEmulatorFamily(row(60002, ORPHANED, OMEGA_CLI), UID)).toBe(false);
        expect(isOrphanedEmulatorFamily(row(60003, ORPHANED, MGR_CLI), UID)).toBe(false);
        expect(isOrphanedEmulatorFamily(row(60004, ORPHANED, FIREBASE_DEPLOY), UID)).toBe(false);
        expect(isOrphanedEmulatorFamily(row(60005, ORPHANED, USER_CHROME), UID)).toBe(false);
        expect(isOrphanedEmulatorFamily(row(60006, ORPHANED, 'node /Users/ian/some-other-tool/server.js'), UID)).toBe(false);
        expect(isOrphanedEmulatorFamily(row(60007, ORPHANED, 'java -jar /Users/ian/Developer/tools/some-app.jar'), UID), 'a jar outside the firebase emulator cache is somebody else\'s').toBe(false);
        expect(isOrphanedEmulatorFamily(row(60008, ORPHANED, EDITOR_ON_PORT_HOLD), UID), "a devkit lane helper is a library module, so a process NAMING one is never running one").toBe(false);
      },
    },

    {
      name: 'init-itself-is-never-a-candidate',
      async run({ expect }) {
        expect(isOrphanedEmulatorFamily(row(1, 0, '/sbin/launchd'), UID)).toBe(false);
        expect(isOrphanedEmulatorFamily(row(NaN, ORPHANED, WORKER), UID)).toBe(false);
        expect(isOrphanedEmulatorFamily(undefined, UID)).toBe(false);
      },
    },

    // ─── the short label the log prints ───

    {
      name: 'every-family-member-has-a-short-name',
      async run({ expect }) {
        expect(describeFamilyMember(HUB)).toBe('firebase hub');
        expect(describeFamilyMember(HUB_TOOLS_ENTRY)).toBe('firebase hub');
        expect(describeFamilyMember(WORKER)).toBe('functions worker');
        expect(describeFamilyMember(DISCOVERY)).toBe('functions discovery server');
        expect(describeFamilyMember(DISCOVERY_ENTRY)).toBe('functions discovery server');
        expect(describeFamilyMember(FIRESTORE_JAR), 'the firestore jar names a database edition — the JAR decides, not the argv').toBe('firestore jar');
        expect(describeFamilyMember(DATABASE_JAR)).toBe('database jar');
        expect(describeFamilyMember(PUBSUB_JAR)).toBe('pubsub jar');
        expect(describeFamilyMember(STORAGE_JAR)).toBe('storage jar');
        expect(describeFamilyMember(UNKNOWN_JAR), 'a jar the cache grows tomorrow is still an emulator jar').toBe('emulator jar');
        expect(describeFamilyMember(PUPPETEER_CHROME)).toBe('puppeteer chrome');
        expect(describeFamilyMember(USER_CHROME)).toBe(null);
        expect(describeFamilyMember(EDITOR_ON_PORT_HOLD)).toBe(null);
      },
    },

    // ─── the sweep ───

    {
      name: 'the-sweep-signals-every-orphan-and-nothing-else',
      async run({ expect }) {
        const table = processTable({
          73529: { ppid: ORPHANED, command: FIRESTORE_JAR },
          74155: { ppid: ORPHANED, command: PUBSUB_JAR },
          38483: { ppid: ORPHANED, command: WORKER },
          37088: { ppid: OUR_BOOT, command: FIRESTORE_JAR },
          60001: { ppid: ORPHANED, command: RELOAD_WATCHER },
          60002: { ppid: ORPHANED, command: FIRESTORE_JAR, uid: OTHER_UID },
        });

        const result = await reapMachineOrphans(table.seams);

        expect(result.reaped.map((entry) => entry.pid).sort()).toEqual([38483, 73529, 74155]);
        expect(result.killed, 'everything left on the first signal').toEqual([]);
        expect(table.signals.map((entry) => entry.signal)).toEqual(['SIGTERM', 'SIGTERM', 'SIGTERM']);
        expect(table.signalled(37088), "a live stack's jar is never signalled").toEqual([]);
        expect(table.signalled(60001), 'the watcher is never signalled').toEqual([]);
        expect(table.signalled(60002), "another user's jar is never signalled").toEqual([]);
      },
    },

    {
      name: 'only-the-survivors-of-sigterm-are-sigkilled',
      async run({ expect }) {
        // Escalation order is the safety story: SIGTERM to everything, and
        // SIGKILL only to what is still standing after the grace window.
        const table = processTable({
          73529: { ppid: ORPHANED, command: FIRESTORE_JAR },
          74155: { ppid: ORPHANED, command: PUBSUB_JAR },
        }, {
          // The firestore jar ignores SIGTERM, as a JVM mid-write does.
          afterTerm: (pid, rows) => { if (pid !== 73529) rows.delete(pid); },
        });

        const result = await reapMachineOrphans(table.seams);

        expect(table.signalled(74155), 'a process that left needs nothing more').toEqual(['SIGTERM']);
        expect(table.signalled(73529), 'the survivor is escalated, in that order').toEqual(['SIGTERM', 'SIGKILL']);
        expect(result.killed).toEqual([73529]);
        expect(result.reaped.map((entry) => entry.pid).sort()).toEqual([73529, 74155]);
      },
    },

    {
      name: 'a-sweep-naming-no-grace-waits-the-one-stop-grace',
      async run({ expect }) {
        const table = processTable({
          73529: { ppid: ORPHANED, command: FIRESTORE_JAR },
        }, {
          afterTerm: () => {},
        });
        const seams = { ...table.seams };
        const sent = {};
        const kill = seams.kill;

        seams.kill = (pid, signal) => { sent[signal] = Date.now(); kill(pid, signal); };
        delete seams.graceMs;
        seams.pollIntervalMs = 10;
        await reapMachineOrphans(seams);

        const waited = sent.SIGKILL - sent.SIGTERM;

        expect(waited, 'SIGTERM gets the whole stop grace before SIGKILL').toBeGreaterThanOrEqual(STOP_GRACE_MS);
        expect(waited, 'and no longer than one more second').toBeLessThan(STOP_GRACE_MS + 1000);
      },
    },

    {
      name: 'a-recycled-pid-is-spared-on-the-re-read',
      async run({ expect }) {
        // The grace window is long enough for a number to be freed and handed
        // out again, and there is no apologising to a SIGKILL: the row is read
        // again and must STILL be an orphaned family member.
        const table = processTable({
          73529: { ppid: ORPHANED, command: FIRESTORE_JAR },
        }, {
          afterTerm: (pid, rows) => rows.set(pid, { ppid: A_TERMINAL, uid: UID, command: 'node /Users/ian/some-other-tool/server.js' }),
        });

        const result = await reapMachineOrphans(table.seams);

        expect(table.signalled(73529), 'the number came back as a stranger — no SIGKILL').toEqual(['SIGTERM']);
        expect(result.killed).toEqual([]);
        expect(result.reaped, 'nothing of ours went down, so nothing is reported reaped').toEqual([]);
      },
    },

    {
      name: 'the-ports-the-orphans-held-are-waited-on-before-the-boot-continues',
      async run({ expect }) {
        // A SIGKILLed JVM holds its listener after kill() returns, and the
        // allocator probes these very ports moments later.
        const table = processTable({
          73529: { ppid: ORPHANED, command: FIRESTORE_JAR },
          74155: { ppid: ORPHANED, command: PUBSUB_JAR },
        });

        await reapMachineOrphans(table.seams);

        expect([...new Set(table.probed)].sort((a, b) => a - b), 'every port the reaped rows published, websocket included').toEqual([9150, 9152, 9154]);
      },
    },

    {
      name: 'the-port-wait-resolves-once-a-still-bound-port-frees',
      async run({ expect }) {
        // A real listener on an OS-picked port. The probe is the real one; the
        // seam around it lets go of the port the first time it answers busy.
        const server = net.createServer();
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        const answers = [];

        await orphans.waitForPortsReleased([port], {
          isFree: async (candidate) => {
            const free = await isPortFree(candidate);

            answers.push(free);

            if (!free) {
              await new Promise((resolve) => server.close(resolve));
            }

            return free;
          },
        });

        expect(answers[0], 'the port was still bound when the wait began').toBe(false);
        expect(answers[answers.length - 1], 'the wait ended on the port answering free').toBe(true);
      },
    },

    {
      name: 'the-emulator-commands-reap-waits-through-the-one-exported-port-wait',
      async run({ expect }) {
        // The boot's record-driven reap waits on the ports it freed. It does so
        // through this module's export, so the poll loop has one home.
        const projectDir = jetpack.tmpDir({ prefix: 'omega-orphan-wait-' }).cwd();
        const command = new EmulatorCommand({ firebaseProjectPath: projectDir, argv: {}, options: {} });
        const calls = [];
        const shared = orphans.waitForPortsReleased;

        command.log = () => {};
        command.logWarning = () => {};
        writeJson(command.getTempPath('emulator-pids.json'), {
          pids: [4001, 4002],
          projectId: 'demo-other-brand',
          rootPid: 4001,
          ports: { firestore: 48152 },
          startedAt: new Date().toISOString(),
        });

        const live = new Map([[4002, { ppid: ORPHANED, command: FIRESTORE_JAR }]]);
        const seams = {
          readProcess: (pid) => live.get(Number(pid)) || null,
          kill: (pid) => live.delete(Number(pid)),
          isFree: async () => true,
        };

        orphans.waitForPortsReleased = (...args) => {
          calls.push(args[0]);
          return shared(...args);
        };

        try {
          await command.reapStaleRecordedProcesses(command.readEmulatorOwnership(), seams);
        } finally {
          orphans.waitForPortsReleased = shared;
          jetpack.remove(projectDir);
        }

        expect(calls, 'the reap waited on the freed port through the exported wait').toEqual([[48152]]);
      },
    },

    {
      name: 'the-shutdown-sweep-looks-at-the-classic-hub-and-storage-ports',
      async run({ expect }) {
        // A defaults run owns the shared hub and storage ports, and their
        // numbers have one home: @omega.js/config's CLASSIC_PORTS.
        const projectDir = jetpack.tmpDir({ prefix: 'omega-orphan-sweep-' }).cwd();
        const command = new EmulatorCommand({ firebaseProjectPath: projectDir, argv: {}, options: {} });
        const probed = [];

        command.log = () => {};
        command.logWarning = () => {};

        try {
          await command.terminateOrphanedEmulatorProcesses({ functions: 45001 }, {
            sweepShared: true,
            isFree: async (port) => { probed.push(port); return true; },
            listPids: () => [],
          });
        } finally {
          jetpack.remove(projectDir);
        }

        expect(probed, 'the hub port comes from CLASSIC_PORTS').toContain(CLASSIC_PORTS.hub);
        expect(probed, 'the storage port comes from CLASSIC_PORTS').toContain(CLASSIC_PORTS.storage);
      },
    },

    {
      name: 'the-sweep-never-signals-itself-or-its-parent',
      async run({ expect }) {
        // No ownership proof stands behind this sweep, so the two numbers it
        // must never signal are named outright: a family-shaped row wearing
        // this very pid would otherwise make the boot kill itself mid-reap.
        const table = processTable({
          [process.pid]: { ppid: ORPHANED, command: FIRESTORE_JAR },
          [process.ppid]: { ppid: ORPHANED, command: WORKER },
          73529: { ppid: ORPHANED, command: PUBSUB_JAR },
        });

        // Not vacuous: both rows clear the verdict, so the guard is the only
        // thing standing between this boot and its own SIGTERM.
        expect(isOrphanedEmulatorFamily(row(process.pid, ORPHANED, FIRESTORE_JAR), UID)).toBe(true);

        const result = await reapMachineOrphans(table.seams);

        expect(table.signalled(process.pid), 'the running boot is never a candidate').toEqual([]);
        expect(table.signalled(process.ppid), 'nor is whatever launched it').toEqual([]);
        expect(result.reaped.map((entry) => entry.pid), 'the real orphan beside them still goes').toEqual([73529]);
      },
    },

    {
      name: 'nothing-orphaned-means-no-signal-and-no-probe',
      async run({ expect }) {
        const table = processTable({
          37088: { ppid: OUR_BOOT, command: FIRESTORE_JAR },
          60001: { ppid: ORPHANED, command: RELOAD_WATCHER },
        });

        const result = await reapMachineOrphans(table.seams);

        expect(result).toEqual({ reaped: [], killed: [] });
        expect(table.signals).toEqual([]);
        expect(table.probed, 'a boot with nothing to reap pays for nothing').toEqual([]);
      },
    },

    // ─── what the boot prints ───

    {
      name: 'the-boot-names-every-pid-it-reaped-and-what-it-was',
      async run({ expect }) {
        const command = new EmulatorCommand({ firebaseProjectPath: os.tmpdir(), argv: {}, options: {} });
        const lines = [];

        command.log = (message) => lines.push(String(message));

        const table = processTable({
          73529: { ppid: ORPHANED, command: FIRESTORE_JAR },
          74155: { ppid: ORPHANED, command: PUBSUB_JAR },
          38483: { ppid: ORPHANED, command: WORKER },
        });

        await command.reapMachineOrphans(table.seams);

        expect(lines.length, 'one line per boot, not one per pid').toBe(1);
        // Named in table order, which `ps -A` prints by pid.
        expect(lines[0]).toMatch(/Reaped 3 orphaned emulator processes left by earlier runs: 38483 functions worker, 73529 firestore jar, 74155 pubsub jar\./);
      },
    },

    {
      name: 'the-boot-is-silent-when-there-is-nothing-to-reap',
      async run({ expect }) {
        const command = new EmulatorCommand({ firebaseProjectPath: os.tmpdir(), argv: {}, options: {} });
        const lines = [];

        command.log = (message) => lines.push(String(message));

        const table = processTable({ 37088: { ppid: OUR_BOOT, command: FIRESTORE_JAR } });

        await command.reapMachineOrphans(table.seams);

        expect(lines, 'a clean machine says nothing at all').toEqual([]);
      },
    },

    {
      name: 'a-single-reap-and-a-sigkill-read-in-plain-english',
      async run({ expect }) {
        const command = new EmulatorCommand({ firebaseProjectPath: os.tmpdir(), argv: {}, options: {} });
        const lines = [];

        command.log = (message) => lines.push(String(message));

        const table = processTable({ 73529: { ppid: ORPHANED, command: FIRESTORE_JAR } }, { afterTerm: () => {} });

        await command.reapMachineOrphans(table.seams);

        // The escalation note sits where every sibling reap line puts it, so
        // the pid list is never read as "this one needed SIGKILL".
        expect(lines[0]).toMatch(/Reaped 1 orphaned emulator process left by earlier runs \(1 needed SIGKILL\): 73529 firestore jar\./);
      },
    },

    // ─── the real thing ───

    {
      name: 'a-real-orphan-is-reaped-and-a-parented-one-survives',
      async run({ expect }) {
        // The whole chain against the real OS: a real `ps -A`, a real row for a
        // real process, and a real SIGTERM. The script is a plain idling node
        // whose path IS the functions-worker shape.
        const dir = jetpack.tmpDir({ prefix: 'omega-orphan-drill-' }).cwd();
        const script = writeWorkerScript(dir);
        const spared = [];
        let live = null;

        try {
          // The orphan: `sh` exits the moment it has forked, so the node it
          // started reparents to PID 1 with nobody left to tear it down. Its
          // stdio is redirected because execSync waits for the child's pipes to
          // close, and an idling node never closes an inherited one.
          childProcess.execSync(`sh -c 'node ${script} > /dev/null 2>&1 &'`, { stdio: 'ignore' });

          const orphanPid = await until(() => {
            const found = parseProcessTable(orphans.readProcessTableText())
              .filter((entry) => entry.command.includes(script) && entry.ppid === 1)
              .map((entry) => entry.pid);

            return found.length > 0 ? found[0] : null;
          }, 10000);

          expect(orphanPid, 'the drill needs a real orphan to reap').toBeTruthy();

          // The one it must NOT touch: same command line, live parent (this
          // very process), so the parentage half of the proof spares it.
          live = childProcess.spawn(process.execPath, [script], { stdio: 'ignore' });

          await until(() => livePidsRunning(script).includes(live.pid), 10000);

          const result = await reapMachineOrphans({
            graceMs: 2000,
            // Machine-wide is the DESIGN, but a test run signals only what
            // THIS FILE spawned — every one of those runs out of a temp root
            // carrying the drill marker. Anything else the sweep matched on
            // this machine is recorded and left standing.
            kill: (pid, signal) => {
              const live = orphans.readProcessRow(pid);

              if (!live || !live.command.includes(DRILL_MARKER)) {
                spared.push({ pid: Number(pid), signal: signal });

                return;
              }

              process.kill(pid, signal);
            },
            // Our idle node binds nothing, and probing real ports is not this
            // drill's business.
            isFree: async () => true,
          });

          expect(result.reaped.some((entry) => entry.pid === orphanPid), 'the real orphan is reported reaped').toBeTruthy();
          expect(result.reaped.find((entry) => entry.pid === orphanPid).label).toBe('functions worker');

          const gone = await until(() => !livePidsRunning(script).includes(orphanPid), 5000);

          expect(gone, 'the real orphan is actually gone').toBeTruthy();
          expect(livePidsRunning(script).includes(live.pid), 'the same shape with a live parent survives the sweep').toBeTruthy();
          expect(spared.filter((entry) => entry.pid === live.pid), 'the parented one was never even signalled').toEqual([]);
        } finally {
          if (live) {
            live.kill();
          }

          jetpack.remove(dir);
        }
      },
    },
  ],
});
