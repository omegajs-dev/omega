// Unit tests for src/ports.js — port auto-allocation (N7).
//
// Real-execution only (no mocks): probes bind real sockets on 127.0.0.1,
// bump-if-taken runs against a real blocker server, and the ports file
// round-trips through a real temp dir. Test ports live in the uncommon
// 42xxx range so parallel suites/CI don't collide with real services.

const defineCases = require('@omega.js/devkit/test/define-cases');
const dgram = require('node:dgram');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  CLASSIC_PORTS,
  FAMILY_UNAVAILABLE,
  isPortFree,
  resolvePorts,
  writePortsFile,
  readPortsFile,
  clearPortsFile,
  readSiblingPorts,
  envName,
  portsToEnv,
  envPort,
  envPorts,
} = require('../src/ports.js');

/** Bind a real blocker on a port; returns close(). host defaults to
 * 127.0.0.1; pass null for a wildcard listener, '::1' for v6-loopback. */
function block(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(host === null ? { port } : { port, host }, () => {
      resolve(() => new Promise((done) => server.close(done)));
    });
  });
}

/** Hold a real UDP socket on a port's wildcard (type 'udp4', or 'udp6' held IPv6-only); returns close(). */
function holdUdp(port, type) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(type === 'udp6' ? { type, ipv6Only: true } : type);
    socket.once('error', reject);
    socket.bind({ port }, () => {
      resolve(() => new Promise((done) => socket.close(done)));
    });
  });
}

/** Pick a real free port from the OS (bind 0, read it back, release) — for
 * cases that must not collide with the fixed 42xxx numbers above. */
function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '0.0.0.0' }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ports-test-'));
}

