/**
 * The web host of the analytics facade — the ONE way a page counts anything
 * ([#328](https://github.com/Omega-JS-Stack/omega/issues/328), stage E).
 *
 * `@omega.js/analytics` owns the catalog, the per-provider adapters and the
 * guarded browser transport ([docs/shared/analytics.md](../../../../../docs/shared/analytics.md)).
 * What lives HERE is the part only a page can supply — the host's three seams:
 *
 *   transport  the package's browser transport: the page's own gtag/fbq/ttq,
 *              each guarded, so a blocked provider is a silent no-op (#306)
 *   consent    the banner's record (`libs/tracking-consent.js`), read LIVE, so
 *              a visitor who accepts mid-session is counted from that moment
 *   context    the captured attribution (#384) flattened into what the adapters
 *              read, plus `runtime: 'web'`
 *
 * `environment` is NOT set here: @omega.js/client injects it at init from the
 * brand's own `config.environment`, which is the one seam that knows.
 *
 * The package is reached through @omega.js/client, never as a bare specifier:
 * `@omega.js/analytics` is private and never publishes, so it exists in a
 * consumer install only as the copy vendored into the client's dist — and the
 * client is a real runtime dependency of every framework (HARD RULE 3).
 *
 * Call sites speak CANONICAL and nothing else:
 *
 *   event('add_to_cart', { currency: 'USD', value: 19, items: [...] });
 *
 * The old guarded wrappers (trackGoogle/trackMeta/trackTikTok) are gone with
 * the rewire: a call site that names a provider is a call site that can drift
 * from the catalog.
 *
 * IDENTITY is the one thing that is not an event — it has no catalog entry
 * because it is a setting the events after it inherit — so it stays here, in
 * the one module already allowed to name the page globals, guarded the same way.
 * GA4's `user_id` is the exception: @omega.js/client owns that one key on every
 * runtime, so nothing below writes it (see `identify()`).
 */
import omega from '@omega.js/web/runtime';

import { analytics } from '@omega.js/client/modules/analytics.js';
import { getTrackingConsent } from '__main_assets__/js/libs/tracking-consent.js';

// The captured touch's utm keys → the flat campaign params the GA4 adapter
// lifts into the event payload (query-strings.js writes the utm names).
const CAMPAIGN_PARAMS = {
  source: 'utm_source',
  medium: 'utm_medium',
  campaign: 'utm_campaign',
  term: 'utm_term',
  content: 'utm_content',
};

// The ad platforms' own cookies, and the attribution key each rides under. They
// are written by the platform pixels, so they are read FRESH at fire time and
// never persisted — a stale `_fbc` would match the wrong click. The BROWSER
// only ever sends real cookies; constructing one from a click id is the
// server's half of the deal (@omega.js/backend's match-data.js).
export const PLATFORM_COOKIES = { _fbc: 'fbc', _fbp: 'fbp', _ttp: 'ttp' };

let configured = false;

/**
 * Wire the page's three seams into the facade. Idempotent — the boot calls it,
 * and every entry point below calls it too, so a fire can never beat it.
 * @returns {void}
 */
export function configureAnalytics() {
  if (configured) {
    return;
  }

  configured = true;

  analytics.configure({
    transport: analytics.transports.browser,
    // The gate reads its provider function on every event, so nothing has to
    // re-configure when the visitor answers the banner.
    consent: analytics.createConsentGate(readTrackingConsent),
    context: {
      runtime: 'web',
      // A getter, not a snapshot: attribution is captured per visit and the
      // platform cookies appear when their pixels load, both after this runs.
      get attribution() {
        return readAttribution();
      },
    },
  });
}

/**
 * The two seams below both READ CLIENT STORAGE, and a page's storage can fail
 * for reasons that have nothing to do with us — a private window, a full quota,
 * a jar the visitor turned off. Every one of these reads sits in front of the
 * thing the customer just pressed, so a throw would take the action with it: the
 * same shape as the blocked-global bug ([#306](https://github.com/Omega-JS-Stack/omega/issues/306)),
 * one layer up. Consent that cannot be read is NO consent — the safe direction,
 * and the only one an unreadable record can honestly claim.
 */
function readTrackingConsent() {
  try {
    return getTrackingConsent();
  } catch (e) {
    return { analytics: false, marketing: false };
  }
}

/** Attribution that cannot be read is simply absent — never a raise. */
function readAttribution() {
  try {
    return buildAttributionContext();
  } catch (e) {
    return {};
  }
}

/**
 * Fire a canonical event.
 *
 * @param {string} name - A canonical event name (the catalog is the SSOT).
 * @param {object} [params] - That event's canonical params.
 * @param {object} [options] - `{ eventId, providers }` for an event whose other
 *   half fires server-side (see the purchase pixel).
 * @returns {object} The facade's per-provider result.
 */
export function event(name, params = {}, options = {}) {
  configureAnalytics();

  return analytics.event(name, params, options);
}

