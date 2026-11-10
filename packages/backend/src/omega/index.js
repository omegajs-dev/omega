/**
 * @omega.js/backend's runtime: the `Omega` class and its ONE instance.
 *
 * The package's main export IS the instance; a consumer never writes `new`:
 *
 *   const omega = require('@omega.js/backend');
 *
 *   omega.initialize({ ... });
 *
 *   module.exports = omega.functions;
 *
 * initialize() is SYNCHRONOUS (Firebase reads a functions entry's exports at
 * module load) and returns the instance: config, env, logger, the Firebase SDK
 * (`firebase.admin`, `firebase.app`, `firebase.functions`), the process
 * services (utilities, storage, email, ai), and `functions`, the Cloud
 * Functions map the consumer exports. A custom-server backend (projectType
 * `custom`) listens on PORT instead and exposes `server` ({ app, server }).
 */
const path = require('path');
const EventEmitter = require('events');
const { hasOmegaConfig, loadConfig, loadEnv, formatErrors, backendProjectType, envEnvironment, envPort, CLASSIC_PORTS, apiAddress, FUNCTIONS_REGION } = require('@omega.js/config');
const environment = require('@omega.js/config/environment');
const { resolvedConfigValues } = require('./helpers/resolved-config.js');
const env = require('./libraries/env.js');
const Context = require('./context.js');
const pipeline = require('./pipeline.js');
const router = require('./router.js');
const events = require('./events.js');
const Analytics = require('./services/analytics.js');
const Utilities = require('./services/utilities.js');
const UserService = require('./services/user.js');
const Storage = require('./services/storage.js');
const Email = require('./libraries/email/index.js');
const AI = require('./libraries/ai/index.js');
const { watchTestMode } = require('../test/utils/test-mode-file.js');

const EVENTS_DIR = path.resolve(__dirname, './events');
const CRON_DIR = path.resolve(EVENTS_DIR, './cron');
const TEMPLATES_DIR = path.resolve(__dirname, '../../templates');
const PACKAGE = require('../../package.json');

// Process-level latch for the TEST-environment banner: initialize() can run more
// than once in a process, and the banner is boot information, said once.
let testBannerLogged = false;

/**
 * ONE dev port read for every local URL (#834): the `OMEGA_<NAME>_PORT` map the
 * booting CLI published, else `CLASSIC_PORTS` (a process booted straight onto
 * `firebase emulators:start` has no map, and its firebase.json IS the classic stack).
 * @param {string} name - the port's name ('functions', 'hosting', 'website').
 * @returns {number} the published port, else the classic default.
 */
function devPort(name) {
  const classic = CLASSIC_PORTS[name];

  // Loud by design: a typo'd name would otherwise compose a URL with `undefined`
  // in it and fail as a connection refusal somewhere far from here
  if (!classic) {
    throw new Error(`[@omega.js/backend:index] No classic port named \`${name}\` in @omega.js/config CLASSIC_PORTS (${Object.keys(CLASSIC_PORTS).join(', ')})`);
  }

  return envPort(name) || classic;
}

// The emulator boots a FRESH functions worker per invocation (53 worker processes
// for 92 invocations on one measured seed), so its test-environment boot lines
// stay silent there and LOUD (once) in a deployed process that resolves test mode.
function isUnderEmulator() {
  return process.env.FUNCTIONS_EMULATOR === 'true';
}

// Development OR testing (no explicit env) resolves the local URLs: test runs hit
// the local emulator. The parent URLs never do: the parent is a real remote server.
function isLocal(omega, env) {
  return env === 'development' || (!env && (omega.isDevelopment() || omega.isTesting()));
}

// The consumer's package.json: the functions dir's first, else the cwd's own
function resolveProjectPackage(dir) {
  try {
    return require(path.resolve(dir, 'functions', 'package.json'));
  } catch (e) {}

  try {
    return require(path.resolve(dir, 'package.json'));
  } catch (e) {}
}

/**
 * The backend runtime. One instance per process: the package's main export.
 */
class Omega extends EventEmitter {
  #storage = null;

