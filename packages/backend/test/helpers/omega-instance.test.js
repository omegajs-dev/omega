/**
 * Test: the package's main export, the Omega instance, and what initialize()
 * leaves on it
 *
 * The consumer contract is one line and one export:
 *
 *   const omega = require('@omega.js/backend'); omega.initialize({ ... });
 *   module.exports = omega.functions;
 *
 * so what this file pins is exactly what a consumer leans on: the main export
 * IS the instance (a consumer never writes `new`), initialize() is synchronous
 * and hands the instance back, the instance carries the core and the process
 * services, `User` mints its ids with the backend's generators once booted,
 * and the request pipeline is one ordered list of named steps.
 *
 * Every boot is a FRESH `new Omega()` against the bundled fixture (with
 * `runnerHost`, as the runner boots), never the singleton, so the file runs
 * with or without an emulator and never disturbs the runner's instance. The
 * one full boot (no `runnerHost`) signs in with a generated service account
 * under its own app name, so it never touches the runner's default app.
 *
 * Run: npx omega test backend:helpers/omega-instance
 */
const crypto = require('node:crypto');
const path = require('node:path');
const jetpack = require('fs-jetpack');
const expect = require('../../dist/vendor/devkit/test/expect.js');
const omega = require('../../dist/omega/index.js');
const pipeline = require('../../dist/omega/pipeline.js');
const { User } = require('../../dist/omega/helpers/account.js');
const { bootOmega } = require('./_boot-omega.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RANDOM_ID_8 = /^[A-Za-z0-9]{8}$/;
const API_KEY = /^[A-Za-z0-9]{40,50}$/;

const FULL_BOOT_APP = 'omega-instance-full-boot';
// The env that sends the Firebase init to the managed-runtime branch instead of the service account.
const RUNTIME_ENV = ['GOOGLE_APPLICATION_CREDENTIALS', 'K_SERVICE', 'FUNCTION_TARGET', 'FUNCTIONS_EMULATOR'];

let booted = null;
const fresh = () => (booted = booted || bootOmega());

// Boot a fresh instance the way bootOmega does, with these options laid over its own.
function bootWith(overrides) {
  const instance = new omega.Omega();
  instance.initialize = (options) => omega.Omega.prototype.initialize.call(instance, { ...options, ...overrides });
  return bootOmega(instance);
}

// The boot a deployed function gets: no runnerHost, signed in with a generated service account.
function bootFull(dir) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const projectId = JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId || 'demo-omega-instance';
  const serviceAccountPath = path.join(dir, 'service-account.json');
  jetpack.write(serviceAccountPath, { project_id: projectId, private_key: privateKey, client_email: `boot@${projectId}.iam.gserviceaccount.com` });

  const saved = RUNTIME_ENV.map((key) => [key, process.env[key]]);
  RUNTIME_ENV.forEach((key) => delete process.env[key]);

  try {
    return bootWith({ runnerHost: false, serviceAccountPath, uniqueAppName: FULL_BOOT_APP });
  } finally {
    saved.filter(([, value]) => value !== undefined).forEach(([key, value]) => { process.env[key] = value; });
  }
}

