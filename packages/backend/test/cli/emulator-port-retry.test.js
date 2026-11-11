/**
 * Test: a port taken between the allocator's probe and firebase-tools' bind bumps and retries ONCE, against the
 * real firebase-tools child on a throwaway project far from the classic ports. Node's own EADDRINUSE wording is
 * parse-level only: firebase-tools' pre-bind check always reports first.
 * Run: cd brands/sandbox-brand/targets/backend && npx omega test backend:cli/emulator-port-retry
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const path = require('path');
const { spawn } = require('child_process');
const jetpack = require('fs-jetpack');

const EmulatorCommand = require('../../dist/cli/commands/emulator.js');
const { isPortFree, CLASSIC_PORTS } = require('../../dist/vendor/config/index.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');
const frameworkPackage = require('../../package.json');

// The names the allocator moves, then the ones firebase-tools binds on its own. Every one is declared, because
// a name firebase.json leaves out falls back to its CLASSIC port.
const ALLOCATED_NAMES = ['auth', 'functions', 'firestore', 'database', 'hosting', 'storage', 'pubsub', 'ui'];
const DECLARED_NAMES = [...ALLOCATED_NAMES, 'hub', 'logging', 'eventarc', 'tasks'];

// Each project takes the first free 70-port window inside 21100-21449 from a random start, so no case boots
// onto a port the last one used, or one a leftover on this machine still holds. The windows sit below every
// machine's short-lived socket range and clear of the classic ports, so no stray socket lands in one.
const WINDOW_BASE = 21100;
const WINDOW_COUNT = 5;
let nextWindow = Math.floor(Math.random() * WINDOW_COUNT);

const REALLOCATING = 'was taken while the stack came up; reallocating';

/** The ports window `slot` (0 to WINDOW_COUNT - 1) declares: every declared name, and the websocket port. */
function windowPorts(slot) {
  const base = WINDOW_BASE + slot * 70;
  const ports = Object.fromEntries(DECLARED_NAMES.map((name, index) => [name, base + index * 5]));
  ports.websocket = base + 60;

  return ports;
}

/** The declared ports of the first window, from the random start, that nothing on this machine holds. */
async function freeWindowPorts() {
  for (let tried = 0; tried < WINDOW_COUNT; tried++) {
    const ports = windowPorts(nextWindow++ % WINDOW_COUNT);

    if ((await heldOf(Object.values(ports))).length === 0) return ports;
  }

  throw new Error(`every 70-port window in ${WINDOW_BASE}-${WINDOW_BASE + WINDOW_COUNT * 70 - 1} has a held port, so no case has a place to boot`);
}

/**
 * A throwaway backend target the real boot can stage and start: its peers declared (so the scaffold installs
 * nothing), its own demo project id, and every port it declares far from the classic map.
 * @param {object} [options]
 * @param {string} [options.databaseRules] - A database rules path for firebase.json to name.
 */
async function makeProject({ databaseRules } = {}) {
  const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-retry-')));
  const projectId = `demo-omega-retry-${path.basename(projectDir).slice(-6).toLowerCase()}`;
  const ports = await freeWindowPorts();
  const emulators = Object.fromEntries(DECLARED_NAMES.map((name) => [name, { port: ports[name] }]));

  emulators.firestore.websocketPort = ports.websocket;
  emulators.ui.enabled = true;

  jetpack.write(path.join(projectDir, 'package.json'), { name: 'retry-fixture', version: '0.0.0', dependencies: frameworkPackage.peerDependencies });
  jetpack.write(path.join(projectDir, '.firebaserc'), { projects: { default: projectId } });
  jetpack.write(path.join(projectDir, 'config', 'omega.json5'), {
    brand: { id: 'retry-fixture' },
    cloud: { provider: 'firebase', config: { projectId } },
    targets: { backend: { type: 'backend' } },
  });
  jetpack.write(path.join(projectDir, 'firebase.json'), {
    firestore: { rules: 'dist/firestore.rules' },
    ...(databaseRules ? { database: { rules: databaseRules } } : {}),
    emulators: { ...emulators, singleProjectMode: true },
  });

  return { projectDir, ports, cleanup: () => jetpack.remove(projectDir) };
}

