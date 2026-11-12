/**
 * Test: POST /payments/plan — guards and the per-provider capability gate
 * ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
 *
 * Plan-switch is an OWNED route next to cancel, cross-provider and capability-gated
 * the same way uncancel is: a provider that can move a live subscription between
 * plans EXPORTS `switchPlan`, one that cannot simply lacks the export.
 *
 * The route is called directly against a real ctx (the _route-harness technique),
 * so one test can choose a provider, a product and a frequency without minting a
 * persona per permutation. The full end-to-end pipeline run lives in
 * test/events/payments/journey-payments-plan-switch.test.js.
 *
 * Run: npx omega test framework:routes/payments/plan
 */
const { buildUser, callHandler, recordingResponse } = require('./_route-harness.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/plan/post.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');
const Context = require('../../../dist/omega/context.js');

const PROVIDERS = ['stripe', 'chargebee', 'paypal', 'test'];

function providerModule(name) {
  return require(`../../../dist/omega/routes/payments/plan/providers/${name}.js`);
}

// Two distinct paid subscription products from the brand's own config — the
// switch has no meaning without them, so a brand that lacks a pair skips.
function paidPair(config, skip) {
  const paid = (config.payment?.products || []).filter((p) => p.id !== 'basic' && p.type === 'subscription' && p.prices);

  if (paid.length < 2) {
    skip('Fewer than two paid subscription products configured in this brand');
  }

  return { from: paid[0], to: paid[1] };
}

// A paying subscriber sitting on `product` at `frequency`.
function subscriber(omega, { uid, product, frequency, provider, resourceId, pending }) {
  const lastYearUNIX = Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60);

  return buildUser({
    auth: { uid: uid, email: `${uid}@example.com` },
    roles: {},
    subscription: {
      product: { id: product.id, name: product.name || product.id },
      status: 'active',
      cancellation: { pending: pending === true },
      payment: {
        provider: provider === undefined ? 'test' : provider,
        resourceId: resourceId === undefined ? 'sub_test_plan_guard' : resourceId,
        frequency: frequency,
        startDate: { timestamp: new Date(lastYearUNIX * 1000).toISOString(), timestampUNIX: lastYearUNIX },
      },
    },
  });
}

function switchPlan(omega, user, settings) {
  return callHandler({
    omega,
    handler,
    functionName: 'payments-plan',
    user,
    data: { confirmed: true, ...(settings || {}) },
  });
}

/**
 * The same direct call, with the `omega-properties` header captured — the
 * uncancel suite's technique, for the same reason: the branchable half of a 4xx
 * rides that header, so a test that asserts a CODE has to read it.
 *
 * @returns {Promise<{ sent: object, properties: object|null }>}
 */
async function switchPlanReadingProperties(omega, user, settings) {
  const res = recordingResponse();
  const headers = {};

  res.header = (key, value) => {
    headers[key] = value;
    return res;
  };
  res.get = (key) => headers[key];

  const req = { method: 'POST', headers: { 'content-type': 'application/json' }, query: {}, body: {} };
  const ctx = new Context(omega, { req, res }, { functionName: 'payments-plan' });

  await handler({ ctx, omega, user, data: { confirmed: true, ...(settings || {}) } });

  return {
    sent: res.sent,
    properties: headers['omega-properties'] ? JSON.parse(headers['omega-properties']) : null,
  };
}

// The frequency a product is actually priced at in this brand's config.
function frequencyOf(product) {
  return Object.keys(product.prices)[0];
}

