import path from 'path';
import powertools from 'node-powertools';
import loadProvider from '../../../libraries/load-provider.js';
import winback from '../../../libraries/payment/winback.js';
import isTrialing from '../cancel/_is-trialing.js';

/**
 * POST /payments/winback
 * Applies the cancel-flow SAVE OFFER to the authenticated user's live
 * subscription, so the cancel they started never happens
 * ([#268](https://github.com/Omega-JS-Stack/omega/issues/268)).
 *
 * The offer is the brand's (`payment.winback` in omega.json5 — 50% off the next
 * cycle by default) and it reaches the provider as a discount, through the same
 * coupon plumbing a checkout discount code rides. The subscription itself does
 * not change: the customer keeps the plan, the cadence and the renewal date they
 * already had, and the next invoice is the only thing that moves — so the only
 * thing this route writes onto the account is the discount itself
 * (`subscription.discount`, [#325]), never the plan, the cadence or the renewal.
 *
 * Claimed ONCE per subscription: the claim is recorded on
 * payments-orders/{orderId}.requests.winback, which is also what a second call
 * is refused against (`offer-already-claimed`) — an offer that could be taken
 * every time the cancel dialog opens is a permanent discount nobody agreed to.
 * A subscription with no order doc has nowhere to record it, so it is refused
 * (`offer-not-claimable`) rather than handed an offer with no memory.
 *
 * Cross-provider and CAPABILITY-GATED, the same shape uncancel uses: a provider
 * that can discount a live subscription exports applyOffer(), one that cannot
 * simply lacks the export, and the route refuses before dispatch rather than
 * letting the caller discover it as a provider error
 * ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
 *
 * EVERY refusal here carries a machine-readable code on the response properties
 * (`additional.code`), not just the capability gate's
 * ([#311](https://github.com/Omega-JS-Stack/omega/issues/311)): the client
 * pitches the offer off the ACCOUNT alone, so a state it cannot see — an
 * admin-granted subscription with no provider details, a brand that turned the
 * offer off since the page loaded — reaches accept, and a refusal it cannot name
 * leaves the customer in a dialog arming a retry that can never succeed. The
 * codes, in the order they are refused: `confirmation-required`,
 * `offer-disabled`, `no-active-subscription`, `trial-not-eligible`,
 * `cancellation-pending`, `missing-payment-details`, `unknown-provider`,
 * `not-supported-by-provider`, `offer-not-claimable`, `offer-already-claimed`.
 * All but the first are dead ends for that account: the billing card retires the
 * offer on them and opens the questionnaire the customer came for.
 * Requires authentication.
 */