/**
 * Attach the signed-in identity to everything counted after it.
 *
 * Not an event: each provider takes an identity SETTING that its later events
 * inherit — GA4's `set`, the Meta Pixel's advanced-matching `init`, TikTok's
 * `identify`. Every call is guarded on its own global, because a blocker takes
 * one provider without touching the others (#306).
 *
 * `external_id` is each platform's own key, matched on their side, and each one
 * takes the shape its spec asks for: Meta the RAW uid, TikTok the SHA-256 of
 * that same uid ([#410](https://github.com/Omega-JS-Stack/omega/issues/410)).
 * GA4's `user_id` is a different contract — one id per person across every
 * surface — and @omega.js/client is its single owner.
 *
 * @param {object|null} user - The signed-in user (`{ uid, email, phoneNumber }`), or null.
 * @returns {Promise<void>} Resolves once the pixels have been told. Nothing
 *   awaits it in production — an auth transition must never wait on a digest —
 *   and a digest that cannot be computed resolves quietly rather than raising.
 */
export function identify(user) {
  configureAnalytics();

  const userId = user?.uid;

  if (!userId) {
    reset();
    return Promise.resolve();
  }

  const email = user?.email;

  // GA4's `user_id` is NOT set here: @omega.js/client's `setUserId()` owns it
  // and sends the DERIVED id (`uuidv5(uid, namespace)`) — the same value the
  // backend's Measurement Protocol and the desktop singleton emit for this
  // account. Both run on this page off the same auth transition, so a raw uid
  // written here would simply be the last writer, and GA4 would hold an id no
  // other surface ever sends. The user PROPERTIES are ours alone.
  if (typeof gtag === 'function') {
    gtag('set', {
      user_properties: {
        email_domain: email ? email.split('@')[1] : undefined,
      },
    });
  }

  return identifyPixels(userId, email, user?.phoneNumber);
}

/**
 * The pixels' half of the identity: every match key SHA-256, and `external_id`
 * in whichever shape its platform's own spec asks for.
 *
 * The hashing rules are the shared package's (`@omega.js/analytics/identity`),
 * not this file's, so a normalization rule has one home to change. They are PER
 * PROVIDER on purpose: Meta's advanced matching hashes a phone as bare digits,
 * TikTok's pixel hashes E.164 — the same number, two digests, and sending either
 * one's key to the other matches nobody.
 *
 * Against the SERVER's match data (@omega.js/backend's
 * `libraries/analytics/match-data.js`) every digest agrees exactly: the email
 * always did, and the phone converged when the server took each platform's own
 * normalization ([#392](https://github.com/Omega-JS-Stack/omega/issues/392)).
 *
 * `external_id` is per provider too, verified against the live specs
 * ([#410](https://github.com/Omega-JS-Stack/omega/issues/410)). TikTok's Events
 * API REQUIRES it hashed, so this half hashes the same uid the same way the
 * server does and the two still meet. Meta only RECOMMENDS hashing and its own
 * Pixel example passes a bare id, so Meta keeps the raw uid — which is not a
 * leak: it is Meta's own key, matched on their side, and it is the exact string
 * the server sends as `identity.externalId`.
 *
 * Consent needs no gate here: a pixel exists on the page only after a marketing
 * grant loaded it (`core/js/core/analytics-loader.js`), so the `typeof` guards
 * below already carry the visitor's answer.
 *
 * @param {string} userId - The raw uid.
 * @param {string} [email] - The account's email address.
 * @param {string} [phone] - Auth's `phoneNumber` (E.164), when the account has one.
 * @returns {Promise<void>} An identity that cannot be HASHED identifies nobody
 *   and says nothing about it, the same silence a blocked global gets (#306).
 */
async function identifyPixels(userId, email, phone) {
  const { sha256, normalizeEmail, normalizeExternalId, metaPhone, tiktokPhone } = analytics.identity;

  const keys = { emailHash: null, metaPhoneHash: null, tiktokPhoneHash: null, tiktokExternalIdHash: null };

  try {
    // A page's only digest is `crypto.subtle`, which is asynchronous — the one
    // reason this half of `identify()` is not synchronous like the gtag half.
    const [emailHash, metaPhoneHash, tiktokPhoneHash, tiktokExternalIdHash] = await Promise.all([
      sha256(normalizeEmail(email)),
      sha256(metaPhone(phone)),
      sha256(tiktokPhone(phone)),
      // TikTok's rule for external_id is the trim and nothing else — the same
      // normalizer the server's `hashExternalId()` runs before it hashes.
      sha256(normalizeExternalId(userId)),
    ]);

    Object.assign(keys, { emailHash, metaPhoneHash, tiktokPhoneHash, tiktokExternalIdHash });
  } catch (e) {
    // A digest that REFUSED. The quieter path is the common one and never lands
    // here: on an insecure origin there is no `crypto.subtle` at all, and the
    // shared `sha256()` answers null rather than throwing (#306). Both paths
    // cost the HASHED keys and neither costs the identity — see the `||` on
    // TikTok's `external_id` below, which covers them together.
  }

  // A digest that could not be computed, by either path, costs the hashed keys
  // and nothing more: `external_id` still goes as the raw uid — Meta's own
  // shape, and one TikTok's pixel documents as accepted ("Unhashed or hashed
  // SHA-256") — because an identity carrying only external_id is worth more
  // than one nobody ever sent, the same call the server's match data makes when
  // it has nothing else to send.

  // Meta's advanced matching is re-`init`ed with the match keys; the pixel id
  // is the same one the consent-gated loader initialized with.
  if (typeof fbq === 'function' && metaPixelId()) {
    fbq('init', metaPixelId(), compact({
      external_id: userId,
      em: keys.emailHash,
      ph: keys.metaPhoneHash,
    }));
  }

  if (typeof ttq !== 'undefined' && typeof ttq.identify === 'function') {
    ttq.identify(compact({
      // The digest the Events API half sends, so one person is one person
      // across the two halves; the raw uid only when no digest exists at all.
      external_id: keys.tiktokExternalIdHash || userId,
      email: keys.emailHash,
      phone_number: keys.tiktokPhoneHash,
    }));
  }
}

