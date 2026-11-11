/**
 * Server-side conversion delivery — the ONE place a backend event reaches an ad
 * platform ([#385](https://github.com/Omega-JS-Stack/omega/issues/385), stage D
 * of [#302](https://github.com/Omega-JS-Stack/omega/issues/302)).
 *
 * Callers speak CANONICAL: one event name from `@omega.js/analytics`' catalog and
 * its canonical params. Every native name and payload shape comes from that
 * package's adapters, so the backend and the browser cannot drift — the catalog
 * is the SSOT for both. What lives here is the part a browser has no use for:
 * the three HTTP transports (GA4 Measurement Protocol, Meta Conversions API,
 * TikTok Events API) and the match data they carry.
 *
 * The name is checked against the catalog FIRST — an entry nobody knows is a
 * typo, and it says so once rather than reading like three deliberate
 * non-mappings. Then one fire walks the browser facade's own steps per provider,
 * plus the environment gate a server has to carry itself:
 *   1. consent — the order's/user's `trackingConsent` snapshot gates the category
 *   2. adapter — the catalog mapping, or null when the provider has none
 *      (`subscription_plan_change` and `trial_lapse` are GA4-only by catalog design)
 *   3. environment — only PRODUCTION reaches a platform; anywhere else the
 *      resolved fire is blocked and says so ([#464](https://github.com/Omega-JS-Stack/omega/issues/464))
 *   4. transport — the platform's HTTP API, fire-and-forget, errors isolated
 *
 * Delivery is NON-BLOCKING and never throws at its caller: a payment webhook or
 * a user creation must never fail because an ad platform did.
 *
 * Google enhanced conversions PROPER (the Google Ads API, uploading hashed
 * identifiers against a gclid) is a FUTURE platform file — it is a different API,
 * a different credential and a different consent story. v1 is GA4 Measurement
 * Protocol carrying the campaign params and gclid as event params.
 */
const fetch = require('wonderful-fetch');
const { ANALYTICS_PROVIDERS, analyticsProvider } = require('@omega.js/config/analytics-providers');
const env = require('../env.js');

// @omega.js/analytics is a private workspace package: in the monorepo the bare
// specifier resolves via the workspace link (and the prepare-package vendor hook
// rewrites it in dist/), but src/ ships in the tarball UNREWRITTEN and the test
// corpus deep-requires it in consumers — so fall back to the copy vendored into
// dist/, which sits at the same depth from both trees.
let adapters;
let entryFor;
try {
  adapters = {
    google: require('@omega.js/analytics/adapters/google'),
    meta: require('@omega.js/analytics/adapters/meta'),
    tiktok: require('@omega.js/analytics/adapters/tiktok'),
  };
  ({ entryFor } = require('@omega.js/analytics/catalog'));
} catch (e) {
  adapters = {
    google: require('../../../../dist/vendor/analytics/adapters/google.js'),
    meta: require('../../../../dist/vendor/analytics/adapters/meta.js'),
    tiktok: require('../../../../dist/vendor/analytics/adapters/tiktok.js'),
  };
  ({ entryFor } = require('../../../../dist/vendor/analytics/catalog.js'));
}

// Meta's Graph version the Conversions API is called on.
const META_API_VERSION = 'v21.0';

/**
 * Resolve the consent snapshot into the two category answers.
 *
 * ABSENCE IS NOT A DENIAL. A legacy order predating the consent system, and the
 * raw-API recovery lane that mints orders with no client anywhere near them,
 * both carry no snapshot — and refusing to report their revenue would be a
 * silent accounting hole. Only an EXPLICIT `false` blocks.
 *
 * @param {object|null} [trackingConsent] - The `{ analytics, marketing, ... }` snapshot.
 * @returns {{ analytics: boolean, marketing: boolean }}
 */
function resolveTrackingConsent(trackingConsent) {
  return {
    analytics: trackingConsent?.analytics !== false,
    marketing: trackingConsent?.marketing !== false,
  };
}

