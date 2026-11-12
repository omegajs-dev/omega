/**
 * Payment transition detection and dispatch
 *
 * Compares subscription state before and after a webhook to detect meaningful
 * transitions (e.g., new subscription, payment failed, cancellation).
 * Dispatches to individual handler files for each transition type.
 */
const path = require('path');
const jetpack = require('fs-jetpack');
const { loadHandler } = require('../../../../libraries/load-handler.js');

// Webhook event types that mean "money went back to the customer", per provider:
// PayPal PAYMENT.SALE.REFUNDED (v1 sales) and PAYMENT.CAPTURE.REFUNDED (v2
// captures — the shape this framework's own one-time purchases refund as,
// [#240](https://github.com/Omega-JS-Stack/omega/issues/240)), Stripe
// charge.refunded, Chargebee payment_refunded (each string is the provider's
// own, as its webhook parser reports it).
const REFUND_EVENTS = ['PAYMENT.SALE.REFUNDED', 'PAYMENT.CAPTURE.REFUNDED', 'charge.refunded', 'payment_refunded'];

// How long a transition claim speaks for. The race it exists to settle is SECONDS
// wide — two provider events for one checkout, a second apart, both reading a user
// doc neither has written yet — and the retry that re-runs a failed event is
// minutes wide. Past that, the same transition name on the same order is a genuinely
// NEW occurrence, not a duplicate: the order id never changes for the subscription's
// life, so a second dunning cycle, a re-cancellation after an uncancel, and a second
// plan change all re-detect a name the order already carries. An unbounded claim
// suppressed every one of them — no dunning email, no analytics, no marketing sync,
// forever after the first ([#665](https://github.com/Omega-JS-Stack/omega/issues/665)).
const CLAIM_WINDOW_MS = 10 * 60 * 1000;

/**
 * Detect what transition occurred based on category and before/after state
 *
 * @param {string} category - 'subscription' or 'one-time'
 * @param {object|null} before - Previous state (null for new users / one-time)
 * @param {object} after - New unified state about to be written
 * @param {string} eventType - Original webhook event type (used for one-time detection)
 * @param {object} [options] - { previouslyCompleted } — this webhook doc already completed once
 * @returns {string|null} Transition name or null if no meaningful change
 */
function detectTransition(category, before, after, eventType, options) {
  if (category === 'subscription') {
    return detectSubscriptionTransition(before, after, eventType, options);
  }

  if (category === 'one-time') {
    return detectOneTimeTransition(eventType, options);
  }

  return null;
}

/**
 * Detect subscription state transitions by comparing before and after
 *
 * Checks are ordered by specificity — most specific first to avoid misclassification.
 *
 * @param {object|null} before - Previous users/{uid}.subscription (null/undefined for new users)
 * @param {object} after - New unified subscription
 * @param {string} eventType - Original webhook event type
 * @param {object} [options] - { previouslyCompleted } — this webhook doc already completed once
 * @returns {string|null} Transition name
 */
