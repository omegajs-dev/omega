/**
 * Test: the per-IP daily signup cap, targets.backend.auth.signup.maxPerIpPerDay.
 * Its default has one home, the config schema, which resolves it and never
 * writes it into a brand file. Run: npx omega test backend:events/auth-signup-limit
 */
const path = require('path');
const jetpack = require('fs-jetpack');
const { loadConfig, missingDefaults } = require('../helpers/_shared-config.js');
const { writeJson } = require('../../dist/vendor/devkit/write-json.js');
const { resolveSignupLimit } = require('../../dist/omega/events/auth/utils.js');
const { loadHandler } = require('../../dist/omega/libraries/load-handler.js');
const beforeCreate = loadHandler(require.resolve('../../dist/omega/events/auth/before-create.js'));
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

/**
 * A brand on disk with a backend target, its own file holding `targetsBackend`,
 * loaded through the real backend loader. Hands back the resolved config and
 * the heal list the manage walk would write into the brand's file.
 */
function loadBrand(targetsBackend) {
  const root = jetpack.tmpDir({ prefix: 'omega-signup-limit-' }).path();
  const brandFile = {
    brand: { id: 'acme', name: 'Acme', url: 'https://acme.test' },
    targets: { backend: { type: 'backend', ...targetsBackend } },
  };

  writeJson(path.join(root, 'config', 'omega.json5'), brandFile);

  try {
    return {
      config: loadConfig(root, 'backend', { record: false }).config,
      heal: missingDefaults(brandFile, 'backend'),
    };
  } finally {
    jetpack.remove(root);
  }
}

// A signup event driven straight through the REAL before-create, with ONE seam:
// what the usage counter does when the gate calls it. That is the whole subject
// — whether a failure that is not a rate limit is still SOLD as one.
class HttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HttpsError';
    this.code = code;
  }
}

function runBeforeCreate(consume) {
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));

  const counter = {
    configure: () => counter,
    forKey: () => counter,
    consume: consume,
  };

  const omega = { config: { auth: { signup: { maxPerIpPerDay: 2 } } }, firebase: { functions: { auth: { HttpsError } } } };

  const ctx = {
    usage: counter,
    log: record,
    debug: record,
    warn: record,
    error: record,
    report: (e, options) => {
      const error = e instanceof Error ? e : new Error(e);
      error.code = (options || {}).code || 500;
      return error;
    },
  };

  return beforeCreate({
    ctx,
    omega,
    user: { uid: 'user-647', email: 'someone@example.com' },
    context: { ipAddress: '203.0.113.7' },
  });
}

module.exports = defineCases({
  description: 'resolveSignupLimit(): per-IP daily signup cap from config',
  type: 'group',

  tests: [
    {
      name: 'a-brand-that-sets-the-cap-gets-it',
      auth: 'none',

      async run({ expect }) {
        const { config } = loadBrand({ auth: { signup: { maxPerIpPerDay: 5 } } });

        expect(resolveSignupLimit(config), 'the brand\'s own cap is the limit').toBe(5);
      },
    },

    {
      name: 'no-cap-set-is-the-schema-default-and-no-brand-file-gains-it',
      auth: 'none',

      async run({ expect }) {
        const { config, heal } = loadBrand({});

        expect(config.auth?.signup?.maxPerIpPerDay, 'the schema default resolves into the loaded config').toBe(2);
        expect(resolveSignupLimit(config), 'the limit is the value the config carries').toBe(2);
        expect(JSON.stringify(heal).includes('maxPerIpPerDay'), `the manage heal never writes the cap into a brand file: ${JSON.stringify(heal)}`).toBe(false);
      },
    },

    {
      name: 'configured-value-wins',
      auth: 'none',

      async run({ expect }) {
        expect(resolveSignupLimit({ auth: { signup: { maxPerIpPerDay: 25 } } })).toBe(25);
        expect(resolveSignupLimit({ auth: { signup: { maxPerIpPerDay: 1 } } })).toBe(1);
      },
    },

    // The gate's catch used to swallow EVERYTHING consume() could throw. A
    // Firestore outage, a programmer error, a 500 of any kind came back to the
    // caller as "too many signups from this IP" — a diagnosis nobody could act
    // on, and one that quietly told a legitimate user to wait a day.
    {
      name: 'a failure that is not a rate limit is never sold as one',
      auth: 'none',

      async run({ expect, ctx }) {
        const boom = Object.assign(new Error('Firestore unavailable'), { code: 500 });

        const thrown = await runBeforeCreate(async () => { throw boom; }).catch((e) => e);

        expect(thrown, 'the original error propagates untouched').toBe(boom);
        expect(thrown.name, 'not converted into an auth HttpsError').toBe('Error');
      },
    },

    {
      name: 'a real 429 still blocks the signup as resource-exhausted',
      auth: 'none',

      async run({ expect }) {
        const refusal = Object.assign(new Error('You have used all 2 of your signups'), { code: 429 });

        const thrown = await runBeforeCreate(async () => { throw refusal; }).catch((e) => e);

        expect(thrown.name, 'a rate limit is the one thing this catch is for').toBe('HttpsError');
        expect(thrown.code).toBe('resource-exhausted');
      },
    },
  ],
});