/**
 * Deliver one canonical event to every provider that maps it.
 *
 * @param {object} options
 * @param {string} options.event - The canonical event name (a catalog entry).
 * @param {object} [options.params] - The canonical params for that event.
 * @param {object} [options.attribution] - The flat attribution context (match-data.js).
 * @param {object} [options.identity] - The identity block (match-data.js buildIdentity).
 * @param {object|null} [options.trackingConsent] - The consent snapshot that rode the payload.
 * @param {string[]} [options.providers] - Restrict the fire to these providers. For a
 *   `placement: 'both'` event whose halves do not all deduplicate — the caller names
 *   the providers THIS half owns. Absent = every provider the catalog maps.
 * @param {string} options.eventId - The platform dedupe id for this fire.
 * @param {object} options.ctx - The route/event context (logging + GA4's request data).
 * @param {object} options.omega - The Omega instance (config + the GA4 helper).
 * @returns {object[]} One `{ provider, outcome }` per provider — for logs and tests.
 */
function deliverConversion({ event, params = {}, attribution = {}, identity = {}, trackingConsent = null, providers = null, eventId, ctx, omega }) {
  const granted = resolveTrackingConsent(trackingConsent);
  const context = { attribution: attribution };
  const results = [];

  // A name the catalog does not know reaches every adapter and resolves to null
  // in each — indistinguishable, per-provider, from a real event a provider
  // deliberately does not map (`subscription_plan_change` on Meta). So a typo
  // in a canonical name would stop reporting revenue and say nothing about it.
  // It gets its OWN outcome and one loud line, and it still never throws: a
  // webhook that has already taken the customer's money must not die on a
  // misspelling.
  if (!entryFor(event)) {
    ctx.error(`deliverConversion: [unknown canonical event] ${event} — not in the catalog; nothing sent (event_id=${eventId})`);

    return Object.keys(ANALYTICS_PROVIDERS).map((provider) => ({ provider, outcome: 'skipped (unknown event)' }));
  }

  // An id no row has selects nothing. It is said out loud, never thrown: the
  // caller may be a webhook that has already taken the money.
  const unknown = (providers || []).filter((id) => !analyticsProvider(id));
  if (unknown.length) {
    ctx.warn(`deliverConversion: [unknown provider] ${unknown.join(', ')} in the providers of ${event}, selects nothing (event_id=${eventId})`);
  }

  for (const { id: provider, consentCategory } of Object.values(ANALYTICS_PROVIDERS)) {
    const adapter = adapters[provider];

    // Selection comes before consent: a provider this half does not own was
    // never going to be asked, whatever the visitor consented to.
    if (providers && !providers.includes(provider)) {
      results.push({ provider, outcome: 'skipped (not selected)' });
      continue;
    }

    if (!granted[consentCategory]) {
      results.push({ provider, outcome: `skipped (consent: ${consentCategory})` });
      continue;
    }

    const descriptor = adapter.resolve(event, params, context);

    if (!descriptor) {
      results.push({ provider, outcome: 'skipped (no mapping)' });
      continue;
    }

    // Read BEFORE the environment gate: what a blocked dev fire WOULD have
    // matched on is the question a dev run is asking.
    const match = matchSummary(provider, { descriptor, identity, eventId });

    // ONLY production reaches a platform. An emulator boot seeds personas, every
    // seeded account fired the server half of `sign_up`, and Meta DELIVERED dozens
    // of fake registrations to the brand's live pixel — a dev run polluting real ad
    // data ([#464](https://github.com/Omega-JS-Stack/omega/issues/464)). The gate is
    // the one `@omega.js/monitoring` and the Measurement Protocol helper already
    // use: any NON-production environment (development OR testing), intentional
    // `!isProduction()`. It sits AFTER the resolve so the dev trace still names
    // which providers would have fired, and with what — a blocked send is
    // information, not silence, so each one says so on its own line.
    if (!ctx.isProduction()) {
      ctx.log(`deliverConversion [${provider}]: ${event} blocked (dev) — nothing sent (event_id=${eventId})`);
      results.push({ provider, outcome: 'blocked (dev)', descriptor, match });
      continue;
    }

    try {
      results.push({ provider, outcome: SENDERS[provider]({ descriptor, identity, eventId, ctx, omega }), descriptor, match });
    } catch (e) {
      ctx.error(`deliverConversion [${provider}] failed: ${e.message}`, e);
      results.push({ provider, outcome: 'failed' });
    }
  }

  // ` | ` between providers, because each one's match summary carries commas of
  // its own — one line per fire is still the contract.
  ctx.log(`deliverConversion: ${event} → ${results.map((result) => [result.provider, result.outcome, result.match].filter(Boolean).join(' ')).join(' | ')} (event_id=${eventId})`);

  return results;
}

