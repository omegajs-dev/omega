/**
 * Test: Payment Journey - Uncancel
 * Simulates: paid active + cancellation pending → POST /payments/uncancel → cancellation cleared
 *
 * The test provider's uncancel() writes a Stripe-shaped `customer.subscription.updated`
 * doc directly to payments-webhooks/{eventId}, triggering the full on-write pipeline
 * automatically — the route itself writes no subscription state, exactly like cancel.
 *
 * The caller is this suite's own seeded persona, driven through the shared route
 * harness: the ACCOUNT is declared in the seed roster (#406) and the starting
 * state (a scheduled cancellation on the test provider) is a SHAPE this suite
 * writes onto it, because the seed only makes healthy steady-state accounts.
 * Everything downstream of the handler — the webhook doc, the on-write trigger,
 * the transition detection, the user-doc write — is the real pipeline.
 *
 * Product-agnostic: resolves the first paid product from config.payment.products
 *
 * Run: npx omega test framework:events/payments/journey-payments-uncancel
 */
const { buildUser, callHandler } = require('../../routes/payments/_route-harness.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/uncancel/post.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

// The suite's own seeded persona ([#406](https://github.com/Omega-JS-Stack/omega/issues/406)):
// exclusive to this suite and declared in the seed roster, so the account it
// drives exists — auth user and doc in sync — before the run starts.
const PERSONA = 'journey-payments-uncancel';
const RESOURCE_ID = 'sub_test_journey_uncancel';

module.exports = defineCases({
  description: 'Payment journey: uncancel endpoint → cancellation cleared',
  type: 'suite',
  timeout: 30000,

  tests: [
    {
      name: 'setup-cancelled-pending-subscription',
      async run({ accounts, firestore, expect, state, config, skip }) {
        const paidProduct = (config.payment?.products || []).find((p) => p.id !== 'basic' && p.type === 'subscription' && p.prices);

        if (!paidProduct) {
          skip('No paid product configured in this brand');
        }

        const frequency = Object.keys(paidProduct.prices)[0];
        const nowUNIX = Math.floor(Date.now() / 1000);
        const periodEndUNIX = nowUNIX + (30 * 86400);
        const startUNIX = nowUNIX - (365 * 86400);

        state.uid = accounts[PERSONA].uid;
        state.email = accounts[PERSONA].email;
        state.productId = paidProduct.id;
        state.productName = paidProduct.name || paidProduct.id;
        state.frequency = frequency;

        // The starting state: active, paid, and scheduled to cancel at period end —
        // the exact shape the cancel route's webhook leaves behind.
        state.subscription = {
          product: { id: paidProduct.id, name: state.productName },
          status: 'active',
          expires: { timestamp: new Date(periodEndUNIX * 1000).toISOString(), timestampUNIX: periodEndUNIX },
          trial: { claimed: false },
          cancellation: {
            pending: true,
            date: { timestamp: new Date(periodEndUNIX * 1000).toISOString(), timestampUNIX: periodEndUNIX },
          },
          payment: {
            provider: 'test',
            orderId: null,
            resourceId: RESOURCE_ID,
            frequency: frequency,
            startDate: { timestamp: new Date(startUNIX * 1000).toISOString(), timestampUNIX: startUNIX },
          },
        };

        // The pipeline reads users/{uid} for its BEFORE state, so the doc has to
        // be the real record the transition is detected against.
        await firestore.set(`users/${state.uid}`, {
          auth: { uid: state.uid, email: state.email },
          roles: {},
          subscription: state.subscription,
        }, { merge: true });

        const userDoc = await firestore.get(`users/${state.uid}`);
        expect(userDoc.subscription.status, 'Should start active').toBe('active');
        expect(userDoc.subscription.cancellation.pending, 'Should start pending cancellation').toBe(true);
      },
    },

    {
      name: 'call-uncancel-endpoint',
      async run({ expect, omega, state }) {
        const user = buildUser({
          auth: { uid: state.uid, email: state.email },
          roles: {},
          subscription: state.subscription,
        });

        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-uncancel',
          user,
          data: { confirmed: true },
        });

        expect(sent.code, `Uncancel should succeed, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(sent.body?.success, `Should return { success: true }, got ${JSON.stringify(sent.body)}`).toBe(true);
      },
    },

    {
      name: 'verify-cancellation-cleared',
      async run({ firestore, expect, state, waitFor }) {
        // Poll the user doc until the on-write pipeline writes the resumed state
        await waitFor(async () => {
          const userDoc = await firestore.get(`users/${state.uid}`);
          return userDoc?.subscription?.cancellation?.pending === false;
        }, 15000, 500);

        const userDoc = await firestore.get(`users/${state.uid}`);
        expect(userDoc.subscription.cancellation.pending, 'Cancellation should no longer be pending').toBe(false);
        expect(userDoc.subscription.status, 'Status should still be active').toBe('active');
        expect(userDoc.subscription.product.id, `Product should still be ${state.productId}`).toBe(state.productId);
        expect(userDoc.subscription.payment.frequency, `Frequency should still be ${state.frequency}`).toBe(state.frequency);
        expect(userDoc.subscription.payment.resourceId, 'Resource ID should be the same subscription').toBe(RESOURCE_ID);
      },
    },

    {
      name: 'webhook-completed-with-cancellation-removed',
      async run({ firestore, expect, state, waitFor }) {
        // The uncancel webhook reaches the pipeline and completes...
        const snapshot = await waitFor(async () => {
          const query = await firestore.collection('payments-webhooks')
            .where('owner', '==', state.uid)
            .where('status', '==', 'completed')
            .limit(1)
            .get();

          return query.empty ? null : query;
        }, 15000, 500);

        const webhookDoc = snapshot.docs[0].data();
        expect(webhookDoc.status, 'Webhook should complete').toBe('completed');

        // ...and fires cancellation-removed, the withdrawal half of the pair whose
        // other half (pending false → true) is cancellation-requested. The handler
        // is log-only for now: the order template carries no copy for a withdrawn
        // cancellation, and its fallback variant would tell this subscriber their
        // subscription was just confirmed ([#212]).
        expect(webhookDoc.transition, `Withdrawing a scheduled cancellation should detect cancellation-removed, got: ${webhookDoc.transition}`).toBe('cancellation-removed');
      },
    },
  ],
});
