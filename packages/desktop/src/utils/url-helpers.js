// Backend URL helpers: plain functions the process `Omega` classes (main /
// renderer / preload) call, each passing itself as `context`, and that resolve
// LOCAL urls in development AND testing through the context's getEnvironment()
// (src/utils/mode-helpers.js). An explicit `environment` arg is an override,
// used mainly by tests. Every local answer comes from the client chain below.

// The local port chain and the local URLs on it (env, then the baked
// `dev.ports`, then a loud miss) are @omega.js/client's, the one home.
const chain = require('@omega.js/client/modules/dev-ports.js');
// The API address (api.<brand host>, or the functions address on a default
// Pages host) and the functions region are @omega.js/config's, the one home.
const { FUNCTIONS_REGION, apiAddress } = require('@omega.js/config/api-address');

// The step that writes the resolved dev map into this surface's artifact, named
// in every missing-fact error below (#834).
const DEV_FACT_WRITER = "@omega.js/desktop's bundle task, from the live stack's ports file plus the OMEGA_*_PORT env channel";

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
 * The Cloud Functions base: the local emulator in development and testing, the
 * project's cloudfunctions.net host in production.
 * @param {object} context - the instance asking (its `config` and `getEnvironment()`).
 * @param {string} [environment] - an override of the running environment.
 * @returns {string} the functions base URL.
 */
function getFunctionsUrl(context, environment) {
  const env = environment || context.getEnvironment();
  const projectId = context.config?.cloud?.config?.projectId;

  if (!projectId) {
    throw new Error('cloud.config.projectId not set in config/omega.json5');
  }

  // Local for development OR testing; production otherwise. The port rides the
  // same chain getApiUrl() walks: the OMEGA_*_PORT env channel (N7), then the
  // baked map, then a loud miss.
  if (env === 'development' || env === 'testing') {
    return chain.localFunctionsUrl(bakedPorts(context), projectId, DEV_FACT_WRITER);
  }

  return `https://${FUNCTIONS_REGION}-${projectId}.cloudfunctions.net`;
}

/**
 * The API base: the local stack in development and testing, the brand's
 * `apiAddress` in production (api.<host>, or the functions url on a Pages host).
 * @param {object} context - the instance asking (its `config` and `getEnvironment()`).
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
  const brandUrl = context.config?.brand?.url;
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

// Marketing-site / brand website URL. Dev → the local website's whole ORIGIN, the
// same answer @omega.js/client's getDevWebsiteOrigin() gives every other surface
// whenever the website published one
// ([#262](https://github.com/Omega-JS-Stack/omega/issues/262)): the baked
// `dev.origin` the live website published (scheme, host AND port, the complete
// fact) wins, else a port from the usual chain (OMEGA_WEBSITE_PORT, then the baked
// `dev.ports.website`) composed over https. There is no classic-origin fallback
// any more (#834): a wrong dev origin fails as a silent connection refusal. The
// scheme is https because `omega dev` fronts its public port with the mkcert
// proxy by default, so a port alone can never say it
// ([#747](https://github.com/Omega-JS-Stack/omega/issues/747)).
// Prod → `config.brand.url`. Use this whenever app code wants to link out to "the
// website" (Help → Website tray/menu items, "Open in browser," billing portal
// landings) so dev runs don't punch out to the real domain.
/**
 * @param {object} context - the instance asking (its `config` and `getEnvironment()`).
 * @param {string} [environment] - an override of the running environment.
 * @returns {string} the website origin (dev) or brand.url (production).
 */
function getWebsiteUrl(context, environment) {
  const env = environment || context.getEnvironment();

  // Local for development OR testing; production otherwise.
  if (env === 'development' || env === 'testing') {
    const origin = context.config?.dev?.origin;
    if (origin) {
      return origin;
    }

    return `https://localhost:${requiredPort(context, 'website')}`;
  }

  const url = context.config?.brand?.url;
  if (!url) {
    throw new Error('brand.url not set in config/omega.json5');
  }
  return url;
}

// Sign-in URL that round-trips an auth token back to the app. Points at the brand
// website's /signin page, chained through its /token page so a successful login
// mints a Firebase custom token and redirects to `<brand.id>://auth/token` — the
// deep-link built-in that hands the token to lib/auth.js (signInWithCustomToken).
// Same env split as getWebsiteUrl: dev/test → the local website, prod → brand.url.
// The token page redirects with ?authToken=<token> — the ONE modern shape the
// auth/token route reads (older formats are not read).
//
// `returnUrl` overrides the final hop (default: `<brand.id>://auth/token`). Used by
// lib/auth-flow.js in dev, where the custom scheme isn't OS-registered — the flow
// returns to a loopback HTTP listener instead (RFC 8252 §7.3).
/**
 * @param {object} context - the instance asking (its `config` and `getEnvironment()`).
 * @param {string} [environment] - an override of the running environment.
 * @param {string} [returnUrl] - the final hop, `<brand.id>://auth/token` by default.
 * @returns {string} the sign-in URL.
 */
function getAuthUrl(context, environment, returnUrl) {
  const site = getWebsiteUrl(context, environment);
  const brandId = context.config?.brand?.id;
  if (!brandId) {
    throw new Error('brand.id not set in config/omega.json5');
  }

  const tokenUrl = new URL('/token', site);
  tokenUrl.searchParams.set('returnUrl', returnUrl || `${brandId}://auth/token`);

  const signinUrl = new URL('/signin', site);
  signinUrl.searchParams.set('returnUrl', tokenUrl.toString());
  return signinUrl.toString();
}

module.exports = {
  localPort,
  requiredPort,
  getFunctionsUrl,
  getApiUrl,
  getAuthEmulatorUrl,
  getWebsiteUrl,
  getAuthUrl,
};
