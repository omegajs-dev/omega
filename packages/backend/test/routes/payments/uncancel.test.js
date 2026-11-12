/**
 * Test: POST /payments/uncancel — guards and the per-provider capability gate
 * ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
 *
 * Uncancel is an OWNED route next to cancel, cross-provider and capability-gated:
 * a provider that can resume a subscription EXPORTS `uncancel`, one that cannot
 * simply lacks the export, and the route refuses BEFORE dispatch rather than
 * letting the caller discover it as a provider error.
 *
 * Two layers:
 *  - the route, called directly against a real ctx (the _route-harness technique),
 *    so one test can choose a provider and a subscription shape without minting a
 *    persona per permutation;
 *  - the provider modules themselves, asserted as a capability TABLE — the export
 *    list IS the contract the route reads.
 *
 * The full end-to-end pipeline run lives in
 * test/events/payments/journey-payments-uncancel.test.js.
 *
 * Run: npx omega test framework:routes/payments/uncancel
 */
const { buildUser, callHandler, recordingResponse, withEnvironment } = require('./_route-harness.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/uncancel/post.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');
const Context = require('../../../dist/omega/context.js');

const PROVIDERS = ['stripe', 'chargebee', 'paypal', 'test'];

function providerModule(name) {
  return require(`../../../dist/omega/routes/payments/uncancel/providers/${name}.js`);
}

// A subscriber whose cancellation is scheduled — the one state uncancel accepts.
function pendingSubscriber(omega, { uid, provider, status, pending, productId, resourceId }) {
  const lastYearUNIX = Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60);

  return buildUser({
    auth: { uid: uid, email: `${uid}@example.com` },
    roles: {},
    subscription: {
      product: { id: productId === undefined ? 'premium' : productId, name: 'Premium' },
      status: status || 'active',
      cancellation: { pending: pending === undefined ? true : pending },
      payment: {
        provider: provider === undefined ? 'test' : provider,
        resourceId: resourceId === undefined ? 'sub_test_uncancel_guard' : resourceId,
        frequency: 'monthly',
        startDate: { timestamp: new Date(lastYearUNIX * 1000).toISOString(), timestampUNIX: lastYearUNIX },
      },
    },
  });
}

function uncancel(omega, user, settings) {
  return callHandler({
    omega,
    handler,
    functionName: 'payments-uncancel',
    user,
    data: { confirmed: true, ...(settings || {}) },
  });
}

/**
 * The same direct call, with the `omega-properties` header captured.
 *
 * The shared harness's recorder implements express's `res.set()`; the assistant
 * writes that header through `res.header()`/`res.get()`, so a test that needs to
 * READ the structured half of a response lends the SAME recorder those two
 * methods rather than inventing a second response shape.
 *
 * @returns {Promise<{ sent: object, properties: object|null }>}
 */
async function uncancelReadingProperties(omega, user) {
  const res = recordingResponse();
  const headers = {};

  res.header = (key, value) => {
    headers[key] = value;
    return res;
  };
  res.get = (key) => headers[key];

  const req = { method: 'POST', headers: { 'content-type': 'application/json' }, query: {}, body: {} };
  const ctx = new Context(omega, { req, res }, { functionName: 'payments-uncancel' });

  await handler({ ctx, omega, user, data: { confirmed: true } });

  return {
    sent: res.sent,
    properties: headers['omega-properties'] ? JSON.parse(headers['omega-properties']) : null,
  };
}

