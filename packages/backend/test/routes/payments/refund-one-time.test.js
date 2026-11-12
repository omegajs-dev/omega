/**
 * Test: POST /payments/refund — refunding a ONE-TIME purchase
 * ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
 *
 * The route was subscription-shaped end to end: it read the caller's
 * `user.subscription` and rejected anybody without a paid one, so a one-time
 * purchase — which never touches the user doc at all — could not be refunded
 * through it. A one-time refund names its subject in the request instead: the
 * `payments-orders` doc of the purchase.
 *
 * The guards are the point of this suite, so it calls the handler DIRECTLY: each
 * case gets exactly the order doc it is about, without minting a persona per
 * permutation. The one valid order deliberately carries an unknown provider —
 * reaching "Unknown provider" proves the request got PAST every guard without
 * anything external being touched.
 *
 * Run: npx omega test backend:routes/payments/refund-one-time
 */
const { buildUser, callHandler } = require('./_route-harness.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/refund/post.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const OWNER = '_test-refund-one-time-owner';

function purchaser(omega, uid) {
  return buildUser({
    auth: { uid: uid, email: `${uid}@example.com` },
    roles: {},
    // A one-time buyer is an ordinary Basic user — the whole point of the branch
    subscription: { product: { id: 'basic' }, status: 'active' },
  });
}

// A completed one-time order, the shape the webhook pipeline writes
function oneTimeOrder(orderId, overrides) {
  const nowUNIX = Math.floor(Date.now() / 1000);

  return {
    id: orderId,
    type: 'one-time',
    owner: OWNER,
    productId: 'credits-100',
    provider: 'unknown-provider',
    resourceId: `_test-cs-${orderId}`,
    unified: {
      product: { id: 'credits-100', name: '100 Credits' },
      status: 'completed',
      payment: { provider: 'unknown-provider', orderId: orderId, resourceId: `_test-cs-${orderId}`, price: 9.99 },
    },
    requests: { cancellation: null, refund: null },
    metadata: { created: { timestamp: new Date(nowUNIX * 1000).toISOString(), timestampUNIX: nowUNIX } },
    ...(overrides || {}),
  };
}

function refund(omega, user, orderId) {
  return callHandler({
    omega,
    handler,
    functionName: 'payments-refund',
    user,
    data: { confirmed: true, reason: 'Bought the wrong thing', feedback: null, orderId: orderId },
  });
}

module.exports = defineCases({
  description: 'Payment refund endpoint: one-time purchases',
  type: 'group',
  timeout: 15000,

  tests: [
    {
      name: 'rejects-an-order-that-does-not-exist',
      auth: 'none',
      async run({ expect, omega }) {
        const sent = await refund(omega, purchaser(omega, OWNER), '_test-order-never-existed');

        expect(sent.code, `An unknown order should be rejected, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'The rejection should name the order').toMatch(/order not found/i);
      },
    },

    {
      name: 'rejects-an-order-owned-by-somebody-else',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        const orderId = '_test-order-one-time-not-yours';
        await firestore.set(`payments-orders/${orderId}`, oneTimeOrder(orderId));

        const sent = await refund(omega, purchaser(omega, '_test-refund-one-time-stranger'), orderId);

        expect(sent.code, `Another user's order should be rejected, got ${sent.code}: ${sent.body}`).toBe(400);
        // Not-found and not-yours read identically: an order id must not be a
        // probe for whether somebody else's purchase exists
        expect(`${sent.body}`, 'Somebody else\'s order must not be distinguishable from a missing one').toMatch(/order not found/i);
      },
    },

    {
      name: 'rejects-a-subscription-order',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        const orderId = '_test-order-one-time-is-a-subscription';
        await firestore.set(`payments-orders/${orderId}`, oneTimeOrder(orderId, { type: 'subscription' }));

        const sent = await refund(omega, purchaser(omega, OWNER), orderId);

        expect(sent.code, `A subscription order should be rejected here, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'The rejection should say the order is not a one-time purchase').toMatch(/one-time/i);
      },
    },

    {
      name: 'rejects-an-already-refunded-order',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        const orderId = '_test-order-one-time-already-refunded';
        const nowUNIX = Math.floor(Date.now() / 1000);
        await firestore.set(`payments-orders/${orderId}`, oneTimeOrder(orderId, {
          requests: {
            cancellation: null,
            refund: {
              reason: 'Changed my mind',
              amount: 9.99,
              full: true,
              date: { timestamp: new Date(nowUNIX * 1000).toISOString(), timestampUNIX: nowUNIX },
            },
          },
        }));

        const sent = await refund(omega, purchaser(omega, OWNER), orderId);

        expect(sent.code, `A refunded order should be rejected, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'The rejection should say it was already refunded').toMatch(/already been refunded/i);
      },
    },

    {
      name: 'rejects-a-dashboard-refunded-order',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        // A refund issued from the provider dashboard arrives by webhook: it
        // flips unified.status to 'refunded' but writes NO requests.refund
        const orderId = '_test-order-one-time-dashboard-refunded';
        await firestore.set(`payments-orders/${orderId}`, oneTimeOrder(orderId, {
          unified: {
            product: { id: 'credits-100', name: '100 Credits' },
            status: 'refunded',
            payment: { provider: 'unknown-provider', orderId: orderId, resourceId: `_test-cs-${orderId}`, price: 9.99 },
          },
        }));

        const sent = await refund(omega, purchaser(omega, OWNER), orderId);

        expect(sent.code, `A dashboard-refunded order should be rejected, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'The rejection should say it was already refunded, not 500 out of the provider').toMatch(/already been refunded/i);
      },
    },

    {
      name: 'rejects-a-purchase-that-never-completed',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        // An abandoned Stripe checkout session stays `open` on the order, with
        // its provider and resourceId intact — so every other refusal passes it
        // and the provider is asked to reverse a charge that never happened
        const orderId = '_test-order-one-time-never-completed';
        await firestore.set(`payments-orders/${orderId}`, oneTimeOrder(orderId, {
          unified: {
            product: { id: 'credits-100', name: '100 Credits' },
            status: 'open',
            payment: { provider: 'unknown-provider', orderId: orderId, resourceId: `_test-cs-${orderId}`, price: 9.99 },
          },
        }));

        const sent = await refund(omega, purchaser(omega, OWNER), orderId);

        expect(sent.code, `An incomplete purchase should be refused, not sent to the provider, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'The rejection should say the purchase never completed').toMatch(/has not completed/i);
      },
    },

    {
      name: 'rejects-a-purchase-older-than-6-months',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        const orderId = '_test-order-one-time-too-old';
        const oldUNIX = Math.floor(Date.now() / 1000) - (200 * 24 * 60 * 60);
        await firestore.set(`payments-orders/${orderId}`, oneTimeOrder(orderId, {
          metadata: { created: { timestamp: new Date(oldUNIX * 1000).toISOString(), timestampUNIX: oldUNIX } },
        }));

        const sent = await refund(omega, purchaser(omega, OWNER), orderId);

        expect(sent.code, `An old purchase should be rejected, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'The refund window applies to one-time purchases too').toMatch(/older than 6 months/i);
      },
    },

    {
      name: 'refuses-a-purchase-on-a-provider-that-cannot-refund',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        // The registry's `refundable: false` row is the refusal, before any
        // provider module is loaded
        const orderId = '_test-order-one-time-no-refund-api';
        await firestore.set(`payments-orders/${orderId}`, oneTimeOrder(orderId, {
          provider: 'coinbase',
          unified: {
            product: { id: 'credits-100', name: '100 Credits' },
            status: 'completed',
            payment: { provider: 'coinbase', orderId: orderId, resourceId: `_test-cs-${orderId}`, price: 9.99 },
          },
        }));

        const sent = await refund(omega, purchaser(omega, OWNER), orderId);

        expect(sent.code, `A provider with no refund API should be refused, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'The refusal names the provider').toMatch(/Coinbase Commerce purchases cannot be refunded/);
      },
    },

    {
      name: 'reaches-the-provider-for-a-valid-one-time-order',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        const orderId = '_test-order-one-time-valid';
        await firestore.set(`payments-orders/${orderId}`, oneTimeOrder(orderId));

        const sent = await refund(omega, purchaser(omega, OWNER), orderId);

        expect(sent.code, `A valid order should reach the provider lookup, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'A valid one-time order should get PAST every guard').toMatch(/Unknown provider/i);
      },
    },

    {
      name: 'still-requires-confirmation',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        const orderId = '_test-order-one-time-unconfirmed';
        await firestore.set(`payments-orders/${orderId}`, oneTimeOrder(orderId));

        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-refund',
          user: purchaser(omega, OWNER),
          data: { confirmed: false, reason: 'Bought the wrong thing', feedback: null, orderId: orderId },
        });

        expect(sent.code, `An unconfirmed refund should be rejected, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'The confirmation guard covers both paths').toMatch(/must be confirmed/i);
      },
    },

    {
      name: 'without-an-order-id-it-is-still-the-subscription-path',
      auth: 'none',
      async run({ expect, omega }) {
        // No orderId: a Basic user is refused for having no paid subscription,
        // exactly as before the one-time branch existed
        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-refund',
          user: purchaser(omega, OWNER),
          data: { confirmed: true, reason: 'Too expensive', feedback: null, orderId: null },
        });

        expect(sent.code, `A basic user should still be rejected, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'The subscription path must be untouched').toMatch(/no paid subscription/i);
      },
    },
  ],
});
