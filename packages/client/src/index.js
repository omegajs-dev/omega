import Storage from './modules/storage.js';
import Utilities from './modules/utilities.js';
import * as domUtils from './modules/dom.js';
import Analytics from './modules/analytics.js';
import Auth from './modules/auth.js';
import Bindings from './modules/bindings.js';
import Firestore from './modules/firestore.js';
import Notifications from './modules/notifications.js';
import ServiceWorker from './modules/service-worker.js';
import Sentry from './modules/sentry.js';
import Device from './modules/device.js';
import Verts from './modules/verts.js';
import Triggers from './modules/triggers.js';
import Icons from './modules/icons.js';
import { createMotion } from './modules/motion.js';
import { createRequest, mergeUsageIntoBindings } from './modules/request.js';
import { createLogger } from './modules/logger.js';
import { pathPrefix } from './modules/path-prefix.js';
import { FUNCTIONS_REGION, apiAddress } from './modules/api-address.js';
import { loadOnce, loadFirestore, loadMessaging } from './modules/firebase-services.js';
// The environment is the ONE module's, vendored in at prepare time like every
// other shared contract this runtime hosts
// ([#817](https://github.com/Omega-JS-Stack/omega/issues/817)). Its one input in
// a browser is `config.environment`, the build fact every OMEGA surface bakes.
import { getEnvironment, isDevelopment, isProduction, isTesting } from '@omega.js/config/environment';
import { devFactMissing } from '@omega.js/config/dev-facts';
import { requiredPort, localApiUrl, localFunctionsUrl, localAuthEmulatorUrl } from './modules/dev-ports.js';

const firebaseLogger = createLogger('firebase');
const analyticsLogger = createLogger('analytics');
const chatsyLogger = createLogger('chatsy');
const versionLogger = createLogger('version');

// The step that wrote the baked dev map, named in every missing-dev-fact error
// (`_devFactMissing` below, and modules/dev-ports.js handed this writer). This
// runtime is embedded in all three browser surfaces, so it names each one.
const DEV_FACT_WRITER = '`omega dev` (into the page chrome, per response) on a website, and the @omega.js/desktop and @omega.js/extension bundle tasks at build time';

/**
 * The missing-dev-fact error, from the ONE home of it (#834).
 * @param {string} what - the fact that is missing, named as the caller needs it.
 * @returns {Error} the error to throw.
 */
function _devFactMissing(what) {
  return devFactMissing(what, DEV_FACT_WRITER);
}

/**
 * The OMEGA browser runtime: the BASE CLASS every browser framework (web, the
 * extension, the desktop renderer) subclasses and exports ONE instance of. This
 * package exports the class and no instance; a consumer never writes `new`.
 *
 * Every module is a plain property built here (`omega.auth`, `omega.storage`,
 * `omega.triggers`), and each one that needs the instance receives it in its
 * constructor, so nothing imports a singleton.
 */
class Omega {
  constructor() {
    // Configuration from init()
    this.config = {};

    // Runtime state
    this.state = {
      serviceWorker: null
    };

    // The session probe's moments are registered ONCE per instance (#798)
    this._sessionProbeMomentsWired = false;

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

    // Modules
    this.storage = new Storage();
    this.utilities = new Utilities(this);
    this.analytics = new Analytics(this);
    this.auth = new Auth(this);
    this.bindings = new Bindings(this);
    this.firestore = new Firestore(this);
    this.notifications = new Notifications(this);
    this.serviceWorker = new ServiceWorker(this);
    this.sentry = new Sentry(this);
    this.device = new Device(this);
    this.verts = new Verts(this);
    this.dom = domUtils;

    // The standalone service modules the framework builds once
    this.triggers = new Triggers();
    this.icons = new Icons();
    this.motion = createMotion();

    // Harmonized API fetch (omega.request) — fresh Bearer token when signed in,
    // omega-properties processed on every response (server usage → bindings)
    this._request = createRequest({
      getApiUrl: () => this.getApiUrl(),
      getIdToken: (force) => this._firebaseAuth?.currentUser
        ? this.auth.getIdToken(force)
        : null,
      onProperties: (properties) => mergeUsageIntoBindings(this.bindings, properties),
      // A 401 is the third moment of doubt (#798): the backend refused this
      // token, so the client asks the Auth server whether the session is still
      // there at all. Fire-and-forget: the caller's error is unchanged.
      onUnauthorized: () => this.auth.probeSession(),
    });
  }

