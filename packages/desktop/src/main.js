// The main-process runtime: ONE ready-made `omega` instance.
// Consumer entry: `const omega = require('@omega.js/desktop/main'); omega.initialize()`; config
// auto-loads (config/omega.json5). The boot sequence below delegates each step to a `lib/*.js` module.

const LoggerLite = require('./lib/logger-lite.js');
const { setEnvironment, ENVIRONMENT_VAR } = require('@omega.js/config/environment');
const { createRequest } = require('@omega.js/client/modules/request.js');
const environment = require('./lib/_environment-mixin.js');
const lifecycle = require('./lib/_lifecycle-mixin.js');

const storage      = require('./lib/storage.js');
const theme        = require('./lib/theme.js');
const fontawesome  = require('./lib/fontawesome.js');
// Error reporting is the shared @omega.js/monitoring contract (#380): the
// package's entry detects main vs renderer and forwards, exactly as the
// lib/sentry/ split it replaced did.
const sentry       = require('@omega.js/monitoring');
const protocol     = require('./lib/protocol.js');
const deepLink     = require('./lib/deep-link.js');
const authFlow     = require('./lib/auth-flow.js');
const appState     = require('./lib/app-state.js');
const ipc          = require('./lib/ipc.js');
const autoUpdater  = require('./lib/auto-updater.js');
const tray         = require('./lib/tray.js');
const menu         = require('./lib/menu.js');
const ctxMenu      = require('./lib/context-menu.js');
const startup      = require('./lib/startup.js');
const auth         = require('./lib/auth.js');
const windows      = require('./lib/window-manager.js');
const context      = require('./lib/context.js');
const usage        = require('./lib/usage.js');
const remoteConfig   = require('./lib/remote-config.js');
const remoteScripts  = require('./lib/remote-scripts.js');
const analytics      = require('./lib/analytics.js');
const restartManager = require('./lib/restart-manager/index.js');
const { createBootGuard } = require('./lib/_boot-guard.js');

// At load, so the framework hears second-instance ahead of every brand listener
deepLink.listenFirst();

/**
 * The main-process runtime. This module exports ONE instance of it; a consumer
 * never writes `new`, and awaits `initialize()` or `ready`. Every library is a
 * plain property (`omega.windows`, `omega.tray`, `omega.auth`, ...).
 */
