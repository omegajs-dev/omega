/**
 * The local port chain: the ONE home of how a context finds a port of the local
 * stack and the local URL built on it. The Omega base class calls it with the
 * map it was handed, and @omega.js/desktop's and @omega.js/extension's
 * url-helpers with the map their build baked. Browser-safe and instance-free.
 *
 * The `OMEGA_<NAME>_PORT` env var comes first (Node-side contexts only), then
 * the given `dev.ports` map. The classic numbers live only in @omega.js/config,
 * as the floor the bundle task bakes under the live map, so a read that finds
 * neither is a broken build and throws, naming the step that writes the map.
 */
import { devFactMissing, envName, parsePort } from '@omega.js/config/dev-facts';
import { FUNCTIONS_REGION } from './api-address.js';

// A browser context has no `process`; only Node-side contexts carry the channel.
function envPort(name) {
  return typeof process !== 'undefined' && process.env
    ? parsePort(process.env[envName(name)])
    : null;
}

/**
 * One local port, from whichever channel this context has.
 * @param {object} [ports] - the resolved `dev.ports` map this context was given.
 * @param {string} name - the port's name (`hosting`, `auth`, ...).
 * @returns {number|null} the port, or null when neither answers.
 */
export function localPort(ports, name) {
  return envPort(name) || parsePort(ports?.[name]);
}

/**
 * The same read, REQUIRED: a getter answering with a local address answers
 * with a resolved one or not at all.
 * @param {object} [ports] - the resolved `dev.ports` map this context was given.
 * @param {string} name - the port's name.
 * @param {string} writer - the build step that writes the map on the caller's surface.
 * @returns {number} the port.
 */
export function requiredPort(ports, name, writer) {
  const port = localPort(ports, name);

  if (!port) {
    throw devFactMissing(`dev port for \`${name}\``, writer);
  }

  return port;
}

/**
 * The local API base. A resolved `https` port is `mgr serve`'s mkcert proxy,
 * whose cert is for localhost. Otherwise the hosting emulator: every plain-http
 * emulator answers on 127.0.0.1, because `localhost` can resolve to ::1 in Node
 * and miss it.
 * @param {object} [ports] - the resolved `dev.ports` map this context was given.
 * @param {string} writer - the build step that writes the map on the caller's surface.
 * @returns {string} the local API base URL.
 */
export function localApiUrl(ports, writer) {
  const httpsPort = localPort(ports, 'https');

  return httpsPort
    ? `https://localhost:${httpsPort}`
    : `http://127.0.0.1:${requiredPort(ports, 'hosting', writer)}`;
}

/**
 * The local Cloud Functions base, on the functions emulator (plain http, 127.0.0.1).
 * @param {object} [ports] - the resolved `dev.ports` map this context was given.
 * @param {string} projectId - the Firebase project the emulator serves.
 * @param {string} writer - the build step that writes the map on the caller's surface.
 * @returns {string} the local functions base URL.
 */
export function localFunctionsUrl(ports, projectId, writer) {
  return `http://127.0.0.1:${requiredPort(ports, 'functions', writer)}/${projectId}/${FUNCTIONS_REGION}`;
}

/**
 * The auth emulator's own origin (plain http, 127.0.0.1).
 * @param {object} [ports] - the resolved `dev.ports` map this context was given.
 * @param {string} writer - the build step that writes the map on the caller's surface.
 * @returns {string} the auth emulator URL.
 */
export function localAuthEmulatorUrl(ports, writer) {
  return `http://127.0.0.1:${requiredPort(ports, 'auth', writer)}`;
}
