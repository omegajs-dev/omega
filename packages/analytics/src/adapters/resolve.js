/**
 * The shared adapter mechanism — internal to the adapters.
 *
 * Every adapter is the same three steps: look the canonical event up in the
 * catalog, take THIS provider's mapping (absent → null, the caller logs the
 * dev skip), and run the entry's `map()` (or pass the canonical params
 * through). Only the attribution attachment differs per provider, so that is
 * the one thing an adapter file supplies.
 *
 * Pure: no I/O, no globals, no state. A descriptor is a plain object a
 * transport executes.
 */

const { entryFor } = require('../catalog.js');

/**
 * Copy the keys a provider understands out of a flat source object.
 * @param {object} source - The source object (may be undefined).
 * @param {string[]} keys - The keys to take.
 * @returns {object} Only the keys that are present.
 */
function pick(source, keys) {
  const out = {};
  if (!source) {
    return out;
  }

  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) {
      out[key] = source[key];
    }
  }

  return out;
}

// The page a conversion happened on, as the attribution touch captured it. Only
// the providers whose server API READS one take it (`attachPage` below).
const PAGE_KEYS = ['url', 'referrer'];

/**
 * Attach the conversion's page to a descriptor — the touch's url, and its
 * referrer when there is one
 * ([#497](https://github.com/Omega-JS-Stack/omega/issues/497)).
 *
 * The URL is neither payload nor match data, so it rides its own descriptor
 * member, and only when the touch actually carried one: a server conversion
 * fires from a webhook or an auth trigger, and an INVENTED url is worse to a
 * platform than an absent one. A referrer with no url is not half a page.
 *
 * @param {object} descriptor - The descriptor being built (mutated).
 * @param {object} [attribution] - The flat attribution context.
 */
function attachPage(descriptor, attribution) {
  const page = pick(attribution, PAGE_KEYS);

  if (page.url) {
    descriptor.page = page;
  }
}

/**
 * Build one provider's adapter.
 *
 * @param {object} options
 * @param {string} options.provider - The provider key, matching the catalog's `providers` key.
 * @param {Function} [options.attach] - (descriptor, attribution) => void; places the
 *   captured attribution where THIS provider wants it. Stage C
 *   ([#384](https://github.com/Omega-JS-Stack/omega/issues/384)) owns the capture;
 *   stage D ([#385](https://github.com/Omega-JS-Stack/omega/issues/385)) fills the
 *   rest of `userData` with server match data.
 * @returns {{ provider: string, resolve: Function }}
 */
function createAdapter({ provider, attach }) {
  /**
   * Resolve a canonical event into this provider's descriptor.
   * @param {string} canonicalName - The canonical event name.
   * @param {object} [params] - The canonical params.
   * @param {object} [context] - { attribution, consent, runtime }.
   * @returns {{ provider: string, name: string, kind: string, payload: object, userData: object }|null}
   */
  function resolve(canonicalName, params = {}, context = {}) {
    const entry = entryFor(canonicalName);
    if (!entry) {
      return null;
    }

    const mapping = entry.providers[provider];
    if (!mapping) {
      return null;
    }

    const descriptor = {
      provider,
      name: mapping.name,
      kind: mapping.kind,
      payload: mapping.map ? mapping.map(params, context) : { ...params },
      // The identity/match block. Empty here by design: attribution lands via
      // `attach` below, and the server enrichment is stage D's.
      userData: {},
    };

    // The one mapping shape a transport executes differently: a provider's own
    // pixel method (TikTok's `ttq.page()`), carried only when the catalog names
    // one so nothing has to test for a key that is normally absent.
    if (mapping.method) {
      descriptor.method = mapping.method;
    }

    // The other optional mapping key a TRANSPORT reads rather than a platform's
    // payload: Meta's `action_source`, the required server-event field naming
    // WHERE a conversion happened. Carried the same way `method` is, only when
    // the catalog overrides the default the sender supplies
    // ([#498](https://github.com/Omega-JS-Stack/omega/issues/498)).
    if (mapping.actionSource) {
      descriptor.actionSource = mapping.actionSource;
    }

    if (attach) {
      attach(descriptor, context.attribution);
    }

    return descriptor;
  }

  return { provider, resolve };
}

module.exports = { createAdapter, pick, attachPage };