function detectSubscriptionTransition(before, after, eventType, options) {
  if (!after) {
    return null;
  }

  // Refund events take priority — detected by webhook event type rather than state diff
  // because the subscription state may not change meaningfully during a refund
  if (REFUND_EVENTS.includes(eventType)) {
    // Idempotency: refund detection is event-type-only, so a webhook doc that is
    // processed a second time (a redelivery, or a doc put back to pending) would
    // re-dispatch payment-refunded and email the customer about the same refund
    // twice. A doc that already completed once has already sent it.
    if (options?.previouslyCompleted) {
      return null;
    }

    return 'payment-refunded';
  }

  const beforeStatus = before?.status;
  const afterStatus = after.status;

  // 1. new-subscription: basic/null → active paid (handler checks after.trial.claimed for trial info)
  if (isBasicOrNull(before) && afterStatus === 'active' && isPaid(after)) {
    return 'new-subscription';
  }

  // 2. subscription-winback: cancelled paid → active paid. A full cancellation
  // leaves the paid product id in place, so a returning subscriber matched
  // nothing here — no confirmation email, and analytics read the checkout as a
  // renewal ([#218](https://github.com/Omega-JS-Stack/omega/issues/218)).
  if (beforeStatus === 'cancelled' && isPaid(before) && afterStatus === 'active' && isPaid(after)) {
    return 'subscription-winback';
  }

  // 3. checkout-declined: basic/null → suspended. Users are born active on basic,
  // so a declined FIRST checkout reads as active → suspended and used to send the
  // renewal-dunning email to someone who never had a subscription to dun.
  if (isBasicOrNull(before) && afterStatus === 'suspended') {
    return 'checkout-declined';
  }

  // 3b. checkout-declined, the win-back branch: cancelled paid → suspended. A full
  // cancellation leaves the paid product id in place, so a returning subscriber
  // whose payment declines matched NOTHING — not the rule above (before must be
  // basic), not subscription-winback (after must be active), not payment-failed
  // (before must be active) — and the webhook completed with no log and no
  // analytics ([#223](https://github.com/Omega-JS-Stack/omega/issues/223)). Same
  // handler as above: the user is standing at the checkout watching it fail, so it
  // logs and sends no dunning email.
  if (beforeStatus === 'cancelled' && isPaid(before) && afterStatus === 'suspended') {
    return 'checkout-declined';
  }

  // 4. payment-failed: active → suspended
  if (beforeStatus === 'active' && afterStatus === 'suspended') {
    return 'payment-failed';
  }

  // 5. payment-recovered: suspended → active
  if (beforeStatus === 'suspended' && afterStatus === 'active') {
    return 'payment-recovered';
  }

  // 6. cancellation-requested: pending flips from false → true while still active
  if (afterStatus === 'active' && !before?.cancellation?.pending && after.cancellation?.pending) {
    return 'cancellation-requested';
  }

  // 7. cancellation-removed: pending flips from true → false on the same product
  // while still active — the uncancel route's half of the pair above. Same product
  // and behind payment-recovered, so a plan change or a recovery that also clears
  // the schedule keeps its own, more meaningful, name.
  if (
    afterStatus === 'active'
    && before?.cancellation?.pending
    && !after.cancellation?.pending
    && before.product?.id === after.product?.id
  ) {
    return 'cancellation-removed';
  }

  // 8. subscription-cancelled: any non-cancelled → cancelled
  if (beforeStatus !== 'cancelled' && afterStatus === 'cancelled') {
    return 'subscription-cancelled';
  }

  // 9. plan-changed: both active, both paid, different product
  if (
    beforeStatus === 'active'
    && afterStatus === 'active'
    && isPaid(before)
    && isPaid(after)
    && before.product.id !== after.product.id
  ) {
    return 'plan-changed';
  }

  return null;
}

/**
 * Detect one-time payment transitions from event type
 * Simpler than subscriptions — no before/after comparison needed
 *
 * @param {string} eventType - Webhook event type
 * @param {object} [options] - { previouslyCompleted } — this webhook doc already completed once
 * @returns {string|null} Transition name
 */
