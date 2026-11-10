/**
 * Verts module — the fallback-ladder ad engine shared by every surface
 * (docs/web/ads-system.md, phase 2).
 *
 * Three lanes, one implementation:
 *   1. Provider lane (web only): AdSense. Script-load failure IS the adblock
 *      detector (no bait divs, no library) — blocked → straight to the
 *      fallback lane. Otherwise the <ins> is built per type and fill is
 *      awaited via a MutationObserver on data-ad-status (+ timeout).
 *   2. Fallback lane (all surfaces): a sandboxed iframe to the resolved
 *      in-house source's /omega/verts/serve, origin-validated postMessage with
 *      a fixed vocabulary (omega-vert:set-dimensions / omega-vert:click), and
 *      HOST-owned lifecycle — rotation timer, staleness recovery
 *      (visibilitychange/online → reload when stale), and no-fill teardown
 *      (a unit that never reports dimensions within the fill timeout drops
 *      its frame and emits omega-vert:no-fill). The iframe only renders and
 *      reports; it never refreshes itself (kills the legacy chrome-error
 *      stranding).
 *   3. Terminal lane (all surfaces): the built-in OMEGA promo. A unit NEVER
 *      renders empty — when every configured lane has failed (no provider /
 *      no fill / blocked, and no reachable in-house source) the host gets a
 *      REAL unit carrying the built-in promo: the same sandboxed iframe, the
 *      same postMessage vocabulary, the same host-owned sizing and click
 *      handling as the fallback lane, except the document arrives by srcdoc
 *      instead of over the wire (zero network, ever). omega-vert:no-fill
 *      still fires first — nothing was sold — followed by omega-vert:promo.
 *
 * Click tracking: analytics cannot run inside a cross-origin frame, so the
 * legacy stack bounced every click through a top-level forward page that
 * fired gtag before navigating. Here the frame posts omega-vert:click OUT and
 * the HOST fires the vert_click event through this brand's own analytics —
 * no forward page, no navigation delay. The destination carries the vert UTM
 * set either way: the promo's link is tagged in-place here, a served vert's
 * by the backend redirect route (both through applyVertUtm).
 *
 * Element binding (the mirrored-implementation surface): mount($el) arms one
 * host lazily near the viewport (IntersectionObserver) reading its
 * data-omega-vert* attributes; bind(root) scans [data-omega-vert] and mounts
 * every match. The web verts/unit section delegates here, and desktop/
 * extension bind the same vocabulary in phase 4 — one implementation.
 *
 * Theme: a unit follows the PAGE, not the OS. Mount reads `data-bs-theme` off
 * the root element into the frame's theme (both lanes: the house serve URL's
 * theme param and the promo document's stamp), a host's own
 * data-omega-vert-theme pins it, and nothing set anywhere leaves the frame on
 * its own prefers-color-scheme branch. A flip after render re-stamps the promo
 * frames (a srcdoc assignment, no network); a house frame keeps the theme it
 * mounted with, since re-theming it would mean re-fetching it.
 *
 * Source resolution (advertising.providers.inhouse.source):
 *   'self'    → this brand's api URL (omega.getApiUrl())
 *   'company' → the parent company's api URL (the RESOLVED config.company.url
 *               through the same api-URL derivation: the brand types
 *               `company: { id }` and the loader fills the url, #677)
 *   full URL  → used verbatim (trailing slashes stripped)
 */

import { createLogger } from './logger.js';
import { replaceChildren } from './dom.js';
import {
  renderVertDocument,
  applyVertUtm,
  MESSAGE_DIMENSIONS,
  MESSAGE_CLICK,
  OMEGA_ACCENT,
  UTM_MEDIUM,
  UTM_CAMPAIGN_PROMO,
} from './vert-document.js';

const logger = createLogger('verts');

// Size presets (name → max-height in pixels) — the ONE px table (SSOT; the
// section scss carries no copy, the module applies the constraint inline).
const SIZE_PRESETS = {
  banner: 150,
  leaderboard: 90,
  rectangle: 250,
  'large-rectangle': 600,
  skyscraper: 600,
};

// AdSense unit attributes per type — the ONE layout table (the legacy
// duplicated the in-feed layout keys across includes).
const ADSENSE_FORMATS = {
  display: { style: 'display:block', attributes: { 'data-ad-format': 'auto', 'data-full-width-responsive': 'true' }, slotKey: 'displaySlot' },
  'in-article': { style: 'display:block; text-align:center', attributes: { 'data-ad-layout': 'in-article', 'data-ad-format': 'fluid' }, slotKey: 'inArticleSlot' },
  'in-feed': { style: 'display:block', attributes: { 'data-ad-format': 'fluid' }, slotKey: 'inFeedSlot', layoutKeys: { 'image-above': '-6t+ed+2x-11-88', 'image-side': '-fb+5w+4e-db+86' } },
  multiplex: { style: 'display:block', attributes: { 'data-ad-format': 'autorelaxed' }, slotKey: 'multiplexSlot' },
};

