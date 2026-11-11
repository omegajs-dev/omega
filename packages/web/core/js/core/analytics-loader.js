/**
 * The provider loaders — gated on consent, at RUNTIME
 * ([#383](https://github.com/Omega-JS-Stack/omega/issues/383)).
 *
 * foot.html used to emit the GA4, Meta and TikTok snippets straight into the
 * page whenever an id was configured, which meant every visitor was counted
 * before the banner had even finished animating in. The chrome still emits the
 * IDS (`window.OMEGA_BUILD_JSON.config.analytics`); the scripts themselves are injected
 * from here, and only for the consent category each provider's row names
 * (`analytics.capabilities`, the rows the build bakes beside the ids).
 *
 * Google Consent Mode is wired for the GA4 half: the `consent default` command
 * is queued into dataLayer BEFORE gtag.js can load (denied-by-default in an
 * opt-in region, granted in an opt-out one), and every later change pushes a
 * `consent update`. That is what makes a denied GA4 behave — the tag itself
 * honors the flags, on top of us not loading it at all.
 *
 * Granting a category injects its loader immediately, no reload. REVOKING one
 * cannot unload a script that is already running — there is no such thing — so
 * it takes effect on the next page load, while Consent Mode updates now.
 */
import { createLogger } from '__main_assets__/js/libs/logger.js';
import { event, getAnalyticsCapabilities } from '__main_assets__/js/libs/analytics.js';
import { getTrackingConsent, onTrackingConsentChange } from '__main_assets__/js/libs/tracking-consent.js';

const logger = createLogger('analytics-loader');

const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js';
const META_SRC = 'https://connect.facebook.net/en_US/fbevents.js';
const TIKTOK_SRC = 'https://analytics.tiktok.com/i18n/pixel/events.js';

// The TikTok pixel's own deferred-method list (vendor snippet).
const TIKTOK_METHODS = [
  'page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once',
  'ready', 'alias', 'group', 'enableCookie', 'disableCookie',
];

export default function ({ omega }) {
  const providers = (omega.config.analytics && omega.config.analytics.providers) || {};
  const ids = {
    google: idOf(providers.google),
    meta: idOf(providers.meta),
    tiktok: idOf(providers.tiktok),
  };

  // Nothing configured: no queues, no flags, no listener.
  if (!ids.google && !ids.meta && !ids.tiktok) {
    logger.log('No analytics provider is configured — nothing to gate');
    return;
  }

  const capabilities = getAnalyticsCapabilities();
  const loaded = { google: false, meta: false, tiktok: false };

  // Inject every provider the consent allows and that is not already running.
  const load = (consent) => {
    Object.keys(LOADERS).forEach((provider) => {
      if (!ids[provider] || loaded[provider] || !consent[capabilities[provider].consentCategory]) {
        return;
      }

      loaded[provider] = true;
      LOADERS[provider](omega, ids[provider]);
    });
  };

  const consent = getTrackingConsent();

  // Consent Mode's default MUST be queued before gtag.js can read dataLayer,
  // so it happens here, ahead of any injection. The boot state IS the default —
  // there is nothing to update yet.
  if (ids.google) {
    installGtagQueue();
    window.gtag('consent', 'default', consentModeFlags(consent));
    window.gtag('js', new Date());
  }

  load(consent);

  onTrackingConsentChange((next) => {
    if (ids.google) {
      window.gtag('consent', 'update', consentModeFlags(next));
    }

    load(next);
  });
}

/** A provider's configured id, or '' — an empty id is not configured. */
function idOf(provider) {
  const id = provider && provider.id;
  return typeof id === 'string' && id.trim() ? id.trim() : '';
}

/**
 * Google Consent Mode flags for one consent record. The ad_* trio rides
 * `marketing`, analytics_storage rides `analytics`.
 * @param {object} consent - a consent record (libs/tracking-consent.js)
 * @returns {object} the gtag consent payload
 */
function consentModeFlags(consent) {
  const ads = consent.marketing ? 'granted' : 'denied';

  return {
    ad_storage: ads,
    ad_user_data: ads,
    ad_personalization: ads,
    analytics_storage: consent.analytics ? 'granted' : 'denied',
  };
}

