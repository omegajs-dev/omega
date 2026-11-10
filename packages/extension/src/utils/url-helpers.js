// Backend URL helpers: plain functions the context `Omega` base class
// (src/omega.js) and the background worker call, resolving LOCAL urls in
// development AND testing through the context's getEnvironment()
// (src/utils/mode-helpers.js). A browser context has no `process`, so it reads
// only the `dev.ports` map the build baked into OMEGA_BUILD_JSON; build-time
// Node and the test harness also carry the env channel.

// The local port chain and the local URLs on it (env, then the baked
// `dev.ports`, then a loud miss) are @omega.js/client's, the one home.
const chain = require('@omega.js/client/modules/dev-ports.js');
// The API address (api.<brand host>, or the functions address on a default
// Pages host) is @omega.js/config's, the one home.
const { apiAddress } = require('@omega.js/config/api-address');

// The step that writes the resolved dev map into this surface's artifact, named
// in every missing-fact error below.
const DEV_FACT_WRITER = "@omega.js/extension's bundle task, from the live stack's ports file plus the OMEGA_*_PORT env channel";

// The map this context's build baked; a production build bakes none.
function bakedPorts(context) {
  return context?.config?.dev?.ports;
}

// One local port by name (`hosting`, `auth`, ...), or null.
function localPort(context, name) {
  return chain.localPort(bakedPorts(context), name);
}

// The same read, REQUIRED, naming this surface's writer on a miss.
function requiredPort(context, name) {
  return chain.requiredPort(bakedPorts(context), name, DEV_FACT_WRITER);
}

/**
 * The API base for a context: the local stack in development and testing, the
 * brand's `apiAddress` in production (api.<host>, or the functions url on a Pages host).
 * @param {object} context - the `Omega` instance (its `config` and `getEnvironment()`).
 * @param {string} [environment] - an override of the running environment.
 * @returns {string} the API base URL.
 */
function getApiUrl(context, environment) {
  const env = environment || context.getEnvironment();

  // Local for development OR testing; production otherwise. The client chain
  // answers the mkcert proxy on localhost, else the hosting emulator on 127.0.0.1.
  if (env === 'development' || env === 'testing') {
    return chain.localApiUrl(bakedPorts(context), DEV_FACT_WRITER);
  }

  // Prod: api.<brand host>, or the functions address on a default Pages host.
  // Mirrors @omega.js/client.getApiUrl. Never derive from authDomain: it is an
  // auth concern (the brand host, with /__/auth/* self-hosted at build time)
  // and must stay free to change independently.
  const brandUrl = context.config.brand?.url;
  if (!brandUrl) {
    throw new Error('brand.url not set in config/omega.json5');
  }

  const address = apiAddress(brandUrl, context.config?.cloud?.config?.projectId);
  if (!address) {
    throw new Error('cloud.config.projectId not set in config/omega.json5: a default Pages brand.url has no API address without it');
  }
  return address;
}

/**
 * The auth emulator's origin, for a testing run's `connectAuthEmulator`.
 * @param {object} context - the instance asking (its baked `config`).
 * @returns {string} the auth emulator URL.
 */
function getAuthEmulatorUrl(context) {
  return chain.localAuthEmulatorUrl(bakedPorts(context), DEV_FACT_WRITER);
}

module.exports = {
  localPort,
  requiredPort,
  getApiUrl,
  getAuthEmulatorUrl,
};
