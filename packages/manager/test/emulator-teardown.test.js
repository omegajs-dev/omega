/**
 * The emulator teardown contract (#440) — the reason test/lib/emulator.js
 * exists at all.
 *
 * A lane's emulator is a process TREE, and a signal aimed at the leader's pid
 * alone does not reach the rest of it. Whatever is left holds the write end of
 * the lane's pipes: the lane goes green, the readable never ends, and node
 * sits there instead of exiting (one manager run hung ~25 minutes at teardown).
 *
 * None of that is provable against the real firebase CLI in a unit lane — it
 * needs a JVM and half a minute — so the stub here wears the SHAPE the
 * teardown must survive: a detached group whose child inherits the pipes and
 * outlives a leader-only signal. The proof is the symptom itself: a node
 * process that boots one, tears it down with the helper, and EXITS.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { realpathSync } = require('node:fs');
const { join } = require('node:path');
const jetpack = require('fs-jetpack');

const { collectStrayEmulators, stopProcessGroup } = require('./lib/emulator.js');

const HELPER = require.resolve('./lib/emulator.js');

// The `firebase emulators:start` stand-in: spawn a child that INHERITS the
// pipes (java), announce ready, then wait to be signalled. `hold-sigterm`
// makes the leader ignore SIGTERM, which is what the SIGKILL backstop is for.
const STUB = `
const { spawn } = require('node:child_process');

if (process.argv[2] === 'hold-sigterm') {
  process.on('SIGTERM', () => {});
}

spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });
process.stdout.write('All emulators ready\\n');
setTimeout(() => {}, 60000);
`;

// A lane, in miniature: boot the stub the way startEmulator boots firebase,
// read its pipes the way the ready-watch does, stop it, and let node exit on
// its own. Anything still holding a pipe keeps this process alive forever.
const DRIVER = `
const { spawn } = require('node:child_process');
const { stopProcessGroup } = require(process.argv[2]);

const child = spawn(process.execPath, [process.argv[3]], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

child.stdout.on('data', () => {});
child.stderr.on('data', () => {});

child.stdout.once('data', async () => {
  process.stderr.write('group ' + child.pid + '\\n');
  await stopProcessGroup(child);
  process.stderr.write('stopped\\n');
});
`;

// The java emulator, in miniature: a process that outlives everyone and wears
// the command line the collection pass has to recognise — `--project_id <id>`
// and the `--rules` path inside the lane's own temp dir.
const SLEEPER = `
setTimeout(() => {}, 60000);
`;

// The CLI that LEAKS (#460): firebase-tools spawns the java emulator DETACHED,
// in its own process group, so a signal aimed at this stub's group can never
// reach it — and this stub dies before its graceful shutdown ever runs.
const STRAY_STUB = `
const { spawn } = require('node:child_process');

const [sleeper, projectId, rules] = process.argv.slice(2);
const stray = spawn(
  process.execPath,
  [sleeper, '--project_id', projectId, '--rules', rules],
  { stdio: 'ignore', detached: true },
);
stray.unref();

process.stdout.write('stray ' + stray.pid + '\\n');
`;

const scripts = jetpack.tmpDir({ prefix: 'omega-emulator-teardown' });
scripts.write('stub.js', STUB);
scripts.write('driver.js', DRIVER);
scripts.write('sleeper.js', SLEEPER);
scripts.write('stray-stub.js', STRAY_STUB);
const STUB_PATH = join(scripts.cwd(), 'stub.js');
const DRIVER_PATH = join(scripts.cwd(), 'driver.js');
const SLEEPER_PATH = join(scripts.cwd(), 'sleeper.js');
const STRAY_STUB_PATH = join(scripts.cwd(), 'stray-stub.js');

// Gone is the reaper's call, not the teardown's: an init that collects orphans
// on a tick (a cloud container's) takes about two seconds, so the window
// outlasts that and still sits far under the stub's 60-second sleep.
const GROUP_GONE_WINDOW_MS = 5000;
const GROUP_GONE_POLL_MS = 20;

/** @returns {Promise<boolean>} True once no process in the group answers. */
async function groupGone(pid) {
  const deadline = Date.now() + GROUP_GONE_WINDOW_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    await sleep(GROUP_GONE_POLL_MS);
  }

  return false;
}

// ─── The collection pass (#460) ──────────────────────────────────────────────

// Every process THIS file spawned, so nothing here can ever outlive the lane —
// and so the cleanup can only ever reach pids of its own making. Real strays on
// this machine (other lanes, Ian's) are never touched by anything below.
const spawned = new Set();
const laneDirs = new Set();

/** @returns {boolean} True while the pid still answers. */
function alive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** @returns {Promise<boolean>} True once the pid stops answering. */
async function processGone(pid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!alive(pid)) {
      return true;
    }
    await sleep(20);
  }

  return false;
}

/**
 * A lane's temp dir, as the emulator's command line will name it: the child
 * gets the path with symlinks resolved (macOS /var → /private/var), while the
 * lane only ever holds the unresolved form.
 */
function laneDir(prefix) {
  const dir = jetpack.tmpDir({ prefix }).cwd();
  laneDirs.add(dir);

  return { dir, rules: join(realpathSync(dir), 'firestore.rules') };
}