class Omega {
  constructor() {
    this.config = null;
    this.logger = new LoggerLite('main');

    // Quit-vs-hide gating. The window-manager `close` handler checks `_allowQuit` /
    // `_isQuitting` before deciding whether to actually close (=quit) or to swallow
    // the event and just hide the window. Set true via `omega.quit({ force: true })`,
    // by `app.on('before-quit')` (any user-initiated quit), and by the auto-updater
    // when it's about to call `quitAndInstall()`.
    this._allowQuit  = false;
    this._isQuitting = false;

    // Public lib references (consumer code can call them by name)
    this.storage     = storage;
    this.theme       = theme;
    this.fontawesome = fontawesome;
    this.sentry      = sentry;
    this.protocol    = protocol;
    this.deepLink    = deepLink;
    this.authFlow    = authFlow;
    this.appState    = appState;
    this.ipc         = ipc;
    this.autoUpdater = autoUpdater;
    this.tray        = tray;
    this.menu        = menu;
    this.contextMenu = ctxMenu;
    this.startup     = startup;
    this.auth        = auth;
    this.windows     = windows;
    this.context     = context;
    this.usage       = usage;
    this.remoteConfig   = remoteConfig;
    this.remoteScripts  = remoteScripts;
    this.analytics      = analytics;
    this.restartManager = restartManager;

    // The harmonized API fetch (omega.request), the client base's shape: a
    // fresh Bearer token from main's session when signed in
    this._request = createRequest({
      getApiUrl: () => this.getApiUrl(),
      getIdToken: (force) => this.auth.getIdToken(force),
    });

    // Settled by initialize(): resolves with the instance, rejects with the
    // error initialize() rethrows. A module that did not call initialize() can
    // still await it.
    this._readyResolve = null;
    this._readyReject = null;
    this.ready = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });

    // A rejected boot nobody awaited must not surface as an unhandled
    // rejection; a consumer awaiting `ready` still sees the error, because this
    // catch hangs off a separate branch of the same promise.
    this.ready.catch(() => {});

    // The one boot guard: a boot that has not reached the auth step within the
    // fixed limit writes its last step to runtime.log and exits non-zero
    this._bootGuard = createBootGuard();
  }

  // Open the sign-in round trip in the user's default browser (lib/auth-flow.js).
  // Resolves once launched; completion arrives via the auth/token deep-link route →
  // auth.handleToken → the desktop:auth:sign-in-with-token broadcast.
  openAuthFlow(options) {
    return authFlow.open(options);
  }

  // Make an API request: `omega.request('/omega/user/token', { method: 'POST', body: {} })`,
  // with @omega.js/client's options (`auth: false`, `output: 'complete'`, `wakeup: true`)
  request(url, options) {
    return this._request(url, options);
  }

  /**
   * Boot the main process in the fixed order (docs/desktop/boot-sequence.md), and
   * settle `ready`.
   * @param {object|string} [consumerConfig] - a RESOLVED config, a project dir to resolve one from, or nothing.
   * @param {object} [options] - boot options (the test harness passes `skipWindowCreation`).
   * @returns {Promise<Omega>} the instance.
   */
  async initialize(consumerConfig, options) {
    try {
      await this._boot(consumerConfig, options);
    } catch (error) {
      this._readyReject(error);
      throw error;
    }

    this._readyResolve(this);

    return this;
  }

  async _boot(consumerConfig, options) {
    this._bootGuard.start();
    this._bootGuard.step('config');

    // Accept either an already-RESOLVED config object, a string path to a consumer
    // project dir, or nothing. Default resolution order (when called with no arg):
    //   1. OMEGA_BUILD_JSON.config: injected at build time by the bundle task's esbuild `define`. This is
    //      authoritative in packaged apps because config/omega.json5 is inside the asar and
    //      not loadable from disk. It's the RESOLVED config (build.getConfig() output:
    //      shared sections + targets.desktop overlaid) snapshotted at build time.
    //   2. <appRoot>/config/omega.json5: resolved via @omega.js/config for dev mode where
    //      @omega.js/desktop is loaded directly (unbundled). appRoot = the consumer project dir.
    if (typeof consumerConfig === 'string') {
      consumerConfig = loadResolvedConfig(consumerConfig);
    } else if (!consumerConfig) {
      // Try OMEGA_BUILD_JSON (set by DefinePlugin in packaged builds) first.
      if (typeof OMEGA_BUILD_JSON !== 'undefined' && OMEGA_BUILD_JSON?.config) {
        consumerConfig = OMEGA_BUILD_JSON.config;
      } else {
        const appRoot = require('./utils/app-root.js')();
        consumerConfig = loadResolvedConfig(appRoot);
      }
    }

    this.config = consumerConfig || {};
    this._options = options || {};

    // The environment's ONE input is the `OMEGA_ENVIRONMENT` variable
    // ([#817](https://github.com/Omega-JS-Stack/omega/issues/817)), and a lane
    // that named one is NEVER overridden here
    // ([#925](https://github.com/Omega-JS-Stack/omega/issues/925)). The baked word
    // is the FALLBACK, for the one case with no parent lane to inherit from: a
    // packaged app, where this is the input every later read answers (the
    // context-free ones, like test-stealth's, included). A dev boot inherits the
    // word from the gulp lane that spawned this electron, and the test lanes spawn
    // their child with `testing` while booting a PRODUCTION artifact, so writing
    // the baked word over theirs turned every isTesting() gate in a booted app
    // silently off.
    if (!process.env[ENVIRONMENT_VAR] && this.config.environment) {
      setEnvironment(this.config.environment);
    }

    {
      const _app = require('electron').app;

      // The name comes first: the log path (app.getPath('logs')) is derived from it.
      const _productName = this.config.app?.productName || this.config.brand?.name;
      if (_productName) {
        _app.setName(_productName);
      }
      // The format first, so every line from boot on carries the lock-off pid tag
      LoggerLite.setSingleInstanceOff(this.protocol.singleInstanceOff(this.config));
    }

    this.logger.log(`Initializing @omega.js/desktop (main)... pid=${process.pid} platform=${process.platform} arch=${process.arch} packaged=${require('electron').app.isPackaged} argv=${JSON.stringify(process.argv.slice(1))}`);

    require('./utils/signing-status.js')(this.logger);

    // Schema validation. Hard-fail boot if required fields are missing: same rules as
    // gulp/audit (single source of truth in @omega.js/config: shared schema + the desktop
    // target refinements). We do this before any lib initializes so a misconfigured app
    // fails loud + early instead of partway through boot with a confusing stack trace.
    {
      const { validateConfig, formatErrors } = require('@omega.js/config');
      // A packaged app's config is baked, build facts included: validate it as decorated
      const { errors } = validateConfig(this.config, { target: 'desktop', decorated: true });
      if (errors.length > 0) {
        throw new Error(`@omega.js/desktop: config validation failed. Fix the following in config/omega.json5:\n${formatErrors(errors)}`);
      }
    }

    // electron is a peer dep, main process only (we're in main.js, always defined).
    const electron = require('electron');
    const app = electron.app;

    // Lifecycle event logging. These are the high-signal app-level events worth tracing
    // when something goes wrong: quit reasons, window-all-closed, will-finish-launching,
    // ready, render-process-gone, child-process-gone. All cheap to log; one line each.
    app.on('before-quit', () => {
      this._isQuitting = true;
      this.logger.log('app event: before-quit (entering quit sequence: close events bypass hide-on-close)');
    });
    app.on('will-quit', () => this.logger.log('app event: will-quit'));
    app.on('quit', (_e, exitCode) => this.logger.log(`app event: quit code=${exitCode}`));
    app.on('window-all-closed', () => this.logger.log('app event: window-all-closed'));
    app.on('render-process-gone', (_e, webContents, details) => this.logger.warn(`app event: render-process-gone reason=${details.reason} exitCode=${details.exitCode}`));
    app.on('child-process-gone', (_e, details) => this.logger.warn(`app event: child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`));
    app.on('activate', () => this.logger.log('app event: activate (macOS: dock click or app re-launch)'));
    app.on('open-url', (_e, url) => this.logger.log(`app event: open-url url=${url}`));
    app.on('open-file', (_e, p) => this.logger.log(`app event: open-file path=${p}`));

    // Process-level signals that bypass Electron's app events. Catches uncaught exceptions
    // so we never crash silently: combined with electron-log file transport, this means
    // ANY unhandled throw lands in runtime.log rather than disappearing into stderr.
    process.on('uncaughtException', (e) => {
      // EPIPE = stdout/stderr pipe closed (CLI consumer hung up). Logging it would
      // write to console, which triggers another EPIPE, cascading into thousands of
      // identical log entries. Exit cleanly: standard Unix behavior.
      if (e?.code === 'EPIPE') {
        process.exit(0);
        return;
      }
      this.logger.error(`uncaughtException: ${e?.stack || e?.message || String(e)}`);
    });
    process.on('unhandledRejection', (reason) => {
      this.logger.error(`unhandledRejection: ${reason?.stack || reason?.message || String(reason)}`);
    });
    process.on('exit', (code) => {
      // electron-log's file transport flushes synchronously, so this last line lands.
      this.logger.log(`process exit code=${code}`);
    });

    // 1. Apply early startup-mode hide. For `mode: 'hidden'` we call app.dock.hide() *before*
    //    anything else so macOS spends as little time animating the dock entry as possible.
    //    In packaged builds the Info.plist's LSUIElement (injected by gulp/build-config when
    //    startup.mode === 'hidden') prevents the bounce entirely.
    this._bootGuard.step('startup-early');
    this.startup._omega = this;
    this.startup._electron = electron || null;
    this.startup.applyEarly();

    // 1a. Test stealth: suppress app-level activation on macOS. Launching a regular-
    //     policy app activates it (menu bar + keyboard focus switch away from whatever
    //     the developer is typing in) even though stealth windows surface via
    //     showInactive() (see lib/window-manager.js). The accessory policy (the same
    //     switch app.dock.hide() flips, and what LSUIElement bakes for packaged
    //     hidden-mode apps) keeps the test process from ever activating; windows still
    //     render normally. Must run before app ready: activation happens when the app
    //     finishes launching. OMEGA_TEST_SHOW=1 restores normal activation along with
    //     visible windows.
    if (process.platform === 'darwin' && require('./utils/test-stealth.js')(this)) {
      app.dock.hide();
      this.logger.log('test stealth: app activation suppressed (dock hidden / accessory policy), launch will not steal focus');
    }

    // 1a-ii. Test stealth for EVERY BrowserWindow, including RAW ones created with
    //        `new BrowserWindow()` that never pass through lib/window-manager (e.g.
    //        a consumer's automation popup). Window-manager stealths only its own
    //        named windows via _surface(); this hook closes the gap so no window
    //        can flash or steal focus during a test run. The predicate is evaluated
    //        PER WINDOW so OMEGA_TEST_SHOW=1 keeps working even when flipped mid-run
    //        (the window-manager suite does exactly that).
    if (this.isTesting()) {
      app.on('browser-window-created', (_event, win) => {
        if (!require('./utils/test-stealth.js')(this)) return;
        require('./utils/stealth-window.js').applyStealth(win);
      });
      // webContents.focus() is NOT covered by the window stealth above: it's a
      // different object whose focus() reaches the native window directly,
      // making the invisible window KEY, so the test app grabs the keyboard from
      // whatever the developer is typing in (the accessory policy from 1a does
      // not prevent key-window steals, only launch activation). Consumers call
      // it legitimately (address-bar focus on tab select, overlay dismiss
      // hand-back), so no-op it per-contents under the same predicate.
      // Synthetic input (executeJavaScript, sendInputEvent, CDP) targets a
      // specific webContents and never depends on OS key status.
      app.on('web-contents-created', (_event, wc) => {
        if (!require('./utils/test-stealth.js')(this)) return;
        wc.focus = () => {};
      });
      this.logger.log('test stealth: every BrowserWindow (raw ones included) surfaces invisible + unfocusable, webContents.focus() suppressed (OMEGA_TEST_SHOW=1 to watch)');
    }

    // 1b. Isolate the userData path per environment. MUST run before
    //     storage.initialize() because electron-store reads `app.getPath('userData')`
    //     at construction time.
    //       production  → <name>                 (untouched)
    //       development → <name> (Development)   (dev runs never touch installed-app data)
    //       testing     → <name> (Testing)       (wiped at boot: every test run starts
    //                                             from a clean slate; post-run state stays
    //                                             on disk for inspection until the next run.
    //                                             Set OMEGA_TEST_KEEP_USERDATA=1 to skip the wipe.)
    this._bootGuard.step('user-data');
    if (this.isTesting()) {
      const before = app.getPath('userData');
      const after  = `${before} (Testing)`;
      const keep   = process.env.OMEGA_TEST_KEEP_USERDATA === '1';
      if (!keep) {
        require('fs').rmSync(after, { recursive: true, force: true });
      }
      app.setPath('userData', after);
      this.logger.log(`userData path: ${before} -> ${after} (testing mode, ${keep ? 'kept' : 'wiped at boot'})`);
    } else if (!this.isProduction()) {
      const before = app.getPath('userData');
      const after  = `${before} (Development)`;
      app.setPath('userData', after);
      this.logger.log(`userData path: ${before} -> ${after} (dev mode)`);
    } else {
      this.logger.log(`userData path: ${app.getPath('userData')} (production)`);
    }

    // 1c. Set the global user agent fallback (utils/user-agent.js): a branded UA on
    //     every BrowserWindow load, fetch and electron-updater download.
    require('./utils/user-agent.js')(this);

    // 2. IPC bus online first: storage and other libs register handlers on it
    this._bootGuard.step('ipc');
    this.ipc.initialize(this);

    // 3. Storage (precedes sentry + auth so opt-out + persisted session are honored)
    this._bootGuard.step('storage');
    await this.storage.initialize(this);

    // 3b. Theme: sets nativeTheme.themeSource from the persisted override / config
    //     default, so every renderer (and native UI) resolves the right appearance
    //     from its very first paint. Needs storage (override) + ipc (handlers) only.
    this._bootGuard.step('theme');
    this.theme.initialize(this);

    // 3c. FontAwesome: serves the bundled icon SVGs to renderers over IPC
    //     (desktop:fontawesome:get). Needs ipc only.
    this._bootGuard.step('fontawesome');
    this.fontawesome.initialize(this);

    // 4. Sentry (earliest catchable global handler)
    this._bootGuard.step('sentry');
    this.sentry.initialize(this);

    // 5. Protocol (single-instance lock + custom URL scheme)
    this._bootGuard.step('protocol');
    this.protocol.initialize(this);

    // Only the lock's holder clears runtime.log, so a duplicate never erases the running copy's lines
    LoggerLite.clearEarlierLaunches(this.protocol.hasSingleInstanceLock());

    if (!this.protocol.hasSingleInstanceLock()) {
      // Quit the duplicate AND halt the boot: returning normally would resolve
      // initialize(), letting the consumer's .then() run its whole main.js (servers,
      // shared files, IPC) against a dying Electron. The duplicate must go quietly.
      // The returned promise intentionally never settles; the process exits first.
      this.logger.warn('Single-instance lock lost. Quitting this duplicate instance.');
      this._bootGuard.stop();
      app.quit();
      return new Promise(() => {});
    }

    // 6. Deep links (parse cold-start argv, wire open-url, register the built-in
    //    routes; the second-instance listener was prepended at module load)
    this._bootGuard.step('deep-link');
    this.deepLink.initialize(this);

    // 6b. Auth flow (the getAuthUrl sign-in round trip: external browser always;
    //     dev/test return via a loopback listener since the scheme isn't OS-registered)
    this._bootGuard.step('auth-flow');
    this.authFlow.initialize(this);

    // 7. App state (first-launch / crash / startup-context flags)
    this._bootGuard.step('app-state');
    await this.appState.initialize(this);

    // 7b. Runtime context: session id, deviceId, OS info, async geolocation fetch.
    // Must run AFTER storage (writes deviceId + cached geolocation to storage) and
    // BEFORE analytics (which reads context.session.deviceId). Async but the geolocation
    // fetch is fire-and-forget so this returns quickly.
    this._bootGuard.step('context');
    await this.context.initialize(this);

    // 7c. Usage tracking: opens / hours-total / hours-this-session. Reads/writes
    // storage.usage and registers a before-quit handler to record session duration.
    this._bootGuard.step('usage');
    this.usage.initialize(this);

    // 8. Wait for app readiness before any UI
    this._bootGuard.step('when-ready');
    await app.whenReady();

    // 9. Auto-updater (queues check, never blocks UI)
    this._bootGuard.step('auto-updater');
    this.autoUpdater.initialize(this);

    // 10. Tray + menu + context menu
    this._bootGuard.step('tray');
    this.tray.initialize(this);
    this._bootGuard.step('menu');
    this.menu.initialize(this);
    this._bootGuard.step('context-menu');
    this.contextMenu.initialize(this);

    // 11. Open-at-login + hide-on-startup state sync
    this._bootGuard.step('startup');
    this.startup.initialize(this);

    // The guard ends here: the auth step may wait on a macOS keychain prompt
    this._bootGuard.stop();

    // 12. Auth (main-side Firebase Auth source of truth, IPC handlers for renderers)
    await this.auth.initialize(this);

    // 12b. Remote config: fetches `<brand.url>/data/resources/main.json` for hot
    // config flips (force-update gate, default user agents, etc.). Polls hourly.
    // Wired AFTER auto-updater so it can inherit feedCheckIntervalMs from there.
    this.remoteConfig.initialize(this);

    // 12c. Remote scripts: fetches `<brand.url>/data/scripts/main.json` for
    // emergency hotfixes (force-update, storage patches, etc.) when the normal
    // update pipeline is broken. Same polling cadence as remote-config.
    this.remoteScripts.initialize(this);

    // 12d. Analytics: GA4 via Measurement Protocol. Wired AFTER auth so it can
    // listen to it and flip user_id automatically.
    this.analytics.initialize(this);

    // 12e. Restart Manager: external guardian app that relaunches us if we crash.
    // Registers over RM's loopback HTTP protocol (runtime.json advertises the port),
    // heartbeats every 60s, deregisters on graceful quit, and silently installs RM
    // when missing (mac zip / win silent NSIS / linux AppImage; RM then self-updates
    // via its own @omega.js/desktop autoUpdater). Skips itself when this app IS restart-manager, in
    // dev (unless OMEGA_RESTART_MANAGER_DEV=1), or when restartManager.enabled=false.
    // See docs/desktop/restart-manager.md.
    this.restartManager.initialize(this);

    // 13. Initialize the windows lib: registers app-level handlers (window-all-closed, etc.)
    //     but does NOT create any windows. Consumers are responsible for calling
    //     `omega.windows.create('main')` (or any other named window) from their main.js
    //     when they want to surface UI. This makes hidden / agent-app patterns trivial:
    //     just don't call create() until something (tray click, deep link, IPC) warrants it.
    this.windows.initialize(this);

    this._initialized = true;

    // 14. Release deep-link dispatch: cold-start URLs (and any early open-url)
    // were queued so handlers like auth/token never fire before auth
    // has Firebase up. Everything they touch exists now.
    this.deepLink.markOmegaReady();

    this.logger.log('@omega.js/desktop (main) initialized.');

    // Boot test harness (utils/boot-harness.js): runs against the live instance AFTER
    // all libs are up, only when the boot test lane spawned this process.
    require('./utils/boot-harness.js')(this);
  }

  // Require: lets consumer main-process code load @omega.js/desktop's bundled dependencies at runtime
  // (e.g. `omega.require('fs-jetpack')`). Resolves from @omega.js/desktop's module context, not the
  // consumer's. Mirrors @omega.js/backend's omega.require(). For build-time resolution, the
  // bundle task's framework-deps resolve hook handles this automatically.
  require(name) {
    return require(name);
  }

  static require(name) {
    return require(name);
  }
}

// The environment and URL helpers, and quit/relaunch: methods on the instance,
// each concern in its own lib file
Object.assign(Omega.prototype, environment, lifecycle);

function loadResolvedConfig(projectDir) {
  // @omega.js/config is vendored into dist (and bundled from there): it
  // finds config/omega.json5 under the project dir and resolves the desktop target
  // (shared sections + targets.desktop overlaid, brand-monorepo walk-up included).
  const { hasOmegaConfig, loadConfig } = require('@omega.js/config');

  if (!hasOmegaConfig(projectDir)) {
    return {};
  }

  return loadConfig(projectDir, 'desktop').config;
}

// The ONE instance, initialized by the consumer's src/main.js
const omega = new Omega();

module.exports = omega;
module.exports.Omega = Omega;