  // Make an API request: `omega.request('/omega/user/token', { method: 'POST', body: {} })`.
  // Route-relative paths resolve through getApiUrl(); pass `auth: false` for public routes,
  // `output: 'complete'` for { status, ok, headers, data, properties }, and
  // `wakeup: true` for a fire-and-forget ping that warms a cold backend.
  request(url, options) {
    return this._request(url, options);
  }

  /**
   * Boot the instance from a surface's resolved config, and settle `ready`.
   * @param {object} configuration - the browser subset of the brand's omega.json5.
   * @returns {Promise<Omega>} the instance.
   */
  async initialize(configuration) {
    try {
      // Store configuration as-is
      this.config = this._processConfiguration(configuration);

      // Set platform and runtime on HTML element
      this._setHtmlDataAttributes();

      // Sentry starts once the page is idle, never on the boot path: the early-
      // error buffer goes in now, and the SDK replays it when it has loaded
      if (this.config.sentry?.enabled) {
        this.sentry.schedule(this.config.sentry.config);
      }

      // Initialize Firebase if a config blob is present (presence-driven — matches @omega.js/backend
      // convention). Reads `cloud.config` (the omega.json5 canonical shape — desktop passes its
      // resolved config through) and falls back to nested `firebase.app.config` (the web/extension
      // bridge contract shape).
      // Initialize Firebase only when the resolved config can actually boot the
      // SDK — apiKey is mandatory (init without one crashes with auth/invalid-api-key).
      // Configs carrying only projectId still resolve for getFunctionsUrl derivation.
      if (this._resolveFirebaseConfig()?.apiKey) {
        await this._initializeFirebase();
      } else {
        firebaseLogger.log('Skipped: config has no apiKey (Firebase-less site or empty framework merge blob)');
      }

      // Initialize Analytics when the google provider is configured
      // (canonical shape: analytics.providers.google.{id,secret} — C4 cp106a;
      // projectId feeds the cross-surface uuidv5 identity namespace)
      // Web is the exception: its transport is the page's own gtag, so there
      // is no id or secret to require here (#159): the api_secret must never
      // reach a page at all.
      // Desktop's renderer is the other exception: it never sends at all
      // ([#411](https://github.com/Omega-JS-Stack/omega/issues/411)). When the
      // host injected an analytics bridge, every event forwards over IPC to the
      // main process, whose sender owns the one device id, the one session id
      // and the real engagement time — so a bridged renderer initializes with
      // no id and no secret of its own.
      const googleAnalytics = this.config.analytics?.providers?.google;
      const isWebRuntime = this.utilities.getRuntime() === 'web';
      const analyticsBridge = this._resolveAnalyticsBridge();
      if (isWebRuntime || analyticsBridge || (googleAnalytics?.id && googleAnalytics?.secret)) {
        this.analytics.init({
          id: googleAnalytics?.id || null,
          secret: googleAnalytics?.secret,
          projectId: this._resolveFirebaseConfig()?.projectId || this.config.brand?.id || null,
          bridge: analyticsBridge,
        });
      } else {
        analyticsLogger.log('Skipped: missing analytics.providers.google id or secret');
      }

      // Initialize service worker if enabled — dev included (push/caching are
      // testable locally). Registering at the page's scope ('/', or the base
      // path the site is mounted under — #360) REPLACES whatever worker last
      // claimed it (a different project on the same localhost port), and the
      // worker itself evicts foreign caches on boot. When a
      // project explicitly disables the SW, sweep the origin clean instead so
      // a previous project's worker can't keep serving its stale caches.
      // Only http(s) origins are eligible: file:// (desktop) and
      // chrome-extension:// (extension) pages ship the API but cannot host a
      // page-scope worker, so they skip the branch entirely — no register, no sweep.
      const originProtocol = window.location?.protocol;

      if (originProtocol === 'http:' || originProtocol === 'https:') {
        if (this.config.serviceWorker?.enabled) {
          this.serviceWorker.register({
            path: this.config.serviceWorker?.config?.path
          });
        } else {
          this.serviceWorker.unregisterAll();
        }
      }

      // Start version checking if enabled
      if (this.config.refreshNewVersion?.enabled) {
        this._startVersionCheck();
      }

      // Set up auth event listeners (uses event delegation, no need to wait for DOM)
      this.auth.setupEventListeners();

      // Set up push notifications
      if (this.config.pushNotifications?.enabled) {
        this.notifications.initialize(this.config.pushNotifications.config);
      }

      // Initialize Chatsy chat widget if enabled
      const chatsy = this.config.inbound?.chat?.providers?.chatsy;
      if (chatsy?.enabled && chatsy?.agentId) {
        this._initializeChatsy();
      }

      // Old IE force polyfill
      // await this._loadPolyfillsIfNeeded();

      // Initialize local device-stats tracking (installed/session/version)
      await this.device.initialize();

      // Update bindings with config and device data. `device` is the LOCAL
      // stats key — the `usage` key belongs to SERVER usage (seeded on auth
      // settle, refreshed from omega-properties by omega.request()).
      this.bindings.update({
        config: this.config,
        device: this.device.getBindingData(),
      });

      this._readyResolve(this);

      return this;
    } catch (error) {
      console.error('Omega initialization error:', error);
      this._readyReject(error);
      throw error;
    }
  }