/** The java emulator stand-in: detached (its own group), wearing the real argv shape. */
function spawnFakeEmulator({ projectId, rules }) {
  const child = spawn(
    process.execPath,
    [SLEEPER_PATH, '--project_id', projectId, '--rules', rules],
    { stdio: 'ignore', detached: true },
  );
  child.unref();
  spawned.add(child.pid);

  return child.pid;
}

module.exports = defineCases({
  type: 'group',
  description: 'emulator-teardown',
  cleanup: async (ctx) => {
    await (() => jetpack.remove(scripts.cwd()))();
    await (() => {
      for (const pid of spawned) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch { /* already gone */ }
      }

      for (const dir of laneDirs) {
        jetpack.remove(dir);
      }
    })();
  },
  tests: [
    {
      name: 'teardown: node exits after a stop, with the pipe-holding grandchild gone',
      run: async (ctx) => {
        const driver = spawn(process.execPath, [DRIVER_PATH, HELPER, STUB_PATH], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });

        let log = '';
        driver.stderr.on('data', (chunk) => { log += String(chunk); });

        const exited = once(driver, 'exit').then(([code]) => code);
        // ref: false — a won race must not hold THIS process open for the rest of
        // the window either. The live driver keeps the loop alive while it matters.
        const hung = sleep(20000, 'HUNG', { ref: false });
        const outcome = await Promise.race([exited, hung]);

        if (outcome === 'HUNG') {
          // Never leave a group behind for the next lane to trip over — the driver's
          // own, and the stub group it left holding the pipes.
          for (const pid of [driver.pid, Number(log.match(/group (\d+)/)?.[1])]) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch { /* already gone */ }
          }
        }

        ctx.expect(outcome, `node never exited after the teardown — a pipe is still held:\n${log}`).not.toBe('HUNG');
        ctx.expect(outcome, `the driver died instead of exiting cleanly:\n${log}`).toBe(0);
        ctx.expect(log, 'the teardown resolved').toMatch(/stopped/);

        const group = Number(log.match(/group (\d+)/)[1]);
        ctx.expect(await groupGone(group), 'the child that inherited the pipes was signalled too, not just the leader').toBe(true);
      },
    },

    {
      name: 'teardown: a group that ignores SIGTERM is SIGKILLed inside the backstop window',
      run: async (ctx) => {
        const child = spawn(process.execPath, [STUB_PATH, 'hold-sigterm'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

        child.stderr.on('data', () => {});
        await once(child.stdout, 'data');

        const started = Date.now();
        await stopProcessGroup(child, { hardKillAfterMs: 300 });
        const elapsed = Date.now() - started;

        ctx.expect(elapsed < 5000, `the teardown returned in ${elapsed}ms, not inside its backstop window`).toBeTruthy();
        ctx.expect(child.stdout.destroyed, 'the readable pipe was released').toBe(true);
        ctx.expect(child.stderr.destroyed, 'the error pipe was released').toBe(true);
        ctx.expect(await groupGone(child.pid), 'SIGKILL reached the whole group').toBe(true);
      },
    },

    {
      name: 'collection: the detached emulator a dead CLI left behind is collected',
      run: async (ctx) => {
        const projectId = 'demo-omega-collect-test';
        const { dir, rules } = laneDir('omega-collect-lane');

        // The CLI stub leaks its emulator and exits, exactly as firebase-tools does
        // when it dies before its own graceful shutdown finishes.
        const cli = spawn(
          process.execPath,
          [STRAY_STUB_PATH, SLEEPER_PATH, projectId, rules],
          { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
        );
        spawned.add(cli.pid);

        const [chunk] = await once(cli.stdout, 'data');
        const strayPid = Number(String(chunk).match(/stray (\d+)/)[1]);
        spawned.add(strayPid);

        await once(cli, 'exit');
        ctx.expect(alive(strayPid), 'the stub leaked its emulator, which is the shape under test').toBe(true);

        const report = await stopProcessGroup(cli, { collect: { projectId, dir } });

        ctx.expect(report.collected, 'the stop path reported the stray it collected').toEqual([strayPid]);
        ctx.expect(await processGone(strayPid), 'the leaked emulator is dead after the stop path ran').toBe(true);
      },
    },

    {
      name: 'collection: a process this lane cannot prove is its own is spared, not killed',
      run: async (ctx) => {
        const projectId = 'demo-omega-collect-test';
        const { dir, rules } = laneDir('omega-collect-lane');

        // Another lane's emulator, in the same temp root: same shape, other project.
        const otherProject = spawnFakeEmulator({ projectId: 'demo-omega-decoy-test', rules });
        // This project's emulator, from some OTHER run — the strays already on this
        // machine wear exactly this shape, and they are not this lane's to kill.
        const otherLane = spawnFakeEmulator({ projectId, rules: laneDir('omega-collect-decoy').rules });
        const mine = spawnFakeEmulator({ projectId, rules });

        const report = await collectStrayEmulators({ projectId, dir });

        ctx.expect(report.collected, 'only the emulator this lane could prove was its own was collected').toEqual([mine]);
        ctx.expect(report.spared, 'the same project from another run was reported, not killed').toEqual([otherLane]);
        ctx.expect(await processGone(mine), 'this lane collected its own').toBe(true);
        ctx.expect(alive(otherProject), 'a different project id survived the collection pass').toBe(true);
        ctx.expect(alive(otherLane), 'a different lane dir survived the collection pass').toBe(true);
      },
    },
  ],
});