module.exports = defineCases({
  description: 'the Omega instance: the export, initialize(), the members, the generators, the pipeline',
  type: 'group',

  tests: [
    {
      name: 'the-main-export-is-the-instance-and-Omega-its-constructor',
      async run() {
        expect(typeof omega.Omega, 'the class rides the export by name').toBe('function');
        expect(omega instanceof omega.Omega, 'the export is an instance of it').toBe(true);
        expect(omega.constructor).toBe(omega.Omega);
        expect(typeof omega.initialize).toBe('function');
      },
    },

    {
      name: 'initialize-is-synchronous-and-returns-the-instance',
      async run() {
        const instance = new omega.Omega();
        const returned = bootOmega(instance);

        expect(returned, 'initialize() hands the same instance back').toBe(instance);
        expect(typeof returned.then, 'and not a promise: Firebase reads the exports at module load').toBe('undefined');
      },
    },

    {
      name: 'the-booted-instance-carries-the-core-and-the-process-services',
      async run() {
        const instance = fresh();
        const members = ['config', 'env', 'logger', 'version', 'cwd', 'project', 'package', 'firebase', 'functions', 'handlers', 'utilities', 'email', 'ai'];

        for (const member of members) {
          expect(instance[member], `omega.${member} is set`).not.toBe(undefined);
        }

        expect(typeof instance.storage, 'omega.storage(options) is a method').toBe('function');
        expect(typeof instance.routes.run, 'omega.routes.run(name, { req, res }, options) is the route entry').toBe('function');
        expect(typeof instance.events.run, 'omega.events.run(name, payload) is the event entry').toBe('function');
        expect(typeof instance.config.resolved, 'config.resolved rides the config').toBe('object');
        expect(typeof instance.firebase.admin.initializeApp, 'firebase.admin is the Admin SDK').toBe('function');
        expect('app' in instance.firebase, 'firebase.app is declared').toBe(true);
        expect(typeof instance.firebase.functions.runWith, 'firebase.functions is the SDK in firebase mode').toBe('function');
        expect(Object.keys(instance.functions), 'the test runner wires no Cloud Functions').toEqual([]);
      },
    },

    {
      name: 'case-119-runnerHost-skips-the-wiring-and-sentry-and-without-it-the-functions-are-wired',
      timeout: 10000,
      async run() {
        const hosted = bootWith({ runnerHost: true });

        expect(Object.keys(hosted.functions), 'runnerHost wires no Cloud Functions').toEqual([]);
        expect(hosted.options.sentry, 'runnerHost defaults sentry off').toBe(false);
        expect(hosted.sentry, 'and starts no Sentry').toBe(null);
        expect(hosted.firebase.app, 'runnerHost skips the Firebase init').toBe(null);

        const dir = jetpack.tmpDir({ prefix: 'omega-instance-boot-' }).path();
        let full = null;

        try {
          full = bootFull(dir);

          expect(Object.keys(full.functions), 'the full boot wires the Cloud Functions').toContain('omega_api');
          expect(full.options.sentry, 'and leaves sentry on by default').toBe(true);
          expect(full.firebase.app.name, 'and runs the Firebase init').toBe(FULL_BOOT_APP);
        } finally {
          if (full && full.firebase.app) await full.firebase.app.delete();
          jetpack.remove(dir);
        }
      },
    },

    {
      name: 'the-retired-surface-is-gone',
      async run() {
        const instance = fresh();

        for (const member of ['libraries', '_internal', 'interface', 'install', 'debug', 'init', 'RouteContext', 'Middleware', 'Utilities', 'User', 'Email', 'AI']) {
          expect(instance[member], `omega.${member} is retired`).toBe(undefined);
        }

        expect(instance.run, 'omega.run is omega.routes.run now, no alias').toBe(undefined);
        expect(instance.runEvent, 'omega.runEvent is omega.events.run now, no alias').toBe(undefined);
        expect(omega.Omega.config, 'no static config').toBe(undefined);
        expect(omega.Omega.require, 'no static require: omega.require is the one').toBe(undefined);
        expect(typeof instance.require).toBe('function');
      },
    },

    {
      name: 'routes-run-hands-the-payload-req-and-res-to-the-pipeline',
      async run() {
        const instance = fresh();
        const req = { path: '/items' };
        const res = {};
        const original = pipeline.run;
        let received = null;

        // The pipeline module is the one the instance calls through, so its run
        // is swapped for the call only and restored after
        pipeline.run = (...args) => { received = args; return 'piped'; };

        try {
          const returned = instance.routes.run('items', { req, res }, { validate: false });

          expect(returned, 'the pipeline\'s answer comes back').toBe('piped');
          expect(received, 'the instance, the name, the payload\'s req and res, the options').toEqual([instance, 'items', req, res, { validate: false }]);
          expect(received[2], 'the same req').toBe(req);
          expect(received[3], 'the same res').toBe(res);
        } finally {
          pipeline.run = original;
        }

        expect(() => instance.routes.run('items', { req }), 'a missing res throws by name').toThrow(/omega\.routes\.run\('items', \{ req, res \}\) needs both req and res/);
        expect(() => instance.routes.run('items'), 'and so does a missing payload').toThrow(/needs both req and res/);
      },
    },

    {
      name: 'User-mints-ids-with-the-backend-generators-once-booted',
      async run() {
        fresh();

        const { uuid, randomId, apiKey } = User.generators;

        expect(uuid(), 'uuid is a v4 uuid').toMatch(UUID_V4);
        expect(randomId(), 'randomId is an 8-char alphanumeric id').toMatch(RANDOM_ID_8);
        expect(apiKey(), 'apiKey is a uid-generator token').toMatch(API_KEY);

        const user = new User();

        expect(user.api.clientId, 'a new account mints its clientId').toMatch(UUID_V4);
        expect(user.api.privateKey, 'and its privateKey').toMatch(API_KEY);
      },
    },

    {
      name: 'the-pipeline-is-one-ordered-list-of-named-steps',
      async run() {
        expect(pipeline.STEPS.map((step) => step.name)).toEqual([
          'guardRoutePath',
          'guardDevOnly',
          'resolveOptions',
          'parseMultipart',
          'logRequest',
          'wakeup',
          'loadHandler',
          'authenticate',
          'attachUsage',
          'logUser',
          'attachAnalytics',
          'resolveData',
          'trim',
          'sanitize',
          'runHandler',
        ]);
      },
    },

    {
      name: 'getApiUrl-on-a-default-Pages-host-is-the-project-functions-address',
      async run() {
        const instance = bootOmega();
        instance.config.brand.url = 'https://ian.github.io/site';
        instance.project.projectId = 'omegajs-playground';

        expect(instance.getApiUrl('production')).toBe('https://us-central1-omegajs-playground.cloudfunctions.net/omega_api');
      },
    },

    {
      name: 'getParentApiUrl-of-a-Pages-company-with-no-project-id-is-empty',
      async run() {
        const instance = bootOmega();
        instance.config.company = { ...instance.config.company, id: 'ian-co', url: 'https://ian.github.io/ian-co-web' };

        expect(instance.getParentApiUrl(), 'never api.ian.github.io, a host nobody serves').toBe('');
      },
    },
  ],
});