// Sandbox attributes for the house iframe (legacy-proven set)
const IFRAME_SANDBOX = 'allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-top-navigation-by-user-activation';

// The promo frame is a srcdoc document, so allow-same-origin would hand it
// THIS page's origin (and with allow-scripts that is no sandbox at all). It
// drops out; the rest of the house set carries over verbatim.
const PROMO_SANDBOX = IFRAME_SANDBOX.split(' ').filter((token) => token !== 'allow-same-origin').join(' ');

// Lifecycle defaults — rotation OFF by default; staleness generous
const DEFAULT_FILL_TIMEOUT = 9000;
const DEFAULT_STALE_AFTER = 1000 * 60 * 10;
const DEFAULT_ROTATE_INTERVAL = 0;
const MAX_HEIGHT_CEILING = 1200;

// The terminal lane: the built-in OMEGA promo. A real unit in every way the
// fallback lane is one, with the document inlined by srcdoc: no network, no
// external image, literal colours per theme (both modes hold, themed page or
// not, since css variables do not cross the frame boundary).
const PROMO_URL = 'https://omegajs.dev';
const PROMO_ID = 'omega-promo';
const PROMO_MIN_HEIGHT = 90;
const PROMO_TITLE = 'Built with OMEGA';
const PROMO_DESCRIPTION = 'The full-stack JavaScript framework for web, backend, desktop, and extensions.';
const PROMO_BUTTON = 'Visit omegajs.dev';

// The promo's thumbnail: an inline svg mark, the ONE trusted-markup value the
// renderer ever receives (a local constant, never data)
const PROMO_MARK = '<svg class="omega-vert-image" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
  + '<rect x="0" y="0" width="24" height="24" fill="var(--omega-vert-accent)"></rect>'
  + '<path d="M13.2 4.5 7.6 13.1h3.4l-.9 6.4 5.8-8.8h-3.4z" fill="var(--omega-vert-accent-text)"></path>'
  + '</svg>';

/**
 * Resolve a size preset name or raw pixel value to a max-height in px.
 * @param {string|number} value - preset name ('banner') or raw px ('300')
 * @returns {number|null} pixels, or null when unresolvable
 */
function resolveSizePx(value) {
  if (!value) {
    return null;
  }

  if (SIZE_PRESETS[value]) {
    return SIZE_PRESETS[value];
  }

  const num = parseInt(value, 10);
  return isNaN(num) || num <= 0 ? null : num;
}

/**
 * Clamp a reported iframe height to sane bounds.
 * @param {*} height - reported height (any postMessage payload value)
 * @param {number} [maxPx] - unit max-height (size preset), ceiling otherwise
 * @returns {number|null} clamped integer px, or null when not a usable number
 */
function clampHeight(height, maxPx) {
  const num = parseInt(height, 10);
  if (isNaN(num) || num <= 0) {
    return null;
  }

  return Math.min(num, maxPx || MAX_HEIGHT_CEILING);
}

/**
 * The host page's bare hostname — every vert click's utm_source (bare, no
 * www., matching the backend's normalizeHost).
 * @returns {string} the hostname, or '' when there is no page
 */
function hostHostname() {
  const hostname = (typeof window !== 'undefined' && window.location?.hostname) || '';

  return hostname.replace(/^www\./, '');
}

/**
 * The utm_source every vert click carries: the HOST brand's own id from its
 * omega config (brand.id), with the parent host as the fallback when no id is
 * available. The house lane carries the same value to the backend as the serve
 * URL's `brand` param, so both lanes tag with one identity.
 * @param {object} omega - the Omega instance
 * @returns {string} the brand id, or the host page's hostname
 */
function utmSource(omega) {
  return omega?.config?.brand?.id || hostHostname();
}

/**
 * The promo's click destination: omegajs.dev tagged with the vert UTM set
 * through the ONE helper both lanes use.
 * @param {string} [size] - the slot's size preset, carried as utm_content
 * @param {string} [source] - utm_source (the brand id); the host page's
 *   hostname when absent
 * @returns {string} the tagged promo URL
 */
function promoHref(size, source) {
  return applyVertUtm(PROMO_URL, {
    source: source || hostHostname(),
    medium: UTM_MEDIUM,
    campaign: UTM_CAMPAIGN_PROMO,
    content: size,
  });
}

/**
 * Fire the host-side click event. Analytics cannot run inside a cross-origin
 * vert frame, so the legacy stack bounced every click through a top-level
 * forward page that fired gtag before navigating. The frame now posts
 * omega-vert:click OUT to the host instead, and the HOST's own analytics
 * fires here — no forward page, no navigation delay.
 * @param {object} omega - the Omega instance
 * @param {object} detail - { id } from the click message
 * @param {object} options - the unit's mount options ({ size, ... })
 * @param {string} lane - 'house' | 'promo'
 */