function detectOneTimeTransition(eventType, options) {
  // Idempotency: EVERY transition on this side is detected from the event type
  // alone, so a webhook doc processed a second time (a redelivery, or a doc put
  // back to pending) would re-dispatch its handler — and email the customer about
  // the same purchase or refund twice. The subscription side guards its
  // event-type-only path the same way.
  if (options?.previouslyCompleted) {
    return null;
  }

  // Refunds first, and by event type alone — a one-time purchase has no
  // before/after state to diff, the event IS the transition. The strings are the
  // same provider strings the subscription side reads
  // ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
  if (REFUND_EVENTS.includes(eventType)) {
    return 'purchase-refunded';
  }

  // Stripe
  if (eventType === 'checkout.session.completed') {
    return 'purchase-completed';
  }

  if (eventType === 'invoice.payment_failed') {
    return 'purchase-failed';
  }

  // PayPal
  if (eventType === 'CHECKOUT.ORDER.APPROVED') {
    return 'purchase-completed';
  }

  // Chargebee. Its provider routes a subscription-less payment_failed to
  // category one-time (routes/payments/webhook/providers/chargebee.js), and
  // reading only Stripe's string left that whole half detecting nothing — no
  // transition, so the failed-payment email never sent
  // ([#714](https://github.com/Omega-JS-Stack/omega/issues/714)). The
  // subscription side never reaches here: it names payment-failed off the
  // active → suspended state diff, not off this string.
  if (eventType === 'payment_failed') {
    return 'purchase-failed';
  }

  // The success half of that same pair, and it has to be THIS string rather than
  // `invoice_generated`: an invoice is born unpaid (libraries/payment/providers/
  // chargebee.js maps `payment_due`/`not_paid` → failed), so mapping the generated
  // invoice would send a receipt for a purchase nobody paid for. Reading neither
  // left a paid Chargebee one-time with no receipt and no purchase analytics at all
  // ([#729](https://github.com/Omega-JS-Stack/omega/issues/729)). The subscription
  // side never reaches here either: its provider gives a payment_succeeded carrying
  // a subscription no category at all, because `subscription_renewed` owns that
  // revenue.
  if (eventType === 'payment_succeeded') {
    return 'purchase-completed';
  }

  // Coinbase Commerce. A crypto charge is a single payment, so `charge:confirmed`
  // is this provider's whole success half — the coins have settled on-chain and
  // the purchase is real ([#642](https://github.com/Omega-JS-Stack/omega/issues/642)).
  //
  // Its two siblings deliberately map to NOTHING, though both are supported by
  // the parser and both write their order: `charge:pending` is money detected but
  // not yet confirmed, so there is nothing to mail about or book yet, and
  // `charge:failed` is a hosted charge that expired unpaid — the abandoned-
  // checkout population, watched by the person who walked away from it, which is
  // exactly the population `checkout-declined` refuses to mail. (An abandoned
  // Stripe session sends nothing either; `purchase-failed` is for a MANUAL
  // invoice nobody is standing in front of.)
  if (eventType === 'charge:confirmed') {
    return 'purchase-completed';
  }

  return null;
}

/**
 * Claim a detected transition for one order, so exactly one webhook dispatches it
 *
 * Detection is a DIFF: it compares the user's stored subscription against the
 * unified state this event carries. Two webhooks for the same checkout can be in
 * flight at once (Stripe sent `customer.subscription.created` and
 * `invoice.payment_succeeded` a second apart), and both read the user doc before
 * either one's write landed — so both saw `basic`, both detected
 * `new-subscription`, and both dispatched it: two order emails, two trial_start
 * fires ([#665](https://github.com/Omega-JS-Stack/omega/issues/665)).
 *
 * The claim is the tiebreaker, keyed on the ORDER rather than the event: the
 * transaction's read locks the order document, so exactly one of the racing runs
 * writes `transitions.<name>` and the other is told who beat it. Per order per
 * transition NAME, so a later renewal, cancellation, or a genuinely second
 * subscription on its own order all still fire their own transitions.
 *
 * A claim carries its OUTCOME, not just its holder — `settleClaim()` below writes
 * it — so a `failed` claim is retakeable at any age. A winner that threw after
 * claiming (the webhook doc goes `failed`, and the frequent cron re-runs THAT SAME
 * event id) was otherwise refused by its own claim forever: no order email, no
 * analytics, no marketing sync, for a customer who paid
 * ([#665](https://github.com/Omega-JS-Stack/omega/issues/665)).
 *
 * And a claim only speaks for `CLAIM_WINDOW_MS`. Whatever its status, an older one
 * is retaken: the same transition name reaching the same order ten minutes later is
 * a new occurrence of it, not the duplicate half of a race (see the constant).
 *
 * @param {object} options
 * @param {object} options.admin - The firebase-admin handle
 * @param {string} options.orderId - The order the transition belongs to
 * @param {string} options.transitionName - e.g., 'new-subscription', 'payment-failed'
 * @param {string} options.eventId - The webhook event making the claim
 * @param {string} options.now - ISO timestamp of this run
 * @param {number} options.nowUNIX - UNIX second of this run
 * @returns {Promise<{ claimed: boolean, eventId: string }>} Whether this event won
 *   the claim, and the event id that holds it either way
 */