export default async ({ ctx, user, data }) => {
  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  const uid = user.auth.uid;
  const confirmed = data.confirmed;

  // Require explicit confirmation
  if (!confirmed) {
    return ctx.respond('Accepting the offer must be confirmed', {
      code: 400,
      additional: { code: 'confirmation-required' },
    });
  }

  // The brand's own offer. A brand that turned it off has no offer to apply, and
  // the client never shows the step — so a call arriving here is a stale page or
  // a hand-rolled request, and it is refused rather than given a default.
  const offer = winback.resolveOffer(ctx.omega.config);

  if (!offer.enabled) {
    ctx.log(`Winback rejected: uid=${uid}, the save offer is disabled for this brand`);
    return ctx.respond('This offer is not available', {
      code: 400,
      additional: { code: 'offer-disabled' },
    });
  }

  const subscription = user.subscription;

  // Require an ACTIVE paid subscription — there is no next cycle to discount on
  // a suspended or already-ended one
  if (!subscription || subscription.status !== 'active' || subscription.product?.id === 'basic') {
    ctx.log(`Winback rejected: uid=${uid}, status=${subscription?.status}, product=${subscription?.product?.id}`);
    return ctx.respond('No active paid subscription found', {
      code: 400,
      additional: { code: 'no-active-subscription' },
    });
  }

  // A TRIAL is never offered this: cancelling a trial ends access immediately
  // (#267) and nothing has been paid, so "off your next cycle" is not the offer
  // that state needs. The billing card gates the same way, off the same rule.
  if (isTrialing(subscription)) {
    ctx.log(`Winback rejected: uid=${uid}, subscription is still in its free trial`);
    return ctx.respond('This offer is not available on a free trial', {
      code: 400,
      additional: { code: 'trial-not-eligible' },
    });
  }

  // The offer is made BEFORE the questionnaire, so a subscription already
  // scheduled to end is past it. Undo cancellation is the honest verb there.
  if (subscription.cancellation?.pending === true) {
    ctx.log(`Winback rejected: uid=${uid}, cancellation already pending`);
    return ctx.respond('Your subscription is already scheduled to cancel', {
      code: 400,
      additional: { code: 'cancellation-pending' },
    });
  }

  const provider = subscription.payment?.provider;
  const resourceId = subscription.payment?.resourceId;

  // A paid, active subscription can still carry NO provider details at all —
  // granted by an admin, imported, a webhook backfill that never landed — and
  // the client pitches what the account says, which is "paid and active". There
  // is nothing to send a discount to, and no retry adds the details, so the
  // refusal is a dead end the billing card retires the offer on ([#311]).
  if (!provider || !resourceId) {
    ctx.log(`Winback rejected: uid=${uid}, missing provider=${provider} or resourceId=${resourceId}`);
    return ctx.respond('Subscription payment details not found', {
      code: 400,
      additional: { code: 'missing-payment-details' },
    });
  }

  // Load the provider module
  let providerModule;
  try {
    providerModule = loadProvider(path.join(import.meta.dirname, 'providers'), provider);
  } catch (e) {
    return ctx.respond(`Unknown provider: ${provider}`, {
      code: 400,
      additional: { code: 'unknown-provider' },
    });
  }

  // The capability gate. A missing export is the provider saying it cannot
  // discount a live subscription at all — a CLIENT fault to be branched on, not
  // an outage to retry, so the code rides the response properties where every
  // 4xx carries its machine-readable half, and the billing card retires the
  // offer and lets the cancel through on it.
  if (typeof providerModule.applyOffer !== 'function') {
    ctx.log(`Winback not supported: uid=${uid}, provider=${provider}`);
    return ctx.respond('Your payment provider cannot apply this offer. Please use the billing portal to manage your subscription.', {
      code: 400,
      additional: { code: 'not-supported-by-provider' },
    });
  }

  // One claim per subscription. The order doc is where the claim lives, so the
  // check reads the same document the write below lands on.
  //
  // No order doc, no claim — and an offer whose claim cannot be RECORDED is an
  // offer takeable every time the cancel dialog opens, each accept re-couponing
  // the subscription. A subscription can reach here without one (created in the
  // provider's dashboard, imported, a metadata backfill that never landed), so
  // it is refused before dispatch rather than handed an offer this route cannot
  // remember. The code rides the response properties the capability gate's does,
  // so the billing card branches on it and lets the cancel through. It is read
  // AFTER that gate: a provider that cannot discount at all is the more
  // permanent answer, and it costs no read.
  const orderId = subscription.payment?.orderId;

  if (!orderId) {
    ctx.log(`Winback rejected: uid=${uid}, the subscription carries no orderId to record the claim on`);
    return ctx.respond('This offer is not available on your subscription. Please use the billing portal to manage your subscription.', {
      code: 400,
      additional: { code: 'offer-not-claimable' },
    });
  }

  const admin = ctx.omega.firebase.admin;
  const orderRef = admin.firestore().doc(`payments-orders/${orderId}`);
  const orderDoc = await orderRef.get();

  // A past claimant reaching the cancel flow again is pitched the offer anyway
  // — the client reads the ACCOUNT, which carries no claim — so this refusal
  // rides the same branchable code the two gates above do ([#310]). Without
  // one, accepting shows an error toast and leaves the dialog armed for a retry
  // that can never succeed; with it the billing card retires the offer and
  // opens the questionnaire, which is what the customer came for.
  if (orderDoc.exists && orderDoc.data().requests?.winback) {
    ctx.log(`Winback rejected: uid=${uid}, offer already claimed on payments-orders/${orderId}`);
    return ctx.respond('You have already claimed this offer', {
      code: 400,
      additional: { code: 'offer-already-claimed' },
    });
  }

  // The offer, in the shape every downstream reader already speaks
  const discount = winback.toDiscount(offer);

  try {
    await providerModule.applyOffer({ resourceId, uid, subscription, discount, ctx });
  } catch (e) {
    // The provider's own words stay in the logs — a client gets one neutral
    // sentence, never an SDK message naming our internals ([#212]).
    ctx.error(`Failed to apply the winback offer via ${provider}: uid=${uid}, sub=${resourceId}, error=${e.message}`);
    return ctx.respond('We could not apply your discount right now. Please try again shortly.', { code: 500 });
  }

  // Record the claim. This is the offer's whole memory: the refusal above reads
  // it, and it is what an analysis of the experiment counts accepts from.
  const now = powertools.timestamp(new Date(), { output: 'string' });
  const nowUNIX = powertools.timestamp(now, { output: 'unix' });

  await orderRef.set({
    requests: {
      winback: {
        discount: discount,
        date: {
          timestamp: now,
          timestampUNIX: nowUNIX,
        },
      },
    },
  }, { merge: true });

  ctx.log(`Stored winback claim on payments-orders/${orderId}: code=${discount.code}`);

  // The ACCOUNT's half of the same claim ([#325]). The order doc is the offer's
  // memory — what a second claim is refused against — but the billing card reads
  // the account, and a saving that disappears on the next page load was never
  // announced at all. The subscription itself still does not change: this is the
  // discount riding it, not a new plan, a new cadence or a new renewal date.
  //
  // EVERY field is written, never the validate() result's own half-shape: the
  // node can already carry a checkout code's discount, and a percent claim
  // merging onto a stored amount would be read as the older, wrong number. And
  // `source` is what makes the node safe to read as a claim at all — a checkout
  // code sets the same shape, so only 'winback' is the cancel flow's signal.
  //
  // `resourceId` is the subscription it was applied TO, and it is what lets the
  // claim ever END ([#333]). The unified webhook write carries no discount key,
  // so the merge preserves this node forever: without the stamp, a customer who
  // churned and resubscribed carried a spent claim into the new subscription,
  // where `source: 'winback'` reads as "already claimed" and the save offer is
  // silently never pitched again. Stamped, the webhook pipeline clears the node
  // the moment the account's subscription is a different one.
  await admin.firestore().doc(`users/${uid}`).set({
    subscription: {
      discount: {
        valid: true,
        code: discount.code,
        percent: discount.percent || 0,
        amount: discount.amount || 0,
        duration: discount.duration,
        source: 'winback',
        resourceId: resourceId,
      },
    },
  }, { merge: true });

  ctx.log(`Stored the applied discount on users/${uid}: code=${discount.code}, sub=${resourceId}`);

  // The experiment's server-side half. The offer is measured against the
  // existing `subscription-winback` baseline (a returning subscriber the webhook
  // pipeline already reads as a purchase), so the ACCEPT is recorded where that
  // pipeline's events go — the client counts shown/declined, which never reach a
  // server at all.
  ctx.analytics.event('payments/winback', {
    code: discount.code,
    percent: discount.percent || null,
    amount: discount.amount || null,
    duration: discount.duration,
    payment_provider: provider,
    product_id: subscription.product?.id || null,
    payment_frequency: subscription.payment?.frequency || null,
  });

  ctx.log(`Winback offer applied: uid=${uid}, provider=${provider}, sub=${resourceId}, code=${discount.code}, duration=${discount.duration}`);

  return ctx.respond({ success: true, discount: discount });
};