function trackClick(omega, detail, options, lane) {
  try {
    omega.analytics.event('vert_click', {
      vert_id: detail.id || '',
      vert_lane: lane,
      vert_campaign: lane === 'promo' ? UTM_CAMPAIGN_PROMO : (detail.id || ''),
      vert_slot: options?.size || '',
      vert_source: hostHostname(),
    });
  } catch (e) {
    logger.error('vert_click analytics error:', e);
  }
}

/**
 * Build the promo document the terminal frame carries: the SAME renderer the
 * backend's serve route calls, fed the house promo data. The promo-only parts
 * are the two things a served unit cannot share: the trusted inline-svg mark
 * (a local constant, so the lane still makes zero network requests) and the
 * omega indigo accent pair.
 * @param {number|null} maxPx - the unit's resolved size in px (null = unsized)
 * @param {string} [theme] - 'light' | 'dark' passthrough; unset follows the OS
 * @param {string} [targetOrigin] - the host origin messages are posted to
 * @param {string} [size] - the slot's size preset, carried as utm_content
 * @param {number} [width] - the host's measured width in px (0 = unknown)
 * @param {string} [source] - utm_source (the brand id); the host page's
 *   hostname when absent
 * @returns {string} a complete html document
 */
function buildPromoDocument(maxPx, theme, targetOrigin, size, width, source) {
  return renderVertDocument({
    id: PROMO_ID,
    href: promoHref(size, source),
    title: PROMO_TITLE,
    description: PROMO_DESCRIPTION,
    button: PROMO_BUTTON,
    imageMarkup: PROMO_MARK,
    theme,
    width: width || 0,
    height: maxPx || 0,
    accent: OMEGA_ACCENT,
    targetOrigin,
  });
}

/**
 * The origin the promo document posts its messages to.
 * @returns {string} this page's origin, or '*' when it is unknown
 */
function promoTargetOrigin() {
  return (typeof window !== 'undefined' && window.location?.origin) || '*';
}

/**
 * Build the terminal promo frame: the house iframe's attribute set, with the
 * document carried by srcdoc instead of a serve URL (no `src`, no request).
 * @param {number|null} maxPx - the unit's resolved size in px (null = unsized)
 * @param {string} [theme] - 'light' | 'dark' passthrough
 * @param {string} [size] - the slot's size preset, carried as utm_content
 * @param {number} [width] - the host's measured width in px (0 = unknown)
 * @param {string} [source] - utm_source (the brand id); the host page's
 *   hostname when absent
 * @returns {Element} the promo iframe
 */
function buildPromo(maxPx, theme, size, width, source) {
  const $iframe = document.createElement('iframe');
  const targetOrigin = promoTargetOrigin();

  $iframe.className = 'omega-vert-promo';
  $iframe.setAttribute('sandbox', PROMO_SANDBOX);
  $iframe.setAttribute('frameborder', '0');
  $iframe.setAttribute('scrolling', 'no');
  $iframe.setAttribute('allowtransparency', 'true');
  $iframe.setAttribute('title', 'Sponsored');
  $iframe.style.setProperty('display', 'block');
  $iframe.style.setProperty('width', '100%');
  $iframe.style.setProperty('border', '0');
  $iframe.style.height = `${maxPx || PROMO_MIN_HEIGHT}px`;
  $iframe.srcdoc = buildPromoDocument(maxPx, theme, targetOrigin, size, width, source);

  return $iframe;
}

/**
 * The terminal lane's mounted unit: the promo frame plus the same
 * host-owned message handling a house unit has (sizing from the reported
 * dimensions, clicks forwarded), minus everything that needs a server:
 * no fill timer, no rotation, no staleness recovery.
 */
class PromoUnit {
  /**
   * @param {object} omega - the Omega instance (analytics on click)
   * @param {Element} $el - host element the frame mounts into
   * @param {object} options - { size, theme } shape the frame
   * @param {Function} emit - (name, detail) host emitter
   */
  constructor(omega, $el, options, emit) {
    this.omega = omega;
    this.$el = $el;
    this.options = options;
    this.emit = emit;
    this.maxHeight = resolveSizePx(options.size);
    // The click tag's identity: this brand's own id (host fallback)
    this.utmSource = utmSource(omega);

    this.destroyed = false;
    this.$iframe = null;

    this._onMessage = (event) => this.handleMessage(event);
  }

  /**
   * Mount the frame and open the message channel.
   * @returns {PromoUnit} this
   */
  load() {
    if (this.maxHeight) {
      this.$el.style.setProperty('max-height', `${this.maxHeight}px`, 'important');
      this.$el.style.setProperty('overflow', 'hidden');
    }

    // The host's measured width reaches the document so the narrow-compact
    // and skyscraper-stacking branches are decidable (0 = unknown, fluid row)
    this.$iframe = buildPromo(this.maxHeight, this.options.theme, this.options.size, this.$el.clientWidth || 0, this.utmSource);
    this.$el.appendChild(this.$iframe);

    window.addEventListener('message', this._onMessage);

    return this;
  }