// ---------------------------------------------------------------------------
// GA4 — Measurement Protocol
// ---------------------------------------------------------------------------

/**
 * Fire the descriptor through the Measurement Protocol helper, which owns the
 * MP envelope (client id, user properties, request context) for the whole
 * backend. The descriptor's payload already carries the campaign params the GA4
 * adapter lifted out of the attribution context.
 *
 * No hashed PII here: `services/analytics.js` builds GA4's `user_data` from the
 * authenticated request's own user, which a webhook or an auth trigger does not
 * have. Meta and TikTok are where the match data earns its keep.
 *
 * https://developers.google.com/analytics/devguides/collection/protocol/ga4
 */
function sendGoogle({ descriptor, identity, ctx, omega }) {
  ctx.analytics.forUser(identity.externalId).event(descriptor.name, descriptor.payload);

  return 'sent';
}

// ---------------------------------------------------------------------------
// Meta — Conversions API
// ---------------------------------------------------------------------------

/**
 * Build the Conversions API body for one descriptor.
 *
 * `user_data` is the match block: the adapter has already put `fbc`/`fbp` there,
 * and the identity block fills the rest — every parameter Meta's
 * customer-information reference accepts, hashed by Meta's own rule for each
 * ([#577](https://github.com/Omega-JS-Stack/omega/issues/577)). `event_id` is
 * Meta's DEDUPLICATION key — a browser event with the same name and id is
 * counted once.
 *
 * `action_source` is `website` unless the catalog's mapping named another one:
 * a renewal, a recovered payment and a trial converting are billed by the
 * provider with nobody on the site, and Meta's own enum has `system_generated`
 * for exactly that ([#498](https://github.com/Omega-JS-Stack/omega/issues/498)).
 *
 * `event_source_url` is the page the conversion is credited to — the attribution
 * touch's url, which the descriptor carries when the touch had one
 * ([#497](https://github.com/Omega-JS-Stack/omega/issues/497)). A webhook has no
 * page of its own, so an order with no touch sends no key at all.
 *
 * https://developers.facebook.com/docs/marketing-api/conversions-api
 *
 * @param {object} options
 * @param {object} options.descriptor - The resolved provider descriptor.
 * @param {object} options.identity - The identity block (match-data.js).
 * @param {string} options.eventId - The dedupe id.
 * @returns {object} The POST body.
 */
function buildMetaBody({ descriptor, identity, eventId }) {
  const userData = { ...descriptor.userData };

  if (identity.externalId) {
    // RAW on purpose, verified against the live spec (#410): Meta's
    // customer-information reference marks external_id "Hashing recommended",
    // not required, and its Pixel example passes a bare id — so both Meta
    // halves carry the same raw uid. TikTok's is the half that must be hashed.
    userData.external_id = identity.externalId;
  }
  if (identity.emailHash) {
    userData.em = identity.emailHash;
  }
  if (identity.metaPhoneHash) {
    // Meta's own spec: the phone hashed as BARE DIGITS (#392).
    userData.ph = identity.metaPhoneHash;
  }
  if (identity.ip) {
    userData.client_ip_address = identity.ip;
  }
  if (identity.userAgent) {
    userData.client_user_agent = identity.userAgent;
  }

  // The rest of Meta's customer-information set — fn ln ct st zp country db ge —
  // already normalized and hashed by Meta's own table
  // (`match-data.js`, [#577](https://github.com/Omega-JS-Stack/omega/issues/577)).
  // Keyed in Meta's vocabulary at the source, so nothing is re-mapped here and
  // a parameter is added in exactly one place.
  Object.assign(userData, identity.meta);

  const event = {
    event_name: descriptor.name,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    // WHERE the conversion happened, a field Meta requires and asks be accurate.
    // `website` is the default because that is where a person converts; the
    // catalog overrides it per event for the charges a card takes with nobody
    // present, which Meta's enum calls `system_generated`
    // ([#498](https://github.com/Omega-JS-Stack/omega/issues/498)).
    action_source: descriptor.actionSource || 'website',
    user_data: userData,
    custom_data: descriptor.payload,
  };

  if (descriptor.page) {
    event.event_source_url = descriptor.page.url;
  }

  return { data: [event] };
}