async function claim({ admin, orderId, transitionName, eventId, now, nowUNIX }) {
  const orderRef = admin.firestore().doc(`payments-orders/${orderId}`);

  return admin.firestore().runTransaction(async (transaction) => {
    const orderDoc = await transaction.get(orderRef);
    const existing = orderDoc.data()?.transitions?.[transitionName];

    // A FAILED claim is retaken at any age — that IS the retry path, the same one
    // the webhook and dispute-alert routes reclaim their own docs from. So is a
    // claim older than the window, whatever it says: that is a repeat of the
    // transition, not the duplicate half of a race. Anything else — a claim still
    // running, or one that finished seconds ago — refuses whoever asks, including
    // the event that holds it. A claim with no stamp cannot be shown to be fresh.
    const spent = existing && (nowUNIX - (existing.timestampUNIX || 0)) * 1000 >= CLAIM_WINDOW_MS;

    if (existing && existing.status !== 'failed' && !spent) {
      return { claimed: false, eventId: existing.eventId || 'unknown' };
    }

    transaction.set(orderRef, {
      transitions: {
        [transitionName]: {
          eventId: eventId,
          status: 'claimed',
          timestamp: now,
          timestampUNIX: nowUNIX,
        },
      },
    }, { merge: true });

    return { claimed: true, eventId: eventId };
  });
}

/**
 * Record how the run that WON a claim ended, so a retry can tell the two apart
 *
 * The claim is taken before anything acts on the transition, and the run holding
 * it can still throw afterwards. `done` is stamped once the dispatch, the
 * analytics fire and the marketing sync are away; `failed` is stamped beside the
 * webhook doc's own failure stamp, and is the only state `claim()` retakes.
 *
 * Only the run that took the claim ever calls this — a run that LOST one settles
 * nothing, and neither does a transition that had no order to claim on.
 *
 * @param {object} options
 * @param {object} options.admin - The firebase-admin handle
 * @param {object} options.claim - The claim this run won: `{ orderId, transitionName }`
 * @param {string} options.status - 'done' or 'failed'
 * @returns {Promise<void>}
 */
async function settleClaim({ admin, claim, status }) {
  if (!claim.orderId || !claim.transitionName) {
    return;
  }

  await admin.firestore().doc(`payments-orders/${claim.orderId}`).set({
    transitions: {
      [claim.transitionName]: {
        status: status,
      },
    },
  }, { merge: true });
}

/**
 * Dispatch a transition handler (fire-and-forget)
 *
 * @param {string} transitionName - e.g., 'new-subscription', 'payment-failed'
 * @param {string} category - 'subscription' or 'one-time'
 * @param {object} context - Full context passed to the handler
 */
function dispatch(transitionName, category, context) {
  const { ctx } = context;
  const handlerPath = path.join(__dirname, category, `${transitionName}.js`);

  // Neither a missing file nor a broken one fails the webhook; a broken one is reported
  if (!jetpack.exists(handlerPath)) {
    ctx.error(`Transition handler [${category}/${transitionName}] not found: ${handlerPath}`);
    return;
  }

  let handler;

  try {
    handler = loadHandler(handlerPath);
  } catch (e) {
    ctx.report(`Transition handler [${category}/${transitionName}] failed to load: ${e.message}`, { code: 500 });
    return;
  }

  // Fire-and-forget: don't block the main webhook processing
  Promise.resolve(handler(context)).catch((e) => {
    ctx.error(`Transition handler [${category}/${transitionName}] failed: ${e.message}`, e);
  });
}

// ─── Helpers ───

function isBasicOrNull(sub) {
  return !sub || !sub.product || sub.product.id === 'basic';
}

function isPaid(sub) {
  return sub && sub.product && sub.product.id !== 'basic';
}

module.exports = {
  detectTransition,
  detectSubscriptionTransition,
  detectOneTimeTransition,
  claim,
  settleClaim,
  dispatch,
  CLAIM_WINDOW_MS,
  // Exported for testing
  REFUND_EVENTS,
  isBasicOrNull,
  isPaid,
};