  /**
   * A sandboxed srcdoc frame has an opaque origin, so its messages arrive as
   * origin "null", which is worthless as a check. Identity against THIS unit's own
   * contentWindow is the validation instead (the house lane keeps its origin
   * check unchanged).
   * @param {MessageEvent} event
   */
  handleMessage(event) {
    if (this.destroyed || !this.$iframe?.contentWindow) {
      return;
    }

    if (!event.source || event.source !== this.$iframe.contentWindow) {
      return;
    }

    const message = event.data || {};

    if (message.type === MESSAGE_DIMENSIONS) {
      const height = clampHeight(message.height, this.maxHeight);
      if (!height) {
        return;
      }

      this.$iframe.style.height = `${height}px`;
    } else if (message.type === MESSAGE_CLICK) {
      // The frame's own link opens omegajs.dev (target=_blank + rel) exactly
      // like a served unit, so the message carries the host-side work: the
      // analytics event no in-frame tracker could ever fire
      trackClick(this.omega, { id: message.id }, this.options, 'promo');
      this.emit('click', { id: message.id });
    }
  }

  /**
   * Re-stamp the frame for a page theme flip. The promo document is inline, so
   * this is a srcdoc assignment with zero network (the house lane has no
   * equivalent — its document comes over the wire, so it keeps the theme it
   * mounted with).
   * @param {string} theme - 'light' | 'dark'; '' follows the OS again
   */
  setTheme(theme) {
    if (this.destroyed || !this.$iframe || theme === this.options.theme) {
      return;
    }

    this.options = { ...this.options, theme };
    this.$iframe.srcdoc = buildPromoDocument(this.maxHeight, theme, promoTargetOrigin(), this.options.size, this.$el.clientWidth || 0, this.utmSource);
  }

  /** Remove the message listener; the unit is inert afterwards. */
  destroy() {
    this.destroyed = true;
    window.removeEventListener('message', this._onMessage);
  }
}

/**
 * One mounted house/company ad unit — owns the iframe and its lifecycle.
 */
class VertUnit {
  /**
   * @param {object} omega - the Omega instance
   * @param {Element} $el - host element the iframe mounts into
   * @param {object} options
   * @param {string} options.source - resolved base URL of the ad server
   * @param {string[]} [options.tags] - contextual tags for targeting
   * @param {string} [options.size] - size preset or raw px (max-height)
   * @param {string} [options.theme] - 'light' | 'dark' passthrough
   * @param {string} [options.vertId] - pin a specific ad
   * @param {number} [options.fillTimeout] - ms before the no-fill teardown
   * @param {number} [options.staleAfter] - ms before a recovery reload
   * @param {number} [options.rotateInterval] - ms between rotations (0 = off)
   * @param {Function} [options.onFill] - first successful dimension report
   * @param {Function} [options.onNoFill] - no fill (204 / never reported)
   * @param {Function} [options.onExhausted] - teardown done; the host is free
   *   for the terminal lane
   * @param {Function} [options.onClick] - click message from the frame
   */
  constructor(omega, $el, options = {}) {
    this.omega = omega;
    this.$el = $el;
    this.options = options;

    this.source = String(options.source || '').replace(/\/+$/, '');
    this.sourceOrigin = new URL(this.source).origin;
    this.maxHeight = resolveSizePx(options.size);

    this.filled = false;
    this.destroyed = false;
    this.lastLoadedAt = 0;
    this.staleAfter = options.staleAfter || DEFAULT_STALE_AFTER;
    this.rotateInterval = options.rotateInterval || DEFAULT_ROTATE_INTERVAL;
    this.fillTimeout = options.fillTimeout || DEFAULT_FILL_TIMEOUT;

    this.$iframe = null;
    this._fillTimer = null;
    this._rotateTimer = null;

    // Bound listeners — kept for removal on destroy
    this._onMessage = (event) => this.handleMessage(event);
    this._onRecover = () => this.recover();
  }

  /**
   * The serve URL for one impression (cache-busted so rotation reloads
   * always reselect).
   * @returns {string}
   */
  buildServeUrl() {
    const url = new URL(`${this.source}/omega/verts/serve`);

    if (typeof window !== 'undefined' && window.location?.host) {
      url.searchParams.set('parent', window.location.host);
    }

    // The click tag's identity travels with the impression: the serve route
    // stamps it on the redirect URL, and the redirect route tags the stored
    // link with it (the parent host stays the targeting input, and the
    // fallback when this brand carries no id)
    const brandId = this.omega?.config?.brand?.id;
    if (brandId) {
      url.searchParams.set('brand', brandId);
    }

    const tags = this.options.tags || [];
    if (tags.length) {
      url.searchParams.set('tags', tags.join(','));
    }

    if (this.options.vertId) {
      url.searchParams.set('vertId', this.options.vertId);
    }

    if (this.maxHeight) {
      url.searchParams.set('height', String(this.maxHeight));
    }

    // The host's measured width lets the served document decide its
    // narrow-compact and skyscraper-stacking branches
    if (this.$el.clientWidth) {
      url.searchParams.set('width', String(this.$el.clientWidth));
    }

    if (this.options.theme) {
      url.searchParams.set('theme', this.options.theme);
    }

    url.searchParams.set('t', String(Date.now()));

    return url.toString();
  }

