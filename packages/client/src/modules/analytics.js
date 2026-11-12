/**
 * The client runtime's analytics — a HOST of `@omega.js/analytics`, never a
 * second implementation of it ([#328](https://github.com/Omega-JS-Stack/omega/issues/328),
 * stage E).
 *
 * `omega.analytics.event('<canonical>', params)` resolves through the shared
 * catalog and adapters, exactly like a web page's call sites and the backend's
 * webhook. What differs per runtime is the TRANSPORT, and this module is where
 * each one is injected:
 *
 *   web                    the PAGE's transport — the guarded gtag/fbq/ttq the
 *                          web host wired (`core/js/libs/analytics.js`), which
 *                          also owns the consent gate and the attribution
 *                          context. Nothing is configured here beyond the
 *                          environment: a page's seams are the page's.
 *   electron / extension   the Measurement Protocol, fed by the GA4 descriptor.
 *                          Meta and TikTok resolve and then skip — no pixel
 *                          exists in these runtimes to receive them.
 *   desktop renderer       NO transport at all: the injected IPC bridge
 *                          ([#411](https://github.com/Omega-JS-Stack/omega/issues/411)).
 *                          Events forward to the main process, whose sender
 *                          owns the one device id, the one session id and the
 *                          real engagement time — one install, one GA client.
 *
 * Identity is real here (#159 is closed): `setUserId` / `setUserProperties` SEND
 * on web through the page's gtag instead of storing values only the Measurement
 * Protocol payload ever read.
 */
import analytics from '@omega.js/analytics';
import core from '@omega.js/analytics/core';
import { analyticsProvider } from '@omega.js/config/analytics-providers';
import { createLogger } from './logger.js';

const logger = createLogger('analytics');

// Supported runtimes for analytics
const SUPPORTED_RUNTIMES = ['browser-extension', 'electron', 'web'];

// Raw per-install device id (a plain UUID) — client_id derives from it
const DEVICE_ID_KEY = '_omega_device_id';

// The GA4 session cache: one id per visit, rolled after 30 minutes of inactivity
const SESSION_KEY = '_ga_session_id';
const SESSION_TIMEOUT = 30 * 60 * 1000;

class Analytics {
  constructor(omega) {
    this.omega = omega;
    this.initialized = false;
    this.devMode = false;
    this.runtime = null;
    this.config = null;
    this.bridge = null;
    this.measurementId = null;
    this.secret = null;
    this.projectId = null;
    this.namespace = null;
    this.clientId = null;
    this.session = null;
    this.userId = null;
    this.userProperties = {};
    this.authed = false;
  }

  // Check if runtime is supported
  _isSupported() {
    return SUPPORTED_RUNTIMES.includes(this.runtime);
  }

  // Web's transport is the page's own pixels, never the Measurement Protocol
  _isWeb() {
    return this.runtime === 'web';
  }

  // A popup / options page / sidepanel — a fresh top-level context every open,
  // which is why the session cache cannot live in sessionStorage here (#412)
  _isExtension() {
    return this.runtime === 'browser-extension';
  }

