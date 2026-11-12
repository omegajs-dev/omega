/**
 * @omega.js/analytics — the ONE analytics consumption surface.
 *
 * Client code and backend code alike call `analytics.event('<canonical>', params)`
 * ([#328](https://github.com/Omega-JS-Stack/omega/issues/328) §Architecture).
 * What differs underneath — page globals on a browser, the Measurement
 * Protocol and the conversion APIs on a server — is the TRANSPORT, injected by
 * the host and invisible to callers.
 *
 * One fire walks three steps per provider:
 *   1. consent — a blocked category's providers never even resolve
 *   2. adapter — the catalog mapping, or null when the provider has none
 *   3. transport — the host's seam; a missing global is a silent no-op (#306)
 *
 * In development the whole walk prints as ONE line per fire, which is the job
 * `setupTrackingInterceptors()` did in web core's `libs/dev.js` (they retired
 * with the rewire).
 *
 * Environment is INJECTED, never sniffed — the same seam the rest of the
 * ecosystem uses (`@omega.js/client`'s `config.environment === 'development'`).
 * The default is 'production': an unconfigured runtime must never throw an
 * event-name error at a visitor.
 */

const { CATALOG, entryFor } = require('./catalog.js');
const { createConsentGate, GRANT_ALL, CATEGORIES } = require('./consent.js');
const { createLogger } = require('./logger.js');
const core = require('./core.js');
const identity = require('./identity.js');
const { ANALYTICS_PROVIDERS, analyticsProvider } = require('@omega.js/config/analytics-providers');
const google = require('./adapters/google.js');
const meta = require('./adapters/meta.js');
const tiktok = require('./adapters/tiktok.js');
const browser = require('./transports/browser.js');

const logger = createLogger('events');

// Every adapter by provider id. A new platform joins here, in the catalog and
// as a row in @omega.js/config's analytics-providers.
const ADAPTERS = { google, meta, tiktok };

// The fire order is the rows' order.
const FIRE_ORDER = Object.keys(ANALYTICS_PROVIDERS).map((id) => ADAPTERS[id]);

const DEFAULTS = {
  // No transport = resolve and log, deliver nothing. A host that never calls
  // configure() is inert rather than guessing at page globals.
  transport: null,
  consent: GRANT_ALL,
  context: {},
  environment: 'production',
};

let state = { ...DEFAULTS };

/**
 * Inject the host's seams. Merges, so a host can wire the transport at boot
 * and swap the consent gate later.
 *
 * @param {object} [options]
 * @param {object} [options.transport] - { send(descriptor) => boolean }.
 * @param {object} [options.consent] - A gate from `createConsentGate`.
 * @param {object} [options.context] - { attribution, consent, runtime } handed to adapters.
 * @param {string} [options.environment] - 'development' | 'production'.
 * @returns {object} The resolved state.
 */
function configure(options = {}) {
  state = { ...state, ...options };
  return { ...state };
}

/**
 * Is this runtime in development? Mirrors the client's `config.environment` seam.
 * @returns {boolean}
 */
function isDevelopment() {
  return state.environment === 'development';
}

// Walk one provider. Returns { provider, outcome, descriptor? } — never throws.
function fire(adapter, canonicalName, params, { eventId, providers }) {
  const provider = adapter.provider;

  // Selection comes before consent: a provider this half does not own was never
  // going to be asked, whatever the visitor consented to (the same order the
  // backend's deliverConversion walks).
  if (providers && !providers.includes(provider)) {
    return { provider, outcome: 'skipped (not selected)' };
  }

  const category = ANALYTICS_PROVIDERS[provider].consentCategory;
  if (!state.consent.granted(category)) {
    return { provider, outcome: `skipped (consent: ${category})` };
  }

  const descriptor = adapter.resolve(canonicalName, params, state.context);
  if (!descriptor) {
    return { provider, outcome: 'skipped (no mapping)' };
  }

  // The dedupe id rides ON the descriptor, which is what a transport executes:
  // Meta takes it as the pixel's `eventID` option and TikTok as `event_id`, so
  // a browser half and a server half of the same conversion collapse into one.
  if (eventId) {
    descriptor.eventId = eventId;
  }

  if (!state.transport) {
    return { provider, outcome: 'skipped (no transport)', descriptor };
  }

  // A transport that returns false could not deliver (a blocked or missing
  // page global). It is a no-op by contract, so the dev log is its only trace.
  const delivered = state.transport.send(descriptor);

  return { provider, outcome: delivered === false ? 'blocked (no global)' : 'sent', descriptor };
}

/**
 * Fire a canonical event across every provider that maps it.
 *
 * An unknown name is a PROGRAMMER error — a typo must not silently cost a
 * conversion — so it throws in development and is logged-and-skipped in
 * production, where throwing would take the customer's action with it.
 *
 * @param {string} canonicalName - A name declared in the catalog.
 * @param {object} [params] - The canonical params for that event.
 * @param {object} [options] - The fire's own options.
 * @param {string} [options.eventId] - The platform dedupe id, for an event whose
 *   other half fires server-side. Both halves MUST name the same string.
 * @param {string[]} [options.providers] - Restrict the fire to these providers.
 *   For a `placement: 'both'` event whose halves do not all deduplicate — this
 *   half names the providers it owns. Absent = every provider the catalog maps.
 * @returns {{ event: string, results: object[] }} One result per provider.
 */
function event(canonicalName, params = {}, options = {}) {
  const entry = entryFor(canonicalName);

  if (!entry) {
    if (isDevelopment()) {
      throw new Error(`Unknown analytics event "${canonicalName}" — every event is declared in the catalog (@omega.js/analytics/catalog)`);
    }

    logger.warn(`Unknown event "${canonicalName}" — not in the catalog, skipped`);
    return { event: canonicalName, results: [] };
  }

  // An id no row has would select nothing in silence: the same programmer error
  // as an unknown event name, so it gets the same answer.
  const unknown = (options.providers || []).filter((id) => !analyticsProvider(id));
  if (unknown.length) {
    if (isDevelopment()) {
      throw new Error(`Unknown analytics provider "${unknown.join('", "')}" in the providers option of "${canonicalName}": every provider is a row in @omega.js/config/analytics-providers`);
    }

    logger.warn(`Unknown provider "${unknown.join('", "')}" in the providers option of "${canonicalName}", selects nothing`);
  }

  const results = FIRE_ORDER.map((adapter) => fire(adapter, canonicalName, params, options));

  if (isDevelopment()) {
    logger.log(`${canonicalName} → ${results.map((result) => `${result.provider} ${result.outcome}`).join(', ')}`);
  }

  return { event: canonicalName, results };
}

module.exports = {
  // The consumption surface
  event,
  configure,
  isDevelopment,

  // The pure pieces, for the hosts that need one without the facade
  catalog: CATALOG,
  entryFor,
  adapters: ADAPTERS,
  transports: { browser },
  core,
  // Identity is not an event, so it never walks the catalog: a host hashes the
  // signed-in visitor's match keys with these and sets them on its own pixels.
  identity,

  // The consent seam
  createConsentGate,
  CONSENT_CATEGORIES: CATEGORIES,
};