  /**
   * Mount the iframe and start the lifecycle (fill timer, rotation,
   * staleness listeners).
   * @returns {VertUnit} this
   */
  load() {
    // Host constraint from the size preset — inline so the px table stays
    // one place (AdSense-style important overrides can't relax it either)
    if (this.maxHeight) {
      this.$el.style.setProperty('max-height', `${this.maxHeight}px`, 'important');
      this.$el.style.setProperty('overflow', 'hidden');
    }

    const $iframe = document.createElement('iframe');
    $iframe.setAttribute('sandbox', IFRAME_SANDBOX);
    $iframe.setAttribute('frameborder', '0');
    $iframe.setAttribute('scrolling', 'no');
    $iframe.setAttribute('allowtransparency', 'true');
    $iframe.setAttribute('title', 'Sponsored');
    $iframe.style.setProperty('display', 'block');
    $iframe.style.setProperty('width', '100%');
    $iframe.style.setProperty('border', '0');
    $iframe.addEventListener('load', () => {
      this.lastLoadedAt = Date.now();
    });
    $iframe.src = this.buildServeUrl();

    this.$iframe = $iframe;
    this.$el.appendChild($iframe);

    // Fixed-vocabulary message channel + host-owned recovery hooks
    window.addEventListener('message', this._onMessage);
    window.addEventListener('online', this._onRecover);
    document.addEventListener('visibilitychange', this._onRecover);

    this._armFillTimer();

    if (this.rotateInterval > 0) {
      this._rotateTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          return;
        }
        this.reload('rotate');
      }, this.rotateInterval);
    }

    return this;
  }

  /**
   * Origin-validated message handler — the source origin ONLY, and (when the
   * browser supplies it) only this unit's own frame.
   * @param {MessageEvent} event
   */
  handleMessage(event) {
    if (this.destroyed || event.origin !== this.sourceOrigin) {
      return;
    }

    // Multiple units on one page: only this unit's frame speaks to it
    if (event.source && this.$iframe?.contentWindow && event.source !== this.$iframe.contentWindow) {
      return;
    }

    const message = event.data || {};

    if (message.type === MESSAGE_DIMENSIONS) {
      const height = clampHeight(message.height, this.maxHeight);
      if (!height) {
        return;
      }

      this.$iframe.style.height = `${height}px`;
      this.lastLoadedAt = Date.now();

      if (!this.filled) {
        this.filled = true;
        this._clearFillTimer();
        this._emit('fill', { height });
      }
    } else if (message.type === MESSAGE_CLICK) {
      // The frame's <a> navigates through the redirect route itself (which
      // UTM-tags the destination) — the message carries the host-side work:
      // the analytics event no in-frame tracker could ever fire
      trackClick(this.omega, { id: message.id }, this.options, 'house');
      this._emit('click', { id: message.id });
    }
  }

  /**
   * Staleness check — has the frame gone longer than staleAfter without a
   * (re)load or dimension report?
   * @param {number} [now]
   * @returns {boolean}
   */
  isStale(now) {
    return ((now || Date.now()) - this.lastLoadedAt) > this.staleAfter;
  }

  /**
   * Recovery hook (visibilitychange / online): reload a stale frame — the
   * legacy self-refresh stranded chrome-error:// pages exactly here.
   */
  recover() {
    if (this.destroyed || !this.filled) {
      return;
    }

    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }

    if (this.isStale()) {
      this.reload('stale');
    }
  }

  /**
   * Reload the iframe with a fresh serve URL (rotation / staleness).
   * @param {string} [reason]
   */
  reload(reason) {
    if (this.destroyed || !this.$iframe) {
      return;
    }

    this.filled = false;
    this.$iframe.src = this.buildServeUrl();
    this._armFillTimer();
    this._emit('reload', { reason });
  }

  /**
   * No fill: drop the frame, emit, tear down, and hand the host back to the
   * ladder's terminal lane (onExhausted) — the unit never ends empty.
   */
  noFill() {
    if (this.destroyed) {
      return;
    }

    if (this.$iframe && typeof this.$iframe.remove === 'function') {
      this.$iframe.remove();
    }

    this._emit('no-fill', {});
    this.destroy();

    if (typeof this.options.onExhausted === 'function') {
      this.options.onExhausted();
    }
  }

  /** Remove listeners and timers; the unit is inert afterwards. */
  destroy() {
    this.destroyed = true;
    this._clearFillTimer();

    if (this._rotateTimer) {
      clearInterval(this._rotateTimer);
      this._rotateTimer = null;
    }

    window.removeEventListener('message', this._onMessage);
    window.removeEventListener('online', this._onRecover);
    document.removeEventListener('visibilitychange', this._onRecover);
  }

  _armFillTimer() {
    this._clearFillTimer();
    this._fillTimer = setTimeout(() => {
      // A 204 no-fill (or a dead server) never posts dimensions — end the lane
      if (!this.filled) {
        this.noFill();
      }
    }, this.fillTimeout);
  }

  _clearFillTimer() {
    if (this._fillTimer) {
      clearTimeout(this._fillTimer);
      this._fillTimer = null;
    }
  }

  _emit(name, detail) {
    const callback = this.options[`on${name.replace(/(^|-)(\w)/g, (m, sep, ch) => ch.toUpperCase())}`];
    if (typeof callback === 'function') {
      try {
        callback(detail);
      } catch (e) {
        logger.error(`on${name} callback error:`, e);
      }
    }

    if (typeof CustomEvent !== 'undefined' && typeof this.$el.dispatchEvent === 'function') {
      this.$el.dispatchEvent(new CustomEvent(`omega-vert:${name}`, { detail, bubbles: true }));
    }
  }
}

