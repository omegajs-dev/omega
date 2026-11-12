/**
 * Test: Payment Journey - Plan switch DURING a trial
 * Simulates: trialing on product A → POST /payments/plan → plan-changed → trialing on product B
 *
 * The ruling this proves (Ian 2026-08-14, [#237](https://github.com/Omega-JS-Stack/omega/issues/237)):
 * a plan switch NEVER grants, resets, or extends a trial. A mid-trial switch
 * CARRIES the trial over — same original end date, new plan — and `trial.claimed`
 * stays claimed.
 *
 * The QA repro this reproduces: Studio → Studio through the modal ENDED the
 * in-progress trial, because the switch's webhook carried no trial at all and the
 * unified transform reads `claimed` straight off it. The end date is therefore
 * asserted on the USER DOC after the real pipeline has written it, not on the
 * provider's payload.
 *
 * The twin without a trial is journey-payments-plan-switch.test.js.
 *
 * Requires at least two paid subscription products in config.
 *
 * Run: npx omega test framework:events/payments/journey-payments-plan-switch-trial
 */
const { buildUser, callHandler } = require('../../routes/payments/_route-harness.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/plan/post.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

// The suite's own seeded persona ([#406](https://github.com/Omega-JS-Stack/omega/issues/406)):
// exclusive to this suite and declared in the seed roster, so the account it
// drives exists — auth user and doc in sync — before the run starts.
const PERSONA = 'journey-payments-plan-switch-trial';
const RESOURCE_ID = 'sub_test_journey_plan_switch_trial';
const ORDER_ID = 'TEST-PLAN-TRIAL';

module.exports = defineCases({
  description: 'Payment journey: mid-trial plan switch carries the trial over',
  type: 'suite',
  timeout: 30000,

  tests: [
    {
      name: 'setup-trialing-subscription',
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
        const startUNIX = nowUNIX - (7 * 86400);

        // The trial the switch must not touch: started a week ago, seven days left
        const trialEndUNIX = nowUNIX + (7 * 86400);

        state.uid = accounts[PERSONA].uid;
        state.email = accounts[PERSONA].email;
        state.trialEndUNIX = trialEndUNIX;
        state.productA = { id: productA.id, name: productA.name || productA.id, frequency: frequencyA };
        state.productB = { id: productB.id, name: productB.name || productB.id, frequency: frequencyB };

        state.subscription = {
          product: { id: productA.id, name: state.productA.name },
          status: 'active',
          expires: { timestamp: new Date(periodEndUNIX * 1000).toISOString(), timestampUNIX: periodEndUNIX },
          trial: {
            claimed: true,
            expires: { timestamp: new Date(trialEndUNIX * 1000).toISOString(), timestampUNIX: trialEndUNIX },
          },
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

        await firestore.set(`users/${state.uid}`, {
          auth: { uid: state.uid, email: state.email },
          roles: {},
          subscription: state.subscription,
        }, { merge: true });

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
        expect(userDoc.subscription.trial.claimed, 'Should start mid-trial').toBe(true);
        expect(userDoc.subscription.trial.expires.timestampUNIX, 'Should start with the original trial end').toBe(trialEndUNIX);
      },
    },

    {
      name: 'call-plan-endpoint-mid-trial',
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

        expect(sent.code, `A mid-trial switch is allowed, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
      },
    },

    {
      name: 'trial-survives-the-switch-unchanged',
      async run({ firestore, expect, state, waitFor }) {
        await waitFor(async () => {
          const userDoc = await firestore.get(`users/${state.uid}`);
          return userDoc?.subscription?.product?.id === state.productB.id;
        }, 15000, 500);

        const userDoc = await firestore.get(`users/${state.uid}`);
        const subscription = userDoc.subscription;

        expect(subscription.product.id, `Product should be ${state.productB.id}`).toBe(state.productB.id);
        expect(subscription.status, 'Status should still be active').toBe('active');

        // The ruling, in two assertions: still claimed, same end date.
        expect(subscription.trial.claimed, 'A plan switch must never un-claim a trial').toBe(true);
        expect(subscription.trial.expires.timestampUNIX, `Trial end should be the ORIGINAL ${state.trialEndUNIX}, got ${subscription.trial.expires.timestampUNIX}`).toBe(state.trialEndUNIX);

        // While a subscription is trialing the current period IS the trial
        // period, and the cancel route reads that equality to decide a
        // cancellation is immediate. A switch that left a 30-day period behind
        // would quietly turn the next trial cancellation into a scheduled one
        // and misreport the next billing date.
        expect(subscription.expires.timestampUNIX, `A trialing subscription's period should END at the trial end (${state.trialEndUNIX}), got ${subscription.expires.timestampUNIX}`).toBe(state.trialEndUNIX);
      },
    },
  ],
});