  _processConfiguration(configuration) {
    // Default configuration structure
    const defaults = {
      runtime: null, // Auto-detect if not provided (web, browser-extension, electron, node)
      // NO `environment` default (#817). It used to default to 'production'
      // here, which is a fourth surface quietly deciding the answer: a page
      // whose build forgot to bake the fact read as production and talked to
      // the LIVE stack. The fact is baked by every OMEGA build, so its absence
      // is a broken artifact, and getEnvironment() says so by name.
      buildTime: Date.now(),
      brand: {
        id: 'brand',
        name: 'Brand',
        description: '',
        type: 'Organization',
        images: {
          brandmark: '',
          wordmark: '',
          combomark: ''
        },
        contact: {
          email: '',
          phone: ''
        },
        address: {}
      },
      auth: {
        enabled: true,
        config: {
          policy: null,
          redirects: {
            authenticated: '/dashboard/account',
            unauthenticated: '/signup'
          }
        }
      },
      firebase: {
        app: {
          enabled: true,
          config: {}
        },
        appCheck: {
          enabled: false,
          config: {
            siteKey: ''
          }
        }
      },
      // Consent (#383) — the region-gated banner. The palette/theme keys the
      // old `cookieConsent` blob carried are gone: the panel paints itself from
      // the --omega-* token sheet, which is the only way it is correct in both
      // color modes. `type` is gone too — the visitor's timezone decides opt-in
      // vs opt-out, never a config key.
      consent: {
        enabled: true,
        config: {
          position: 'bottom-left',
          content: {
            message: 'We use cookies to improve your experience, measure traffic, and personalize marketing. See our { terms }.',
            panelIntro: 'We and our partners use cookies and similar technologies to operate this site, measure how it is used, and personalize marketing. Necessary technologies are always active; the rest are yours to switch on or off, here or later, and a choice takes effect the moment you make it. See our { cookies } and { terms }.',
            accept: 'Accept',
            customize: 'Customize',
            acceptAll: 'Accept all',
            acceptNone: 'Accept none'
          }
        }
      },
      // ONE home (#23): @omega.js/manager provisions the agent and writes agentId
      // here, and the widget's presentation settings sit beside it — there is
      // no second `chatsy` blob to keep in sync.
      inbound: {
        chat: {
          providers: {
            chatsy: {
              enabled: false,
              agentId: '',
              settings: {
                button: {
                  backgroundColor: '#237afc',
                  textColor: '#FFFFFF',
                  position: 'bottom-right',
                  type: 'round',
                  icon: 'default',
                }
              }
            }
          }
        }
      },
      sentry: {
        enabled: true,
        config: {
          dsn: '',
          release: '',
          replaysSessionSampleRate: 0.01,
          replaysOnErrorSampleRate: 0.01
        }
      },
      exitPopup: {
        enabled: true,
        config: {
          timeout: 1000 * 60 * 60 * 4,
          title: 'Want 15% off?',
          message: 'Get 15% off your purchase of our Premium plans.',
          okButton: {
            text: 'Claim 15% Discount',
            link: '/pricing'
          },
          // Social-proof faces above the offer (foot.html renders them);
          // an empty list renders four neutral glyph slots
          avatars: []
        }
      },
      lazyLoading: {
        enabled: true,
        config: {
          selector: '[data-lazy]',
          rootMargin: '50px 0px', // Start loading 50px before element comes into view
          threshold: 0.01, // Trigger when 1% of element is visible
          loadedClass: 'lazy-loaded',
          loadingClass: 'lazy-loading',
          errorClass: 'lazy-error'
        }
      },
      socialSharing: {
        enabled: false,
        config: {
          selector: '[data-social-share]',
          defaultPlatforms: ['facebook', 'twitter', 'linkedin', 'pinterest', 'reddit', 'email', 'copy'],
          buttonClass: '',
          showLabels: false,
          openInNewWindow: true,
          windowWidth: 600,
          windowHeight: 400,
        }
      },
      pushNotifications: {
        enabled: true,
        config: {
          autoRequest: 1000 * 60
        }
      },
      validRedirectHosts: [],
      payment: {
        providers: {},
        products: [],
      },

      // Non-configurable defaults
      refreshNewVersion: {
        enabled: true,
        config: {
          interval: 1000 * 60 * 60, // Check every hour
        }
      },
      serviceWorker: {
        enabled: true,
        config: {
          path: '/service-worker.js'
        }
      },
      analytics: {
        providers: {
          google: { id: '', secret: '' },
          meta: { id: '' },
          tiktok: { id: '' },
        },
      },
    };

    // Deep merge configuration with defaults
    const merged = this._deepMerge(defaults, this._canonicalConfiguration(configuration));

    // Evaluate string expressions for timeout values
    if (merged.exitPopup?.config?.timeout) {
      merged.exitPopup.config.timeout = safeEvaluate(merged.exitPopup.config.timeout);
    }

    if (merged.pushNotifications?.config?.autoRequest) {
      merged.pushNotifications.config.autoRequest = safeEvaluate(merged.pushNotifications.config.autoRequest);
    }

    if (merged.refreshNewVersion?.config?.interval) {
      merged.refreshNewVersion.config.interval = safeEvaluate(merged.refreshNewVersion.config.interval);
    }

    // Calculate buildTimeISO from buildTime
    if (merged.buildTime) {
      merged.buildTimeISO = new Date(merged.buildTime).toISOString();
    }

    // Return merged configuration
    return merged;
  }

