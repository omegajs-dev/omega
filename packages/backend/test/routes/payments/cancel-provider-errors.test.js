/**
 * Test: POST /payments/cancel — only "already gone" force-cancels
 * ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
 *
 * A suspended subscriber whose provider record no longer exists gets their
 * subscription reset directly, so they can re-subscribe. That write used to fire
 * on ANY provider error: a network blip, an expired key, a rate limit — each
 * one silently downgraded a paying user to Basic and reported success. Now the
 * force-cancel answers to one classification only, and everything else returns
 * the failure with NOTHING written.
 *
 * Two layers, each proving what it can:
 *  - the classifier against REAL SDK error objects (the Stripe SDK's own error
 *    classes; the exact strings the PayPal and Chargebee clients in this repo
 *    throw) — the only place a live 404 can be represented offline;
 *  - the route against a genuine transient failure: a `stripe` subscription with
 *    no STRIPE_SECRET_KEY configured, which is exactly the misconfiguration that
 *    used to fake a cancellation.
 *
 * Run: npx omega test backend:routes/payments/cancel-provider-errors
 */
const Stripe = require('stripe');
const { buildUser, callHandler, withEnvironment } = require('./_route-harness.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/cancel/post.js'));
const isAlreadyGone = require('../../../dist/omega/libraries/payment/provider-errors.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

// A subscriber on a real provider, old enough to clear the age guard.
function subscriber(omega, { uid, status, provider }) {
  const lastYearUNIX = Math.floor(Date.now() / 1000) - (365 * 24 * 60 * 60);

  return buildUser({
    auth: { uid: uid, email: `${uid}@example.com` },
    roles: {},
    subscription: {
      product: { id: 'premium', name: 'Premium' },
      status: status,
      cancellation: { pending: false },
      payment: {
        provider: provider,
        resourceId: 'sub_test_provider_error',
        startDate: { timestamp: new Date(lastYearUNIX * 1000).toISOString(), timestampUNIX: lastYearUNIX },
      },
    },
  });
}

// Cancel with Stripe unconfigured — StripeLib.init() throws, the transient failure
// closest to a real outage that can be produced offline.
function cancelWithoutStripeKey(omega, user) {
  return withEnvironment({ STRIPE_SECRET_KEY: null }, () => callHandler({
    omega,
    handler,
    functionName: 'payments-cancel',
    user,
    data: { confirmed: true, skipGuards: false, reason: null, feedback: null },
  }));
}

module.exports = defineCases({
  description: 'Payment cancel endpoint: provider error classification',
  type: 'group',
  timeout: 15000,

  tests: [
    // ─── the route ───

    {
      name: 'a-transient-failure-on-a-suspended-subscription-writes-nothing',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        const uid = '_test-cancel-transient-suspended';
        const user = subscriber(omega, { uid, status: 'suspended', provider: 'stripe' });

        expect(await firestore.exists(`users/${uid}`), 'the case starts with no user doc to overwrite').toBe(false);

        const sent = await cancelWithoutStripeKey(omega, user);

        expect(sent.code, `A transient failure must reach the caller, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(500);
        expect(await firestore.exists(`users/${uid}`), 'A transient failure must never write a cancelled subscription').toBe(false);
      },
    },

    {
      name: 'a-transient-failure-on-an-active-subscription-writes-nothing',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        const uid = '_test-cancel-transient-active';
        const user = subscriber(omega, { uid, status: 'active', provider: 'stripe' });

        const sent = await cancelWithoutStripeKey(omega, user);

        expect(sent.code, `A transient failure must reach the caller, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(500);
        expect(await firestore.exists(`users/${uid}`), 'A transient failure must never write a cancelled subscription').toBe(false);
      },
    },

    {
      name: 'the-failure-response-carries-no-sdk-detail',
      auth: 'none',
      async run({ expect, omega }) {
        const user = subscriber(omega, { uid: '_test-cancel-neutral-message', status: 'active', provider: 'stripe' });

        const sent = await cancelWithoutStripeKey(omega, user);

        expect(sent.code, `Expected the provider failure, got ${sent.code}`).toBe(500);
        expect(!/STRIPE_SECRET_KEY/.test(`${sent.body}`), `The SDK detail must stay in the logs, got: ${sent.body}`).toBeTruthy();
        expect(`${sent.body}`, 'The client should get the neutral message').toMatch(/could not cancel your subscription/i);
      },
    },

    // ─── the classifier: already gone ───

    {
      name: 'classifies-a-stripe-missing-resource-as-gone',
      auth: 'none',
      async run({ expect }) {
        // The SDK's own error class, generated from the payload Stripe returns
        // for a subscription that does not exist.
        const error = Stripe.errors.StripeInvalidRequestError.generate({
          type: 'invalid_request_error',
          code: 'resource_missing',
          statusCode: 404,
          message: "No such subscription: 'sub_test_provider_error'",
        });

        expect(isAlreadyGone(error), 'Stripe resource_missing means the subscription is gone').toBe(true);
      },
    },

    {
      name: 'classifies-a-chargebee-404-as-gone',
      auth: 'none',
      async run({ expect }) {
        // The shape libraries/payment/providers/chargebee.js throws
        const error = new Error('Chargebee API 404: Sorry, we couldn\'t find that resource');
        error.statusCode = 404;

        expect(isAlreadyGone(error), 'A Chargebee 404 means the subscription is gone').toBe(true);
      },
    },

    {
      name: 'classifies-a-paypal-404-as-gone',
      auth: 'none',
      async run({ expect }) {
        // The shape libraries/payment/providers/paypal.js throws — status in the message only
        const error = new Error('PayPal API 404: The specified resource does not exist.');

        expect(isAlreadyGone(error), 'A PayPal 404 means the subscription is gone').toBe(true);
      },
    },

    // ─── the classifier: everything else ───

    {
      name: 'does-not-classify-a-stripe-outage-as-gone',
      auth: 'none',
      async run({ expect }) {
        const error = Stripe.errors.StripeAPIError.generate({
          type: 'api_error',
          statusCode: 503,
          message: 'Stripe is temporarily unavailable',
        });

        expect(isAlreadyGone(error), 'A Stripe outage is transient, not gone').toBe(false);
      },
    },

    {
      name: 'does-not-classify-a-stripe-auth-failure-as-gone',
      auth: 'none',
      async run({ expect }) {
        const error = Stripe.errors.StripeAuthenticationError.generate({
          type: 'invalid_request_error',
          statusCode: 401,
          message: 'Invalid API Key provided',
        });

        expect(isAlreadyGone(error), 'A rotated key is transient, not gone').toBe(false);
      },
    },

    {
      name: 'does-not-classify-a-paypal-422-as-gone',
      auth: 'none',
      async run({ expect }) {
        // PayPal answers 422 for an already-cancelled subscription too, but the
        // client surfaces no issue code — so it stays in the transient bucket
        // rather than becoming a guess that writes.
        const error = new Error('PayPal API 422: The requested action could not be performed, semantically incorrect, or failed business validation.');

        expect(isAlreadyGone(error), 'An unreadable PayPal 422 must not force a cancellation').toBe(false);
      },
    },

    {
      name: 'does-not-classify-a-paypal-outage-as-gone',
      auth: 'none',
      async run({ expect }) {
        const error = new Error('PayPal API 503: Service Unavailable');

        expect(isAlreadyGone(error), 'A PayPal outage is transient, not gone').toBe(false);
      },
    },

    {
      name: 'does-not-classify-a-configuration-error-as-gone',
      auth: 'none',
      async run({ expect }) {
        const error = new Error('STRIPE_SECRET_KEY environment variable is required');

        expect(isAlreadyGone(error), 'A misconfiguration is not a missing subscription').toBe(false);
      },
    },

    {
      name: 'does-not-classify-an-unknown-error-as-gone',
      auth: 'none',
      async run({ expect }) {
        expect(isAlreadyGone(new Error('socket hang up')), 'An unrecognized error must never be the one that writes').toBe(false);
        expect(isAlreadyGone(undefined), 'A missing error must never be the one that writes').toBe(false);
      },
    },
  ],
});
