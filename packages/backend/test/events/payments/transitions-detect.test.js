/**
 * Test: payment transition detection
 * Unit tests for detectSubscriptionTransition() — a pure function over the
 * before/after unified subscription plus the webhook's event type.
 *
 * Covers the two things the event type alone decides:
 *   1. Refund detection, which must know EVERY provider's refund event string
 *      (the strings are pinned against each provider's own webhook parser here,
 *      so a parser that renames one fails this test instead of silently dropping
 *      the customer's refund email)
 *   2. Refund idempotency — a webhook doc that already completed once must not
 *      dispatch payment-refunded (and its email) a second time
 *   3. The one-time side of the same question — detectOneTimeTransition() reads
 *      the event type alone, so EVERY one-time transition needs that same
 *      idempotency guard, not just the refund
 *
 * And the state rules, where ORDER inside the array is the behavior: each rule
 * added here is proved to fire AND proved not to shadow the rule it sits in
 * front of ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
 */
const fs = require('fs');
const path = require('path');
const transitions = require('../../../dist/omega/events/firestore/payments-webhooks/transitions/index.js');
const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const stripeProvider = require('../../../dist/omega/routes/payments/webhook/providers/stripe.js');
const paypalProvider = require('../../../dist/omega/routes/payments/webhook/providers/paypal.js');
const chargebeeProvider = require('../../../dist/omega/routes/payments/webhook/providers/chargebee.js');
const coinbaseProvider = require('../../../dist/omega/routes/payments/webhook/providers/coinbase.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

// Every transition name the detector can return, and the category whose folder
// holds its handler file
const HANDLED_TRANSITIONS = [
  ['subscription', 'new-subscription'],
  ['subscription', 'subscription-winback'],
  ['subscription', 'checkout-declined'],
  ['subscription', 'payment-failed'],
  ['subscription', 'payment-recovered'],
  ['subscription', 'cancellation-requested'],
  ['subscription', 'cancellation-removed'],
  ['subscription', 'subscription-cancelled'],
  ['subscription', 'plan-changed'],
  ['subscription', 'payment-refunded'],
  ['one-time', 'purchase-completed'],
  ['one-time', 'purchase-failed'],
  ['one-time', 'purchase-refunded'],
];

// A paid, active unified subscription — the shape a refund webhook arrives against
function paidSubscription() {
  return {
    product: { id: 'premium', name: 'Premium' },
    status: 'active',
    cancellation: { pending: false },
    payment: { frequency: 'monthly', price: 9.99 },
  };
}

// A user doc's birth state: active on basic, never subscribed to anything
function basicSubscription() {
  return {
    product: { id: 'basic', name: 'Basic' },
    status: 'active',
    cancellation: { pending: false },
    payment: {},
  };
}

// A fully cancelled paid subscriber — the state a win-back starts from
function cancelledSubscription() {
  return {
    product: { id: 'premium', name: 'Premium' },
    status: 'cancelled',
    cancellation: { pending: false },
    payment: { frequency: 'monthly', price: 9.99 },
  };
}

module.exports = defineCases({
  description: 'Payment transition detection (state rules, refund events + idempotency)',
  type: 'group',

  tests: [
    // ─── State rules: win-back ───

    {
      name: 'detects-a-win-back',
      async run({ expect }) {
        // A subscriber who cancelled outright and came back: the product id stays
        // paid through the cancellation, so no rule but this one describes it
        const detected = transitions.detectSubscriptionTransition(cancelledSubscription(), paidSubscription(), 'customer.subscription.created');

        expect(detected, 'cancelled paid → active paid should detect subscription-winback').toBe('subscription-winback');
      },
    },

    {
      name: 'a-first-subscription-is-still-new-subscription',
      async run({ expect }) {
        // The win-back rule sits behind new-subscription — a user arriving from
        // basic is still buying for the first time
        const detected = transitions.detectSubscriptionTransition(basicSubscription(), paidSubscription(), 'customer.subscription.created');

        expect(detected, 'basic → active paid should still detect new-subscription').toBe('new-subscription');
      },
    },

    {
      name: 'a-cancelled-basic-user-subscribing-is-still-new-subscription',
      async run({ expect }) {
        // A cancellation that also downgraded the product leaves nothing to win
        // back — that user reads as a first purchase, as it always has
        const before = cancelledSubscription();
        before.product = { id: 'basic', name: 'Basic' };

        const detected = transitions.detectSubscriptionTransition(before, paidSubscription(), 'customer.subscription.created');

        expect(detected, 'cancelled basic → active paid should still detect new-subscription').toBe('new-subscription');
      },
    },

    // ─── State rules: checkout decline ───

    {
      name: 'detects-a-first-checkout-decline',
      async run({ expect }) {
        // A user doc is born active on basic, so a declined FIRST checkout is
        // basic active → suspended: a checkout the user is watching fail, not a
        // renewal that needs dunning
        const after = paidSubscription();
        after.status = 'suspended';

        const detected = transitions.detectSubscriptionTransition(basicSubscription(), after, 'customer.subscription.created');

        expect(detected, 'basic → suspended should detect checkout-declined').toBe('checkout-declined');
      },
    },

    {
      name: 'a-new-user-declining-is-also-a-checkout-decline',
      async run({ expect }) {
        // No user doc at all (no before state) is the same case
        const after = paidSubscription();
        after.status = 'suspended';

        const detected = transitions.detectSubscriptionTransition(null, after, 'customer.subscription.created');

        expect(detected, 'null → suspended should detect checkout-declined').toBe('checkout-declined');
      },
    },

    {
      name: 'detects-a-declined-win-back-checkout',
      async run({ expect }) {
        // The win-back branch of the same moment: a full cancellation leaves the
        // PAID product id on the user doc, so a returning subscriber whose payment
        // declines is cancelled paid → suspended — not the rule above (before must
        // be basic), not subscription-winback (after must be active), not
        // payment-failed (before must be active). It matched nothing at all, and
        // the webhook completed with no log and no analytics
        // ([#223](https://github.com/Omega-JS-Stack/omega/issues/223))
        const after = paidSubscription();
        after.status = 'suspended';

        const detected = transitions.detectSubscriptionTransition(cancelledSubscription(), after, 'customer.subscription.created');

        expect(detected, 'cancelled paid → suspended should detect checkout-declined').toBe('checkout-declined');
      },
    },

    {
      name: 'a-returning-subscriber-who-pays-is-still-a-win-back',
      async run({ expect }) {
        // The declined-win-back rule sits BEHIND subscription-winback — the same
        // before state, and only the outcome tells them apart
        const detected = transitions.detectSubscriptionTransition(cancelledSubscription(), paidSubscription(), 'customer.subscription.created');

        expect(detected, 'cancelled paid → active paid should still detect subscription-winback').toBe('subscription-winback');
      },
    },

    {
      name: 'a-paying-subscriber-still-gets-payment-failed',
      async run({ expect }) {
        // The decline rule sits in FRONT of payment-failed, so this is the one
        // that proves it did not swallow the dunning case it precedes
        const after = paidSubscription();
        after.status = 'suspended';

        const detected = transitions.detectSubscriptionTransition(paidSubscription(), after, 'invoice.payment_failed');

        expect(detected, 'active paid → suspended should still detect payment-failed').toBe('payment-failed');
      },
    },

    {
      name: 'a-second-decline-event-fires-nothing',
      async run({ expect }) {
        // The declined checkout's failed invoice arrives after the subscription
        // event already suspended the user — suspended → suspended, no repeat
        const before = paidSubscription();
        before.status = 'suspended';
        const after = paidSubscription();
        after.status = 'suspended';

        const detected = transitions.detectSubscriptionTransition(before, after, 'invoice.payment_failed');

        expect(detected, 'suspended → suspended should detect nothing').toBe(null);
      },
    },

    // ─── State rules: recovery ───

    {
      name: 'detects-a-plain-recovery',
      async run({ expect }) {
        // Dunning's happy ending, with no cancellation schedule in the way:
        // the retry succeeded and the provider put the subscriber back
        const before = paidSubscription();
        before.status = 'suspended';

        const detected = transitions.detectSubscriptionTransition(before, paidSubscription(), 'invoice.payment_succeeded');

        expect(detected, 'suspended → active should detect payment-recovered').toBe('payment-recovered');
      },
    },

    // ─── State rules: cancellation withdrawn ───

    {
      name: 'detects-a-cancellation-being-withdrawn',
      async run({ expect }) {
        const before = paidSubscription();
        before.cancellation = { pending: true };

        const detected = transitions.detectSubscriptionTransition(before, paidSubscription(), 'customer.subscription.updated');

        expect(detected, 'pending true → false while active should detect cancellation-removed').toBe('cancellation-removed');
      },
    },

    {
      name: 'a-cancellation-being-scheduled-is-still-cancellation-requested',
      async run({ expect }) {
        const after = paidSubscription();
        after.cancellation = { pending: true };

        const detected = transitions.detectSubscriptionTransition(paidSubscription(), after, 'customer.subscription.updated');

        expect(detected, 'pending false → true should still detect cancellation-requested').toBe('cancellation-requested');
      },
    },

    {
      name: 'a-recovery-that-clears-a-pending-cancellation-is-still-payment-recovered',
      async run({ expect }) {
        // The withdrawal rule sits BEHIND payment-recovered — money moving is the
        // more meaningful half of a suspended subscriber coming back
        const before = paidSubscription();
        before.status = 'suspended';
        before.cancellation = { pending: true };

        const detected = transitions.detectSubscriptionTransition(before, paidSubscription(), 'invoice.payment_succeeded');

        expect(detected, 'suspended → active should still detect payment-recovered').toBe('payment-recovered');
      },
    },

    {
      name: 'a-plan-change-that-clears-a-pending-cancellation-is-still-plan-changed',
      async run({ expect }) {
        // Same product is part of the rule, so switching plans stays a plan change
        const before = paidSubscription();
        before.cancellation = { pending: true };
        const after = paidSubscription();
        after.product = { id: 'pro', name: 'Pro' };

        const detected = transitions.detectSubscriptionTransition(before, after, 'customer.subscription.updated');

        expect(detected, 'A different product should still detect plan-changed').toBe('plan-changed');
      },
    },

    // ─── State rules: cancellation ───

    {
      name: 'detects-a-cancellation',
      async run({ expect }) {
        // The term actually ended (or the provider deleted the subscription):
        // any non-cancelled state arriving at cancelled is the one rule for it
        const after = paidSubscription();
        after.status = 'cancelled';

        const detected = transitions.detectSubscriptionTransition(paidSubscription(), after, 'customer.subscription.deleted');

        expect(detected, 'active paid → cancelled should detect subscription-cancelled').toBe('subscription-cancelled');
      },
    },

    {
      name: 'a-cancellation-that-also-drops-the-product-is-still-a-cancellation',
      async run({ expect }) {
        // The cancel route writes cancelled AND resets to basic in one go — the
        // product moving must not make this read as a plan change
        const after = cancelledSubscription();
        after.product = { id: 'basic', name: 'Basic' };

        const detected = transitions.detectSubscriptionTransition(paidSubscription(), after, 'customer.subscription.deleted');

        expect(detected, 'active paid → cancelled basic should still detect subscription-cancelled').toBe('subscription-cancelled');
      },
    },

    {
      name: 'a-second-cancellation-event-fires-nothing',
      async run({ expect }) {
        // The rule reads the EDGE (non-cancelled → cancelled), so a redelivered
        // deletion against an already-cancelled subscriber sends no second email
        const detected = transitions.detectSubscriptionTransition(cancelledSubscription(), cancelledSubscription(), 'customer.subscription.deleted');

        expect(detected, 'cancelled → cancelled should detect nothing').toBe(null);
      },
    },

    // ─── State rules: plan change ───

    {
      name: 'detects-a-plan-change',
      async run({ expect }) {
        const after = paidSubscription();
        after.product = { id: 'pro', name: 'Pro' };

        const detected = transitions.detectSubscriptionTransition(paidSubscription(), after, 'customer.subscription.updated');

        expect(detected, 'active premium → active pro should detect plan-changed').toBe('plan-changed');
      },
    },

    {
      name: 'a-frequency-only-switch-detects-nothing',
      async run({ expect }) {
        // The rule keys on the PRODUCT, so monthly → annually on the same plan
        // has no transition of its own. Recorded here because it is a real gap in
        // the table, not an accident: the plan route's own tests pin the state it
        // writes, and analytics reads the renewal, but no email fires for it
        const after = paidSubscription();
        after.payment = { frequency: 'annually', price: 99.99 };

        const detected = transitions.detectSubscriptionTransition(paidSubscription(), after, 'customer.subscription.updated');

        expect(detected, 'A frequency-only switch has no transition rule').toBe(null);
      },
    },

    // ─── The guards around the table ───

    {
      name: 'no-after-state-detects-nothing',
      async run({ expect }) {
        // The first line of the detector: with nothing to compare against, every
        // rule below would read `undefined.status` and throw
        expect(transitions.detectSubscriptionTransition(paidSubscription(), null, 'customer.subscription.updated'), 'A null after state should detect nothing').toBe(null);
        expect(transitions.detectSubscriptionTransition(paidSubscription(), undefined, 'customer.subscription.updated'), 'An undefined after state should detect nothing').toBe(null);
      },
    },

    {
      name: 'an-unknown-category-detects-nothing',
      async run({ expect }) {
        // on-write refuses an unknown category before it ever gets here, so this
        // is the detector's own belt: a category it does not know routes nowhere
        const detected = transitions.detectTransition('donation', null, paidSubscription(), 'charge.refunded');

        expect(detected, 'An unknown category should route to no transition').toBe(null);
      },
    },

    {
      name: 'an-unknown-event-type-detects-nothing-on-either-side',
      async run({ expect }) {
        // The one-time side reads the event type ALONE, so an event nothing maps
        // must come back null rather than falling into the last rule it read
        expect(transitions.detectOneTimeTransition('customer.subscription.trial_will_end'), 'An unmapped event should detect no one-time transition').toBe(null);

        // The subscription side ignores the event type unless it is a refund, so
        // an unknown type over an unchanged subscription (a renewal) is also null
        expect(transitions.detectSubscriptionTransition(paidSubscription(), paidSubscription(), 'invoice.payment_succeeded'), 'A renewal has no transition of its own').toBe(null);
      },
    },

    {
      name: 'the-paid-helpers-read-the-product-not-the-status',
      async run({ expect }) {
        // Every rule in the table branches on these two in boolean position, and
        // both answer for a subscription in ANY status — the status is the other
        // half of each rule, never these
        expect(transitions.isBasicOrNull(null), 'No subscription at all is basic-or-null').toBeTruthy();
        expect(transitions.isBasicOrNull({ status: 'active' }), 'A subscription with no product is basic-or-null').toBeTruthy();
        expect(transitions.isBasicOrNull(basicSubscription()), 'Basic is basic-or-null').toBeTruthy();
        expect(!transitions.isBasicOrNull(cancelledSubscription()), 'A cancelled PAID subscription is not basic — that is what makes the win-back rules necessary').toBeTruthy();

        expect(!transitions.isPaid(null), 'No subscription at all is not paid').toBeTruthy();
        expect(!transitions.isPaid(basicSubscription()), 'Basic is not paid').toBeTruthy();
        expect(transitions.isPaid(cancelledSubscription()), 'A cancelled paid subscription still reads as paid').toBeTruthy();
      },
    },

    // ─── Every rule has somewhere to dispatch ───

    {
      name: 'every-detectable-transition-has-a-handler-file',
      async run({ expect }) {
        // dispatch() resolves <category>/<name>.js by name — a rule whose handler
        // file is missing logs "not found" and silently sends the customer nothing
        const root = path.join(__dirname, '../../../dist/omega/events/firestore/payments-webhooks/transitions');

        for (const [category, name] of HANDLED_TRANSITIONS) {
          const handlerPath = path.join(root, category, `${name}.js`);

          expect(fs.existsSync(handlerPath), `Transition ${category}/${name} should have a handler file`).toBeTruthy();
          expect(typeof loadHandler(handlerPath), `Transition ${category}/${name} handler should export a function`).toBe('function');
        }
      },
    },

    // ─── Refund event strings, per provider ───

    {
      name: 'detects-stripe-refund',
      async run({ expect }) {
        const detected = transitions.detectSubscriptionTransition(paidSubscription(), paidSubscription(), 'charge.refunded');

        expect(detected, 'charge.refunded should detect payment-refunded').toBe('payment-refunded');
        expect(stripeProvider.isSupported('charge.refunded'), 'Stripe provider should accept the same event string').toBeTruthy();
      },
    },

    {
      name: 'detects-paypal-refund',
      async run({ expect }) {
        const detected = transitions.detectSubscriptionTransition(paidSubscription(), paidSubscription(), 'PAYMENT.SALE.REFUNDED');

        expect(detected, 'PAYMENT.SALE.REFUNDED should detect payment-refunded').toBe('payment-refunded');
        expect(paypalProvider.isSupported('PAYMENT.SALE.REFUNDED'), 'PayPal provider should accept the same event string').toBeTruthy();
      },
    },

    {
      name: 'detects-chargebee-refund',
      async run({ expect }) {
        const detected = transitions.detectSubscriptionTransition(paidSubscription(), paidSubscription(), 'payment_refunded');

        expect(detected, 'payment_refunded should detect payment-refunded').toBe('payment-refunded');
        expect(chargebeeProvider.isSupported('payment_refunded'), 'Chargebee provider should accept the same event string').toBeTruthy();
      },
    },

    {
      name: 'a-refund-outranks-every-state-rule',
      async run({ expect }) {
        // The refund check sits in FRONT of the whole table, deliberately: a full
        // refund usually cancels the subscription in the same breath, and reading
        // that state diff instead would send the cancellation email for a refund
        const after = paidSubscription();
        after.status = 'cancelled';

        const detected = transitions.detectSubscriptionTransition(paidSubscription(), after, 'charge.refunded');

        expect(detected, 'A refund that also cancels should still detect payment-refunded').toBe('payment-refunded');
      },
    },

    {
      name: 'every-refund-event-is-a-parsed-event',
      async run({ expect }) {
        // Each refund string must be one a webhook parser actually delivers —
        // an event no provider reports could never fire the transition
        for (const eventType of transitions.REFUND_EVENTS) {
          const supported = stripeProvider.isSupported(eventType)
            || paypalProvider.isSupported(eventType)
            || chargebeeProvider.isSupported(eventType);

          expect(supported, `Refund event ${eventType} should be supported by a webhook provider`).toBeTruthy();
        }
      },
    },

    // ─── One-time refunds ───

    {
      name: 'detects-a-one-time-refund',
      async run({ expect }) {
        const detected = transitions.detectOneTimeTransition('charge.refunded');

        expect(detected, 'A refunded one-time purchase should detect purchase-refunded').toBe('purchase-refunded');
      },
    },

    {
      name: 'every-refund-event-detects-on-the-one-time-side',
      async run({ expect }) {
        // The one-time side reads the same provider strings the subscription
        // side does — a refund is a refund whichever thing was bought
        for (const eventType of transitions.REFUND_EVENTS) {
          expect(transitions.detectOneTimeTransition(eventType), `${eventType} should detect purchase-refunded for a one-time purchase`).toBe('purchase-refunded');
        }
      },
    },

    {
      name: 'dispatches-a-one-time-refund-through-detect-transition',
      async run({ expect }) {
        // The path on-write actually calls: category + event type, no before state
        const detected = transitions.detectTransition('one-time', null, { product: { id: 'credits' }, status: 'completed' }, 'charge.refunded');

        expect(detected, 'A one-time refund should route to purchase-refunded').toBe('purchase-refunded');
      },
    },

    {
      name: 'a-one-time-purchase-still-detects-purchase-completed',
      async run({ expect }) {
        // The refund mapping must not shadow the events already on this side
        expect(transitions.detectOneTimeTransition('checkout.session.completed'), 'A completed checkout is still a purchase').toBe('purchase-completed');
        expect(transitions.detectOneTimeTransition('CHECKOUT.ORDER.APPROVED'), 'An approved PayPal order is still a purchase').toBe('purchase-completed');
        expect(transitions.detectOneTimeTransition('invoice.payment_failed'), 'A failed one-time invoice is still a failure').toBe('purchase-failed');
      },
    },

    {
      name: 'a-chargebee-one-time-failure-detects-through-the-provider-fold',
      async run({ expect }) {
        // The fold the pipeline runs: the provider categorizes a
        // subscription-less payment_failed as one-time, and the detector reads
        // the provider's OWN event string off that same parse. Reading only
        // Stripe's string left the Chargebee half of this path detecting
        // nothing, so the failed-payment email never sent
        // ([#714](https://github.com/Omega-JS-Stack/omega/issues/714)).
        const parsed = chargebeeProvider.parseWebhook({
          body: {
            id: 'ev_cb_onetime_fail',
            event_type: 'payment_failed',
            content: {
              invoice: { id: 'inv_cb_onetime_fail' },
              customer: { id: 'cust_cb_onetime', meta_data: '{"uid":"_test-cb-onetime-fail"}' },
            },
          },
        });

        expect(parsed.category, 'A subscription-less Chargebee payment_failed parses as one-time').toBe('one-time');

        const detected = transitions.detectTransition(parsed.category, null, { product: { id: 'credits' }, status: 'failed' }, parsed.eventType);

        expect(detected, 'Chargebee payment_failed should detect purchase-failed for a one-time purchase').toBe('purchase-failed');
      },
    },

    {
      name: 'a-chargebee-one-time-purchase-detects-through-the-provider-fold',
      async run({ expect }) {
        // The success half of the same fold: a subscription-less
        // payment_succeeded is the honest paid signal for a one-time purchase.
        // Nothing on this side read it, so a paid Chargebee one-time sent no
        // receipt and fired no purchase analytics
        // ([#729](https://github.com/Omega-JS-Stack/omega/issues/729)).
        const parsed = chargebeeProvider.parseWebhook({
          body: {
            id: 'ev_cb_onetime_paid',
            event_type: 'payment_succeeded',
            content: {
              invoice: { id: 'inv_cb_onetime_paid' },
              customer: { id: 'cust_cb_onetime', meta_data: '{"uid":"_test-cb-onetime-paid"}' },
            },
          },
        });

        expect(parsed.category, 'A subscription-less Chargebee payment_succeeded parses as one-time').toBe('one-time');

        const detected = transitions.detectTransition(parsed.category, null, { product: { id: 'credits' }, status: 'completed' }, parsed.eventType);

        expect(detected, 'Chargebee payment_succeeded should detect purchase-completed for a one-time purchase').toBe('purchase-completed');
      },
    },

    {
      name: 'a-coinbase-charge-detects-through-the-provider-fold',
      async run({ expect }) {
        // Crypto's half of the same fold: every Coinbase Commerce event is about
        // a CHARGE, which is one purchase, so the provider categorizes all three
        // as one-time and the detector reads the provider's own event strings
        // ([#642](https://github.com/Omega-JS-Stack/omega/issues/642)).
        const confirmed = coinbaseProvider.parseWebhook({
          body: {
            id: '_test-delivery',
            event: {
              id: '_test-evt-coinbase-confirmed',
              type: 'charge:confirmed',
              data: { id: 'ch_coinbase_confirmed', metadata: { uid: '_test-coinbase-fold', orderId: 'ord-1', productId: 'credits' } },
            },
          },
        });

        expect(confirmed.category, 'A confirmed crypto charge parses as one-time').toBe('one-time');
        expect(transitions.detectTransition(confirmed.category, null, { product: { id: 'credits' }, status: 'completed' }, confirmed.eventType), 'charge:confirmed should detect purchase-completed — the crypto settled').toBe('purchase-completed');
      },
    },

    {
      name: 'an-unsettled-or-expired-crypto-charge-detects-nothing',
      async run({ expect }) {
        // Both write their order (so the account page tells the truth about it)
        // and neither may MAIL: charge:pending is money detected on-chain but not
        // confirmed, and charge:failed is an expired hosted page — the abandoned
        // -checkout population, watched by the person who walked away from it,
        // which is exactly the population checkout-declined refuses to mail. An
        // abandoned Stripe session sends nothing either ([#642]).
        expect(transitions.detectOneTimeTransition('charge:pending'), 'Nothing is mailed for money that has not settled').toBe(null);
        expect(transitions.detectOneTimeTransition('charge:failed'), 'And nothing is mailed for a checkout nobody paid').toBe(null);
      },
    },

    {
      name: 'a-chargebee-renewal-charge-never-reaches-the-one-time-side',
      async run({ expect }) {
        // With a subscription present, payment_succeeded is the renewal's charge
        // and `subscription_renewed` already carries it — so the provider gives it
        // no category, no doc is stored, and nothing double-fires ([#729]).
        const parsed = chargebeeProvider.parseWebhook({
          body: {
            id: 'ev_cb_renewal_paid',
            event_type: 'payment_succeeded',
            content: {
              subscription: { id: 'sub_cb_renewal', meta_data: '{"uid":"_test-cb-renewal"}' },
              invoice: { id: 'inv_cb_renewal', subscription_id: 'sub_cb_renewal' },
            },
          },
        });

        expect(parsed.category, 'A Chargebee payment_succeeded carrying a subscription parses as null').toBe(null);
        expect(transitions.detectTransition(parsed.category, null, {}, parsed.eventType), 'No category → no transition').toBe(null);
      },
    },

    {
      name: 'an-unpaid-chargebee-invoice-detects-nothing',
      async run({ expect }) {
        // `invoice_generated` still stores its one-time doc, but an invoice is
        // born UNPAID (the Chargebee library maps `payment_due`/`not_paid` →
        // failed), so it must stay transition-less — mapping it would email a
        // receipt for a purchase nobody paid for ([#729]).
        const parsed = chargebeeProvider.parseWebhook({
          body: {
            id: 'ev_cb_invoice_generated',
            event_type: 'invoice_generated',
            content: {
              invoice: { id: 'inv_cb_unpaid' },
              customer: { id: 'cust_cb_onetime', meta_data: '{"uid":"_test-cb-unpaid"}' },
            },
          },
        });

        expect(parsed.category, 'A non-recurring invoice_generated still parses as one-time').toBe('one-time');

        const detected = transitions.detectTransition(parsed.category, null, { product: { id: 'credits' }, status: 'pending' }, parsed.eventType);

        expect(detected, 'invoice_generated is not a paid signal — no transition, no receipt').toBe(null);
      },
    },

    {
      name: 'a-redelivered-chargebee-purchase-dispatches-nothing',
      async run({ expect }) {
        // The new arm is event-type-only like the rest of this side, so it needs
        // the same idempotency guard — one purchase, one receipt
        expect(transitions.detectOneTimeTransition('payment_succeeded', { previouslyCompleted: true }), 'A reprocessed Chargebee purchase should dispatch nothing').toBe(null);
        expect(transitions.detectOneTimeTransition('payment_succeeded', { previouslyCompleted: false }), 'A first-pass Chargebee purchase should still dispatch').toBe('purchase-completed');
      },
    },

    // ─── Refund idempotency ───

    {
      name: 'refund-fires-on-first-pass',
      async run({ expect }) {
        const detected = transitions.detectSubscriptionTransition(
          paidSubscription(), paidSubscription(), 'charge.refunded', { previouslyCompleted: false },
        );

        expect(detected, 'A first-pass refund should dispatch').toBe('payment-refunded');
      },
    },

    {
      name: 'refund-suppressed-when-doc-already-completed',
      async run({ expect }) {
        const detected = transitions.detectSubscriptionTransition(
          paidSubscription(), paidSubscription(), 'charge.refunded', { previouslyCompleted: true },
        );

        expect(detected, 'A reprocessed refund webhook should dispatch nothing (one refund, one email)').toBe(null);
      },
    },

    {
      name: 'a-redelivered-one-time-completion-dispatches-nothing',
      async run({ expect }) {
        // The whole one-time side reads the event type alone, so a doc that
        // already completed once would re-dispatch its confirmation email on a
        // redelivery — the same hole the subscription refund path closed
        const detected = transitions.detectOneTimeTransition('checkout.session.completed', { previouslyCompleted: true });

        expect(detected, 'A reprocessed one-time completion should dispatch nothing (one purchase, one email)').toBe(null);
      },
    },

    {
      name: 'a-first-pass-one-time-completion-still-dispatches',
      async run({ expect }) {
        const detected = transitions.detectOneTimeTransition('checkout.session.completed', { previouslyCompleted: false });

        expect(detected, 'A first-pass one-time completion should still dispatch').toBe('purchase-completed');
      },
    },

    {
      name: 'the-one-time-guard-reaches-detect-transition',
      async run({ expect }) {
        // The path on-write actually calls — the options have to travel through it
        const detected = transitions.detectTransition('one-time', null, { product: { id: 'credits' }, status: 'completed' }, 'checkout.session.completed', { previouslyCompleted: true });

        expect(detected, 'A reprocessed one-time webhook should dispatch nothing through detectTransition').toBe(null);
      },
    },

    {
      name: 'reprocess-does-not-suppress-other-transitions',
      async run({ expect }) {
        // The guard covers the refund path only — a reprocessed state change is
        // still detected from the before/after diff
        const before = paidSubscription();
        const after = paidSubscription();
        after.status = 'cancelled';

        const detected = transitions.detectSubscriptionTransition(
          before, after, 'customer.subscription.deleted', { previouslyCompleted: true },
        );

        expect(detected, 'A cancellation should still be detected on a reprocess').toBe('subscription-cancelled');
      },
    },
  ],
});