class Verts {
  constructor(omega) {
    this.omega = omega;

    // The AdSense script loads ONCE — the cached promise keeps a rejection
    // (adblock) sticky for every later unit on the page
    this._adsenseScript = null;

    // Live promo units + the one observer that re-themes them on a page flip
    this._promoUnits = new Set();
    this._themeObserver = null;
  }

  /**
   * The page's current theme — the frame's theme SSOT. `data-bs-theme` on the
   * root element is what the appearance module stamps; when it says nothing the
   * frame follows the OS through its own prefers-color-scheme branch.
   * @returns {string} 'light' | 'dark', or '' to follow the OS
   */
  pageTheme() {
    const theme = typeof document !== 'undefined'
      ? document.documentElement?.getAttribute('data-bs-theme')
      : null;

    return theme === 'light' || theme === 'dark' ? theme : '';
  }

  /**
   * Resolve the in-house ad source to a base URL.
   * @param {string} [source] - override; defaults to advertising.providers.inhouse.source
   * @returns {string|null} base URL (no trailing slash), or null when unconfigured
   */
  resolveSource(source) {
    const configured = source
      || this.omega.config.advertising?.providers?.inhouse?.source;

    if (!configured) {
      return null;
    }

    if (/^https?:\/\//i.test(configured)) {
      return configured.replace(/\/+$/, '');
    }

    if (configured === 'self') {
      return this.omega.getApiUrl();
    }

    if (configured === 'company') {
      const companyUrl = this.omega.config.company?.url;
      if (!companyUrl) {
        logger.warn('inhouse source is "company" but no company url resolved (the brand names none, or its company is not reachable)');
        return null;
      }
      // A company on a default Pages host has no address this brand can derive
      try {
        return this.omega.getApiUrl(null, companyUrl);
      } catch (e) {
        logger.warn(`inhouse source is "company" but ${e.message}`);
        return null;
      }
    }

    logger.warn('Unsupported inhouse source:', configured);
    return null;
  }

  /**
   * Read a host element's data-omega-vert* attributes into render options. The
   * theme is the one option with a fallback chain: the host's own
   * data-omega-vert-theme pin wins, else the page's theme, else the OS.
   * @param {Element} $el - element carrying the data-omega-vert vocabulary
   * @returns {object} { type, size, vertId, tags, theme }
   */
  parseElementOptions($el) {
    const attr = (name) => (typeof $el.getAttribute === 'function' && $el.getAttribute(name)) || '';

    return {
      type: attr('data-omega-vert') || 'display',
      size: attr('data-omega-vert-size'),
      vertId: attr('data-omega-vert-id'),
      theme: attr('data-omega-vert-theme') || this.pageTheme(),
      tags: attr('data-omega-vert-tags')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    };
  }

