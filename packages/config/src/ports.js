/**
 * Port auto-allocation (N7) — classic defaults, probe at boot, bump-if-taken.
 *
 * The allocator is boot-time only: when the classic defaults are free (the
 * single-brand case) resolution returns them untouched and dev behaves
 * exactly as it always has. When a port is taken (a second brand's stack is
 * up), that port bumps +1 until free — per port, with a shared claimed-set so
 * two names never land on the same number.
 *
 * The RESOLVED map publishes two ways (the CLI that booted the stack owns
 * both): a ports file (`<projectDir>/.temp/ports.json`, pid-stamped, deleted
 * on clean shutdown) for sibling processes of the same brand, and
 * `OMEGA_<NAME>_PORT` env vars injected into spawned children for URL
 * getters. Browser code receives `dev.ports` via the injected dev config —
 * it can read neither env nor files.
 *
 * A port is not always the whole fact: the website's dev ORIGIN carries a
 * protocol too (mkcert HTTPS by default), and a sibling reading `website:
 * 4000` cannot guess it. The publisher writes the resolved origin string
 * beside the map in the same file, and `readSiblingOrigin` reads it back
 * ([#262](https://github.com/Omega-JS-Stack/omega/issues/262)).
 *
 * Under local HTTPS the map carries two hosting entries: `https` is the
 * public origin (the mkcert proxy) and `hosting` is the proxy's INTERNAL
 * plain-http port. A consumer process targets `https`, never `hosting`
 * ([#795](https://github.com/Omega-JS-Stack/omega/issues/795)).
 *
 * Explicit pins (config `ports` section) never bump: a pinned port that is
 * busy is a hard error naming the pin, because the user asked for exactly
 * that port.
 */

const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { writeJson } = require('@omega.js/devkit/write-json');
const { findBrandRoot } = require('./load.js');
// The env-var name and the port check are browser-safe, so they live beside
// the missing-fact error the browser chain also reads.
const { envName, parsePort } = require('./dev-facts.js');

// The classic defaults every framework has always used — allocation starts
// here, and single-brand dev never leaves them.
const CLASSIC_PORTS = {
  auth: 9099,
  functions: 5001,
  firestore: 8080,
  database: 9000,
  hosting: 5002,
  storage: 9199,
  pubsub: 8085,
  // The firebase emulator hub: firebase-tools' own fixed default, shared by
  // every stack on the machine rather than allocated per run.
  hub: 4400,
  ui: 4050,
  website: 4000,
  livereload: 35729,
  cdp: 9222,
};

const PORTS_FILE = 'ports.json';

// The dev website origin every surface assumes when no live website published
// one — the classic port, over the protocol `omega dev` speaks by default (the
// mkcert proxy). An assumption, and every fallback says so out loud (#262).
const CLASSIC_DEV_ORIGIN = `https://localhost:${CLASSIC_PORTS.website}`;

// The bind errors that mean "this host has no such address family" (no IPv6),
// which a probe reads as free rather than busy.
const FAMILY_UNAVAILABLE = ['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL'];

/**
 * Attempt one bind (the probe primitive). On macOS/BSD, wildcard and
 * specific-address listeners COEXIST on the same port, so no single bind
 * can see every listener; isPortFree composes four TCP binds and two UDP.
 * @param {object} listenOptions - net listen options ({ port } = wildcard).
 * @param {boolean} [ignoreMissingFamily] - Treat address-family-unavailable
 *   errors (no IPv6 on this host) as free rather than busy.
 * @returns {Promise<boolean>} True when the bind succeeded.
 */
function bindProbe(listenOptions, ignoreMissingFamily = false) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (ignoreMissingFamily && FAMILY_UNAVAILABLE.includes(error.code)) {
        return resolve(true);
      }
      resolve(false);
    });
    server.listen(listenOptions, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Attempt one UDP bind on a family's wildcard (the UDP twin of bindProbe),
 * with no address reuse, so any UDP socket already on the port fails it.
 * @param {'udp4'|'udp6'} type - Socket type; picks the wildcard (0.0.0.0 or ::).
 * @param {number} port - Port to probe.
 * @returns {Promise<boolean>} True when the bind succeeded. A host with no
 *   IPv6 reads free for `udp6`.
 */
function udpProbe(type, port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket(type);
    socket.once('error', (error) => {
      socket.close();
      if (type === 'udp6' && FAMILY_UNAVAILABLE.includes(error.code)) {
        return resolve(true);
      }
      resolve(false);
    });
    socket.bind({ port, address: type === 'udp4' ? '0.0.0.0' : '::' }, () => {
      socket.close(() => resolve(true));
    });
  });
}