/**
 * The emulator command over a throwaway project, its log captured. The machine-wide orphan reap stays out: it
 * signals every orphaned emulator-family process on this machine, whoever started it.
 * @param {string} projectDir - The throwaway project.
 */
function bootCommand(projectDir) {
  const command = new EmulatorCommand({ firebaseProjectPath: projectDir, argv: { https: false, seed: false }, options: {} });
  const lines = [];

  command.log = (message) => lines.push(String(message));
  command.logWarning = (message) => lines.push(String(message));
  command.reapMachineOrphans = async () => {};

  return { command, lines };
}

/** The OMEGA_*_PORT block a boot publishes, snapshotted so a case can put the door's own stack back. */
function capturePortEnv() {
  const keys = Object.keys(process.env).filter((key) => /^OMEGA_.*_PORT$/.test(key));
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  return () => {
    for (const key of Object.keys(process.env)) {
      if (/^OMEGA_.*_PORT$/.test(key) && !(key in prior)) delete process.env[key];
    }
    Object.assign(process.env, prior);
  };
}

/** The map `.temp/ports.json` publishes right now, or null while there is none to read. */
function publishedPorts(projectDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectDir, '.temp', 'ports.json'), 'utf8')).ports;
  } catch (error) {
    // Not published yet, retracted between attempts, or caught mid-write: the next poll reads it whole.
    return null;
  }
}

/** A real listener on 127.0.0.1:`port`, the way a foreign stack would hold it. */
function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());

    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1' }, () => resolve(server));
  });
}

/** A real UDP socket on the IPv4 wildcard at `port`, the way a stray short-lived socket would sit; returns close(). */
function holdUdp(port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');

    socket.once('error', reject);
    socket.bind({ port }, () => resolve(() => new Promise((done) => socket.close(() => done()))));
  });
}

/** Close the listeners a case opened. */
function release(servers) {
  return Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
}

/**
 * Take the auth port the moment a boot attempt publishes it, while firebase-tools is still on its way to its own
 * pre-bind check. `every` holds each new map's auth port; otherwise only the first.
 * @param {string} projectDir - The throwaway project.
 * @param {{every: boolean}} options
 */
function holdPublishedAuth(projectDir, { every }) {
  const maps = [];
  const servers = [];
  const state = { error: null };
  let binding = false;

  const timer = setInterval(async () => {
    const ports = publishedPorts(projectDir);

    if (binding || !ports?.auth || maps.some((map) => map.auth === ports.auth) || (!every && maps.length > 0)) {
      return;
    }

    binding = true;
    maps.push(ports);

    try {
      servers.push(await listen(ports.auth));
    } catch (error) {
      state.error = error;
    }

    binding = false;
  }, 10);

  return { maps, state, release: () => { clearInterval(timer); return release(servers); } };
}

/** The subset of `ports` something still listens on. */
async function heldOf(ports) {
  const unique = [...new Set(ports)];
  const free = await Promise.all(unique.map((port) => isPortFree(port)));

  return unique.filter((port, index) => !free[index]);
}

/** The ports in `ports` still held once they have had 10 s to come back free. */
async function stillHeld(waitFor, ports) {
  try {
    await waitFor(async () => (await heldOf(ports)).length === 0, 10000, 200);
  } catch (error) {
    // Out of time: the read below names whatever stayed held.
  }

  return heldOf(ports);
}

/**
 * Boot the real stack with the declared storage port held, so every attempt reads as bumped and its stop path
 * never sweeps the classic hub and storage ports. Storage is not one of the emulators the boot starts.
 * @param {object} project - From makeProject.
 * @param {Function} fn - Runs with `{ command, lines }` while the hold stands.
 */
async function withBumpedBoot(project, fn) {
  const restoreEnv = capturePortEnv();
  const storage = await listen(project.ports.storage);

  try {
    return await fn(bootCommand(project.projectDir));
  } finally {
    await release([storage]);
    restoreEnv();
  }
}

