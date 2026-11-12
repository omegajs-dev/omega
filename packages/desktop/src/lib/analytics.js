// Analytics — GA4 via Measurement Protocol. Mirrors @omega.js/backend's
// `omega.config.analytics.providers.google.id` shape so the same person can be
// tracked across desktop (@omega.js/desktop) + web (@omega.js/client) + backend (@omega.js/backend) by
// referencing a single namespaced UUIDv5 identity.
//
// Cross-platform identity (the key feature):
//   client_id = uuidv5(deviceId, namespace)    // anonymous-but-stable per install
//   user_id   = uuidv5(firebaseUid, namespace) // same human across all surfaces
//
// The HUMAN is what crosses surfaces, never the machine: this app's deviceId comes
// from desktop's own storage and a browser's comes from its localStorage, so one
// machine is two client_ids and always was (#396). The derivation is shared
// (@omega.js/analytics' `deriveDeviceId`), the storage it reads is not. user_id
// rides ALONGSIDE the client_id in every payload — it never replaces it, because
// GA stitches sessions by client_id.
//
// `namespace` is the consumer's `cloud.config.projectId` re-encoded as a UUIDv5
// namespace via uuidv5.URL of the projectId string. Same projectId in @omega.js/backend/@omega.js/client/@omega.js/desktop
// → the same uid hashes to the same user_id everywhere → unified analytics.
//
// Anonymous (auth holds no signed-in account yet) → user_id stays null.
// Authed (auth event fires) → user_id is set + a `login` event is dispatched. On
// logout → user_id clears + `logout` event fires.
//
// API surface:
//   omega.analytics.event(name, params?)         // generic event
//   omega.analytics.pageview(path?)              // convenience wrapper
//   omega.analytics.screenview(name?)            // convenience wrapper
//   omega.analytics.setUserId(uid)               // manual override; auto-wired to auth
//   omega.analytics.setUserProperties(props)     // merge into user_properties block
//
// Events fired during normal operation are queued until init completes (we need
// context.session + measurement_id + secret). Once initialized, the queue
// flushes and subsequent calls send immediately.
//
// Config:
//   analytics: {
//     enabled: true,                                   // default true
//     providers: {
//       google: {
//         id: 'G-XXXXXXXXXX',                          // Measurement ID (REQUIRED)
//       },
//     },
//   }
//
// Secret comes from `process.env.GOOGLE_ANALYTICS_SECRET` (matches @omega.js/backend). The bundle
// task's esbuild `define` injects it at build time so packaged apps don't need .env at runtime.
// Without the secret, the module logs a warning + becomes a no-op.

const LoggerLite = require('./logger-lite.js');
const fetch      = require('wonderful-fetch');
// The MP semantics live in ONE place — @omega.js/analytics' core
// (C4 cp106b): identity math, payload + URL shape are shared with the browser
// engine and can never drift again.
const core = require('@omega.js/analytics/core');
// And so does WHAT an event is called: the shared catalog and its adapters
// decide the native name and payload for every surface
// ([#328](https://github.com/Omega-JS-Stack/omega/issues/328)). This module
// keeps only what is genuinely desktop's — the Measurement Protocol transport,
// the pre-init queue, and the IPC bridge.
const analytics_ = require('@omega.js/analytics');
const { analyticsProvider } = require('@omega.js/config/analytics-providers');

const logger = new LoggerLite('analytics');

const FETCH_TIMEOUT_MS = 30 * 1000;
const MAX_QUEUE = 200;