/**
 * Is this port free for a dev server to take? SIX binds, all must succeed.
 * Four TCP (127.0.0.1, ::1, 0.0.0.0, and the bare `::` wildcard): on
 * macOS/BSD specific-address and wildcard listeners coexist per port, and
 * so do the two wildcard families, so any single bind misses a holder.
 * Two UDP (the 0.0.0.0 and `::` wildcards): firebase-tools' macOS check
 * (`lsof -i :<port> -sTCP:LISTEN`) still lists a UDP socket as taken.
 * A host with no IPv6 skips ::1 and the UDP `::`.
 * @param {number} port - Port to probe.
 * @returns {Promise<boolean>} True when the port is free.
 */
async function isPortFree(port) {
  return (await bindProbe({ port, host: '127.0.0.1' }))
    && (await bindProbe({ port, host: '::1' }, true))
    && (await bindProbe({ port, host: '0.0.0.0' }))
    && (await bindProbe({ port }))
    && (await udpProbe('udp4', port))
    && (await udpProbe('udp6', port));
}

/**
 * Resolve a port map: each wanted port keeps its value when free, bumps +1
 * until free when taken. Pinned ports (explicit config) never bump — busy
 * pin throws.
 *
 * @param {object} options
 * @param {object} options.wanted - Name → desired port (usually the classic
 *   defaults or a brand's firebase.json values).
 * @param {object} [options.pins] - Name → explicitly-configured port (config
 *   `ports` section). Pinned names use the pin verbatim; busy → throw.
 * @param {Set<number>} [options.claimed] - Ports already claimed in this
 *   process run (shared across resolvePorts calls for multi-family boots).
 * @returns {Promise<{ ports: object, bumped: string[] }>} Resolved map + the
 *   names that moved off their wanted value.
 */
async function resolvePorts({ wanted, pins = {}, claimed = new Set() }) {
  const ports = {};
  const bumped = [];

  for (const [name, wantedPort] of Object.entries(wanted)) {
    const pin = pins[name];

    if (typeof pin === 'number') {
      if (claimed.has(pin) || !(await isPortFree(pin))) {
        throw new Error(`Port ${pin} (pinned via config ports.${name}) is already in use — free it or change the pin`);
      }
      ports[name] = pin;
      claimed.add(pin);
      continue;
    }

    let candidate = wantedPort;
    while (claimed.has(candidate) || !(await isPortFree(candidate))) {
      candidate += 1;
    }

    if (candidate !== wantedPort) {
      bumped.push(name);
    }
    ports[name] = candidate;
    claimed.add(candidate);
  }

  return { ports, bumped };
}

/**
 * Publish the resolved map for sibling processes of the same brand.
 * @param {string} projectDir - The project directory (owns `.temp/`).
 * @param {object} ports - Resolved name → port map.
 * @param {object} [facts] - Resolved non-port facts published beside the map
 *   ({ origin }, the website's resolved dev origin — protocol included).
 * @returns {string} The file path written.
 */
function writePortsFile(projectDir, ports, facts = {}) {
  const file = path.join(projectDir, '.temp', PORTS_FILE);
  writeJson(file, { ports, ...facts, pid: process.pid, startedAt: new Date().toISOString() });
  return file;
}

/**
 * Read a live ports file's WHOLE payload (the map plus the facts published
 * beside it). Returns null when absent, unparseable, or stale (the writing
 * process is no longer running).
 * @param {string} projectDir - The project directory.
 * @returns {object|null} The parsed payload, or null.
 */
function readPortsData(projectDir) {
  const file = path.join(projectDir, '.temp', PORTS_FILE);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.ports) {
    return null;
  }

  // Stale check: the allocator deletes the file on clean shutdown, so a
  // surviving file with a dead pid is a crash leftover — ignore it.
  if (parsed.pid) {
    try {
      process.kill(parsed.pid, 0);
    } catch (error) {
      return null;
    }
  }

  return parsed;
}

/**
 * Read a live ports file. Returns null when absent, unparseable, or stale
 * (the writing process is no longer running).
 * @param {string} projectDir - The project directory.
 * @returns {object|null} The resolved name → port map, or null.
 */
function readPortsFile(projectDir) {
  const data = readPortsData(projectDir);
  return data ? data.ports : null;
}

/**
 * Remove the ports file (clean shutdown).
 * @param {string} projectDir - The project directory.
 */
function clearPortsFile(projectDir) {
  try {
    fs.unlinkSync(path.join(projectDir, '.temp', PORTS_FILE));
  } catch (error) {
    // Absent is fine.
  }
}

