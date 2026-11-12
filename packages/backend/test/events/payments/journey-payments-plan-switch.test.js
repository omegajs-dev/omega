/**
 * Test: Payment Journey - Plan switch via endpoint
 * Simulates: paid product A → POST /payments/plan → plan-changed → paid product B
 *
 * The twin of journey-payments-plan-change.test.js, driven by the OWNED route
 * instead of a hand-sent webhook: the test provider's switchPlan() writes a
 * Stripe-shaped `customer.subscription.updated` carrying the NEW product, and the
 * existing plan-changed transition fires naturally — the route needs no pipeline
 * work of its own.
 *
 * The caller is this suite's own seeded persona, driven through the shared route
 * harness (see journey-payments-uncancel.test.js for the reasoning); everything
 * downstream of the handler is the real pipeline.
 *
 * Requires at least two paid subscription products in config.
 *
 * Run: npx omega test framework:events/payments/journey-payments-plan-switch
 */
const { buildUser, callHandler } = require('../../routes/payments/_route-harness.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/plan/post.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

// The suite's own seeded persona ([#406](https://github.com/Omega-JS-Stack/omega/issues/406)):
// exclusive to this suite and declared in the seed roster, so the account it
// drives exists — auth user and doc in sync — before the run starts.
const PERSONA = 'journey-payments-plan-switch';
const RESOURCE_ID = 'sub_test_journey_plan_switch';
const ORDER_ID = 'TEST-PLAN-SWTCH';

module.exports = defineCases({
  description: 'Payment journey: plan endpoint → plan-changed → paid product B',
  type: 'suite',
  timeout: 30000,

  tests: [
    {
      name: 'setup-paid-subscription',
      async run({ accounts, firestore, expect, state, config, skip }) {
        const paidProducts = (config.payment?.products || []).filter((p) => p.id !== 'basic' && p.type === 'subscription' && p.prices);

        if (paidProducts.length < 2) {
          skip('Fewer than two paid subscription products configured in this brand');
        }

        const productA = paidProducts[0];
        const productB = paidProducts[1];
        const frequencyA = Object.keys(productA.prices)[0];
        const frequencyB = Object.keys(productB.prices)[0];

        const nowUNIX = Math.floor(Date.now() / 1000);
        const periodEndUNIX = nowUNIX + (30 * 86400);
        const startUNIX = nowUNIX - (365 * 86400);

        state.uid = accounts[PERSONA].uid;
        state.email = accounts[PERSONA].email;
        state.productA = { id: productA.id, name: productA.name || productA.id, frequency: frequencyA };
        state.productB = { id: productB.id, name: productB.name || productB.id, frequency: frequencyB };

        state.subscription = {
          product: { id: productA.id, name: state.productA.name },
          status: 'active',
          expires: { timestamp: new Date(periodEndUNIX * 1000).toISOString(), timestampUNIX: periodEndUNIX },
          trial: { claimed: false },
          cancellation: { pending: false },
          payment: {
            provider: 'test',
            orderId: ORDER_ID,
            resourceId: RESOURCE_ID,
            frequency: frequencyA,
            price: productA.prices[frequencyA],
            startDate: { timestamp: new Date(startUNIX * 1000).toISOString(), timestampUNIX: startUNIX },
          },
        };

        // The pipeline reads users/{uid} for its BEFORE state — plan-changed is
        // detected by comparing that product against the incoming one.
        await firestore.set(`users/${state.uid}`, {
          auth: { uid: state.uid, email: state.email },
          roles: {},
          subscription: state.subscription,
        }, { merge: true });

        // The order the checkout would have written, so the switch's effect on it
        // is observable the way journey-payments-plan-change.test.js observes it.
        await firestore.set(`payments-orders/${ORDER_ID}`, {
          id: ORDER_ID,
          type: 'subscription',
          owner: state.uid,
          productId: productA.id,
          provider: 'test',
          resourceId: RESOURCE_ID,
          unified: state.subscription,
          requests: { cancellation: null, refund: null },
        }, { merge: true });

        const userDoc = await firestore.get(`users/${state.uid}`);
        expect(userDoc.subscription.product.id, `Should start as ${productA.id}`).toBe(productA.id);
        expect(userDoc.subscription.status, 'Should be active').toBe('active');
      },
    },

    {
      name: 'call-plan-endpoint',
      async run({ expect, omega, state }) {
        const user = buildUser({
          auth: { uid: state.uid, email: state.email },
          roles: {},
          subscription: state.subscription,
        });

        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-plan',
          user,
          data: {
            productId: state.productB.id,
            frequency: state.productB.frequency,
            confirmed: true,
          },
        });

        expect(sent.code, `Plan switch should succeed, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(sent.body?.success, `Should return { success: true }, got ${JSON.stringify(sent.body)}`).toBe(true);
      },
    },

    {
      name: 'plan-changed-transition-detected',
      async run({ firestore, expect, state, waitFor }) {
        const snapshot = await waitFor(async () => {
          const query = await firestore.collection('payments-webhooks')
            .where('owner', '==', state.uid)
            .where('status', '==', 'completed')
            .limit(1)
            .get();

          return query.empty ? null : query;
        }, 15000, 500);

        const webhookDoc = snapshot.docs[0].data();
        expect(webhookDoc.transition, `Transition should be plan-changed, got ${webhookDoc.transition}`).toBe('plan-changed');
      },
    },

    {
      name: 'subscription-updated-to-product-b',
      async run({ firestore, expect, state, waitFor }) {
        await waitFor(async () => {
          const userDoc = await firestore.get(`users/${state.uid}`);
          return userDoc?.subscription?.product?.id === state.productB.id;
        }, 15000, 500);

        const userDoc = await firestore.get(`users/${state.uid}`);
        expect(userDoc.subscription.product.id, `Product should be ${state.productB.id}`).toBe(state.productB.id);
        expect(userDoc.subscription.product.name, `Product name should be ${state.productB.name}`).toBe(state.productB.name);
        expect(userDoc.subscription.status, 'Status should still be active').toBe('active');
        expect(userDoc.subscription.cancellation.pending, 'Switching plans must not schedule a cancellation').toBe(false);
        expect(userDoc.subscription.payment.provider, 'Provider should be test').toBe('test');
        expect(userDoc.subscription.payment.frequency, `Frequency should be ${state.productB.frequency}`).toBe(state.productB.frequency);
        expect(userDoc.subscription.payment.resourceId, 'Resource ID should be the same subscription').toBe(RESOURCE_ID);
      },
    },

    {
      name: 'order-doc-updated',
      async run({ firestore, expect, state, waitFor }) {
        await waitFor(async () => {
          const orderDoc = await firestore.get(`payments-orders/${ORDER_ID}`);
          return orderDoc?.unified?.product?.id === state.productB.id;
        }, 15000, 500);

        const orderDoc = await firestore.get(`payments-orders/${ORDER_ID}`);
        expect(orderDoc.unified.product.id, `Order product should be ${state.productB.id}`).toBe(state.productB.id);
        expect(orderDoc.unified.status, 'Order status should be active').toBe('active');
        expect(orderDoc.requests.cancellation, 'requests.cancellation should still be null').toBe(null);
        expect(orderDoc.requests.refund, 'requests.refund should still be null').toBe(null);
      },
    },
  ],
});