/**
 * The dataLayer queue gtag.js drains when (if) it loads. Ours is the standard
 * snippet's function — a real `arguments` push, not a rest spread, because
 * Google's tag reads the pushed object's `length`/index shape.
 */
function installGtagQueue() {
  window.dataLayer = window.dataLayer || [];

  if (window.gtag && window.gtag.__omega) {
    return;
  }

  function gtag() {
    window.dataLayer.push(arguments);
  }

  gtag.__omega = true;
  window.gtag = gtag;
}

/** The Meta pixel's queue (vendor snippet), without its script injection. */
function installMetaQueue() {
  if (window.fbq && window.fbq.queue) {
    return;
  }

  const fbq = function () {
    fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments);
  };

  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = '2.0';
  fbq.queue = [];

  window.fbq = fbq;
  window._fbq = window._fbq || fbq;
}

/**
 * The TikTok pixel's queue (vendor snippet), without its script injection —
 * `ttq.load` in the vendor blob both registers the instance AND appends the
 * script tag; only the registration survives here, so every provider script on
 * the page goes through the ONE seam (omega.dom.loadScript).
 */
function installTikTokQueue() {
  if (window.ttq && window.ttq.methods) {
    return;
  }

  window.TiktokAnalyticsObject = 'ttq';
  const ttq = window.ttq = [];

  ttq.methods = TIKTOK_METHODS;
  ttq.setAndDefer = function (target, method) {
    target[method] = function () {
      target.push([method].concat(Array.prototype.slice.call(arguments, 0)));
    };
  };
  ttq.methods.forEach((method) => ttq.setAndDefer(ttq, method));

  ttq.instance = function (id) {
    const instance = (ttq._i && ttq._i[id]) || [];
    ttq.methods.forEach((method) => ttq.setAndDefer(instance, method));
    return instance;
  };

  ttq.load = function (id, options) {
    ttq._i = ttq._i || {};
    ttq._i[id] = [];
    ttq._i[id]._u = TIKTOK_SRC;
    ttq._t = ttq._t || {};
    ttq._t[id] = +new Date();
    ttq._o = ttq._o || {};
    ttq._o[id] = options || {};
  };
}

/**
 * This pixel's page view, counted through the FACADE
 * ([#409](https://github.com/Omega-JS-Stack/omega/issues/409)). The raw
 * `fbq('track', 'PageView')` and `ttq.page()` this file used to fire at init
 * were the only page-view signal Meta and TikTok ever got, and they walked past
 * the catalog and the per-event consent gate every other event goes through.
 *
 * GA4 is deliberately NOT in the fire: `gtag('config', id)` counts the page view
 * itself, so a second one here would double-count every page.
 *
 * No params: both pixels read the page's own URL and title, exactly as the raw
 * calls left them to. The catalog's page params are for the runtimes that have
 * no document to read — desktop and the extension fire the same canonical event
 * through @omega.js/client.
 *
 * @param {string} provider - The provider id of the pixel that just
 *   initialized ('meta' | 'tiktok').
 * @returns {void}
 */
function countPageView(provider) {
  event('page_view', {}, { providers: [provider] });
}

/** Inject one provider script; a blocked or failed load is never fatal. */
function inject(omega, provider, src) {
  omega.dom.loadScript({ src: src })
    .catch((error) => logger.log(`${provider} did not load (blocked or offline):`, error.message));
}

const LOADERS = {
  google: (omega, id) => {
    // `config` is queued, not called on a loaded library: dataLayer holds it
    // until gtag.js drains the queue, exactly as the inline snippet did.
    window.gtag('config', id);
    inject(omega, 'google', `${GTAG_SRC}?id=${encodeURIComponent(id)}`);
  },

  meta: (omega, id) => {
    installMetaQueue();
    window.fbq('init', id);
    countPageView('meta');
    inject(omega, 'meta', META_SRC);
  },

  tiktok: (omega, id) => {
    installTikTokQueue();
    window.ttq.load(id);
    countPageView('tiktok');
    inject(omega, 'tiktok', `${TIKTOK_SRC}?sdkid=${encodeURIComponent(id)}&lib=ttq`);
  },
};