function sendMeta({ descriptor, identity, eventId, ctx, omega }) {
  const pixelId = omega.config.analytics?.providers?.meta?.id;
  const accessToken = env.get('META_ACCESS_TOKEN');

  if (!pixelId || !accessToken) {
    return 'skipped (not configured)';
  }

  post(`https://graph.facebook.com/${META_API_VERSION}/${pixelId}/events?access_token=${accessToken}`, {
    body: buildMetaBody({ descriptor, identity, eventId }),
  }, { provider: 'Meta', descriptor, ctx });

  return 'sent';
}

// ---------------------------------------------------------------------------
// TikTok — Events API
// ---------------------------------------------------------------------------

/**
 * Build the Events API body for one descriptor.
 *
 * The `/event/track/` endpoint speaks Events API 2.0, where the match block is
 * ONE FLAT `data[].user` object: the hashed email, phone and external id, the
 * `ttclid`/`ttp` the adapter put in `userData`, and the request pair. The v1.2
 * nesting this used to build (`context.user`, `context.ad.callback`,
 * `context.ip`, `context.user_agent`) is not a synonym — TikTok reads none of
 * it, so a body in the old shape matched nobody while looking accepted
 * ([#482](https://github.com/Omega-JS-Stack/omega/issues/482)). The phone's key
 * moved with it: `phone_number` in v1.2, `phone` in 2.0.
 *
 * `page` (the url + referrer of the conversion) is 2.0's other data-item member,
 * and it is the attribution touch's: a server conversion arrives from a payment
 * webhook or an auth trigger and has no page of its own, so the touch's is the
 * only URL it can honestly claim ([#497](https://github.com/Omega-JS-Stack/omega/issues/497)).
 * The descriptor carries it only when the touch did — an order with no touch
 * sends no `page`, because an invented one is worse than an absent one. Meta's
 * body takes the same url as its `event_source_url`.
 *
 * https://business-api.tiktok.com/portal/docs?id=1771100865818625
 *
 * @param {object} options
 * @param {object} options.descriptor - The resolved provider descriptor.
 * @param {object} options.identity - The identity block (match-data.js).
 * @param {string} options.eventId - The dedupe id.
 * @param {string} options.pixelCode - The brand's TikTok pixel code.
 * @returns {object} The POST body.
 */
function buildTikTokBody({ descriptor, identity, eventId, pixelCode }) {
  const user = {};

  if (identity.tiktokExternalIdHash) {
    // TikTok's Events API reference: "SHA-256 hashing is required" for
    // external_id, where Meta's spec only recommends it (#410). The browser
    // half hashes the same uid the same way, so the two still link.
    user.external_id = identity.tiktokExternalIdHash;
  }
  if (identity.emailHash) {
    user.email = identity.emailHash;
  }
  if (identity.tiktokPhoneHash) {
    // TikTok's own spec: the phone hashed in E.164, WITH the plus (#392) — a
    // different digest from Meta's for the same person.
    user.phone = identity.tiktokPhoneHash;
  }
  if (descriptor.userData.ttp) {
    user.ttp = descriptor.userData.ttp;
  }
  if (descriptor.userData.ttclid) {
    user.ttclid = descriptor.userData.ttclid;
  }
  if (identity.ip) {
    user.ip = identity.ip;
  }
  if (identity.userAgent) {
    user.user_agent = identity.userAgent;
  }

  const event = {
    event: descriptor.name,
    // REQUIRED, and in Unix SECONDS — the ISO string this used to send is
    // v1.2's `timestamp`, a field 2.0 does not read (#482).
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    user: user,
    properties: descriptor.payload,
  };

  if (descriptor.page) {
    event.page = descriptor.page;
  }

  return {
    // The DESTINATION is named at the top level, and TikTok validates it there
    // first: the id used to ride as `data[].pixel_code`, so every live fire came
    // back `{"code":40002,"message":"Invalid value for event_source_id: not a
    // valid string."}` while the pixel id sat correctly in config the whole time
    // ([#465](https://github.com/Omega-JS-Stack/omega/issues/465)).
    event_source: 'web',
    event_source_id: pixelCode,
    data: [event],
  };
}