  constructor() {
    super();

    this.version = PACKAGE.version;

    // The consumer's pre/post hooks, keyed by function name (events.js)
    this.handlers = {};
    // The Cloud Functions map the consumer exports (firebase projectType)
    this.functions = {};
    // { app, server } once a custom-server backend is listening
    this.server = null;

    // A consumer's own Cloud Function runs a request through the pipeline as the
    // named route: `https.onRequest((req, res) => omega.routes.run('items', { req, res }))`.
    // `options` are the pipeline options (pipeline.js resolveOptions); a payload
    // missing req or res is a programmer error, thrown by name.
    this.routes = { run: (name, { req, res } = {}, options) => {
      if (!req || !res) { throw new Error(`[@omega.js/backend:index] omega.routes.run('${name}', { req, res }) needs both req and res`); }
      return pipeline.run(this, name, req, res, options);
    } };

    // A consumer's own trigger runs its handler through the framework:
    // `.onCreate((user, context) => omega.events.run('users/on-create', { user, context }))`.
    // A relative name loads `${cwd}/events/<name>.js`; a leading `/` is verbatim.
    this.events = { run: (name, payload) => events.run(this, name, payload) };
  }

  /**
   * Boot the backend. Synchronous; returns the instance.
   * @param {object} [options] - projectType, resourceZone, sentry, reportErrorsInDev,
   *   firebaseConfig, serviceAccountPath, checkNodeVersion, uniqueAppName, cwd, projectPackageDirectory,
   *   logSavePath, express.bodyParser, identity, useFirebaseLogger, ctx, runnerHost
   * @returns {Omega} the instance.
   */
  initialize(options = {}) {
    // A runner host (the test runner) has already initialized firebase-admin and is
    // no Functions runtime: the Firebase init, the function wiring, the custom
    // server and Sentry stay off
    options.runnerHost = typeof options.runnerHost === 'undefined' ? false : options.runnerHost;
    options.identity = typeof options.identity === 'undefined' ? true : options.identity;
    options.resourceZone = typeof options.resourceZone === 'undefined' ? FUNCTIONS_REGION : options.resourceZone;
    options.sentry = typeof options.sentry === 'undefined' ? !options.runnerHost : options.sentry;
    options.reportErrorsInDev = typeof options.reportErrorsInDev === 'undefined' ? false : options.reportErrorsInDev;
    options.useFirebaseLogger = typeof options.useFirebaseLogger === 'undefined' ? true : options.useFirebaseLogger;
    options.serviceAccountPath = typeof options.serviceAccountPath === 'undefined' ? 'service-account.json' : options.serviceAccountPath;
    options.checkNodeVersion = typeof options.checkNodeVersion === 'undefined' ? true : options.checkNodeVersion;
    options.uniqueAppName = options.uniqueAppName || undefined;
    options.ctx = options.ctx || {};
    options.cwd = typeof options.cwd === 'undefined' ? process.cwd() : options.cwd;
    options.logSavePath = typeof options.logSavePath === 'undefined' ? false : options.logSavePath;
    options.express = options.express || {};
    options.express.bodyParser = options.express.bodyParser || {};
    options.express.bodyParser.json = options.express.bodyParser.json || { limit: '100kb' };
    options.express.bodyParser.urlencoded = options.express.bodyParser.urlencoded || { limit: '100kb', extended: true };

    this.options = options;
    this.cwd = options.cwd;
    this.env = env;
    this.project = options.firebaseConfig || JSON.parse(process.env.FIREBASE_CONFIG || '{}');
    this.project.resourceZone = options.resourceZone;
    this.project.serviceAccountPath = path.resolve(this.cwd, options.serviceAccountPath);
    this.package = resolveProjectPackage(options.projectPackageDirectory || this.cwd);

    // Resolve the .env cascade from the functions dir (functions/.env rides the
    // deploy artifact; the brand/company layers exist only in local dev)
    try {
      loadEnv(this.cwd);
    } catch (e) {
      throw new Error(`Failed to set up environment variables from .env file: ${e.message}`, { cause: e });
    }

    // The environment's ONE input, resolved ONCE per process (#817); a deploy that
    // named its own environment already set it, and it is left as it is
    if (!process.env.OMEGA_ENVIRONMENT) {
      environment.setEnvironment(envEnvironment());
    }

    // The consumer's config/omega.json5 over the framework defaults; none means
    // defaults only, and an advisory env guard below (the framework fixture, #581)
    const configDefaults = loadConfig(TEMPLATES_DIR, 'backend').config;
    delete configDefaults.targets;

    const hasConsumerConfig = hasOmegaConfig(this.cwd);

    if (hasConsumerConfig) {
      const { config, errors } = loadConfig(this.cwd, 'backend', { defaults: configDefaults });
      this.config = config;

      // Boot warns on schema findings; audit (the target checks) throws
      if (errors.length) {
        console.warn(`[@omega.js/backend] config/omega.json5 schema warnings:\n${formatErrors(errors)}`);
      }
    } else {
      this.config = configDefaults;
    }

    // How this backend RUNS (#584): Cloud Functions, or the same app on PORT.
    // The brand's `targets.backend.projectType` decides; an explicit option wins.
    // firebase-functions loads only for the mode that has functions.
    options.projectType = options.projectType || backendProjectType(this.config);

    this.firebase = {
      admin: require('firebase-admin'),
      app: null,
      functions: options.projectType === 'firebase' ? require('firebase-functions/v1') : null,
    };

    // Config-DERIVED values (#290): `config.resolved.github.repo` and the rest,
    // computed once from @omega.js/config's private recipes
    this.config.resolved = resolvedConfigValues(this.config);

    // The wonderful-log file sink the Context logger also writes to
    this.fileLogger = options.logSavePath
      ? new (require('wonderful-log'))({ console: { enabled: false }, file: { enabled: true, path: options.logSavePath } })
      : null;

    this.sentry = null;

    // Every REQUIRED env key (#581): a brand's backend refuses to boot without one,
    // in every environment; advisory only without a consumer config
    try {
      env.assertRequired('backend');
    } catch (e) {
      if (!env.guardIsAdvisory({ hasConsumerConfig })) { throw e; }
      console.warn(`[@omega.js/backend:index] ${e.message}`);
    }

    // The keys this brand's OWN config made mandatory (#626): production refuses,
    // every other environment warns (a half-configured local loop is normal)
    try {
      env.assertRules(this.config, 'backend');
    } catch (e) {
      if (this.getEnvironment() === 'production') { throw e; }
      console.warn(`[@omega.js/backend:index] ${e.message}`);
    }

    // The process services, built once. Utilities first: the Context id and the
    // User generators read it.
    this.utilities = new Utilities(this);
    new UserService(this);
    this.#storage = new Storage(this);
    this.logger = new Context(this, {}, options.ctx);
    this.email = new Email(this.logger);
    this.ai = new AI(this.logger);

    this.project.functionsUrl = this.getFunctionsUrl();
    this.project.apiUrl = this.getApiUrl();
    this.project.websiteUrl = this.getWebsiteUrl();

    process.env.ENVIRONMENT = process.env.ENVIRONMENT || this.getEnvironment();
    process.env.OMEGA_FUNCTIONS_URL = this.project.functionsUrl;
    process.env.OMEGA_API_URL = this.project.apiUrl;
    process.env.OMEGA_WEBSITE_URL = this.project.websiteUrl;

    // The Firebase logger compat shim, in production only: it routes console to
    // Cloud Logging's structured logger, which local runs have no use for
    if (process.env.GCLOUD_PROJECT && this.isProduction() && options.useFirebaseLogger) {
      require('firebase-functions/logger/compat');
    }

    // The test environment: the banner once per process (silent under the
    // emulator, see isUnderEmulator), and the test-mode file watcher that lets
    // the test command flip env vars on the running emulator
    if (this.isTesting()) {
      if (!isUnderEmulator() && !testBannerLogged) {
        testBannerLogged = true;
        this.logger.log('⚠️⚠️⚠️ Running in TEST environment, some features may be disabled ⚠️⚠️⚠️');
      }

      watchTestMode(path.dirname(this.cwd), this.logger, { quiet: isUnderEmulator() });
    }

    if (this.isDevelopment()) {
      const version = require('wonderful-version');
      const nodeUsing = version.major(process.versions.node);
      const nodeRequired = version.major(this.package?.engines?.node || '0.0.0');

      // firebase-tools overwrites console.log under the emulator, so it goes to stderr
      // https://stackoverflow.com/questions/56026747/firebase-console-log-on-localhost
      if (process.env.GCLOUD_PROJECT) {
        const logFix = (...args) => console.error(...args);
        console.log = logFix;
        console.info = logFix;
      }

      // Refuse an unsupported Node.js version (checkNodeVersion: false only logs it)
      if (version.is(nodeUsing, '<', nodeRequired)) {
        const msg = `Node.js version mismatch: using ${nodeUsing} but asked for ${nodeRequired}`;
        if (options.checkNodeVersion) {
          this.logger.error(new Error(msg));
          return process.exit(1);
        }
        this.logger.log(msg);
      }
    }

    const brandId = this.config.brand?.id;

    if (!brandId) {
      this.logger.warn('⚠️ Missing config.brand.id');
    }

    // Sentry: @omega.js/monitoring owns the policy (#380); `sentry` is the ONE
    // capture handle (null when off)
    if (options.sentry) {
      this.sentry = require('@omega.js/monitoring/node').initialize({
        config:       this.config.monitoring,
        release:      { id: brandId || this.project.projectId, version: this.package.version },
        isProduction: this.isProduction(),
        allowInDev:   options.reportErrorsInDev,
        // Read at capture time: one process serves many invocations
        tags: () => ({
          'function.name': this.logger.meta.name,
          'function.type': this.logger.meta.type,
          'environment':   this.getEnvironment(),
        }),
      });
    }

    if (!options.runnerHost) {
      this.#initializeFirebase(options);

      if (options.projectType === 'firebase') {
        this.#wireFunctions(options);
      }

      if (options.projectType === 'custom') {
        this.#startServer(options);
      }
    }

    // The boot event, as the server itself
    this.logger.analytics.forUser(Analytics.SERVER_UUID).event('admin/initialized', {});

    return this;
  }