module.exports = defineCases({
  type: 'group',
  description: 'ports',
  tests: [
    // ---- isPortFree

    {
      name: 'isPortFree: free port true, blocked port false',
      run: async (ctx) => {
        ctx.expect(await isPortFree(42801)).toBe(true);
        const close = await block(42801);
        try {
          ctx.expect(await isPortFree(42801)).toBe(false);
        } finally {
          await close();
        }
      },
    },

    {
      name: 'isPortFree sees listeners on EVERY bind surface (macOS coexistence)',
      run: async (ctx) => {
        // On macOS/BSD, wildcard and specific-address listeners coexist per port —
        // a single-host probe false-positives and the stack crashes at the real
        // bind (found live: the playground https proxy holds IPv6 *:5002; the
        // second brand's allocator probed 127.0.0.1 only, handed 5002 to the
        // functions emulator, and firebase's own connect-probe refused to boot).
        const wildcard = await block(42802, null);
        try {
          ctx.expect(await isPortFree(42802), 'wildcard listener must read busy').toBe(false);
        } finally {
          await wildcard();
        }

        const v4only = await block(42802, '127.0.0.1');
        try {
          ctx.expect(await isPortFree(42802), 'v4-specific listener must read busy').toBe(false);
        } finally {
          await v4only();
        }

        let v6only;
        try {
          v6only = await block(42802, '::1');
        } catch (error) {
          v6only = null; // host without IPv6 — the ::1 leg is vacuously covered
        }
        if (v6only) {
          try {
            ctx.expect(await isPortFree(42802), 'v6-loopback listener must read busy').toBe(false);
          } finally {
            await v6only();
          }
        }

        ctx.expect(await isPortFree(42802), 'all listeners closed → free again').toBe(true);
      },
    },

    {
      name: 'isPortFree: an IPv4-wildcard (0.0.0.0) holder reads busy',
      run: async (ctx) => {
        // The shape Docker port forwards and most non-loopback dev servers bind.
        // On macOS/BSD an IPv6-wildcard bind COEXISTS with it, so the ::/::1/
        // 127.0.0.1 probes all succeed and the port false-reads free — the
        // allocator then hands firebase a port it cannot take
        // ([#345](https://github.com/Omega-JS-Stack/omega/issues/345)).
        const port = await ephemeralPort();
        const close = await block(port, '0.0.0.0');
        try {
          ctx.expect(await isPortFree(port), 'v4-wildcard listener must read busy').toBe(false);
        } finally {
          await close();
        }

        ctx.expect(await isPortFree(port), 'listener closed → free again').toBe(true);
      },
    },

    {
      name: 'isPortFree: a UDP socket on the IPv4 wildcard reads busy, and free once it closes',
      run: async (ctx) => {
        // firebase-tools on macOS counts a UDP socket as a taken port, so a TCP-only probe hands it one it refuses.
        const close = await holdUdp(42870, 'udp4');
        try {
          ctx.expect(await isPortFree(42870), 'udp4 wildcard socket must read busy').toBe(false);
        } finally {
          await close();
        }

        ctx.expect(await isPortFree(42870), 'socket closed → free again').toBe(true);
      },
    },

    {
      name: 'isPortFree: a UDP socket on the IPv6 wildcard reads busy',
      run: async (ctx) => {
        let close;
        try {
          close = await holdUdp(42872, 'udp6');
        } catch (error) {
          if (!FAMILY_UNAVAILABLE.includes(error.code)) throw error;
          ctx.skip(`no IPv6 on this host (${error.code})`);
        }
        try {
          ctx.expect(await isPortFree(42872), 'udp6 wildcard socket must read busy').toBe(false);
        } finally {
          await close();
        }
      },
    },

    // ---- resolvePorts

    {
      name: 'resolvePorts: all free → classic values untouched, nothing bumped',
      run: async (ctx) => {
        const { ports, bumped } = await resolvePorts({ wanted: { a: 42810, b: 42811 } });
        ctx.expect(ports).toEqual({ a: 42810, b: 42811 });
        ctx.expect(bumped).toEqual([]);
      },
    },

    {
      name: 'resolvePorts: taken port bumps +1 until free',
      run: async (ctx) => {
        const close = await block(42820);
        try {
          const { ports, bumped } = await resolvePorts({ wanted: { a: 42820 } });
          ctx.expect(ports.a).toBe(42821);
          ctx.expect(bumped).toEqual(['a']);
        } finally {
          await close();
        }
      },
    },

    {
      name: 'resolvePorts: a wanted port held on 0.0.0.0 bumps, never resolves in place',
      run: async (ctx) => {
        const port = await ephemeralPort();
        const close = await block(port, '0.0.0.0');
        try {
          const { ports, bumped } = await resolvePorts({ wanted: { a: port } });
          ctx.expect(ports.a).toBe(port + 1);
          ctx.expect(bumped).toEqual(['a']);
        } finally {
          await close();
        }
      },
    },

    {
      name: 'resolvePorts: claimed-set prevents two names landing on one port',
      run: async (ctx) => {
        // b wants a's port — must skip past it even though the OS says it is free.
        const { ports } = await resolvePorts({ wanted: { a: 42830, b: 42830 } });
        ctx.expect(ports.a).toBe(42830);
        ctx.expect(ports.b).toBe(42831);
      },
    },

    {
      name: 'resolvePorts: claimed-set shared across calls (multi-family boots)',
      run: async (ctx) => {
        const claimed = new Set();
        const first = await resolvePorts({ wanted: { a: 42840 }, claimed });
        const second = await resolvePorts({ wanted: { b: 42840 }, claimed });
        ctx.expect(first.ports.a).toBe(42840);
        ctx.expect(second.ports.b).toBe(42841);
      },
    },

    {
      name: 'resolvePorts: free pin honored verbatim, never bumped',
      run: async (ctx) => {
        const { ports, bumped } = await resolvePorts({
          wanted: { a: 42850 },
          pins: { a: 42855 },
        });
        ctx.expect(ports.a).toBe(42855);
        ctx.expect(bumped).toEqual([]);
      },
    },

    {
      name: 'resolvePorts: busy pin throws naming the pin',
      run: async (ctx) => {
        const close = await block(42860);
        try {
          await ctx.expect((() => resolvePorts({ wanted: { a: 42800 }, pins: { a: 42860 } }))()).rejects.toThrow(/pinned via config ports\.a/);
        } finally {
          await close();
        }
      },
    },

    // ---- ports file

    {
      name: 'ports file: write → read round-trips; clear removes',
      run: (ctx) => {
        const dir = makeTempProject();
        writePortsFile(dir, { hosting: 5102 });
        ctx.expect(readPortsFile(dir)).toEqual({ hosting: 5102 });
        clearPortsFile(dir);
        ctx.expect(readPortsFile(dir)).toBe(null);
      },
    },

    {
      name: 'ports file: dead-pid file is stale → null (crash leftover ignored)',
      run: (ctx) => {
        const dir = makeTempProject();
        const file = path.join(dir, '.temp', 'ports.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // PID 1 is init/launchd — alive but not signalable by a user process on
        // macOS/Linux CI? Use an implausible high pid instead: kill(pid, 0) throws
        // ESRCH for non-existent pids, which is the staleness signal.
        fs.writeFileSync(file, JSON.stringify({ ports: { hosting: 5102 }, pid: 999999999 }));
        ctx.expect(readPortsFile(dir)).toBe(null);
      },
    },

    {
      name: 'ports file: absent and malformed both read as null',
      run: (ctx) => {
        const dir = makeTempProject();
        ctx.expect(readPortsFile(dir)).toBe(null);
        const file = path.join(dir, '.temp', 'ports.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'not json');
        ctx.expect(readPortsFile(dir)).toBe(null);
      },
    },

    // ---- sibling ports (the map a target hands its browser code)

    {
      name: 'readSiblingPorts: merges live sibling maps, skips own target dir and dead pids, empty without brand root',
      run: (ctx) => {
        // Brand layout: <root>/config/omega.json5 + targets/{backend,website}
        const brand = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-test-brand-'));
        fs.mkdirSync(path.join(brand, 'config'), { recursive: true });
        fs.writeFileSync(path.join(brand, 'config', 'omega.json5'), '{}');
        const backend = path.join(brand, 'targets', 'backend');
        const website = path.join(brand, 'targets', 'website');
        fs.mkdirSync(path.join(backend, '.temp'), { recursive: true });
        fs.mkdirSync(path.join(website, '.temp'), { recursive: true });

        // Live backend map (our own pid = definitely alive)
        fs.writeFileSync(path.join(backend, '.temp', 'ports.json'), JSON.stringify({
          ports: { hosting: 5003, auth: 9099 }, pid: process.pid, startedAt: 'x',
        }));
        // Own target's file must be skipped even with a live pid (a previous run of THIS server)
        fs.writeFileSync(path.join(website, '.temp', 'ports.json'), JSON.stringify({
          ports: { website: 4999 }, pid: process.pid, startedAt: 'x',
        }));

        ctx.expect(readSiblingPorts(website)).toEqual({ hosting: 5003, auth: 9099 });

        // A restarted emulator republishes new numbers — the NEXT read carries them
        // (the whole reason this is a use-time read, #300)
        fs.writeFileSync(path.join(backend, '.temp', 'ports.json'), JSON.stringify({
          ports: { hosting: 5004, auth: 9100 }, pid: process.pid, startedAt: 'x',
        }));
        ctx.expect(readSiblingPorts(website)).toEqual({ hosting: 5004, auth: 9100 });

        // Dead-pid sibling map is a crash leftover — ignored
        fs.writeFileSync(path.join(backend, '.temp', 'ports.json'), JSON.stringify({
          ports: { hosting: 5003 }, pid: 999999999, startedAt: 'x',
        }));
        ctx.expect(readSiblingPorts(website)).toEqual({});

        // Standalone consumer (no brand root) → empty map, caller falls back to classics
        ctx.expect(readSiblingPorts(makeTempProject())).toEqual({});
      },
    },

    // ---- env mapping

    {
      name: 'envName / portsToEnv / envPort round-trip',
      run: (ctx) => {
        ctx.expect(envName('hosting')).toBe('OMEGA_HOSTING_PORT');
        const env = portsToEnv({ hosting: 5102, auth: 9100 });
        ctx.expect(env).toEqual({ OMEGA_HOSTING_PORT: '5102', OMEGA_AUTH_PORT: '9100' });
        ctx.expect(envPort('hosting', env)).toBe(5102);
        ctx.expect(envPort('auth', env)).toBe(9100);
        ctx.expect(envPort('firestore', env)).toBe(null);
        ctx.expect(envPort('hosting', { OMEGA_HOSTING_PORT: 'garbage' })).toBe(null);
      },
    },

    {
      name: 'envPorts: the whole injected map back out, garbage and foreign vars dropped',
      run: (ctx) => {
        ctx.expect(envPorts(portsToEnv({ hosting: 5102, auth: 9100 }))).toEqual({ hosting: 5102, auth: 9100 });
        ctx.expect(envPorts({
          OMEGA_AUTH_PORT: '9100',
          OMEGA_HOSTING_PORT: 'garbage',
          OMEGA_ENVIRONMENT: 'testing',
          PORT: '3000',
        })).toEqual({ auth: 9100 });
        ctx.expect(envPorts({})).toEqual({});
      },
    },

    // ---- classic defaults sanity

    {
      name: 'CLASSIC_PORTS carries the historical defaults',
      run: (ctx) => {
        ctx.expect(CLASSIC_PORTS.functions).toBe(5001);
        ctx.expect(CLASSIC_PORTS.hosting).toBe(5002);
        ctx.expect(CLASSIC_PORTS.firestore).toBe(8080);
        ctx.expect(CLASSIC_PORTS.auth).toBe(9099);
        ctx.expect(CLASSIC_PORTS.website).toBe(4000);
        ctx.expect(CLASSIC_PORTS.livereload).toBe(35729);
        ctx.expect(CLASSIC_PORTS.cdp).toBe(9222);
        ctx.expect(CLASSIC_PORTS.hub, 'the emulator hub: the backend sweep and test runner read it here').toBe(4400);
      },
    },
  ],
});