const analytics = {
  _initialized:  false,
  _omega:        null,
  _enabled:      false,
  _measurementId: null,
  _apiSecret:    null,
  _namespace:    null,
  _clientId:     null,    // uuidv5(deviceId, namespace) — set on init
  _userId:       null,    // uuidv5(firebaseUid, namespace) — set on auth
  _userProperties: {},
  _queue:        [],
  _authUnsub:    null,

  initialize(omega) {
    if (analytics._initialized) return;
    analytics._initialized = true;
    analytics._omega = omega;

    const cfg = omega.config.analytics || {};

    // Presence-driven: providers.google.id presence enables analytics. No separate
    // `enabled` flag (matches @omega.js/backend convention — credentials are the enable signal).
    analytics._measurementId = cfg.providers?.google?.id || null;
    // Secret comes from env. In packaged builds, the bundle task's esbuild `define`
    // replaces `process.env.GOOGLE_ANALYTICS_SECRET` with the build-time literal so the
    // packaged app has it baked in without shipping .env.
    analytics._apiSecret = process.env.GOOGLE_ANALYTICS_SECRET || null;

    if (!analytics._measurementId) {
      logger.log('analytics: no measurement ID set (config.analytics.providers.google.id) — disabled.');
      analytics._enabled = false;
      return;
    }
    if (!analytics._apiSecret) {
      logger.warn('analytics: GOOGLE_ANALYTICS_SECRET env var not set — disabled. (Set in .env for dev; the bundle task bakes it in at build time for packaged apps.)');
      analytics._enabled = false;
      return;
    }
    analytics._enabled = true;

    // Namespace = uuidv5 of the firebase project ID (or app id as fallback). Same
    // projectId in @omega.js/backend/@omega.js/client/@omega.js/desktop → same namespace → same per-uid UUIDv5
    // everywhere. UUIDv5 needs a UUID-shaped namespace — we derive one from the
    // string projectId by hashing it into uuidv5.URL space (RFC 4122).
    const projectId = omega.config.cloud?.config?.projectId
      || omega.config.brand.id;
    analytics._namespace = core.deriveNamespace(projectId);

    // Apply a uid stored by a pre-init setUserId() call — the auth
    // subscription below still overrides it when auth resolves.
    if (analytics._pendingUid) {
      analytics.setUserId(analytics._pendingUid);
      analytics._pendingUid = null;
    }

    // client_id = the PERSISTED per-install device id. context.session.deviceId is
    // async-resolved and context.initialize() runs before this in the boot sequence,
    // so an empty one is a broken boot order, never a runtime condition — and a
    // fresh id minted here would persist nowhere, making every launch a new GA
    // client (#396). It raises instead.
    const deviceId = omega.context.session.deviceId;

    if (!deviceId) {
      throw new Error('analytics.initialize() ran before context.initialize() resolved session.deviceId — the boot sequence must init context first');
    }

    analytics._clientId = core.deriveClientId(deviceId, analytics._namespace);

    // The facade's seams for THIS process. The transport is the Measurement
    // Protocol below — Meta's and TikTok's pixels do not exist in a main
    // process, so their descriptors report blocked and the fire log says so.
    // Environment mirrors the app's own dev flag: an unknown event name throws
    // in development, where a typo is a bug, and is logged-and-skipped in a
    // packaged app, where throwing would take the user's action with it.
    analytics_.configure({
      transport: { send: (descriptor) => analytics._send(descriptor) },
      context: { runtime: 'electron' },
      environment: omega.isDevelopment?.() ? 'development' : 'production',
    });

    // Listen to auth so user_id flips automatically on login/logout. The listen
    // catch-up delivers the state auth already holds, so nothing is pulled here.
    analytics._authUnsub = omega.auth.listen(({ user }) => {
      analytics._handleAuthChange(user);
    });

    // Compute initial user_properties from context + usage.
    analytics._userProperties = analytics._buildUserProperties();

    logger.log(`analytics initialized — measurement=${analytics._measurementId} client_id=${analytics._clientId.slice(0, 8)}…`);

    // Flush any queued events.
    if (analytics._queue.length > 0) {
      logger.log(`analytics: flushing ${analytics._queue.length} queued event(s).`);
      const queued = analytics._queue.slice();
      analytics._queue = [];
      for (const item of queued) analytics.event(item.name, item.params);
    }

    // Auto-emit app_launch from the main process — the one launch event for the
    // whole app. A renderer emits nothing of its own on init: it forwards the
    // events its own code fires through the IPC bridge below, and this sender
    // is what delivers them ([#411](https://github.com/Omega-JS-Stack/omega/issues/411)).
    if (analytics._isMain()) {
      analytics.event('app_launch');
    }

    // IPC: renderer → main analytics calls. Forward fires-and-forgets via send;
    // status query via invoke.
    omega.ipc.unhandle('desktop:analytics:status');
    omega.ipc.handle('desktop:analytics:status', () => analytics.toJSON());
    // Use Set-deduped listener; named handler so re-init collapses duplicates.
    omega.ipc.on('desktop:analytics:event',               analytics._onIpcEvent);
    omega.ipc.on('desktop:analytics:set-user-properties', analytics._onIpcSetProps);
  },

  _onIpcEvent({ name, params } = {}) {
    if (!name) return;
    analytics.event(name, params);
  },

  _onIpcSetProps(props) {
    analytics.setUserProperties(props);
  },

  // ─── Public API ─────────────────────────────────────────────────────────────

  // Fire a CANONICAL event (a catalog name). Queues if not initialized yet.
  event(name, params) {
    if (!analytics._enabled || !analytics._measurementId) {
      // Queue while we're still booting (init may flip _enabled later).
      if (!analytics._initialized) {
        if (analytics._queue.length < MAX_QUEUE) {
          analytics._queue.push({ name, params });
        }
      }
      return;
    }

    // The catalog resolves the name and the payload; the transport below is
    // handed the result. Nothing about a provider's dialect lives here.
    analytics_.event(name, analytics._enrichParams(params || {}));
  },

  // The Measurement Protocol transport: one resolved descriptor → one POST, for
  // the providers whose row says `measurementProtocol`.
  _send(descriptor) {
    if (!analyticsProvider(descriptor.provider).measurementProtocol) {
      return false;
    }

    const payload = core.buildPayload({
      clientId:       analytics._clientId,
      userId:         analytics._userId,
      userProperties: analytics._userProperties,
      eventName:      descriptor.name,
      params:         descriptor.payload,
    });

    const url = core.buildCollectUrl(analytics._measurementId, analytics._apiSecret);

    fetch(url, {
      method:   'post',
      response: 'text',
      tries:    2,
      timeout:  FETCH_TIMEOUT_MS,
      body:     payload,
    }).catch((e) => {
      logger.warn(`event "${descriptor.name}" failed: ${e.message}`);
    });

    return true;
  },

  pageview(path) {
    analytics.event('page_view', path ? { page_path: path } : {});
  },

  screenview(name) {
    analytics.event('screen_view', name ? { screen_name: name } : {});
  },

  // Manual user-id override. Normally auth.listen wires this automatically.
  setUserId(uid) {
    if (!analytics._namespace) {
      // Init hasn't run yet — store and apply at init.
      analytics._pendingUid = uid || null;
      return;
    }
    analytics._userId = core.deriveUserId(uid, analytics._namespace);
  },

  // Merge into the user_properties block sent on every subsequent event.
  setUserProperties(props) {
    if (!props || typeof props !== 'object') return;
    analytics._userProperties = { ...analytics._userProperties, ...core.wrapUserProperties(props) };
  },

  // ─── Internals ──────────────────────────────────────────────────────────────

  _isMain() {
    return process.type === 'browser' || process.type === undefined;   // undefined in tests
  },

  // GA4 param contract: each event needs engagement_time_msec (else session bounces),
  // and we add session_id + page_location so reports group properly.
  _enrichParams(params) {
    const omega = analytics._omega;
    const ctx = omega.context;
    const sessionStart = ctx.session.startTime ? new Date(ctx.session.startTime).getTime() : Date.now();
    const engagement   = Math.max(1, Date.now() - sessionStart);
    return {
      session_id:           ctx.session.id || 'unknown',
      engagement_time_msec: engagement,
      page_location:        params.page_location || `app://${omega.config.brand.id}`,
      page_title:           params.page_title || omega.config.app?.productName || omega.config.brand.name,
      ...params,
    };
  },

  // Compute user-properties from current context + usage. Re-run on auth change.
  _buildUserProperties() {
    const omega = analytics._omega;
    const ctx = omega.context;
    const usage = omega.usage;
    const wrap = (v) => ({ value: v });
    const out = {
      app_version:      wrap(ctx.app.version || 'unknown'),
      operating_system: wrap(ctx.client.platform || 'unknown'),
      device_category:  wrap(ctx.client.mobile ? 'mobile' : 'desktop'),
      country:          wrap(ctx.geolocation.country || 'None'),
      language:         wrap(ctx.client.locale || 'None'),
      authenticated:    wrap(!!analytics._userId),
    };
    out.app_opens       = wrap(usage.opens());
    out.app_hours_total = wrap(Math.round((usage.hoursTotal() || 0) * 100) / 100);
    return out;
  },

  // Auth bridge wiring — fires login/logout events on transition.
  _handleAuthChange(snap) {
    const newUid = snap?.uid || null;
    const prevUid = analytics._userId
      ? 'set'   // we don't reverse the uuidv5; just need to know whether one was set
      : null;

    if (newUid) {
      const previousAuthed = analytics._userId !== null;
      analytics.setUserId(newUid);
      analytics._userProperties = analytics._buildUserProperties();
      if (!previousAuthed) {
        analytics.event('login', { method: snap?.providerId || 'unknown' });
      }
    } else if (prevUid) {
      analytics.event('logout');
      analytics._userId = null;
      analytics._userProperties = analytics._buildUserProperties();
    }
  },

  // Plain-JSON snapshot for IPC inspection.
  toJSON() {
    return {
      enabled:        analytics._enabled,
      measurementId:  analytics._measurementId,
      clientId:       analytics._clientId,
      userId:         analytics._userId,
      queueLength:    analytics._queue.length,
    };
  },

  // Test teardown.
  shutdown() {
    if (typeof analytics._authUnsub === 'function') {
      analytics._authUnsub();
    }
    analytics._initialized   = false;
    analytics._omega         = null;
    analytics._enabled       = false;
    analytics._measurementId = null;
    analytics._apiSecret     = null;
    analytics._namespace     = null;
    analytics._clientId      = null;
    analytics._userId        = null;
    analytics._userProperties = {};
    analytics._queue         = [];
    analytics._authUnsub     = null;
    analytics._pendingUid    = null;
  },
};

module.exports = analytics;
