// Deep Link: one dispatch pipeline for every way a `<scheme>://` URL arrives (macOS
// open-url, Windows/Linux argv on cold start, second-instance on warm start, manual
// dispatch), with pattern routes, built-ins (auth/token, app/show, app/quit) and boot
// queueing. The API, the handler ctx and the resolution order: docs/desktop/deep-link.md.

const LoggerLite = require('./logger-lite.js');
const protocol = require('./protocol.js');

const logger = new LoggerLite('deep-link');

const deepLink = {
  _initialized:    false,
  _omega:          null,
  _electron:       null,
  _handlers:       [],          // [{ pattern, fn, builtin: bool }]
  _coldStartUrl:   null,        // the URL the app was launched with (if any)
  _wired:          false,       // open-url + queueing wired?
  _listening:      false,       // second-instance listener prepended (listenFirst)?
  _pendingUrls:    [],          // urls received before whenReady — drained on init
  _omegaReady:     false,       // omega.initialize() finished — safe to dispatch
  _bootQueue:      [],          // dispatches held until _omegaReady (auth et al. are up)

  initialize(omega) {
    if (deepLink._initialized) {
      return;
    }

    deepLink._omega = omega;
    deepLink._electron = require('electron');

    deepLink._wireElectronEvents();
    deepLink._registerBuiltins();

    // Cold-start argv parse. On Windows/Linux the deep link arrives in argv;
    // on macOS it arrives via open-url (already wired above).
    const coldUrl = deepLink._extractUrlFromArgv(process.argv);
    if (coldUrl) {
      deepLink._coldStartUrl = coldUrl;
      omega.appState.setLaunchedFromDeepLink(true);
      // _handle queues until markOmegaReady() — a cold-start auth/token must
      // not dispatch before auth has booted Firebase.
      deepLink._handle(coldUrl, 'cold-start', { argv: process.argv, cwd: process.cwd() });
    }

    // Drain anything that came in via open-url before initialize ran.
    if (deepLink._pendingUrls.length > 0) {
      const urls = deepLink._pendingUrls.slice();
      deepLink._pendingUrls = [];
      if (!deepLink._coldStartUrl) {
        deepLink._coldStartUrl = urls[0];
        omega.appState.setLaunchedFromDeepLink(true);
      }
      urls.forEach((u) => deepLink._handle(u, 'cold-start', { argv: process.argv, cwd: process.cwd() }));
    }

    logger.log(`initialize — coldStartUrl=${deepLink._coldStartUrl || '(none)'} handlers=${deepLink._handlers.length}`);
    deepLink._initialized = true;
  },

  _wireElectronEvents() {
    if (deepLink._wired) return;
    deepLink._wired = true;

    const { app } = deepLink._electron;

    // macOS: open-url. Fires for both cold-start and warm-start opens.
    app.on('open-url', (event, url) => {
      event.preventDefault();
      // Before whenReady: queue.
      if (!app.isReady()) {
        deepLink._pendingUrls.push(url);
        return;
      }
      // Post-whenReady: dispatch as warm-start (the app is already running).
      deepLink._handle(url, 'warm-start', { argv: process.argv, cwd: process.cwd() });
    });
  },

  // main.js calls this at load, so the framework hears second-instance ahead of every
  // brand listener, one registered before the require included. Outside the main
  // process (plain Node, where `electron` is a path string) there is no app to hear.
  listenFirst() {
    const { app } = require('electron');
    if (!app || deepLink._listening) return;
    deepLink._listening = true;
    app.prependListener('second-instance', deepLink._onSecondInstance);
  },

  // Windows/Linux warm-start: another instance launched (e.g. user double-clicked the
  // app icon while it's already running, or a deep link arrived). The OS gave us the
  // lock, killed the duplicate, and forwarded its argv here.
  _onSecondInstance(_event, argv, cwd, additionalData) {
    // First, so a quit any later listener asks for waits on this duplicate
    protocol.markForwarding(additionalData?.pid);

    // The event's own argv is Chromium-processed (switches first, the values detached
    // at the end), so the duplicate's REAL command line rides along in the object it
    // passed to requestSingleInstanceLock. The fallback covers a duplicate
    // started by a build from before that object existed.
    const realArgv = Array.isArray(additionalData?.argv) ? additionalData.argv : argv;
    const realCwd  = additionalData?.cwd || cwd;
    logger.log(`second-instance argv=${JSON.stringify(realArgv)} eventArgv=${JSON.stringify(argv)} cwd=${realCwd}`);

    if (!deepLink._initialized) {
      logger.log('second-instance before deep-link initialize; nothing to surface or dispatch');
      return;
    }

    // Surface the main window. With hidden-mode apps, the consumer typically created
    // `main` with `show: false` at boot, so it's in the registry but invisible: we
    // just need to show it now that the user explicitly asked.
    const main = deepLink._omega.windows.get('main');
    if (main) {
      logger.log(`second-instance: surfacing main (visible=${main.isVisible()}, minimized=${main.isMinimized()})`);
      if (main.isMinimized()) main.restore();
      deepLink._omega.windows._ensureDockVisible();
      main.show();
      main.focus();
    } else {
      logger.log('second-instance: no main window in registry; ignoring');
    }

    const url = deepLink._extractUrlFromArgv(realArgv);
    if (url) {
      deepLink._handle(url, 'warm-start', { argv: realArgv, cwd: realCwd });
    }
  },

  _registerBuiltins() {
    // auth/token: hand off to lib/auth.js. The receiving end of
    // omega.getAuthUrl()'s sign-in round-trip: the website's token page redirects
    // here with ?authToken=<custom-token>. MODERN shape only — older formats
    // (?payload=, ?token=) are not read.
    deepLink._handlers.push({
      pattern: 'auth/token',
      builtin: true,
      fn: (ctx) => {
        const token = ctx.query?.authToken;
        if (!token) {
          logger.warn('auth/token: no authToken in query string.');
          return;
        }
        deepLink._omega.auth.handleToken(token);
      },
    });

    // app/show — surface a named window.
    deepLink._handlers.push({
      pattern: 'app/show',
      builtin: true,
      fn: (ctx) => {
        const name = ctx.query?.window || 'main';
        deepLink._omega.windows.show(name);
      },
    });

    // app/quit: graceful quit, through omega.quit() so a warm-start link waits
    // for its forwarding duplicate to exit.
    deepLink._handlers.push({
      pattern: 'app/quit',
      builtin: true,
      fn: () => {
        deepLink._omega.quit();
      },
    });
  },

  // Pull a `<scheme>://...` URL out of an argv array. Returns null if none of our schemes match.
  _extractUrlFromArgv(argv) {
    if (!Array.isArray(argv)) return null;
    const schemes = deepLink._omega.protocol.getSchemes();
    if (schemes.length === 0) return null;

    // Walk argv backward — the URL is typically the last meaningful arg.
    for (let i = argv.length - 1; i >= 0; i -= 1) {
      const a = argv[i];
      if (typeof a !== 'string') continue;
      if (schemes.some((s) => a.startsWith(`${s}://`))) {
        return a;
      }
    }
    return null;
  },

  // Parse a `<scheme>://route?query` URL into a route object.
  _parseUrl(url) {
    try {
      const u = new URL(url);
      const scheme = u.protocol.replace(/:$/, '');
      // host + pathname together form the "route." Strip leading/trailing slashes.
      // myapp://auth/token        → host='auth', pathname='/token' → route='auth/token'
      // myapp://user/profile/42   → host='user', pathname='/profile/42' → route='user/profile/42'
      const host = u.host || u.hostname || '';
      const path = (u.pathname || '').replace(/^\/+|\/+$/g, '');
      const route = [host, path].filter(Boolean).join('/');

      const query = {};
      u.searchParams.forEach((v, k) => { query[k] = v; });

      return { scheme, route, query };
    } catch (e) {
      logger.warn(`failed to parse URL "${url}":`, e.message);
      return null;
    }
  },

  // Match a parsed route against a registered pattern. Returns the params object on match,
  // or null on miss. Wildcard '*' matches anything and yields {}.
  _matchPattern(route, pattern) {
    if (pattern === '*') return {};
    const pParts = pattern.split('/');
    const rParts = route.split('/');
    if (pParts.length !== rParts.length) return null;

    const params = {};
    for (let i = 0; i < pParts.length; i += 1) {
      const p = pParts[i];
      const r = rParts[i];
      if (p.startsWith(':')) {
        params[p.slice(1)] = decodeURIComponent(r);
      } else if (p !== r) {
        return null;
      }
    }
    return params;
  },

  // Called by main.js once omega.initialize() completes — every LIB a handler
  // touches (auth's Firebase, the windows registry, tray) is up from here
  // on. (Consumer-created windows may still be pending — consumers create them
  // in initialize().then(); app/show on a not-yet-created window warns + drops,
  // same as always.) Any dispatch that arrived earlier drains now.
  markOmegaReady() {
    deepLink._omegaReady = true;
    const queued = deepLink._bootQueue.slice();
    deepLink._bootQueue = [];
    queued.forEach(({ url, source, env }) => deepLink._handle(url, source, env));
  },

  // Run the dispatch pipeline for a single URL.
  _handle(url, source, env) {
    // Hold every dispatch until omega is fully initialized: handlers
    // deref omega surfaces that do not exist yet during boot.
    if (!deepLink._omegaReady) {
      logger.log(`queueing ${source} dispatch until omega ready — ${url}`);
      deepLink._bootQueue.push({ url, source, env });
      return;
    }

    const parsed = deepLink._parseUrl(url);
    if (!parsed) return;

    logger.log(`dispatch — source=${source} scheme=${parsed.scheme} route=${parsed.route}`);

    // Concrete (non-wildcard) handlers first, in registration order. Consumer concrete handlers
    // are appended in registration order; built-in handlers were registered first by @omega.js/desktop, so
    // they run last among concrete handlers — meaning a consumer concrete handler runs BEFORE
    // @omega.js/desktop's built-in for the same route. To shadow a built-in entirely, the consumer sets
    // ctx.handled = true.
    //
    // We split into concrete + wildcard so wildcards never run if any concrete handler matched.
    const concrete = deepLink._handlers.filter((h) => h.pattern !== '*');
    const wild     = deepLink._handlers.filter((h) => h.pattern === '*');

    // Re-order: consumer concrete handlers BEFORE built-ins of the same pattern, regardless of
    // registration order. We do this by partitioning by builtin flag.
    const consumerConcrete = concrete.filter((h) => !h.builtin);
    const builtinConcrete  = concrete.filter((h) =>  h.builtin);
    const ordered = [...consumerConcrete, ...builtinConcrete];

    let matched = false;
    let claimed = false;

    for (const h of ordered) {
      const params = deepLink._matchPattern(parsed.route, h.pattern);
      if (params == null) continue;
      matched = true;

      const ctx = {
        url,
        scheme:  parsed.scheme,
        route:   parsed.route,
        pattern: h.pattern,
        params,
        query:   parsed.query,
        source,
        argv:    env?.argv || process.argv,
        cwd:     env?.cwd  || process.cwd(),
        handled: false,
      };

      try {
        h.fn(ctx);
      } catch (e) {
        logger.error(`handler for "${h.pattern}" threw:`, e);
      }

      if (ctx.handled) {
        claimed = true;
        break;
      }
    }

    // Wildcards run only if NO concrete handler matched (not even a built-in).
    if (!matched && !claimed) {
      for (const h of wild) {
        const ctx = {
          url,
          scheme:  parsed.scheme,
          route:   parsed.route,
          pattern: '*',
          params:  {},
          query:   parsed.query,
          source,
          argv:    env?.argv || process.argv,
          cwd:     env?.cwd  || process.cwd(),
          handled: false,
        };
        try { h.fn(ctx); }
        catch (e) { logger.error('wildcard handler threw:', e); }
      }
    }
  },

  // Public API ──────────────────────────────────────────────────────────────────

  on(pattern, fn) {
    if (typeof pattern !== 'string' || !pattern) {
      throw new Error('deepLink.on: pattern must be a non-empty string');
    }
    if (typeof fn !== 'function') {
      throw new Error('deepLink.on: fn must be a function');
    }
    deepLink._handlers.push({ pattern, fn, builtin: false });
    return () => deepLink.off(pattern, fn);
  },

  off(pattern, fn) {
    deepLink._handlers = deepLink._handlers.filter((h) => !(h.pattern === pattern && h.fn === fn));
  },

  dispatch(url) {
    deepLink._handle(url, 'manual', { argv: process.argv, cwd: process.cwd() });
  },

  getColdStartUrl() {
    return deepLink._coldStartUrl;
  },

  // Inspection (used by tests).
  getHandlers() {
    return deepLink._handlers.slice();
  },
};

module.exports = deepLink;