/**
 * Merge the live ports files of the sibling targets in the same brand — a
 * running backend's resolved emulator map, as the website/desktop/extension
 * target beside it sees it. Dead-pid leftovers are ignored by readPortsFile; the
 * caller's OWN target dir is skipped (a previous run of the same process).
 *
 * Read at USE time, never once at boot: the ports file is pid-stamped and
 * deleted on shutdown, so a boot-time read races the sibling that has not
 * booted yet and goes stale the moment an emulator restarts on new numbers
 * ([#300](https://github.com/Omega-JS-Stack/omega/issues/300)).
 *
 * No brand root (standalone consumer) → empty map, and the caller falls back
 * to the classic ports.
 * @param {string} targetDir - The reading target's root (its own file is skipped).
 * @returns {object} Merged name → port map.
 */
function readSiblingPorts(targetDir) {
  const merged = {};

  for (const dir of siblingTargetDirs(targetDir)) {
    Object.assign(merged, readPortsFile(dir) || {});
  }

  return merged;
}

/**
 * The resolved dev WEBSITE ORIGIN a sibling target of the same brand published —
 * protocol and port together, because a port alone cannot say whether the dev
 * server speaks TLS (mkcert is the default) and every client that links to the
 * website in dev needs the whole origin
 * ([#262](https://github.com/Omega-JS-Stack/omega/issues/262)).
 *
 * Read at USE time like readSiblingPorts, and null when no sibling is live —
 * the caller falls back to the classic assumption and says so.
 * @param {string} targetDir - The reading target's root (its own file is skipped).
 * @returns {string|null} The published origin, or null.
 */
function readSiblingOrigin(targetDir) {
  for (const dir of siblingTargetDirs(targetDir)) {
    const origin = readPortsData(dir)?.origin;
    if (origin) {
      return origin;
    }
  }

  return null;
}

/**
 * The sibling target dirs of the target that asks: every `targets/<name>` of
 * the same brand except its own. No brand root (standalone consumer) → none.
 * @param {string} targetDir - The reading target's root.
 * @returns {string[]} Absolute sibling target dirs.
 */
function siblingTargetDirs(targetDir) {
  const brandRoot = findBrandRoot(targetDir);
  if (!brandRoot) {
    return [];
  }

  const targetsDir = path.join(brandRoot, 'targets');
  const dirs = [];

  for (const entry of fs.existsSync(targetsDir) ? fs.readdirSync(targetsDir, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const dir = path.join(targetsDir, entry.name);
    if (path.resolve(dir) === path.resolve(targetDir)) {
      continue;
    }
    dirs.push(dir);
  }

  return dirs;
}

/**
 * Resolved map → the OMEGA_*_PORT env block to inject into spawned children.
 * @param {object} ports - Resolved name → port map.
 * @returns {object} Env var name → string port.
 */
function portsToEnv(ports) {
  const env = {};
  for (const [name, port] of Object.entries(ports)) {
    env[envName(name)] = String(port);
  }
  return env;
}

/**
 * Read a port from the environment (`OMEGA_<NAME>_PORT`).
 * @param {string} name - Port name ('auth', 'hosting', ...).
 * @param {object} [env] - Env object (defaults to process.env).
 * @returns {number|null} The port, or null when unset/invalid.
 */
function envPort(name, env = process.env) {
  return parsePort(env[envName(name)]);
}

/**
 * Every `OMEGA_<NAME>_PORT` in an environment as a resolved map — the inverse
 * of portsToEnv, for a spawned child reading the whole map its parent
 * injected rather than one name at a time.
 * @param {object} [env] - Env object (defaults to process.env).
 * @returns {object} Name → port map (lowercased names, invalid values dropped).
 */
function envPorts(env = process.env) {
  const ports = {};
  for (const key of Object.keys(env)) {
    const match = /^OMEGA_([A-Z0-9]+)_PORT$/.exec(key);
    if (!match) {
      continue;
    }
    const name = match[1].toLowerCase();
    const port = envPort(name, env);
    if (port) {
      ports[name] = port;
    }
  }
  return ports;
}

module.exports = {
  CLASSIC_PORTS,
  CLASSIC_DEV_ORIGIN,
  FAMILY_UNAVAILABLE,
  isPortFree,
  resolvePorts,
  writePortsFile,
  readPortsFile,
  clearPortsFile,
  readSiblingPorts,
  readSiblingOrigin,
  envName,
  portsToEnv,
  envPort,
  envPorts,
};