  /**
   * The ONE bridge from omega.json5's CANONICAL shape to this contract
   * ([#894](https://github.com/Omega-JS-Stack/omega/issues/894)).
   *
   * Every surface hands over the same browser-safe subset of its resolved
   * config now (`OMEGA_BUILD_JSON.config`, @omega.js/config's clientConfig),
   * so the two mappings that used to be copied into web's engine.js, web's
   * foot.html and the extension's bundle task live here instead:
   *
   *   `client`                       the settings blob's home in omega.json5 IS
   *                                  this contract's top level (auth, consent,
   *                                  exitPopup, serviceWorker, env, …)
   *   `monitoring.providers.sentry`  the one error-reporting home (#425): a DSN
   *                                  there IS the switch, and it outranks a
   *                                  legacy `client.sentry` blob (#485 part 3),
   *                                  which still reports until a brand migrates
   *
   * `cloud.config` needs no bridge: _resolveFirebaseConfig() reads the
   * canonical home first already.
   * @param {object} configuration - the resolved subset a surface baked.
   * @returns {object} the same facts in this contract's shape.
   */
  _canonicalConfiguration(configuration) {
    const { client, ...config } = configuration || {};
    const sentry = config.monitoring?.providers?.sentry;

    // The off state rides BEFORE the blob, so a brand parked at the legacy home
    // keeps its own switch; a real DSN rides AFTER it and wins.
    const base = sentry?.dsn ? config : this._deepMerge(config, { sentry: { enabled: false, config: {} } });
    const merged = this._deepMerge(base, client || {});

    return sentry?.dsn ? this._deepMerge(merged, { sentry: { enabled: true, config: sentry } }) : merged;
  }