module.exports = defineCases({
  description: 'Payment uncancel endpoint: guards + provider capability gate',
  type: 'group',
  timeout: 15000,

  tests: [
    // ─── the wire guards ───

    {
      name: 'rejects-unauthenticated',
      async run({ http, expect }) {
        const response = await http.as('none').post('omega/payments/uncancel', {
          confirmed: true,
        });

        expect(response, 'Should reject unauthenticated request').toBeError(401);
      },
    },

    {
      name: 'rejects-missing-confirmed',
      async run({ http, expect }) {
        const response = await http.as('basic').post('omega/payments/uncancel', {});

        expect(response, 'Should reject a request that never confirmed').toBeError(400);
      },
    },

    // ─── the subscription-state guards ───

    {
      name: 'rejects-unconfirmed',
      auth: 'none',
      async run({ expect, omega }) {
        const user = pendingSubscriber(omega, { uid: '_test-uncancel-unconfirmed' });

        const sent = await uncancel(omega, user, { confirmed: false });

        expect(sent.code, `An unconfirmed uncancel must be refused, got ${sent.code}`).toBe(400);
      },
    },

    {
      name: 'rejects-basic-user',
      auth: 'none',
      async run({ expect, omega }) {
        const user = pendingSubscriber(omega, { uid: '_test-uncancel-basic', productId: 'basic' });

        const sent = await uncancel(omega, user);

        expect(sent.code, `A free user has no cancellation to undo, got ${sent.code}`).toBe(400);
      },
    },

    {
      name: 'rejects-no-pending-cancellation',
      auth: 'none',
      async run({ expect, omega }) {
        const user = pendingSubscriber(omega, { uid: '_test-uncancel-not-pending', pending: false });

        const sent = await uncancel(omega, user);

        expect(sent.code, `Nothing is scheduled, so there is nothing to resume, got ${sent.code}`).toBe(400);
        expect(`${sent.body}`, `Expected the no-pending-cancellation message, got: ${sent.body}`).toMatch(/not scheduled to cancel/i);
      },
    },

    {
      name: 'rejects-a-subscription-that-is-no-longer-active',
      auth: 'none',
      async run({ expect, omega }) {
        // A suspended (or fully cancelled) subscription cannot be resumed by
        // clearing a scheduled cancellation — the term is already broken.
        const user = pendingSubscriber(omega, { uid: '_test-uncancel-suspended', status: 'suspended' });

        const sent = await uncancel(omega, user);

        expect(sent.code, `Only an ACTIVE subscription can be resumed, got ${sent.code}`).toBe(400);
      },
    },

    {
      name: 'rejects-missing-payment-details',
      auth: 'none',
      async run({ expect, omega }) {
        const user = pendingSubscriber(omega, { uid: '_test-uncancel-no-provider', provider: null, resourceId: null });

        const sent = await uncancel(omega, user);

        expect(sent.code, `Without a provider there is nothing to call, got ${sent.code}`).toBe(400);
      },
    },

    {
      name: 'rejects-unknown-provider',
      auth: 'none',
      async run({ expect, omega }) {
        const user = pendingSubscriber(omega, { uid: '_test-uncancel-unknown', provider: 'unknown-provider' });

        const sent = await uncancel(omega, user);

        expect(sent.code, `An unknown provider must be refused, got ${sent.code}`).toBe(400);
      },
    },

    // ─── the capability gate ───

    {
      name: 'paypal-is-gated-before-any-api-call',
      auth: 'none',
      async run({ expect, omega }) {
        const user = pendingSubscriber(omega, { uid: '_test-uncancel-paypal', provider: 'paypal', resourceId: 'I-TESTUNCANCEL' });

        // PayPal's credential is stripped: ANY attempt to reach PayPal would
        // throw inside the client and surface as a 500. A 400 is therefore proof
        // the route refused BEFORE dispatch — no network dependency at all.
        // Only the SECRET is an env key now (#893): the public client id is
        // config, which a route test never rewrites.
        const sent = await withEnvironment({ PAYPAL_CLIENT_SECRET: null }, () => uncancel(omega, user));

        expect(sent.code, `An unsupported operation is a client fault, not an outage, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(400);
        expect(`${sent.body}`, `The refusal should point at the billing portal, got: ${sent.body}`).toMatch(/billing portal/i);
        expect(!/paypal api/i.test(`${sent.body}`), `No PayPal call may be attempted, got: ${sent.body}`).toBeTruthy();
      },
    },

    {
      name: 'the-gate-carries-a-structured-code',
      auth: 'none',
      async run({ expect, omega }) {
        // The client branches on the code, not on the sentence — so the code
        // rides the response's own properties, where every 4xx carries its
        // machine-readable half.
        const user = pendingSubscriber(omega, { uid: '_test-uncancel-paypal-code', provider: 'paypal', resourceId: 'I-TESTUNCANCEL' });

        const { sent, properties } = await withEnvironment(
          { PAYPAL_CLIENT_SECRET: null },
          () => uncancelReadingProperties(omega, user),
        );

        expect(sent.code, `Expected the capability gate, got ${sent.code}`).toBe(400);
        expect(properties?.additional?.code, `Expected a branchable code on omega-properties, got: ${JSON.stringify(properties?.additional)}`).toBe('not-supported-by-provider');
      },
    },

    // ─── the capability TABLE: the export list IS the contract ───

    {
      name: 'every-provider-module-loads',
      auth: 'none',
      async run({ expect }) {
        PROVIDERS.forEach((name) => {
          expect(providerModule(name), `routes/payments/uncancel/providers/${name}.js should exist so the route can ask it about the operation`).toBeTruthy();
        });
      },
    },

    {
      name: 'stripe-chargebee-and-test-support-uncancel',
      auth: 'none',
      async run({ expect }) {
        ['stripe', 'chargebee', 'test'].forEach((name) => {
          expect(typeof providerModule(name).uncancel, `${name} should export uncancel()`).toBe('function');
        });
      },
    },

    {
      name: 'paypal-ships-no-uncancel-export',
      auth: 'none',
      async run({ expect }) {
        // PayPal's API cannot resume a cancelled subscription — activate only
        // works on a SUSPENDED one. The missing export is the whole gate.
        expect(typeof providerModule('paypal').uncancel, 'paypal must not export uncancel() — its API cannot resume a cancelled subscription').toBe('undefined');
      },
    },
  ],
});