function sendTikTok({ descriptor, identity, eventId, ctx, omega }) {
  const pixelCode = omega.config.analytics?.providers?.tiktok?.id;
  const accessToken = env.get('TIKTOK_ACCESS_TOKEN');

  if (!pixelCode || !accessToken) {
    return 'skipped (not configured)';
  }

  post('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
    headers: { 'Access-Token': accessToken },
    body: buildTikTokBody({ descriptor, identity, eventId, pixelCode }),
  }, { provider: 'TikTok', descriptor, ctx });

  return 'sent';
}

// The provider id → its transport: one per row whose `serverSender` is true. A
// new platform joins here, as an adapter, and as a row in @omega.js/config's
// analytics-providers; nothing else in the backend changes.
const SENDERS = {
  google: sendGoogle,
  meta: sendMeta,
  tiktok: sendTikTok,
};

// The provider id → its match block, read out of the body the transport would
// send. Built here rather than tracked alongside, so the log can never claim a
// key the wire does not actually carry. One per row with match keys.
const MATCH_BLOCKS = {
  meta: ({ descriptor, identity, eventId }) => buildMetaBody({ descriptor, identity, eventId }).data[0].user_data,
  tiktok: ({ descriptor, identity, eventId }) => buildTikTokBody({ descriptor, identity, eventId, pixelCode: null }).data[0].user,
};

/**
 * What this fire matches on, for the log: `sent em,external_id; empty ph,fn,…`
 *
 * KEY NAMES ONLY. A hashed email is still that person's email, so no value from
 * a match block ever reaches a log line — the names are what say whether the
 * plumbing is working.
 *
 * @param {string} provider - The provider key.
 * @param {object} fire - `{ descriptor, identity, eventId }`.
 * @returns {string|null} The summary, or null for a provider whose match block
 *   this module does not build (GA4 — the Measurement Protocol helper owns it).
 */
function matchSummary(provider, fire) {
  const accepted = ANALYTICS_PROVIDERS[provider].matchKeys;

  if (!accepted.length) {
    return null;
  }

  const block = MATCH_BLOCKS[provider](fire);
  const sent = accepted.filter((key) => key in block);
  const empty = accepted.filter((key) => !(key in block));

  return `sent ${sent.join(',') || 'nothing'}; empty ${empty.join(',') || 'nothing'}`;
}

/**
 * Fire-and-forget POST. The conversion is a side effect of work that already
 * succeeded, so a platform being down is a log line, never a rejection.
 */
function post(url, options, { provider, descriptor, ctx }) {
  fetch(url, {
    method: 'post',
    response: 'json',
    timeout: 60000,
    tries: 2,
    ...options,
  })
    .then(() => {
      ctx.log(`deliverConversion [${provider}]: ${descriptor.name} delivered`);
    })
    .catch((e) => {
      ctx.error(`deliverConversion [${provider}] failed: ${e.message}`, e);
    });
}

module.exports = {
  deliverConversion,
  // Exported for testing — the payload shapes are the contract with the platforms
  resolveTrackingConsent,
  buildMetaBody,
  buildTikTokBody,
  adapters,
  // Pinned against the provider rows: a sender per serverSender row, a match
  // block per row with match keys
  SENDERS,
  MATCH_BLOCKS,
};