module.exports = defineCases({
  description: 'Payment plan endpoint: guards + provider capability gate',
  type: 'group',
  timeout: 15000,

  tests: [
    // ─── the wire guards ───

    {
      name: 'rejects-unauthenticated',
      async run({ http, expect }) {
        const response = await http.as('none').post('omega/payments/plan', {
          productId: 'premium',
          frequency: 'monthly',
          confirmed: true,
        });

        expect(response, 'Should reject unauthenticated request').toBeError(401);
      },
    },

    {
      name: 'rejects-missing-confirmed',
      async run({ http, expect }) {
        const response = await http.as('basic').post('omega/payments/plan', {
          productId: 'premium',
          frequency: 'monthly',
        });

        expect(response, 'Should reject a request that never confirmed').toBeError(400);
      },
    },

    {
      name: 'rejects-missing-product-id',
      async run({ http, expect }) {
        const response = await http.as('basic').post('omega/payments/plan', {
          confirmed: true,
        });

        expect(response, 'Should reject a switch with no target product').toBeError(400);
      },
    },

    // ─── the subscription-state guards ───

    {
      name: 'rejects-unconfirmed',
      auth: 'none',
      async run({ expect, omega, config, skip }) {
        const { from, to } = paidPair(config, skip);
        const user = subscriber(omega, { uid: '_test-plan-unconfirmed', product: from, frequency: frequencyOf(from) });

        const sent = await switchPlan(omega, user, { confirmed: false, productId: to.id, frequency: frequencyOf(to) });

        expect(sent.code, `An unconfirmed switch must be refused, got ${sent.code}`).toBe(400);
      },
    },

    {
      name: 'rejects-basic-user',
      auth: 'none',
      async run({ expect, omega, config, skip }) {
        const { to } = paidPair(config, skip);
        const user = subscriber(omega, { uid: '_test-plan-basic', product: { id: 'basic', name: 'Basic' }, frequency: null });

        const sent = await switchPlan(omega, user, { productId: to.id, frequency: frequencyOf(to) });

        expect(sent.code, `A free user has no subscription to move, got ${sent.code}`).toBe(400);
      },
    },

    {
      name: 'rejects-a-product-the-brand-does-not-sell',
      auth: 'none',
      async run({ expect, omega, config, skip }) {
        const { from } = paidPair(config, skip);
        const user = subscriber(omega, { uid: '_test-plan-unknown-product', product: from, frequency: frequencyOf(from) });

        const sent = await switchPlan(omega, user, { productId: '_not-a-configured-product', frequency: 'monthly' });

        expect(sent.code, `An unconfigured product must be refused, got ${sent.code}`).toBe(400);
      },
    },

    {
      name: 'rejects-the-plan-the-user-is-already-on',
      auth: 'none',
      async run({ expect, omega, config, skip }) {
        const { from } = paidPair(config, skip);
        const frequency = frequencyOf(from);
        const user = subscriber(omega, { uid: '_test-plan-same', product: from, frequency });

        const sent = await switchPlan(omega, user, { productId: from.id, frequency });

        expect(sent.code, `Switching to the current plan is a no-op, got ${sent.code}`).toBe(400);
        expect(`${sent.body}`, `Expected the same-plan message, got: ${sent.body}`).toMatch(/already on/i);
      },
    },

    {
      name: 'rejects-the-current-plan-at-EVERY-cadence-it-is-sold-at',
      auth: 'none',
      async run({ expect, omega, config, skip }) {
        // The no-op is "this product at THIS frequency", whichever frequency the
        // account happens to sit on — a subscriber on the annual price must be
        // refused an annual "switch" exactly as a monthly one is.
        const { from } = paidPair(config, skip);

        for (const frequency of Object.keys(from.prices)) {
          const user = subscriber(omega, { uid: `_test-plan-same-${frequency}`, product: from, frequency });

          const sent = await switchPlan(omega, user, { productId: from.id, frequency });

          expect(sent.code, `Switching to the current plan (${frequency}) is a no-op, got ${sent.code}`).toBe(400);
          expect(`${sent.body}`, `Expected the same-plan message at ${frequency}, got: ${sent.body}`).toMatch(/already on/i);
        }
      },
    },

    {
      name: 'rejects-the-current-product-when-no-frequency-is-recorded',
      auth: 'none',
      async run({ expect, omega, config, skip }) {
        // The QA repro's actual state: `payment.frequency` never got recorded,
        // so a pair comparison alone ('monthly' === undefined) let the no-op
        // through to a real provider call. With nothing to compare, the product
        // id decides and EVERY cadence of it is refused — the same conservatism
        // the modal applies, and the reason the backend can stop leaning on it.
        const { from } = paidPair(config, skip);

        for (const frequency of Object.keys(from.prices)) {
          const user = subscriber(omega, { uid: `_test-plan-no-frequency-${frequency}`, product: from, frequency: undefined });

          const { sent, properties } = await switchPlanReadingProperties(omega, user, { productId: from.id, frequency });

          expect(sent.code, `An unrecorded frequency must refuse the current product at ${frequency}, got ${sent.code}`).toBe(400);
          expect(properties?.additional?.code, `Expected already-on-plan at ${frequency}, got: ${JSON.stringify(properties?.additional)}`).toBe('already-on-plan');
        }
      },
    },

    {
      name: 'still-lets-ANOTHER-product-through-when-no-frequency-is-recorded',
      auth: 'none',
      async run({ expect, omega, config, skip }) {
        // The conservative branch keys on the PRODUCT — it must not become a
        // blanket refusal for an account whose frequency was never written.
        const { from, to } = paidPair(config, skip);
        const user = subscriber(omega, { uid: '_test-plan-no-frequency-other', product: from, frequency: undefined, provider: 'unknown-provider' });

        const sent = await switchPlan(omega, user, { productId: to.id, frequency: frequencyOf(to) });

        expect(sent.code, `Expected the unknown-provider gate, got ${sent.code}`).toBe(400);
        expect(!/already on/i.test(`${sent.body}`), `A different product must clear the same-plan guard, got: ${sent.body}`).toBeTruthy();
      },
    },

    {
      name: 'the-same-plan-guard-carries-a-structured-code',
      auth: 'none',
      async run({ expect, omega, config, skip }) {
        // The client branches on the code, not on the sentence — the same
        // contract the capability gate ships under.
        const { from } = paidPair(config, skip);
        const frequency = frequencyOf(from);
        const user = subscriber(omega, { uid: '_test-plan-same-code', product: from, frequency });

        const { sent, properties } = await switchPlanReadingProperties(omega, user, { productId: from.id, frequency });

        expect(sent.code, `Expected the same-plan guard, got ${sent.code}`).toBe(400);
        expect(properties?.additional?.code, `Expected a branchable code on omega-properties, got: ${JSON.stringify(properties?.additional)}`).toBe('already-on-plan');
      },
    },

    {
      name: 'rejects-a-switch-while-a-cancellation-is-pending',
      auth: 'none',
      async run({ expect, omega, config, skip }) {
        // Swapping the price under a scheduled cancellation would land the user
        // on a NEW plan still set to end at period end, silently. Undo the
        // cancellation first — the provider is deliberately unknown here, so a
        // refusal before that gate is the proof nothing was dispatched.
        const { from, to } = paidPair(config, skip);
        const user = subscriber(omega, {
          uid: '_test-plan-cancelling',
          product: from,
          frequency: frequencyOf(from),
          provider: 'unknown-provider',
          pending: true,
        });

        const { sent, properties } = await switchPlanReadingProperties(omega, user, { productId: to.id, frequency: frequencyOf(to) });

        expect(sent.code, `A pending cancellation must refuse the switch, got ${sent.code}`).toBe(400);
        expect(properties?.additional?.code, `Expected a branchable code on omega-properties, got: ${JSON.stringify(properties?.additional)}`).toBe('cancellation-pending');
        expect(`${sent.body}`, `The refusal should name the cancellation, got: ${sent.body}`).toMatch(/cancel/i);
      },
    },

    {
      name: 'lets-a-frequency-change-on-the-same-product-through',
      auth: 'none',
      async run({ expect, omega, config, skip }) {
        // Monthly → annually on ONE product is a real switch: the same-plan guard
        // keys on product AND frequency, never on product alone. The provider is
        // deliberately unknown, so the route stops at the NEXT gate — reaching it
        // is the proof, and nothing is dispatched.
        const { from } = paidPair(config, skip);
        const frequencies = Object.keys(from.prices);

        if (frequencies.length < 2) {
          skip(`Product ${from.id} is priced at a single frequency`);
        }

        const user = subscriber(omega, { uid: '_test-plan-frequency', product: from, frequency: frequencies[0], provider: 'unknown-provider' });

        const sent = await switchPlan(omega, user, { productId: from.id, frequency: frequencies[1] });

        expect(sent.code, `Expected the unknown-provider gate, got ${sent.code}`).toBe(400);
        expect(!/already on/i.test(`${sent.body}`), `A frequency change must clear the same-plan guard, got: ${sent.body}`).toBeTruthy();
      },
    },

    {
      name: 'rejects-missing-payment-details',
      auth: 'none',
      async run({ expect, omega, config, skip }) {
        const { from, to } = paidPair(config, skip);
        const user = subscriber(omega, { uid: '_test-plan-no-provider', product: from, frequency: frequencyOf(from), provider: null, resourceId: null });

        const sent = await switchPlan(omega, user, { productId: to.id, frequency: frequencyOf(to) });

        expect(sent.code, `Without a provider there is nothing to call, got ${sent.code}`).toBe(400);
      },
    },

    {
      name: 'rejects-unknown-provider',
      auth: 'none',
      async run({ expect, omega, config, skip }) {
        const { from, to } = paidPair(config, skip);
        const user = subscriber(omega, { uid: '_test-plan-unknown-provider', product: from, frequency: frequencyOf(from), provider: 'unknown-provider' });

        const sent = await switchPlan(omega, user, { productId: to.id, frequency: frequencyOf(to) });

        expect(sent.code, `An unknown provider must be refused, got ${sent.code}`).toBe(400);
      },
    },

    // ─── the capability TABLE: the export list IS the contract ───

    {
      name: 'every-provider-supports-plan-switch',
      auth: 'none',
      async run({ expect }) {
        // Unlike uncancel, every provider here can move a live subscription:
        // Stripe updates the item, Chargebee updates for items, PayPal revises.
        PROVIDERS.forEach((name) => {
          expect(typeof providerModule(name).switchPlan, `${name} should export switchPlan()`).toBe('function');
        });
      },
    },
  ],
});
