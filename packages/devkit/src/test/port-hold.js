/**
 * Classic-port holding: how an e2e lane owns a whole stack without ever
 * disturbing the one a developer has running.
 *
 * The N7 allocator starts from the CLASSIC defaults and bumps past anything
 * taken, so a lane that HOLDS every classic port forces its children onto
 * fresh numbers while a live `omega dev` keeps serving. A busy classic port
 * is somebody else's stack: the hold declines it and the allocator bumps.
 * "Held" means both LOOPBACK addresses, 127.0.0.1 and ::1, after the
 * allocator's own probe has answered "no foreign listener". Never the bare
 * wildcard: on Linux it collides with the hold's own loopback bind.
 */

// Libraries
const net = require('net');
const { CLASSIC_PORTS, FAMILY_UNAVAILABLE, isPortFree } = require('@omega.js/config');

// The classics the allocator starts from, plus the two internal ports the
// HTTPS proxies want (web's 4443, the backend's 5443) — holding those too
// keeps a bumped stack from landing back on a number a developer's stack uses.
const CLASSIC_HOLD_PORTS = [...new Set([...Object.values(CLASSIC_PORTS), 4443, 5443])];

/**
 * Hold one address of one port.
 *
 * @param {number} port - Port to hold
 * @param {string} host - Bind address
 * @returns {Promise<{ status: 'held'|'busy'|'unavailable', server?: net.Server }>}
 */
function holdAddress(port, host) {
  return new Promise((resolve) => {
    // A held port answers nothing: no accepted socket outlives the hold, so a
    // release closes at once even with a browser tab still connected.
    const server = net.createServer((socket) => socket.destroy());
    // A missing address family (no IPv6) has nothing to hold or collide with,
    // read with the allocator's own codes; any other error is a real occupant.
    server.once('error', (error) => resolve({
      status: FAMILY_UNAVAILABLE.includes(error.code) ? 'unavailable' : 'busy',
    }));
    server.listen({ port, host }, () => resolve({ status: 'held', server }));
  });
}

/**
 * Hold every classic port for the run's duration.
 *
 * @param {number[]} [ports] - Ports to hold (defaults to CLASSIC_HOLD_PORTS)
 * @param {object} [options]
 * @param {Function} [options.bind] - The per-address bind (the test seam)
 * @param {Function} [options.probe] - The foreign-listener check (the test seam)
 * @returns {Promise<{ servers: net.Server[], held: number[], busy: number[] }>}
 */
async function holdClassicPorts(ports = CLASSIC_HOLD_PORTS, { bind = holdAddress, probe = isPortFree } = {}) {
  const servers = [];
  const held = [];
  const busy = [];

  for (const port of ports) {
    // The probe binds and closes each address in turn, so it never meets the
    // hold's own binds, and its wildcard binds see a foreign `::`/`0.0.0.0`.
    if (!(await probe(port))) {
      busy.push(port);
      continue;
    }

    const bound = [];
    let occupied = false;

    for (const host of ['127.0.0.1', '::1']) {
      const result = await bind(port, host);
      if (result.status === 'held') bound.push(result.server);
      // 'unavailable' is a family this host does not have: nothing to hold
      // there, and nothing anyone else can collide with either.
      if (result.status === 'busy') occupied = true;
    }

    // A port nobody else owns binds on every address this host HAS; a single
    // busy one means a live listener is there — leave it alone, the allocator
    // bumps around it. "Alone" means CLOSING the partial binds too:
    // SO_REUSEADDR lets a more-specific socket win, so keeping a 127.0.0.1
    // bind next to someone else's live listener would steal their localhost
    // traffic for the run.
    if (!occupied && bound.length > 0) {
      held.push(port);
      servers.push(...bound);
    } else {
      busy.push(port);
      releasePorts(bound);
    }
  }

  return { servers, held, busy };
}

/**
 * Release held listeners. Safe to call twice.
 *
 * @param {net.Server[]} servers - The listeners from holdClassicPorts
 */
function releasePorts(servers) {
  for (const server of servers || []) {
    try { server.close(); } catch (e) { /* already closed */ }
  }
}

module.exports = { holdClassicPorts, releasePorts, holdAddress, CLASSIC_HOLD_PORTS };