  /**
   * Arm one host element lazily: the ladder runs only near the viewport
   * (IntersectionObserver; no observer support → immediately). Options are
   * read from the element's data-omega-vert* attributes; passed options win.
   * Idempotent — a mounted element never mounts twice.
   * @param {Element} $el - host element
   * @param {object} [options] - overrides merged over the element attributes
   * @returns {Promise<object|null>|null} the render result when armed
   *   immediately (no observer), null otherwise (armed lazily or repeat call)
   */
  mount($el, options = {}) {
    if (!$el || $el.__omegaVertMounted) {
      return null;
    }
    $el.__omegaVertMounted = true;

    const merged = { ...this.parseElementOptions($el), ...options };

    if (typeof IntersectionObserver === 'undefined') {
      return this.render($el, merged);
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }
      observer.disconnect();
      this.render($el, merged);
    }, { rootMargin: '200px 0px' });

    observer.observe($el);
    return null;
  }

  /**
   * Auto-bind every [data-omega-vert] element under a root — the surface hook
   * desktop/extension call (phase 4); the web section mounts per element.
   * @param {Element|Document} [root] - scan scope (defaults to document)
   * @returns {Element[]} the elements newly mounted by this call
   */
  bind(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') {
      return [];
    }

    const mounted = [];
    scope.querySelectorAll('[data-omega-vert]').forEach(($el) => {
      if ($el.__omegaVertMounted) {
        return;
      }
      this.mount($el);
      mounted.push($el);
    });

    return mounted;
  }

  /**
   * Run the full ladder into a host element: provider (AdSense) when
   * configured and the type is a provider type, then the fallback lane, then
   * the terminal promo.
   * @param {Element} $el - host element
   * @param {object} [options] - VertUnit options + { type }
   * @returns {Promise<{ lane: string, unit?: VertUnit }>}
   */
  async render($el, options = {}) {
    const advertising = this.omega.config.advertising || {};
    const adsense = advertising.providers?.adsense;
    const type = options.type || 'display';

    if (type === 'house') {
      return this.renderHouse($el, options);
    }

    const format = ADSENSE_FORMATS[type];
    if (!format) {
      logger.warn('Unsupported ad type:', type);
      return this._fallback($el, options);
    }

    // No client id: the provider lane is not attempted at all. Presence of
    // the client id is the ONE adsense switch (#527) — it decides the manager
    // managing the account, these units rendering, and the ads.txt record
    // together, so there is no second gate to read here.
    if (!adsense?.client) {
      return this._fallback($el, options);
    }

    // Script-load failure IS the adblock detector — no bait divs, no library
    try {
      await this._loadAdSenseScript(adsense.client);
    } catch (e) {
      logger.warn('AdSense script blocked/failed — fallback lane:', e?.message || e);
      return this._fallback($el, options);
    }

    const $ins = this._buildIns(adsense, type, format, options);
    const maxHeight = resolveSizePx(options.size);
    if (maxHeight) {
      $el.style.setProperty('max-height', `${maxHeight}px`, 'important');
      $el.style.setProperty('overflow', 'hidden');
    }
    $el.appendChild($ins);

    (window.adsbygoogle = window.adsbygoogle || []).push({});

    const status = await this._awaitFill($ins, options.fillTimeout || DEFAULT_FILL_TIMEOUT);
    if (status === 'filled') {
      this._emitHost($el, options, 'fill', { lane: 'provider' });
      return { lane: 'provider' };
    }

    // unfilled / timeout → clear the provider markup, fall through
    if (typeof $ins.remove === 'function') {
      $ins.remove();
    }
    return this._fallback($el, options);
  }

  /**
   * Mount the fallback lane directly (house/company inventory) — the lane
   * desktop/extension bind to (no AdSense in those surfaces).
   * @param {Element} $el - host element
   * @param {object} [options] - VertUnit options ({ source } overrides config)
   * @returns {{ lane: string, unit?: VertUnit }} the terminal promo lane when
   *   no source resolves
   */
  renderHouse($el, options = {}) {
    const source = this.resolveSource(options.source);

    if (!source) {
      return this._exhausted($el, options);
    }

    const tags = options.tags?.length
      ? options.tags
      : this.omega.config.advertising?.tags || [];

    // The house frame's own no-fill hands the host to the terminal lane
    const unit = new VertUnit(this.omega, $el, {
      ...options,
      source,
      tags,
      onExhausted: () => this.renderPromo($el, options),
    }).load();

    // The host keeps a handle on its live unit, so a re-mount can tear the
    // old one down first (its listeners and timers outlive the DOM otherwise)
    $el.__omegaVertUnit = unit;

    return { lane: 'house', unit };
  }

  /**
   * Render the terminal promo into a host: a real unit carrying the built-in
   * promo document by srcdoc, no network. Clears whatever the failed lanes
   * left behind and keeps the unit's reserved size.
   * @param {Element} $el - host element
   * @param {object} [options] - { size, theme } shape the frame; callbacks are
   *   emitted
   * @returns {{ lane: string, unit: PromoUnit }}
   */
  renderPromo($el, options = {}) {
    replaceChildren($el);

    // A previous lane may have hidden, capped or clipped the host; the promo
    // unit re-applies its own ceiling when the slot is sized
    $el.style.removeProperty('display');
    $el.style.removeProperty('max-height');
    $el.style.removeProperty('overflow');

    const unit = new PromoUnit(this.omega, $el, options, (name, detail) => {
      this._emitHost($el, options, name, detail);
    }).load();

    $el.__omegaVertUnit = unit;
    this._promoUnits.add(unit);
    this._watchPageTheme();

    this._emitHost($el, options, 'promo', {});

    return { lane: 'promo', unit };
  }

  /**
   * Watch the page's theme attribute once and re-stamp every live promo frame
   * when it flips (a host that pinned its own data-omega-vert-theme keeps it).
   * The house lane is deliberately absent: its document is a server response,
   * so a live re-theme would be a reload.
   */
  _watchPageTheme() {
    if (this._themeObserver || typeof MutationObserver === 'undefined' || typeof document === 'undefined') {
      return;
    }

    this._themeObserver = new MutationObserver(() => {
      const theme = this.pageTheme();

      this._promoUnits.forEach((unit) => {
        if (unit.destroyed) {
          this._promoUnits.delete(unit);
          return;
        }

        const pinned = typeof unit.$el?.getAttribute === 'function' && unit.$el.getAttribute('data-omega-vert-theme');
        if (!pinned) {
          unit.setTheme(theme);
        }
      });
    });

    this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme'] });
  }

  /**
   * Provider miss → the configured fallback role, or the terminal lane.
   * @param {Element} $el
   * @param {object} options
   * @returns {Promise<object|null>|object}
   */
  _fallback($el, options) {
    const fallback = this.omega.config.advertising?.fallback;

    if (fallback === 'inhouse') {
      return this.renderHouse($el, options);
    }

    return this._exhausted($el, options);
  }

  /**
   * The ladder's end — every configured lane failed. no-fill still emits (the
   * telemetry meaning is unchanged: nothing was sold), then the built-in promo
   * renders so the unit is never empty.
   * @param {Element} $el
   * @param {object} options
   * @returns {{ lane: string }}
   */
  _exhausted($el, options) {
    this._emitHost($el, options, 'no-fill', {});
    return this.renderPromo($el, options);
  }

  _emitHost($el, options, name, detail) {
    const callback = options[`on${name.replace(/(^|-)(\w)/g, (m, sep, ch) => ch.toUpperCase())}`];
    if (typeof callback === 'function') {
      try {
        callback(detail);
      } catch (e) {
        logger.error(`on${name} callback error:`, e);
      }
    }

    if (typeof CustomEvent !== 'undefined' && typeof $el.dispatchEvent === 'function') {
      $el.dispatchEvent(new CustomEvent(`omega-vert:${name}`, { detail, bubbles: true }));
    }
  }

  _loadAdSenseScript(client) {
    if (!this._adsenseScript) {
      this._adsenseScript = this.omega.dom.loadScript({
        src: `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${client}`,
        async: true,
        crossorigin: 'anonymous',
      });
    }

    return this._adsenseScript;
  }

  _buildIns(adsense, type, format, options) {
    const $ins = document.createElement('ins');
    $ins.className = 'adsbygoogle';
    $ins.style.cssText = format.style;
    $ins.setAttribute('data-ad-client', adsense.client);

    for (const [key, value] of Object.entries(format.attributes)) {
      $ins.setAttribute(key, value);
    }

    // In-feed layout keys — one JS-side table (kills the duplicated include keys)
    if (format.layoutKeys) {
      const layoutKey = format.layoutKeys[options.layout || 'image-above'] || format.layoutKeys['image-above'];
      $ins.setAttribute('data-ad-layout-key', layoutKey);
    }

    const slot = adsense[format.slotKey];
    if (slot) {
      $ins.setAttribute('data-ad-slot', slot);
    }

    return $ins;
  }

  /**
   * Await AdSense fill: a MutationObserver on data-ad-status (+ timeout) —
   * not the legacy 100 ms poll.
   * @param {Element} $ins
   * @param {number} timeout
   * @returns {Promise<string>} 'filled' | 'unfilled' | 'timeout'
   */
  _awaitFill($ins, timeout) {
    return new Promise((resolve) => {
      let observer = null;
      let timer = null;

      const settle = (status) => {
        if (observer) {
          observer.disconnect();
        }
        if (timer) {
          clearTimeout(timer);
        }
        resolve(status);
      };

      const check = () => {
        const status = typeof $ins.getAttribute === 'function' ? $ins.getAttribute('data-ad-status') : null;
        if (status === 'filled' || status === 'unfilled') {
          settle(status);
          return true;
        }
        return false;
      };

      if (check()) {
        return;
      }

      if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(() => check());
        observer.observe($ins, { attributes: true, attributeFilter: ['data-ad-status'] });
      }

      timer = setTimeout(() => settle('timeout'), timeout);
    });
  }
}

export default Verts;
export {
  VertUnit,
  PromoUnit,
  SIZE_PRESETS,
  ADSENSE_FORMATS,
  PROMO_URL,
  PROMO_ID,
  promoHref,
  buildPromo,
  buildPromoDocument,
  MESSAGE_DIMENSIONS,
  MESSAGE_CLICK,
  IFRAME_SANDBOX,
  PROMO_SANDBOX,
  resolveSizePx,
  clampHeight,
};
