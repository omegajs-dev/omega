/**
 * Test: Payment Journey - Win-back
 * Simulates: fully cancelled paid subscriber → checkout → active again
 *
 * A full cancellation leaves the PAID product id on the user doc (status goes to
 * cancelled, the product does not go back to basic), so the returning subscriber's
 * checkout matched none of the transition rules: no confirmation email, and the
 * analytics resolver read the payment event as a renewal
 * ([#218](https://github.com/Omega-JS-Stack/omega/issues/218)).
 *
 * The caller is this suite's own seeded persona, driven through the shared route
 * harness: the ACCOUNT is declared in the seed roster (#406) and the starting
 * state (a cancelled subscription) is a SHAPE this suite writes onto it, because
 * the seed only makes healthy steady-state accounts. Everything downstream of
 * the handler — the test provider's checkout, the webhook doc, the on-write
 * trigger, the transition detection, the user-doc write — is the real pipeline.
 *
 * Product-agnostic: resolves the first paid product from config.payment.products
 *
 * Run: npx omega test framework:events/payments/journey-payments-winback
 */
const { buildUser, callHandler } = require('../../routes/payments/_route-harness.js');
const analytics = require('../../../dist/omega/events/firestore/payments-webhooks/analytics.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/intent/post.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

// The suite's own seeded persona ([#406](https://github.com/Omega-JS-Stack/omega/issues/406)):
// exclusive to this suite and declared in the seed roster, so the account it
// drives exists — auth user and doc in sync — before the run starts.
const PERSONA = 'journey-payments-winback';
const RESOURCE_ID = 'sub_test_journey_winback_cancelled';

module.exports = defineCases({
  description: 'Payment journey: cancelled subscriber resubscribes → win-back',
  type: 'suite',
  timeout: 60000,

  tests: [
    {
      name: 'setup-cancelled-subscriber',
      async run({ accounts, firestore, expect, state, config, skip }) {
        const paidProduct = (config.payment?.products || []).find((p) => p.id !== 'basic' && p.type === 'subscription' && p.prices);

        if (!paidProduct) {
          skip('No paid subscription product configured in this brand');
        }

        const frequency = Object.keys(paidProduct.prices)[0];
        const nowUNIX = Math.floor(Date.now() / 1000);
        const cancelledUNIX = nowUNIX - (7 * 86400);
        const startUNIX = nowUNIX - (365 * 86400);

        state.uid = accounts[PERSONA].uid;
        state.email = accounts[PERSONA].email;
        state.productId = paidProduct.id;
        state.frequency = frequency;

        // The starting state: cancelled outright a week ago, still carrying the paid
        // product id — what subscription-cancelled leaves behind.
        state.subscription = {
          product: { id: paidProduct.id, name: paidProduct.name || paidProduct.id },
          status: 'cancelled',
          expires: { timestamp: new Date(cancelledUNIX * 1000).toISOString(), timestampUNIX: cancelledUNIX },
          trial: { claimed: false },
          cancellation: {
            pending: false,
            date: { timestamp: new Date(cancelledUNIX * 1000).toISOString(), timestampUNIX: cancelledUNIX },
          },
          payment: {
            provider: 'test',
            orderId: null,
            resourceId: RESOURCE_ID,
            frequency: frequency,
            price: paidProduct.prices[frequency],
            startDate: { timestamp: new Date(startUNIX * 1000).toISOString(), timestampUNIX: startUNIX },
          },
        };

        // The pipeline reads users/{uid} for its BEFORE state, so the doc has to be
        // the real record the transition is detected against.
        await firestore.set(`users/${state.uid}`, {
          auth: { uid: state.uid, email: state.email },
          roles: {},
          subscription: state.subscription,
        }, { merge: true });

        const userDoc = await firestore.get(`users/${state.uid}`);
        expect(userDoc.subscription.status, 'Should start cancelled').toBe('cancelled');
        expect(userDoc.subscription.product.id, 'Should still carry the paid product id').toBe(state.productId);
      },
    },

    {
      name: 'resubscribe-through-checkout',
      async run({ expect, omega, state }) {
        const user = buildUser({
          auth: { uid: state.uid, email: state.email },
          roles: {},
          subscription: state.subscription,
        });

        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-intent',
          user,
          // What schemas/payments/intent/post.js resolves a bare checkout request
          // to — the handler receives settings already defaulted, and writes them
          // onto the intent doc as-is.
          data: {
            provider: 'test',
            productId: state.productId,
            frequency: state.frequency,
            trial: false,
            verification: {},
            attribution: {},
            trackingConsent: null,
            discount: null,
            supplemental: {},
            simulate: null,
          },
        });

        expect(sent.code, `A cancelled subscriber should be allowed to check out again, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(sent.body?.orderId, `Checkout should return an orderId, got ${JSON.stringify(sent.body)}`).toBeTruthy();

        state.orderId = sent.body.orderId;
      },
    },

    {
      name: 'subscription-is-active-again',
      async run({ firestore, expect, state, waitFor }) {
        await waitFor(async () => {
          const userDoc = await firestore.get(`users/${state.uid}`);
          return userDoc?.subscription?.status === 'active';
        }, 20000, 500);

        const userDoc = await firestore.get(`users/${state.uid}`);
        expect(userDoc.subscription.status, 'Status should be active again').toBe('active');
        expect(userDoc.subscription.product.id, `Product should be ${state.productId}`).toBe(state.productId);
        expect(userDoc.subscription.cancellation.pending, 'The new subscription should carry no pending cancellation').toBe(false);
      },
    },

    {
      name: 'win-back-transition-detected',
      async run({ firestore, expect, state, waitFor }) {
        const snapshot = await waitFor(async () => {
          const query = await firestore.collection('payments-webhooks')
            .where('owner', '==', state.uid)
            .where('event.type', '==', 'customer.subscription.created')
            .limit(1)
            .get();

          if (query.empty) {
            return null;
          }

          const status = query.docs[0].data().status;
          return (status === 'completed' || status === 'failed') ? query : null;
        }, 30000, 500);

        const webhookDoc = snapshot.docs[0].data();

        expect(webhookDoc.status, 'The win-back webhook should process cleanly').toBe('completed');
        expect(webhookDoc.transition, 'Transition should be subscription-winback').toBe('subscription-winback');

        state.eventType = webhookDoc.event.type;
        state.transition = webhookDoc.transition;
      },
    },

    {
      name: 'win-back-tracks-as-a-purchase',
      async run({ firestore, expect, state }) {
        // The order doc the pipeline just wrote IS what trackPayment resolved its
        // event from — run the resolver over it to prove the win-back reports a
        // purchase and not the renewal it used to report.
        const orderDoc = await firestore.get(`payments-orders/${state.orderId}`);

        expect(orderDoc, 'Order doc should exist').toBeTruthy();
        expect(orderDoc.owner, 'Owner should match').toBe(state.uid);

        const resolved = analytics.resolvePaymentEvent('subscription', state.transition, state.eventType, orderDoc.unified, orderDoc);

        expect(resolved, 'A win-back should resolve to a trackable analytics event').toBeTruthy();
        expect(resolved.reason, 'Reason should be winback-purchase').toBe('winback-purchase');
        expect(resolved.isRecurring, 'A win-back is a purchase, not recurring revenue').toBe(false);
        expect(resolved.productId, 'The tracked product should be the resubscribed product').toBe(state.productId);
      },
    },
  ],
});