/**
 * Forget the identity — the visitor signed out, and nothing counted after this
 * belongs to them.
 * @returns {void}
 */
export function reset() {
  configureAnalytics();

  // GA4 is not cleared here for the same reason it is not set in `identify()`:
  // @omega.js/client's `setUserId(null)` is what tells GA4 to stop attributing
  // to the person who just signed out, and it fires off the same transition.

  if (typeof fbq === 'function' && metaPixelId()) {
    fbq('init', metaPixelId(), {});
  }

  if (typeof ttq !== 'undefined' && typeof ttq.identify === 'function') {
    ttq.identify({});
  }
}

/** The brand's Meta pixel id, or '' when Meta is not configured. */
function metaPixelId() {
  return omega.config.analytics?.providers?.meta?.id || '';
}

/**
 * Only the keys that resolved to a value — a block carrying `ph: null` is noise
 * the platforms read as a field we tried and failed to send. The same shape the
 * server's match data compacts with.
 * @param {object} block - The match or attribution block.
 * @returns {object} The block without its empty keys.
 */
function compact(block) {
  return Object.fromEntries(Object.entries(block).filter(([, value]) => value !== undefined && value !== null));
}

/**
 * The flat attribution the adapters read: GA4 takes the campaign fields as
 * event params, Meta takes `fbc`/`fbp` and TikTok `ttclid`/`ttp` into the
 * descriptor's match block. Mirrors the backend's `buildAttributionContext()`
 * ([#385](https://github.com/Omega-JS-Stack/omega/issues/385)), two deliberate
 * differences: the browser sends only REAL cookies, and it carries no
 * `url`/`referrer` ([#497](https://github.com/Omega-JS-Stack/omega/issues/497)
 * added them server-side; browser pixels read the page themselves).
 *
 * @returns {object} Only the keys that resolved to a value.
 */
function buildAttributionContext() {
  const attribution = omega.storage.get('attribution', {});
  // Last touch when there is one, else first: last is only ever written by a
  // TAGGED visit (#384), so the fallback is what gives an organic-then-direct
  // visitor their campaign back.
  const touch = attribution?.last || attribution?.first || {};
  const tags = touch.tags || {};
  const clickIds = touch.clickIds || {};
  const cookies = readPlatformCookies();

  const context = {
    ...Object.fromEntries(
      Object.entries(CAMPAIGN_PARAMS)
        .map(([param, utmKey]) => [param, tags[utmKey]])
        .filter(([, value]) => !!value)
    ),
    fbc: cookies.fbc,
    fbp: cookies.fbp,
    ttclid: clickIds.ttclid,
    ttp: cookies.ttp,
    gclid: clickIds.gclid,
  };

  return compact(context);
}

/**
 * The platform cookies present on this document right now.
 *
 * Exported because the checkout's intent payload needs the same read at the
 * same moment — one reader, so a separator quirk cannot be fixed on one path
 * and left on the other.
 *
 * @returns {object} `{ fbc?, fbp?, ttp? }` — only the cookies that are set.
 */
export function readPlatformCookies() {
  const cookies = {};

  (document.cookie || '').split(';').forEach((entry) => {
    const separator = entry.indexOf('=');

    if (separator === -1) {
      return;
    }

    const key = PLATFORM_COOKIES[entry.slice(0, separator).trim()];
    const value = entry.slice(separator + 1).trim();

    if (key && value) {
      cookies[key] = value;
    }
  });

  return cookies;
}

/**
 * The provider rows the build bakes as `analytics.capabilities`. A config
 * without them was not baked by the build, so there is nothing to fall back to.
 * @returns {object} provider id → its row.
 */
export function getAnalyticsCapabilities() {
  const capabilities = omega.config.analytics?.capabilities;

  if (!capabilities) {
    throw new Error('analytics.capabilities is missing from the build config: the page cannot tell which consent category gates each provider');
  }

  return capabilities;
}