  _deepMerge(target, source) {
    const output = Object.assign({}, target);
    if (isObject(target) && isObject(source)) {
      Object.keys(source).forEach(key => {
        if (isObject(source[key])) {
          if (!(key in target))
            Object.assign(output, { [key]: source[key] });
          else
            output[key] = this._deepMerge(target[key], source[key]);
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;

    function isObject(item) {
      return item && typeof item === 'object' && !Array.isArray(item);
    }
  }

  _setHtmlDataAttributes() {
    // Skip if not in browser environment
    if (typeof document === 'undefined') {
      return;
    }

    const $html = document.documentElement;

    // Set platform (OS) - windows, mac, linux, ios, android, chromeos, unknown
    $html.dataset.platform = this.utilities.getPlatform();

    // Set browser - chrome, firefox, safari, edge, opera, brave
    $html.dataset.browser = this.utilities.getBrowser();

    // Set runtime - web, browser-extension, electron, node
    $html.dataset.runtime = this.utilities.getRuntime();

    // Set device - mobile, tablet, desktop
    $html.dataset.device = this.utilities.getDevice();
  }

  // Resolve the desktop renderer's analytics bridge — the ONE seam that turns
  // this client into a forwarder instead of a sender
  // ([#411](https://github.com/Omega-JS-Stack/omega/issues/411)).
  //
  // INJECTED by the host, never sniffed off a global: @omega.js/desktop's
  // renderer passes its preload's analytics surface as `config.analyticsBridge`
  // when it boots this client. A page that merely happens to carry a
  // `window.desktop` can never bridge a brand's analytics into a void, and web
  // and the extension inject nothing, so they keep every path they have today.
  //
  // An injected value with no `event()` is a broken host, not a runtime
  // condition — it raises rather than quietly falling back to a sender the
  // desktop app must not have.
  _resolveAnalyticsBridge() {
    const bridge = this.config?.analyticsBridge;

    if (!bridge) {
      return null;
    }

    if (typeof bridge.event !== 'function') {
      throw new Error('config.analyticsBridge carries no event() — the host must inject its preload\'s analytics surface, or nothing at all');
    }

    return bridge;
  }

  // Resolve the Firebase web SDK config blob. `cloud.config` first (canonical
  // omega.json5 role shape — desktop passes its resolved config through), then nested
  // `firebase.app.config` (the web/extension bridge contract shape).
  // A blob only counts when at least one value is non-empty — framework config merges
  // can inject all-empty-string blobs into Firebase-less sites,
  // and those must resolve to null (no init, no URL derivation).
  _resolveFirebaseConfig() {
    const hasValues = (blob) => !!blob
      && typeof blob === 'object'
      && Object.values(blob).some((value) => value);

    const cloud = this.config.cloud?.config;
    if (hasValues(cloud)) {
      return cloud;
    }
    const nested = this.config.firebase?.app?.config;
    if (hasValues(nested)) {
      return nested;
    }
    return null;
  }

  async _initializeFirebase() {
    const firebaseConfig = this._resolveFirebaseConfig();

    // Dynamically import Firebase v12
    const { initializeApp } = await import('firebase/app');
    const { getAuth, onAuthStateChanged } = await import('firebase/auth');

    // If we're in devmode, set the firebase config authDomain to the current host
    // if (this.isDevelopment() && firebaseConfig) {
    //   firebaseConfig.authDomain = window.location.hostname;
    // }

    // Initialize Firebase. Re-init guards: if there's already a [DEFAULT] app
    // (live reload, re-init in tests), get the existing one rather than throwing
    // `app/duplicate-app`.
    const { getApp, getApps } = await import('firebase/app');
    const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

    // Store Firebase references
    this._firebaseApp = app;
    this._firebaseAuth = getAuth(app);

    // A LOCAL stack (`_localStack()`: development, or a testing run handed a dev
    // port map) talks to the emulators, never live Firebase; production never
    // connects. Auth connects here, at creation; Firestore connects inside its
    // loader, before any read. Ports come from the resolved dev map only.
    if (this._localStack()) {
      const authEmulatorUrl = this._authEmulatorUrl();
      firebaseLogger.log(`Connecting the auth emulator (${authEmulatorUrl})`);
      const { connectAuthEmulator } = await import('firebase/auth');
      // No warnings banner: its DOM overlay gets in the way of automated flows
      connectAuthEmulator(this._firebaseAuth, authEmulatorUrl, { disableWarnings: true });
    }

    // Initialize Firebase App Check if enabled
    if (this.config.firebase.appCheck?.enabled) {
      const { initializeAppCheck, ReCaptchaEnterpriseProvider } = await import('firebase/app-check');
      const siteKey = this.config.firebase.appCheck.config.siteKey;

      if (siteKey) {
        initializeAppCheck(app, {
          provider: new ReCaptchaEnterpriseProvider(siteKey),
          isTokenAutoRefreshEnabled: true
        });
      }
    }

    // Setup auth state listener
    onAuthStateChanged(this._firebaseAuth, (user) => {
      // The auth module builds the one state for this change and lands it on
      // every consumer. Not awaited: its account fetch must never block
      // Firebase's callback, and the Chatsy/analytics calls below need none of it.
      this.auth._handleAuthStateChange(user);

      // Analytics follows auth: the identity on every runtime (user_id =
      // uuidv5(uid, namespace)), plus the login/logout events on the runtimes
      // that own them — web's auth pages fire their own (#328 gap 8)
      this.analytics.handleAuthChange(user);

      // Update Chatsy with current user
      // (the identity, not `this.auth.user`: the User for this change lands
      // only after its account fetch, and Chatsy needs no account fields)
      if (this._chatsy) {
        const identity = this.auth._identity(user);
        this._chatsy.setUser(identity ? { id: identity.uid, email: identity.email, firstName: identity.displayName, photoURL: identity.photoURL } : null);
      }
    });

    // The moments of doubt ([#798](https://github.com/Omega-JS-Stack/omega/issues/798)).
    // Firebase asks the Auth server about the persisted session on page load
    // and at the hourly refresh and never again, so a revoked, disabled or
    // deleted account (or a dev backend whose emulator restarted) keeps this
    // tab signed in until a reload. The tab coming back into view and the
    // network coming back are the two free moments to re-ask; the third is a
    // 401 (wired as the request layer's onUnauthorized dep). No timer: a
    // periodic ping would be a request per open tab for nothing.
    if (!this._sessionProbeMomentsWired) {
      this._sessionProbeMomentsWired = true;

      // Swallowed at the call site: the probe classifies its own answer, so the
      // only way it rejects is a sign-out that failed, and an event handler is
      // nobody's promise to catch.
      //
      // The extension's background service worker has no document, and a
      // headless host may carry neither
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            this.auth.probeSession().catch(() => {});
          }
        });
      }

      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('online', () => {
          this.auth.probeSession().catch(() => {});
        });
      }
    }
  }

  // Getters for Firebase services
  get firebaseApp() { return this._firebaseApp; }
  get firebaseAuth() { return this._firebaseAuth; }

  // Firestore and messaging load on first use, never at boot: ONE memoized
  // promise of each instance (modules/firebase-services.js). A caller gates on
  // `firebaseApp` first; a call on a page with no Firebase rejects by name.
  loadFirebaseFirestore() {
    return loadOnce(this, '_firestoreLoad', loadFirestore);
  }

  loadFirebaseMessaging() {
    return loadOnce(this, '_messagingLoad', loadMessaging);
  }

  // The environment surface (#817): ONE implementation, shared with every other
  // OMEGA target, reading ONE input. In this runtime that input is
  // `this.config.environment`, the build fact the page's OMEGA_BUILD_JSON
  // carries; a config without it throws by name rather than quietly reading as
  // "not development". The three checks DERIVE from getEnvironment(), so they
  // can never disagree with it, and isProduction() is a real positive check.
  getEnvironment() {
    return getEnvironment.call(this);
  }

  isDevelopment() {
    return isDevelopment.call(this);
  }

  isProduction() {
    return isProduction.call(this);
  }

  isTesting() {
    return isTesting.call(this);
  }

  // Whether this page talks to a LOCAL stack: the emulators, and the API on the
  // hosting or https port. Development always (a dev build always carries the
  // resolved map, and a key nobody resolved throws by name). A testing run only
  // when it was HANDED a dev port map: the desktop boot lane and the extension's
  // emulator run bake one, and their renderers answer the running word (#925),
  // while a testing page with no map (a unit lane, a static build under a
  // driver) has no local stack to reach and stays live, as it always did.
  // Production never. The `environment` argument lets the url getters honor
  // the word a caller passed ahead of the running one.
  _localStack(environment) {
    const env = environment || this.getEnvironment();

    if (env === 'development') return true;
    if (env !== 'testing') return false;

    return Object.keys(this._providedDevPorts()).length > 0;
  }

  // The dev port map a page was GIVEN (N7), and the only one there is (#834):
  // two channels, and the BAKED CHROME WINS: `config.dev.ports` is written by
  // `omega dev` at render time, so it is the live map of the stack this page
  // was served by. `window.__OMEGA_DEV_PORTS__` is a driver-injected fallback
  // for pages whose chrome carries nothing — a statically built site the
  // devkit e2e harness serves, say — and it must not be able to OVERRIDE the
  // real channel, or a green suite proves only the side channel
  // ([#300](https://github.com/Omega-JS-Stack/omega/issues/300)). Presence of
  // a key means a RESOLVED fact about a live stack; absence used to mean
  // "assume the classics", and now means the build is broken.
  _providedDevPorts() {
    return {
      ...(typeof window !== 'undefined' && window.__OMEGA_DEV_PORTS__ || {}),
      ...(this.config.dev?.ports || {}),
    };
  }

  _devPorts() {
    return this._providedDevPorts();
  }

  // ONE port, by name, through the shared chain over the map this page was
  // given. No classic fallback: a miss is loud, at the call that needed the
  // number, naming the step that writes the map.
  _devPort(name) {
    return requiredPort(this._providedDevPorts(), name, DEV_FACT_WRITER);
  }

  // Where the dev WEBSITE answers — the one shared answer for every surface
  // that links to it in dev (#262). A resolved fact when the stack published
  // one: `omega dev` puts its origin in the same `dev` map as the ports, and
  // web reads it from the page chrome while desktop/extension read it from
  // their build-time bake of that same map. Protocol is part of the fact —
  // the dev server fronts its public port with the mkcert proxy by default,
  // so a port alone would still be a guess about the scheme.
  getDevWebsiteOrigin() {
    const provided = this.config.dev?.origin;

    if (!provided) {
      // The classic `https://localhost:4000` assumption is gone (#834): a wrong
      // dev origin fails as a silent connection refusal, which is the worst
      // possible way for a guess to be wrong.
      throw _devFactMissing('dev website origin');
    }

    return provided;
  }

  // Where the auth emulator answers FROM THE BROWSER'S POINT OF VIEW (#156).
  // A surface whose dev server proxies the emulator under its own origin says
  // so with `dev.authEmulatorProxy` — and then the emulator URL must be that
  // origin, so the OAuth handler and the SDK's helper iframe are first-party
  // and the redirect credential survives storage partitioning. Every other
  // surface (desktop, extension, a page with no proxy) keeps talking straight
  // to the emulator's own port.
  // Origin only, never a path: connectAuthEmulator() discards any path on the
  // URL it is handed, so the proxy has to be mounted at the site root.
  _authEmulatorUrl() {
    if (this.config.dev?.authEmulatorProxy && typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin;
    }

    return localAuthEmulatorUrl(this._providedDevPorts(), DEV_FACT_WRITER);
  }

  getFunctionsUrl(environment) {
    const env = environment || this.getEnvironment();
    const projectId = this._resolveFirebaseConfig()?.projectId;

    if (!projectId) {
      throw new Error('Firebase project ID not configured');
    }

    if (this._localStack(env)) {
      return localFunctionsUrl(this._providedDevPorts(), projectId, DEV_FACT_WRITER);
    }

    return `https://${FUNCTIONS_REGION}-${projectId}.cloudfunctions.net`;
  }

  getApiUrl(environment, url) {
    // Precedence: passed environment > query string > the one environment
    // surface (#817), which reads the same baked `config.environment` this used
    // to compare by hand.
    const searchParams = new URLSearchParams(window.location.search);
    const queryEnv = searchParams.get('_dev_apiEnvironment');
    const env = environment
      || queryEnv
      || this.getEnvironment();

    // Scheme and host follow what the provided dev map says is running (N7):
    // the shared chain answers the mkcert proxy, else the hosting emulator,
    // else throws by name.
    if (this._localStack(env)) {
      return localApiUrl(this._providedDevPorts(), DEV_FACT_WRITER);
    }

    // The API rides the BRAND domain (api.<brand host>), or the functions
    // address on a default Pages host. Never derive from authDomain: it is an
    // auth concern (the brand host, with /__/auth/* self-hosted at build time)
    // and its value must stay free to change without moving the API base.
    const brandUrl = this.config.brand?.url; // schema enforces an http(s) URL
    const baseUrl = url || brandUrl || window.location.origin;

    // This brand's project id addresses only this brand's own url: another
    // url (the company's) on a default Pages host has no address here.
    const ownUrl = !url || url === brandUrl;

    const address = apiAddress(baseUrl, ownUrl ? this._resolveFirebaseConfig()?.projectId : undefined);
    if (!address) {
      throw new Error(`No API address for ${baseUrl}: a default Pages host needs cloud.config.projectId`);
    }
    return address;
  }

  isValidRedirectUrl(url) {
    try {
      const currentUrlObject = new URL(window.location.href);
      const decoded = decodeURIComponent(url);

      // Path-relative values ('/pricing') resolve against the page origin so they
      // reach the checks below as an absolute URL instead of throwing and falling
      // back to the policy default. Only a leading '/' counts: anything else must
      // parse as an absolute URL on its own, so garbage ('not-a-url') still fails.
      // A protocol-relative value ('//evil.com') resolves to its own host and is
      // then rejected by the same-host check, exactly like the absolute form.
      const returnUrlObject = decoded.startsWith('/')
        ? new URL(decoded, currentUrlObject.origin)
        : new URL(decoded);

      // Loopback returns (RFC 8252 §7.3) are valid while the SITE runs in development:
      // native apps (Electron desktop) can't OS-register their custom scheme in dev, so
      // their sign-in flow returns to an ephemeral 127.0.0.1 listener instead. Any port —
      // the app binds it at flow start. Production sites never match this branch.
      if (this.isDevelopment() && ['127.0.0.1', '[::1]', 'localhost'].includes(returnUrlObject.hostname)) {
        return true;
      }

      return returnUrlObject.host === currentUrlObject.host
        || returnUrlObject.protocol === `${this.config.brand?.id}:`
        || (this.config.validRedirectHosts || []).includes(returnUrlObject.host);
    } catch (e) {
      return false;
    }
  }

  // The web build's public config filter inlines `settings: null` when a
  // brand sets none, and Chatsy's constructor rejects a null blob — omit the
  // key instead so the widget applies its own defaults (#377).
  _chatsyOptions(config) {
    return config.settings ? { settings: config.settings } : {};
  }

  async _initializeChatsy() {
    try {
      const { default: Chatsy } = await import('chatsy');
      const config = this.config.inbound.chat.providers.chatsy;

      this._chatsy = new Chatsy(config.agentId, this._chatsyOptions(config));

      chatsyLogger.log('Initialized');
    } catch (error) {
      chatsyLogger.error('Failed to initialize:', error);
    }
  }

  _startVersionCheck() {
    // Quit if window is not available
    if (typeof window !== 'undefined') {
      // Re-focus events
      window.addEventListener('focus', () => {
        this._checkVersion();
      });

      window.addEventListener('online', () => {
        this._checkVersion();
      });
    }

    // Set up interval — re-initializing replaces the timer, never stacks a
    // second one on top of the first
    clearInterval(this._versionCheckInterval);
    this._versionCheckInterval = setInterval(() => {
      this._checkVersion();
    }, this.config.refreshNewVersion.config.interval);
  }


  // async _loadPolyfillsIfNeeded() {
  //   // Check if polyfills are needed by testing for ES6 features
  //   const featuresPass = (
  //     typeof Symbol !== 'undefined'
  //   );

  //   // If all features are supported, no polyfills needed
  //   if (featuresPass) {
  //     return;
  //   }

  //   // Load polyfills for older browsers (especially IE)
  //   try {
  //     await domUtils.loadScript({
  //       src: 'https://cdnjs.cloudflare.com/polyfill/v3/polyfill.min.js?flags=always%2Cgated&features=default%2Ces5%2Ces6%2Ces7%2CPromise.prototype.finally%2C%7Ehtml5-elements%2ClocalStorage%2Cfetch%2CURLSearchParams',
  //       crossorigin: 'anonymous'
  //     });
  //     console.log('Polyfills loaded for older browser');
  //   } catch (error) {
  //     console.error('Failed to load polyfills:', error);
  //     // Continue initialization even if polyfills fail to load
  //   }
  // }

  async _checkVersion() {
    if (this.isDevelopment()) {
      /* @dev-only:start */
      {
        versionLogger.log('Skipping version check in development mode');
      }
      /* @dev-only:end */
      return;
    }

    try {
      // The manifest is served from the site's own mount (#364): under a URL
      // path (#355) a root-relative fetch lands off-site and 404s forever. No
      // stamp means the domain root and an unchanged URL.
      const response = await fetch(`${pathPrefix()}/build.json?cb=${Date.now()}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch build.json (${response.status})`);
      }

      const data = await response.json();
      if (!data.timestamp) {
        throw new Error('No timestamp found in build.json');
      }

      const buildTimeLive = new Date(data.timestamp);
      const buildTimeCurrent = new Date(this.config.buildTime);

      // Add 1 hour to current build time to account for npm build process
      buildTimeCurrent.setHours(buildTimeCurrent.getHours() + 1);

      // Log version info
      versionLogger.log(`Current build time: ${buildTimeCurrent.toISOString()}, Live build time: ${buildTimeLive.toISOString()}`);

      // If live version is newer, reload the page
      if (buildTimeCurrent >= buildTimeLive) {
        return; // No update needed
      }

      // New version detected
      versionLogger.log('New version detected, reloading page...');

      // If running in a non-browser environment, warn and return
      if (typeof window === 'undefined') {
        versionLogger.warn('Cannot reload in non-browser environment');
        return;
      }

      // Force page reload
      window.onbeforeunload = function () {
        return undefined;
      };

      window.location.reload(true);
    } catch (error) {
      versionLogger.warn('Failed version check:', error);
    }
  }
}

// Safely evaluate timeout string expressions
const safeEvaluate = (str) => {
  if (typeof str !== 'string') return str;

  // Only allow numbers, *, +, -, /, parentheses, and whitespace
  if (!/^[\d\s\*\+\-\/\(\)]+$/.test(str)) {
    console.warn('Invalid expression format:', str);
    return str;
  }

  try {
    // Use Function constructor instead of eval for safer evaluation
    return new Function(`return ${str}`)();
  } catch (e) {
    console.warn('Failed to evaluate expression:', str, e);
    return str;
  }
};

// The class only: each browser framework subclasses it and exports its one instance
export default Omega;
export { Omega };