  // Firebase Admin: a managed runtime (ADC, Cloud Functions/Run, the emulator) uses its
  // own identity; a staged service-account.json is ONLY for local scripts
  #initializeFirebase(options) {
    const admin = this.firebase.admin;
    const onCloudRuntime = !!process.env.K_SERVICE || !!process.env.FUNCTION_TARGET;

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS || onCloudRuntime || isUnderEmulator()) {
      this.firebase.app = admin.initializeApp();
      return;
    }

    const serviceAccount = require(this.project.serviceAccountPath);
    const loadedProjectId = serviceAccount.project_id;
    const expectedProjectId = this.project.projectId;

    // A cert for the wrong project fails every Firestore call far from the cause,
    // so boot refuses: project id to project id, EXACTLY (a brand id is not one)
    if (expectedProjectId && loadedProjectId !== expectedProjectId) {
      throw new Error(`Service account project mismatch: ${loadedProjectId} is not ${expectedProjectId} — fix ${this.project.serviceAccountPath}`);
    }

    this.firebase.app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: this.project.databaseURL || `https://${this.project.projectId}.firebaseio.com`,
    }, options.uniqueAppName);
  }

  // The Cloud Functions map: omega_api (every route and the MCP endpoint), the
  // auth and Firestore triggers, and the two cron schedules
  #wireFunctions(options) {
    const functions = this.functions;
    const fn = (runtimeOptions) => this.firebase.functions.runWith(runtimeOptions).region(options.resourceZone);
    const event = (file, payload) => events.run(this, `${EVENTS_DIR}/${file}`, payload);

    functions.omega_api = fn({memory: '256MB', timeoutSeconds: 60 * 5})
      .https.onRequest(async (req, res) => router.dispatch(this, req, res));

    // The blocking identity triggers (the `identity` option opts out)
    if (options.identity) {
      functions.omega_authBeforeCreate = fn({memory: '256MB', timeoutSeconds: 60})
        .auth.user()
        .beforeCreate((user, context) => event('auth/before-create.js', { user, context }));

      functions.omega_authBeforeSignIn = fn({memory: '256MB', timeoutSeconds: 60})
        .auth.user()
        .beforeSignIn((user, context) => event('auth/before-signin.js', { user, context }));
    }

    functions.omega_authOnCreate = fn({memory: '256MB', timeoutSeconds: 60})
      .auth.user()
      .onCreate((user, context) => event('auth/on-create.js', { user, context }));

    functions.omega_authOnDelete = fn({memory: '256MB', timeoutSeconds: 60})
      .auth.user()
      .onDelete((user, context) => event('auth/on-delete.js', { user, context }));

    functions.omega_notificationsOnWrite = fn({memory: '256MB', timeoutSeconds: 60})
      .firestore.document('notifications/{token}')
      .onWrite((change, context) => event('firestore/notifications/on-write.js', { change, context }));

    functions.omega_paymentsWebhookOnWrite = fn({memory: '256MB', timeoutSeconds: 60})
      .firestore.document('payments-webhooks/{eventId}')
      .onWrite((change, context) => event('firestore/payments-webhooks/on-write.js', { change, context }));

    functions.omega_paymentsDisputeOnWrite = fn({memory: '256MB', timeoutSeconds: 60})
      .firestore.document('payments-disputes/{alertId}')
      .onWrite((change, context) => event('firestore/payments-disputes/on-write.js', { change, context }));

    functions.omega_cronDaily = fn({memory: '256MB', timeoutSeconds: 60 * 5})
      .pubsub.schedule('0 0 * * *')
      .timeZone('Etc/UTC')
      .onRun((context) => events.run(this, `${CRON_DIR}/daily.js`, { context }));

    // Frequent cron runs the inline newsletter generator (AI structure + section
    // images + article + uploads), so it needs the v1 max timeout. A run that
    // times out or OOMs is retried safely by the campaign lease reclaim.
    functions.omega_cronFrequent = fn({memory: '256MB', timeoutSeconds: 540})
      .pubsub.schedule('*/10 * * * *')
      .onRun((context) => events.run(this, `${CRON_DIR}/frequent.js`, { context }));
  }

  // Custom-server mode (#584): the same routes on an express app listening on PORT
  #startServer(options) {
    require('./server.js').start(this, options);
  }

  // A named local JSON store (services/storage.js), memoized per name
  storage(options) {
    return this.#storage.get(options);
  }

  // The framework's own module context: a brand cannot resolve its dependencies
  require(name) {
    return require(name);
  }

  // The environment: @omega.js/config's ONE implementation (#817), reading the
  // OMEGA_ENVIRONMENT initialize() resolved. Exactly one is*() is true:
  // isDevelopment() is NOT true in testing, and isProduction() is a real
  // positive check, never `!isDevelopment()`.
  getEnvironment() {
    return environment.getEnvironment();
  }

  isDevelopment() {
    return environment.isDevelopment();
  }

  isProduction() {
    return environment.isProduction();
  }

  isTesting() {
    return environment.isTesting();
  }

  getFunctionsUrl(env) {
    return isLocal(this, env)
      ? `http://localhost:${devPort('functions')}/${this.project.projectId}/${this.project.resourceZone}`
      : `https://${this.project.resourceZone}-${this.project.projectId}.cloudfunctions.net`;
  }

  getApiUrl(env) {
    if (isLocal(this, env)) {
      const httpsPort = envPort('https');
      return httpsPort
        ? `https://localhost:${httpsPort}`
        : `http://localhost:${devPort('hosting')}`;
    }
    return apiAddress(this.config.brand?.url || '', this.project.projectId, this.project.resourceZone);
  }

  getWebsiteUrl(env) {
    // The scheme follows the local https stack: ONE mkcert install fronts backend
    // AND web dev, so this process's proxy presence (OMEGA_HTTPS_PORT) is the
    // honest signal for the website's scheme too
    const websiteScheme = envPort('https') ? 'https' : 'http';
    return isLocal(this, env)
      ? `${websiteScheme}://localhost:${devPort('website')}`
      : this.config.brand?.url || '';
  }

  // The parent's website URL (#677): the RESOLVED company IS the topology, so a
  // brand with a company resolves the parent's url, and one without (or
  // `company: { id: 'self' }`) its own. No `api.` subdomain.
  getParentUrl() {
    return this.config.company?.url || this.config.brand?.url || '';
  }

  // The parent's API URL (its `apiAddress`), ALWAYS the live one, in every
  // environment of this brand. Only a brand that IS its parent knows the
  // parent's project id here, so a sub-brand's Pages-hosted parent answers ''.
  getParentApiUrl() {
    return apiAddress(this.getParentUrl(), this.isParent() ? this.project.projectId : undefined, this.project.resourceZone);
  }

  // Whether this backend IS the webhook root: the brand names no company, or
  // names itself as one (#677). Gates parent-only routes.
  isParent() {
    const id = this.config.company?.id;
    return !id || id === 'self';
  }
}

// The ONE instance, initialized by the consumer's src/index.js
const omega = new Omega();

module.exports = omega;
module.exports.Omega = Omega;