/** The boot's rejection, or null when it came up. */
async function bootFailure(command) {
  try {
    const stack = await command.startEmulators({ https: false });
    await stack.shutdown();
  } catch (error) {
    return error;
  }

  return null;
}

/** A process that ignores SIGTERM (noting that it got one beside its state file) and holds a port. */
const SURVIVOR_SOURCE = `const fs = require('fs');
const [port, stateFile] = process.argv.slice(4);
process.on('SIGTERM', () => fs.writeFileSync(stateFile + '.sigterm', ''));
require('net').createServer().listen(Number(port), '127.0.0.1', () => fs.writeFileSync(stateFile, String(process.pid)));
`;

// The run that dies: it starts the survivor in its own group and exits, so the survivor orphans to PID 1.
const LAUNCHER_SOURCE = `require('child_process').spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore' }).unref();`;

/** A port nothing holds, from the 20 that start 380 above the window base, clear of every window. */
async function freeHighPort() {
  const first = WINDOW_BASE + 380;

  for (let port = first; port < first + 20; port++) {
    if (await isPortFree(port)) return port;
  }

  throw new Error(`every port in ${first}-${first + 19} is held, so the reap case has nowhere to listen`);
}

module.exports = defineCases({
  description: 'emulator boot bumps and retries once when a port is taken mid-bind',
  type: 'group',
  timeout: 120000,

  tests: [
    {
      name: 'a-port-taken-mid-bind-is-bumped-and-the-boot-retried-once',
      async run({ expect, waitFor }) {
        const project = await makeProject();
        const auth = holdPublishedAuth(project.projectDir, { every: false });

        try {
          await withBumpedBoot(project, async ({ command, lines }) => {
            let stack = await command.startEmulators({ https: false });

            try {
              const [first] = auth.maps;
              const { auth: _firstAuth, ...firstOthers } = first;
              const { auth: retryAuth, ...retryOthers } = publishedPorts(project.projectDir);

              expect(auth.state.error, 'the hold took the published auth port before firebase-tools did').toBe(null);
              expect(lines.filter((line) => line.includes(REALLOCATING)).length, 'one reallocation, then the stack came up').toBe(1);
              expect(stack.emulatorPorts.auth, 'the stack that came up is off the held port').not.toBe(first.auth);
              expect(stack.bumped.includes('auth'), 'the moved name is reported as bumped').toBeTruthy();
              expect(retryAuth, 'the ports file siblings read carries the new auth port').toBe(stack.emulatorPorts.auth);
              expect(retryOthers, 'every other name kept its first allocation').toEqual(firstOthers);

              // The held auth and storage ports are this test's own listeners, not the stack's.
              const { storage: _storage, auth: _auth, ...declared } = project.ports;
              const bound = [...Object.values(stack.emulatorPorts), ...Object.values(declared)];

              await stack.shutdown();
              stack = null;

              expect(await stillHeld(waitFor, bound), 'the stop path freed every port the stack bound').toEqual([]);
            } finally {
              if (stack) await stack.shutdown();
            }
          });
        } finally {
          await auth.release();
          project.cleanup();
        }
      },
    },

    {
      name: 'a-udp-socket-on-a-wanted-port-moves-that-name-before-the-first-attempt',
      async run({ expect }) {
        // firebase-tools on macOS counts a UDP socket as a taken port, so the allocator moves off it up front and
        // the boot never spends its one retry on it.
        const project = await makeProject();
        const releaseUdp = await holdUdp(project.ports.auth);

        try {
          await withBumpedBoot(project, async ({ command }) => {
            const stack = await command.startEmulators({ https: false });

            try {
              // Storage is the hold withBumpedBoot keeps, so it moves too.
              const kept = ALLOCATED_NAMES.filter((name) => name !== 'auth' && name !== 'storage');
              const keptPorts = (map) => Object.fromEntries(kept.map((name) => [name, map[name]]));

              expect(command.activeAttempt, 'the stack came up on its first attempt').toBe(1);
              expect(stack.emulatorPorts.auth, 'auth moved off the held UDP port').not.toBe(project.ports.auth);
              expect(keptPorts(stack.emulatorPorts), 'every other name kept its wanted port').toEqual(keptPorts(project.ports));
            } finally {
              await stack.shutdown();
            }
          });
        } finally {
          await releaseUdp();
          project.cleanup();
        }
      },
    },

    {
      name: 'a-second-bind-failure-names-the-port-and-its-holder',
      async run({ expect, waitFor }) {
        // Twice on the same wall is not a race any more: the report names the port, and the holder lsof finds
        // for it (this test process), and never signals it.
        const project = await makeProject();
        const auth = holdPublishedAuth(project.projectDir, { every: true });
        let failure = null;

        try {
          failure = await withBumpedBoot(project, ({ command }) => bootFailure(command));
        } finally {
          await auth.release();
        }

        try {
          const second = auth.maps[1]?.auth;
          const touched = [...Object.values(project.ports), ...auth.maps.flatMap((map) => Object.values(map))];

          expect(failure?.message, 'the report names the port the retry could not bind').toMatch(new RegExp(`port ${second} \\(auth\\)`));
          expect(failure.message, 'and the process holding it').toMatch(new RegExp(`held by pid ${process.pid}\\b`));
          expect(auth.state.error, 'the hold took each published auth port before firebase-tools did').toBe(null);
          expect(auth.maps.length, 'ONE retry, never a loop').toBe(2);
          expect(await stillHeld(waitFor, touched), 'nothing of the stack is left listening').toEqual([]);
        } finally {
          project.cleanup();
        }
      },
    },

    {
      name: 'a-failure-with-no-port-in-it-is-not-retried',
      async run({ expect, waitFor }) {
        // A rules file that does not exist: firebase-tools refuses the database emulator and exits before ready,
        // naming no port. The retry is for the race this run can do something about, so this fails once.
        const project = await makeProject({ databaseRules: 'missing/database.rules.json' });

        try {
          await withBumpedBoot(project, async ({ command, lines }) => {
            const failure = await bootFailure(command);

            expect(lines.some((line) => line.includes(REALLOCATING)), 'one attempt, no reallocation').toBeFalsy();
            expect(failure?.addressInUsePort, 'the failure carries no port tag').toBe(undefined);
            expect(failure?.message, 'the boot fails the way it always did').toMatch(/exited before ready/);
            const { storage: _held, ...declared } = project.ports;

            expect(await stillHeld(waitFor, Object.values(declared)), 'nothing of the stack is left listening').toEqual([]);
          });
        } finally {
          project.cleanup();
        }
      },
    },

    {
      name: 'a-close-from-an-attempt-no-longer-in-charge-leaves-the-published-files-alone',
      async run({ expect }) {
        // The real close handler of a real stack, read after a newer attempt took the token: a late close from a
        // dead first attempt must not unpublish the stack that is actually up, nor delete the config it runs on.
        const project = await makeProject();
        const resolvedConfig = path.join(project.projectDir, 'firebase.resolved.json');

        try {
          await withBumpedBoot(project, async ({ command }) => {
            const stack = await command.startEmulators({ https: false });

            command.activeAttempt += 1;
            await stack.shutdown();

            expect(publishedPorts(project.projectDir)?.auth, "the stale close leaves the newer attempt's ports file").toBe(stack.emulatorPorts.auth);
            expect(jetpack.exists(resolvedConfig), 'and the config it is running on').toBeTruthy();
          });
        } finally {
          project.cleanup();
        }
      },
    },

    {
      name: 'a-port-taken-line-in-either-wording-names-only-a-port-this-run-allocated',
      run({ expect }) {
        const warning = '⚠  database: Port 9001 is not open on localhost (127.0.0.1,::1), could not start Database Emulator.';
        const output = `${warning}\nError: Could not start Database Emulator, port taken.\n`;
        const nodeWording = '⚠  emulators: Error: listen EADDRINUSE: address already in use 127.0.0.1:9099';

        expect(EmulatorCommand.addressInUsePort(warning, [9099, 9001]), 'the warning names an allocated port').toBe(9001);
        expect(EmulatorCommand.addressInUsePort(output, [9099, 9001]), 'the whole exit reads as that same port').toBe(9001);
        expect(EmulatorCommand.addressInUsePort(output, [9099, 9002]), 'a port this run never allocated is no bump').toBe(null);
        expect(EmulatorCommand.addressInUsePort(nodeWording, [9099, 9001]), "node's own bind failure reads the same").toBe(9099);
        expect(EmulatorCommand.addressInUsePort('Error: listen EADDRINUSE: address already in use :::9099', [9099]), 'in its IPv6 form too').toBe(9099);
        expect(EmulatorCommand.addressInUsePort(nodeWording, [9001]), 'and names no bump for a port this run never asked for').toBe(null);
      },
    },

    {
      name: 'every-window-port-sits-below-the-short-lived-range-and-off-the-classic-ports',
      run({ expect }) {
        // A window inside the range a machine hands out for short-lived sockets meets a stray one by chance.
        const declared = Array.from({ length: WINDOW_COUNT }, (_, slot) => Object.values(windowPorts(slot))).flat();
        const classic = new Set(Object.values(CLASSIC_PORTS));

        expect(declared.filter((port) => port >= 32768), 'every window port is below 32768').toEqual([]);
        expect(declared.filter((port) => classic.has(port)), 'no window port is a classic port').toEqual([]);
      },
    },

    {
      name: 'the-stale-reap-takes-a-sigterm-survivor-down-and-waits-for-its-port',
      timeout: 30000,
      async run({ expect, waitFor }) {
        // A dead run's survivor: orphaned to PID 1, ignoring SIGTERM, holding a port. The reap proves it is this
        // project's by its live row, escalates, and asks about the port only once the pid is gone.
        const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-retry-reap-')));
        const projectId = 'demo-omega-retry-reap';
        const command = new EmulatorCommand({ firebaseProjectPath: projectDir, argv: {}, options: {} });
        const survivorPath = path.join(projectDir, 'emulator-survivor.js');
        const stateFile = path.join(projectDir, 'survivor.pid');
        const lines = [];
        let pid = null;

        command.log = (message) => lines.push(String(message));
        command.logWarning = (message) => lines.push(String(message));
        jetpack.write(survivorPath, SURVIVOR_SOURCE);

        try {
          const port = await freeHighPort();
          const launcher = spawn(process.execPath, ['-e', LAUNCHER_SOURCE, survivorPath, '--project_id', projectId, String(port), stateFile], { stdio: 'ignore' });

          await new Promise((resolve) => launcher.once('exit', resolve));
          await waitFor(() => jetpack.exists(stateFile), 5000, 20);
          pid = Number(jetpack.read(stateFile));

          jetpack.write(command.getTempPath('emulator-pids.json'), {
            pids: [pid],
            projectId,
            rootPid: launcher.pid,
            ports: { firestore: port },
            startedAt: new Date().toISOString(),
          });

          await command.reapStaleRecordedProcesses(command.readEmulatorOwnership());

          expect(jetpack.exists(`${stateFile}.sigterm`), 'the survivor got SIGTERM first, and stayed').toBeTruthy();
          expect(lines.join('\n'), 'so the reap escalated').toMatch(/Reaped 1 recorded process left by a previous run \(1 needed SIGKILL\)/);
          expect(EmulatorCommand.readProcessInfo(pid), 'and the pid is gone').toBe(null);
          expect(await isPortFree(port), 'its port reads free').toBeTruthy();
          expect(lines.join('\n').includes('still closing'), 'and was never reported as held').toBeFalsy();
        } finally {
          // Only ever the survivor this case started (its pid file re-read, in case the wait above timed
          // out before it wrote), and only while its live row is still that survivor.
          const survivorPid = Number(jetpack.read(stateFile)) || pid;
          if (survivorPid && EmulatorCommand.readProcessInfo(survivorPid)?.command.includes(survivorPath)) process.kill(survivorPid, 'SIGKILL');
          jetpack.remove(projectDir);
        }
      },
    },
  ],
});
