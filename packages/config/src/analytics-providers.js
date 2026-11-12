/**
 * analytics-providers.js: one frozen row per analytics provider, the one home
 * of every fact a provider carries. @omega.js/analytics, the backend's
 * conversion delivery and the client and desktop Measurement Protocol
 * transports read these rows; clientConfig() bakes them into the browser
 * config as `analytics.capabilities` for web core.
 *
 * The functions stay where they run (the adapters, the browser senders, the
 * server senders and match blocks), and a test pins each row to them. The
 * field contract: docs/shared/analytics.md (The provider rows).
 */

const { deepFreeze } = require('./deep-freeze.js');

// In fire order. matchKeys are in the order the fire log reads them out;
// Google's match data is the Measurement Protocol helper's `user_data`, built
// from the request's own user, so its row lists none and no match block exists.
const ANALYTICS_PROVIDERS = deepFreeze({
  google: {
    id: 'google',
    consentCategory: 'analytics',
    dedupesOnEventId: false,
    matchKeys: [],
    browserSender: true,
    serverSender: true,
    measurementProtocol: true,
  },
  meta: {
    id: 'meta',
    consentCategory: 'marketing',
    dedupesOnEventId: true,
    matchKeys: ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'db', 'ge', 'external_id', 'client_ip_address', 'client_user_agent', 'fbc', 'fbp'],
    browserSender: true,
    serverSender: true,
    measurementProtocol: false,
  },
  tiktok: {
    id: 'tiktok',
    consentCategory: 'marketing',
    dedupesOnEventId: true,
    matchKeys: ['email', 'phone', 'external_id', 'ttclid', 'ttp', 'ip', 'user_agent'],
    browserSender: true,
    serverSender: true,
    measurementProtocol: false,
  },
});

/**
 * The row for a provider id, or null when no row has that id. An own-property
 * read, so an inherited name like `constructor` is never a provider.
 *
 * @param {string} id - The provider id (`google`, `meta`, `tiktok`)
 * @returns {object|null}
 */
function analyticsProvider(id) {
  return Object.hasOwn(ANALYTICS_PROVIDERS, id) ? ANALYTICS_PROVIDERS[id] : null;
}

module.exports = { ANALYTICS_PROVIDERS, analyticsProvider };
