/**
 * Test: the daily trial-lapse sweep
 *
 * A trial that ends without converting should leave the user on basic. The providers
 * say so with a webhook, and when that webhook is missed the user keeps a paid product
 * they never paid for — invisibly, because `trial.claimed` means "this subscription HAD
 * a trial", never "it converted" ([#212]).
 *
 * The sweep is a BACKSTOP, so what it must NOT do matters as much as what it does: it
 * never infers a lapse from dates alone (every candidate is confirmed against live
 * provider state), it leaves the 24h grace window and everything older than 30 days
 * alone, and a second run changes nothing.
 *
 * The test provider answers `fetchResource` from `payments-orders`, so "the provider
 * says X" is seeded as an order doc — or, for "the subscription is gone", as no order
 * doc at all.
 */
const { resolveTrialOutcomeConversion } = require('../../../dist/omega/events/cron/helpers/trial-lapse-sweep.js');
const analytics = require('../../../dist/omega/events/firestore/payments-webhooks/analytics.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const DAY = 24 * 60 * 60;

const GONE_UID = '_test-trial-lapse-gone';
const CANCELLED_UID = '_test-trial-lapse-cancelled';
const CONVERTED_UID = '_test-trial-lapse-converted';
const GRACE_UID = '_test-trial-lapse-grace';
const AGED_UID = '_test-trial-lapse-aged';

const CANCELLED_ORDER = '_test-order-trial-lapse-cancelled';
const CONVERTED_ORDER = '_test-order-trial-lapse-converted';

module.exports = defineCases({
  description: 'Trial-lapse sweep: confirms with the provider, then corrects state',
  type: 'suite',
  timeout: 180000,

  tests: [
    {
      // The sweep is the ONLY path that ever sees a PayPal trial's outcome: PayPal
      // fires no trial-end event, so nothing else in the pipeline is told. Before
      // [#407](https://github.com/Omega-JS-Stack/omega/issues/407) the state was
      // corrected here and the analytics signal was never sent at all.
      name: 'the-sweep-reports-a-lapse-no-webhook-will-ever-announce',
      async run({ expect }) {
        const nowUNIX = Math.floor(Date.now() / 1000);
        const trialEndUNIX = nowUNIX - 5 * DAY;

        // PayPal's in-trial shape: `expires` is next_billing_time, which during a
        // trial IS the trial's end.
        const paypalTrial = {
          product: { id: 'premium', name: 'Premium' },
          status: 'active',
          expires: stamp(trialEndUNIX),
          trial: { claimed: true, expires: stamp(trialEndUNIX) },
          payment: { provider: 'paypal', resourceId: 'I-PAYPAL-TRIAL', frequency: 'monthly', price: 9.99 },
        };

        const conversion = resolveTrialOutcomeConversion(paypalTrial, 'lapsed', 'USD');

        expect(conversion, 'a lapse the sweep decided should be reported').toBeTruthy();
        expect(conversion.event).toBe('trial_lapse');
        expect(conversion.params.value, 'the value is the subscription that never started paying').toBe(9.99);
        expect(conversion.params.is_trial).toBe(true);
        expect(conversion.params.is_recurring, 'nothing was ever charged').toBe(false);
        expect(conversion.eventId, 'the dedupe id is keyed to the SUBSCRIPTION, which is the one thing this sweep and the payment webhook both know').toBe('trial_lapse.I-PAYPAL-TRIAL');

        const converted = resolveTrialOutcomeConversion({ ...paypalTrial }, 'converted', 'USD');

        expect(converted.event).toBe('trial_convert');
        expect(converted.eventId).toBe('trial_convert.I-PAYPAL-TRIAL');
      },
    },

    {
      // A trial whose outcome a payment webhook already resolved was already
      // reported at the moment it happened. The sweep still stamps the outcome —
      // that is state correction — but reporting it again would be a second
      // conversion: GA4 deduplicates a `purchase` on `transaction_id`, and this
      // path has no invoice to name, so the two reports would arrive under two
      // different ids ([#656]).
      name: 'the-sweep-never-reports-an-outcome-a-webhook-already-resolved',
      async run({ expect }) {
        const nowUNIX = Math.floor(Date.now() / 1000);
        const trialEndUNIX = nowUNIX - 5 * DAY;

        // The conversion charge moved `expires` out to the end of the first paid
        // period — the webhook saw it, and fired trial_convert then.
        const alreadyReported = {
          product: { id: 'premium', name: 'Premium' },
          status: 'active',
          expires: stamp(nowUNIX + 25 * DAY),
          trial: { claimed: true, expires: stamp(trialEndUNIX) },
          payment: { provider: 'stripe', resourceId: 'sub_stripe_converted', frequency: 'monthly', price: 9.99 },
        };

        expect(resolveTrialOutcomeConversion(alreadyReported, 'converted', 'USD'), 'the term has already moved past the trial, so a payment webhook reported this conversion').toBe(null);
      },
    },

    {
      // The two paths that can report a trial outcome derive their dedupe id in
      // two different files, and the whole no-double-count guarantee rests on the
      // two strings being IDENTICAL. Nothing else would notice them drifting, so
      // this compares the real output of both derivations for one subscription
      // ([#407](https://github.com/Omega-JS-Stack/omega/issues/407)).
      name: 'the-sweep-and-the-webhook-derive-the-same-trial-dedupe-id',
      async run({ expect }) {
        const nowUNIX = Math.floor(Date.now() / 1000);
        const trialEndUNIX = nowUNIX - 5 * DAY;
        const RESOURCE_ID = 'sub_shared_trial';

        const inTrial = {
          product: { id: 'premium', name: 'Premium' },
          status: 'active',
          expires: stamp(trialEndUNIX),
          trial: { claimed: true, expires: stamp(trialEndUNIX) },
          payment: { provider: 'stripe', resourceId: RESOURCE_ID, frequency: 'monthly', price: 9.99 },
        };

        // The same subscription, one charge later — what the webhook resolves.
        const converted = { ...inTrial, expires: stamp(nowUNIX + 25 * DAY) };

        for (const [outcome, transition, eventType, after] of [
          ['converted', null, 'invoice.payment_succeeded', converted],
          ['lapsed', 'payment-failed', 'invoice.payment_failed', { ...inTrial, status: 'suspended' }],
        ]) {
          const resolved = analytics.resolvePaymentEvent('subscription', transition, eventType, after, {}, null, inTrial);
          const webhookId = analytics.resolveEventId(resolved, { id: '_test-order', metadata: { updatedBy: { event: { id: 'evt_whatever' } } } });
          const sweepId = resolveTrialOutcomeConversion(inTrial, outcome, 'USD').eventId;

          expect(webhookId, `both paths must call a ${outcome} trial the same conversion`).toBe(sweepId);
          expect(webhookId.endsWith(`.${RESOURCE_ID}`), 'and both must key it on the subscription').toBe(true);
        }
      },
    },

    {
      name: 'seed-expired-trials',
      async run({ firestore, expect, state, config, skip }) {
        const paidProduct = config.payment.products.find(p => p.id !== 'basic' && p.type === 'subscription' && p.prices);

        if (!paidProduct) {
          skip('No paid subscription product configured in this brand');
        }

        state.paidProductId = paidProduct.id;

        // Five candidates, one per branch the sweep has to get right
        state.seeds = {
          // Trial ended 5 days ago; NO order doc → the provider has no such subscription
          [GONE_UID]: { expiredAgo: 5 * DAY, resourceId: 'sub_test_trial_gone', orderId: null },
          // Trial ended 5 days ago; the order says the provider cancelled it
          [CANCELLED_UID]: { expiredAgo: 5 * DAY, resourceId: 'sub_test_trial_cancelled', orderId: CANCELLED_ORDER },
          // Trial ended 5 days ago; the order says the subscription is live — it converted
          [CONVERTED_UID]: { expiredAgo: 5 * DAY, resourceId: 'sub_test_trial_converted', orderId: CONVERTED_ORDER },
          // Trial ended 2 hours ago — inside the grace window that absorbs webhook lag
          [GRACE_UID]: { expiredAgo: 2 * 60 * 60, resourceId: 'sub_test_trial_grace', orderId: null },
          // Trial ended 40 days ago — aged out below the sweep's floor
          [AGED_UID]: { expiredAgo: 40 * DAY, resourceId: 'sub_test_trial_aged', orderId: null },
        };

        const nowUNIX = Math.floor(Date.now() / 1000);

        for (const [uid, seed] of Object.entries(state.seeds)) {
          const expiredUNIX = nowUNIX - seed.expiredAgo;

          await firestore.delete(`users/${uid}`);
          await firestore.set(`users/${uid}`, {
            subscription: {
              product: { id: paidProduct.id, name: paidProduct.name || paidProduct.id },
              status: 'active',
              expires: stamp(expiredUNIX),
              trial: { claimed: true, expires: stamp(expiredUNIX) },
              cancellation: { pending: false, date: stamp(0) },
              payment: { provider: 'test', orderId: seed.orderId, resourceId: seed.resourceId, frequency: 'monthly' },
            },
          });
        }

        // The provider's answers for the two candidates that have a subscription:
        // an order whose `unified` the test library reconstructs a resource from
        await firestore.delete(`payments-orders/${CANCELLED_ORDER}`);
        await firestore.set(`payments-orders/${CANCELLED_ORDER}`, order({
          id: CANCELLED_ORDER,
          owner: CANCELLED_UID,
          productId: paidProduct.id,
          resourceId: 'sub_test_trial_cancelled',
          status: 'cancelled',
        }));

        await firestore.delete(`payments-orders/${CONVERTED_ORDER}`);
        await firestore.set(`payments-orders/${CONVERTED_ORDER}`, order({
          id: CONVERTED_ORDER,
          owner: CONVERTED_UID,
          productId: paidProduct.id,
          resourceId: 'sub_test_trial_converted',
          status: 'active',
        }));

        const seeded = await firestore.get(`users/${GONE_UID}`);
        expect(seeded.subscription.status, 'Every candidate starts active on a paid product').toBe('active');
      },
    },

    {
      name: 'the-sweep-lapses-what-the-provider-no-longer-has',
      timeout: 150000,
      async run({ firestore, expect, waitFor, pubsub, state }) {
        await pubsub.trigger('omega_cronDaily');

        await waitFor(async () => {
          const doc = await firestore.get(`users/${GONE_UID}`);
          return !!doc?.subscription?.trial?.outcome;
        }, 120000, 1000);

        const gone = await firestore.get(`users/${GONE_UID}`);

        expect(gone.subscription.trial.outcome, 'The provider has no such subscription — the trial lapsed').toBe('lapsed');
        expect(gone.subscription.status, 'A lapsed trial ends cancelled').toBe('cancelled');
        expect(gone.subscription.product.id, 'A lapsed trial ends on basic').toBe('basic');
        expect(gone.subscription.cancellation.pending, 'Nothing is left pending').toBe(false);
        expect(gone.subscription.trial.claimed, 'claimed still means "a trial happened" — the sweep never repurposes it').toBe(true);

        state.lapsedCancelledAtUNIX = gone.subscription.cancellation.date.timestampUNIX;
      },
    },

    {
      name: 'a-cancelled-subscription-lapses-the-same-way',
      timeout: 60000,
      async run({ firestore, expect, waitFor }) {
        await waitFor(async () => {
          const doc = await firestore.get(`users/${CANCELLED_UID}`);
          return !!doc?.subscription?.trial?.outcome;
        }, 30000, 500);

        const cancelled = await firestore.get(`users/${CANCELLED_UID}`);

        expect(cancelled.subscription.trial.outcome, 'The provider says cancelled — the trial lapsed').toBe('lapsed');
        expect(cancelled.subscription.status, 'A lapsed trial ends cancelled').toBe('cancelled');
        expect(cancelled.subscription.product.id, 'A lapsed trial ends on basic').toBe('basic');
      },
    },

    {
      name: 'a-converted-trial-is-stamped-and-otherwise-untouched',
      timeout: 60000,
      async run({ firestore, expect, waitFor, state }) {
        await waitFor(async () => {
          const doc = await firestore.get(`users/${CONVERTED_UID}`);
          return !!doc?.subscription?.trial?.outcome;
        }, 30000, 500);

        const converted = await firestore.get(`users/${CONVERTED_UID}`);

        expect(converted.subscription.trial.outcome, 'The provider says active — the trial converted').toBe('converted');
        expect(converted.subscription.status, 'A converted trial keeps its active subscription').toBe('active');
        expect(converted.subscription.product.id, 'A converted trial keeps its paid product').toBe(state.paidProductId);
        expect(converted.subscription.cancellation.pending, 'Nothing was cancelled').toBe(false);
      },
    },

    {
      name: 'the-window-edges-are-left-alone',
      async run({ firestore, expect, state }) {
        const grace = await firestore.get(`users/${GRACE_UID}`);
        const aged = await firestore.get(`users/${AGED_UID}`);

        expect(grace.subscription.trial.outcome, 'A trial that ended 2h ago is inside the grace window — webhook lag gets its chance first').toBe(undefined);
        expect(grace.subscription.status, 'The grace candidate is untouched').toBe('active');
        expect(grace.subscription.product.id, 'The grace candidate keeps its product').toBe(state.paidProductId);

        expect(aged.subscription.trial.outcome, 'A trial that ended 40 days ago is below the floor — history is not the sweep\'s job').toBe(undefined);
        expect(aged.subscription.status, 'The aged candidate is untouched').toBe('active');
      },
    },

    {
      name: 'a-second-run-changes-nothing',
      timeout: 150000,
      async run({ firestore, expect, waitFor, pubsub, state }) {
        // A run that skips every stamped candidate produces no signal of its own, so
        // the grace candidate becomes the marker: aged past the grace window, the
        // SECOND run must lapse it — and its stamp is proof the sweep ran to the end.
        const expiredUNIX = Math.floor(Date.now() / 1000) - 5 * DAY;
        await firestore.set(`users/${GRACE_UID}`, {
          subscription: { trial: { expires: stamp(expiredUNIX) } },
        }, { merge: true });

        await pubsub.trigger('omega_cronDaily');

        await waitFor(async () => {
          const doc = await firestore.get(`users/${GRACE_UID}`);
          return !!doc?.subscription?.trial?.outcome;
        }, 120000, 1000);

        const grace = await firestore.get(`users/${GRACE_UID}`);
        const gone = await firestore.get(`users/${GONE_UID}`);
        const converted = await firestore.get(`users/${CONVERTED_UID}`);

        expect(grace.subscription.trial.outcome, 'The second run reached the sweep and lapsed the newly-eligible candidate').toBe('lapsed');
        expect(gone.subscription.trial.outcome, 'The already-lapsed candidate is still lapsed').toBe('lapsed');
        expect(gone.subscription.cancellation.date.timestampUNIX, 'The cancellation date is the FIRST run\'s — the second run skipped it instead of writing again').toBe(state.lapsedCancelledAtUNIX);
        expect(converted.subscription.trial.outcome, 'The converted candidate is still converted').toBe('converted');
        expect(converted.subscription.status, 'The converted candidate is still active').toBe('active');
      },
    },

  ],
});

/**
 * A `$timestamp` pair from a UNIX second
 */
function stamp(unix) {
  return { timestamp: new Date(unix * 1000).toISOString(), timestampUNIX: unix };
}

/**
 * The purchase record the test provider answers `fetchResource` from — its `unified`
 * status IS what the provider reports for the subscription
 */
function order({ id, owner, productId, resourceId, status }) {
  const nowUNIX = Math.floor(Date.now() / 1000);

  return {
    id: id,
    type: 'subscription',
    owner: owner,
    productId: productId,
    provider: 'test',
    resourceId: resourceId,
    unified: {
      product: { id: productId },
      status: status,
      expires: stamp(nowUNIX + 30 * DAY),
      trial: { claimed: true, expires: stamp(nowUNIX - 5 * DAY) },
      cancellation: { pending: false },
      payment: { provider: 'test', orderId: id, resourceId: resourceId, frequency: 'monthly' },
    },
    metadata: {
      created: stamp(nowUNIX - 20 * DAY),
      updated: stamp(nowUNIX - 20 * DAY),
    },
  };
}