  // Get extension storage API — the same seam `device` persists through
  _getExtensionStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return chrome.storage.local;
    }
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      return browser.storage.local;
    }
    return null;
  }

  // Inside desktop's renderer, where the host injected the preload's IPC bridge
  // to the main process's sender (#411). It outranks every runtime branch
  // below: an Electron window sets no `config.runtime`, so a desktop renderer
  // reads as the WEB runtime and the bridge is the only thing that says
  // otherwise. Bridged means this client NEVER sends — not the Measurement
  // Protocol, not a page pixel — so it holds no secret and no device id.
  _isBridged() {
    return !!this.bridge;
  }

  // Initialize analytics
  init(config = {}) {
    // Store config
    this.config = config;

    // Get runtime
    this.runtime = this.omega.utilities.getRuntime();

    if (!this._isSupported()) {
      logger.log(`Runtime "${this.runtime}" not supported yet, skipping`);
      return;
    }

    // Skip if already initialized
    if (this.initialized) {
      logger.log('Already initialized');
      return;
    }

    // Check for development mode — dev NEVER posts to a real property
    // (consumers' dev traffic must not land in anyone's GA4; the baked-in
    // fallback credentials are gone by design — C4 cp106a de-ITW).
    this.devMode = this.omega.isDevelopment();

    // The host's seam for a runtime whose events belong to another process
    // (#411) — the desktop renderer's IPC bridge, null everywhere else.
    this.bridge = config.bridge || null;

    // Canonical handoff: analytics.providers.google.{id,secret} + the
    // brand's projectId for the cross-surface identity namespace
    this.measurementId = config.measurementId || config.id;
    this.projectId = config.projectId || null;

    // The Measurement Protocol api_secret is never read on web: the page's
    // gtag is the transport there, and the secret must never reach a page. Nor
    // is it read in a bridged renderer — and that is the guard behind desktop's
    // rule that the secret must never be injected into a renderer's config: a
    // second sender here would split one install into two GA devices (#396).
    this.secret = (this._isWeb() || this._isBridged()) ? null : config.secret;

    // Skip if no measurement ID. Web has none to require, since the gtag
    // config is page-side (the consent-gated loader owns it), and a bridged
    // renderer has none to require because main holds them.
    if (!this.measurementId && !this._isWeb() && !this._isBridged()) {
      logger.log('No measurement ID provided, skipping initialization');
      return;
    }

    // Cross-surface identity — @omega.js/analytics core (the ONE place the
    // uuidv5 math lives; desktop's main-process lib uses the same module)
    this.namespace = core.deriveNamespace(this.projectId);

    // Generate or retrieve client ID. A bridged renderer mints none: main's
    // sender already resolved the install's device id from its OWN storage,
    // and a second one here is the identity fork this bridge exists to prevent.
    this.clientId = this._isBridged() ? null : this._getClientId();

    // The facade's environment seam is the brand's own `config.environment` —
    // it decides whether an unknown event name throws and whether the fire log
    // prints. Injected for EVERY runtime, because it is the one thing a page
    // host cannot know before the config has loaded.
    analytics.configure({
      environment: this.devMode ? 'development' : 'production',
    });

    // The transport per runtime. On web it is the package's guarded browser
    // transport — the same object the page host wires, so a client-fired event
    // (a vert click, a permission prompt) counts on a page whose own call sites
    // never loaded. The page keeps the seams only a page can supply: the
    // consent gate and the attribution context.
    //
    // A bridged renderer configures NONE: it never resolves a descriptor at
    // all, because `event()` hands the canonical name to the bridge and main
    // walks the catalog on the other side.
    if (!this._isBridged()) {
      analytics.configure(this._isWeb()
        ? { transport: analytics.transports.browser }
        : {
          transport: { send: (descriptor) => this._sendViaMeasurementProtocol(descriptor) },
          context: { runtime: this.runtime },
        });
    }

    // Log initialization
    logger.log(`Initializing with ${this._isBridged() ? 'the desktop IPC bridge (main is the sender)' : `measurement ID: ${this.measurementId || 'page-side gtag'}`}${this.devMode ? ' (dev mode)' : ''} [${this.runtime}]`);

    // Mark as initialized
    this.initialized = true;

    // An extension's session cache lives in chrome.storage (#412) — the only
    // storage a popup close does not wipe. That read is async while
    // `_getSessionId()` must stay synchronous for the payload, so it hydrates
    // ONCE here into the in-memory mirror the getter reads, and every later
    // update writes through. Null when there is no extension storage to read.
    const storage = this._isExtension() ? this._getExtensionStorage() : null;
    const hydrating = storage ? this._loadSessionFromExtensionStorage(storage) : null;

    // Send initial pageview, never on web: the page's own gtag config
    // already fired one and a second would double-count. Nor from a bridged
    // renderer: main fires the launch events for the whole app (app_launch,
    // once per launch), and a per-window page_view here would be its own
    // decision to make, not a side effect of wiring the bridge.
    //
    // It waits for the hydrate above, because the launch event of a reopened
    // popup is exactly the one that must carry the session it is rejoining —
    // minting a new id here is the bug (#412), not a detail.
    if (!this._isWeb() && !this._isBridged()) {
      if (hydrating) {
        hydrating.then(() => this.event('page_view'));
      } else {
        this.event('page_view');
      }
    }
  }

  // Stable per-install device id, hashed into the project namespace so every
  // event from this browser is the same GA client. The derivation is the
  // package's ([#396](https://github.com/Omega-JS-Stack/omega/issues/396)) —
  // all this runtime supplies is where it persists, since a page can read
  // nothing about the machine to seed from. Without a projectId the raw (still
  // stable) device id is used as-is.
  _getClientId() {
    const deviceId = core.deriveDeviceId({
      get: () => {
        try {
          return localStorage.getItem(DEVICE_ID_KEY);
        } catch (e) {
          // localStorage not available
          return null;
        }
      },
      set: (value) => {
        try {
          localStorage.setItem(DEVICE_ID_KEY, value);
        } catch (e) {
          // localStorage not available
        }
      },
    });

    return core.deriveClientId(deviceId, this.namespace);
  }

  // Get page data to include with all events
  _getPageData() {
    return {
      page_path: window.location.pathname,
      page_title: document.title,
      page_location: window.location.href,
    };
  }

  /**
   * Fire a canonical event.
   *
   * @param {string} eventName - A canonical name from the catalog — the SSOT
   *   for what each provider is told and in which dialect.
   * @param {object} [params] - That event's canonical params.
   * @param {object} [options] - `{ eventId, providers }` for an event whose
   *   other half fires server-side.
   * @returns {void}
   */
  event(eventName, params = {}, options = {}) {
    if (!this._isSupported()) {
      return;
    }

    if (!this.initialized) {
      return;
    }

    // Bridged (desktop's renderer): the canonical name and the caller's params
    // cross to main, which resolves the catalog and enriches with ITS identity
    // — device id, the session id minted once per launch, real engagement time
    // — and with the app's own page context, which is main's to own and not a
    // renderer's file:// href. `options` stays behind with the page-pixel
    // providers it exists to deduplicate: GA4 through main is the one lane here.
    if (this._isBridged()) {
      // The catalog check happens HERE, on the facade's own rule (throw in
      // development, log-and-skip in production): a typo is the CALL SITE's
      // bug, and it must surface at that stack in that renderer's console —
      // not as an unattributable warn in the main process's runtime.log.
      if (!analytics.entryFor(eventName)) {
        if (analytics.isDevelopment()) {
          throw new Error(`Unknown analytics event "${eventName}" — every event is declared in the catalog (@omega.js/analytics/catalog)`);
        }

        logger.warn(`Unknown event "${eventName}" — not in the catalog, skipped`);
        return;
      }

      try {
        this.bridge.event(eventName, params);
      } catch (e) {
        // The forward crossing IPC is the one thing here that can fail on the
        // caller's data (a param that structured-clone cannot carry). The
        // facade never throws at a visitor mid-action, so neither does this.
        logger.warn(`Failed to forward "${eventName}" to the main process:`, e.message);
      }

      return;
    }

    // Merge page data with provided params
    const eventParams = {
      ...this._getPageData(),
      ...params,
    };

    // The facade walks consent → adapters → transport and never throws at a
    // visitor; its own dev line is the per-fire trace.
    analytics.event(eventName, eventParams, options);
  }

  /**
   * The Measurement Protocol transport for the runtimes with no page pixels.
   * It delivers only the providers whose row says `measurementProtocol`: a
   * browser pixel does not exist in an Electron window or an extension context,
   * so every other descriptor reports "blocked" and the fire log says so.
   *
   * @param {object} descriptor - The resolved provider descriptor.
   * @returns {boolean} true when the descriptor was delivered.
   */
  _sendViaMeasurementProtocol(descriptor) {
    if (!analyticsProvider(descriptor.provider).measurementProtocol) {
      return false;
    }

    // Dev mode logs only — nothing posts
    if (this.devMode) {
      logger.log('Dev mode: event logged locally, not sent');
      return true;
    }

    // Measurement Protocol requires api_secret
    if (!this.secret) {
      logger.warn('No API secret provided, cannot send via Measurement Protocol');
      return false;
    }

    const url = core.buildCollectUrl(this.measurementId, this.secret);

    const payload = core.buildPayload({
      clientId: this.clientId,
      userId: this.userId,
      userProperties: this.userProperties,
      eventName: descriptor.name,
      params: {
        ...descriptor.payload,
        engagement_time_msec: 100,
        session_id: this._getSessionId(),
      },
    });

    // Send via fetch (fire and forget)
    fetch(url, {
      method: 'POST',
      body: JSON.stringify(payload),
    }).catch((err) => {
      logger.warn('Failed to send event:', err);
    });

    return true;
  }

  // Get or generate session ID
  _getSessionId() {
    const now = Date.now();
    const session = this._readSession();

    // Check if session is still valid
    if (session && (now - session.lastActive) < SESSION_TIMEOUT) {
      this._writeSession({ ...session, lastActive: now });
      return session.id;
    }

    // Create new session
    const newSession = {
      id: `${now}`,
      lastActive: now,
    };

    this._writeSession(newSession);

    return newSession.id;
  }

  // The session cache's two backings. An extension reads the in-memory mirror
  // hydrated at init, since chrome.storage is async and this is not; every
  // other runtime reads sessionStorage, which outlives nothing but its own
  // page — exactly what a web session is.
  _readSession() {
    if (this._isExtension()) {
      return this.session;
    }

    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    } catch (e) {
      // sessionStorage not available
      return null;
    }
  }

  _writeSession(session) {
    if (this._isExtension()) {
      this.session = session;

      const storage = this._getExtensionStorage();
      if (storage) {
        // Write-through, fire and forget: the mirror already carries the value
        // the event being built is about to send
        this._saveSessionToExtensionStorage(storage, session);
      }

      return;
    }

    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (e) {
      // sessionStorage not available
    }
  }

  // Load the session from extension storage (async)
  async _loadSessionFromExtensionStorage(storage) {
    try {
      const result = await storage.get(SESSION_KEY);
      const stored = result?.[SESSION_KEY];

      // A session minted while this read was in flight belongs to THIS context
      // and already rode an event — hydrating over it would rewind a sent id
      if (!this.session && stored && typeof stored === 'object' && stored.id) {
        this.session = stored;
      }
    } catch (e) {
      logger.warn('Failed to load session from extension storage:', e);
    }
  }

  // Save the session to extension storage (async)
  async _saveSessionToExtensionStorage(storage, session) {
    try {
      await storage.set({ [SESSION_KEY]: session });
    } catch (e) {
      logger.warn('Failed to save session to extension storage:', e);
    }
  }

  // Set user properties — GA4 wraps each value as { value } — merged into
  // every subsequent event's user_properties block, and SENT on web through
  // the page's own gtag (#159: they used to be stored and never sent)
  setUserProperties(properties = {}) {
    if (!this._isSupported()) {
      return;
    }

    if (!this.initialized) {
      return;
    }

    // Bridged: main's sender owns the user_properties block that rides every
    // event, so they cross raw (it does the GA4 { value } wrapping) and are
    // never held here, where nothing would ever read them.
    if (this._isBridged()) {
      try {
        this.bridge.setUserProperties(properties);
      } catch (e) {
        // Same rule as the event forward above: a value IPC cannot carry is
        // never allowed to throw into the caller's action.
        logger.warn('Failed to forward user properties to the main process:', e.message);
      }

      return;
    }

    this.userProperties = { ...this.userProperties, ...core.wrapUserProperties(properties) };

    if (this._isWeb()) {
      this._setOnGtag({ user_properties: this.userProperties });
    }
  }

  // Set user ID — raw uid in, uuidv5 out (the same value desktop/backend
  // emit for this uid). Without a namespace the raw uid is never sent.
  setUserId(userId) {
    if (!this._isSupported()) {
      return;
    }

    if (!this.initialized) {
      return;
    }

    // Bridged: identity is main's OWN, and this is the one place the bridge
    // does not forward — the preload exposes no setUserId, because main's auth
    // bridge already flips user_id off the same Firebase user (#411). Storing
    // it here would set a value nothing in this process ever reads, so the
    // call raises where it was made instead of quietly doing nothing (#480).
    if (this._isBridged()) {
      throw new Error('setUserId() is not a bridged renderer\'s to call — the main process owns identity (its auth bridge sets user_id off the same Firebase user). Call omega.analytics.setUserId(uid) in MAIN to set one by hand');
    }

    this.userId = core.deriveUserId(userId, this.namespace);

    // Web sends it (#159). A null userId is sent as null, which is how GA4 is
    // told to stop attributing to the person who just signed out.
    if (this._isWeb()) {
      this._setOnGtag({ user_id: this.userId });
    }
  }

  /**
   * GA4's `set` command through the page's own gtag, guarded: an ad blocker
   * does not stub the global, it keeps it from existing, and a bare call would
   * throw a ReferenceError (#306).
   * @param {object} properties - The `set` payload.
   */
  _setOnGtag(properties) {
    // `typeof` against an undeclared NAME is the one check that does not throw:
    // a blocker leaves `gtag` undefined rather than stubbed, so `window.gtag`
    // would be a miss on any page that never made a window object of it.
    if (typeof gtag !== 'function') {
      return;
    }

    gtag('set', properties);
  }

  /**
   * Auth transitions → the catalog's `login` / `logout`.
   *
   * The audited asymmetry (#328 inventory gap 8): desktop's main-process
   * singleton fired these off its auth bridge while web and the extension fired
   * nothing. The wiring belongs here, in the class every runtime shares — with
   * ONE owner per surface:
   *
   *   web       the auth pages own it (`libs/auth/tracking.js` fires `login`
   *             with the METHOD the visitor actually used, which an auth-state
   *             callback cannot know), so this wiring stays out of web's way
   *             entirely.
   *   bridged   desktop's main-process singleton owns it: its auth bridge fires
   *             login/logout off the SAME Firebase user, so forwarding them
   *             from the renderer would double-count every sign-in (#411).
   *   other     this is the only owner.
   *
   * @param {object|null} user - The auth user, or null when signed out.
   * @returns {void}
   */
  handleAuthChange(user) {
    const uid = user?.uid || null;

    // Bridged: NEITHER half is this renderer's — main's auth bridge sets the
    // identity and fires the events off the same user, so the setUserId below
    // would hit the throw that guards main's ownership (#480).
    if (this._isBridged()) {
      return;
    }

    // Identity follows auth on every other runtime (user_id = uuidv5(uid, namespace))
    this.setUserId(uid);

    if (this._isWeb()) {
      return;
    }

    if (uid && !this.authed) {
      this.authed = true;
      this.event('login', { method: user?.providerId || 'unknown', user_id: uid });
    } else if (!uid && this.authed) {
      this.authed = false;
      this.event('logout');
    }
  }
}

export default Analytics;

// The facade itself, for the HOST that wires a runtime's seams — @omega.js/web's
// page module reaches the package through here, because `@omega.js/analytics` is
// private and exists in a consumer install only as the copy vendored into this
// package's dist (HARD RULE 3).
export { analytics };
