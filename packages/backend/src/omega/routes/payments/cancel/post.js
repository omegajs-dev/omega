import path from 'path';
import loadProvider from '../../../libraries/load-provider.js';
import powertools from 'node-powertools';
import isAlreadyGone from '../../../libraries/payment/provider-errors.js';
import isTrialing from './_is-trialing.js';

/**
 * POST /payments/cancel
 * Cancels the authenticated user's subscription at the end of the current billing period.
 * Delegates to the provider (e.g., Stripe) to set cancel_at_period_end=true.
 * The resulting webhook triggers the Firestore pipeline which updates subscription state
 * and fires the cancellation-requested transition handler.
 * Stores the cancellation reason/feedback on payments-orders/{orderId}.requests.cancellation.
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
    return ctx.respond('Cancellation must be confirmed', { code: 400 });
  }

  const subscription = user.subscription;

  // Require an active or suspended paid subscription
  if (!subscription || (subscription.status !== 'active' && subscription.status !== 'suspended') || subscription.product?.id === 'basic') {
    ctx.log(`Cancel rejected: uid=${uid}, status=${subscription?.status}, product=${subscription?.product?.id}`);
    return ctx.respond('No active paid subscription found', { code: 400 });
  }

  // `skipGuards` arrives in the request body, so it is a REQUEST, not a decision:
  // it is honored for an admin, or anywhere outside a real deployment (the test
  // suites and the dev palette cancel seeded subscriptions minutes old). Every
  // other caller is ignored — loudly — and the guards below run as normal.
  const mayBypassGuards = user.roles?.admin === true || ctx.isDevelopment() || ctx.isTesting();
  const skipGuards = data.skipGuards === true && mayBypassGuards;

  if (data.skipGuards === true && !mayBypassGuards) {
    ctx.warn(`Ignoring skipGuards on cancel: uid=${uid} is not permitted to bypass the cancellation guards`);
  }

  // Guard: subscription younger than 24 hours (privileged callers may bypass via skipGuards).
  //
  // A TRIAL is exempt ([#267](https://github.com/Omega-JS-Stack/omega/issues/267)):
  // the guard exists to stop a cancellation racing a PAID checkout that is still
  // settling, and a trial has no payment to settle. Blocking it told the most
  // common trial behavior there is — cancelling the same day you started — that
  // the subscription "is still being set up".
  const trialing = isTrialing(subscription);
  const startDateUNIX = subscription.payment?.startDate?.timestampUNIX;
  if (!skipGuards && !trialing && startDateUNIX) {
    const ageMs = Date.now() - (startDateUNIX * 1000);
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    if (ageMs < twentyFourHoursMs) {
      ctx.log(`Cancel rejected: uid=${uid}, subscription is only ${Math.round(ageMs / 1000 / 60)} minutes old`);
      return ctx.respond('Your subscription is still being set up. Please try again after 24-48 hours.', { code: 400 });
    }
  }

  // Guard: already pending cancellation
  if (subscription.cancellation?.pending === true) {
    ctx.log(`Cancel rejected: uid=${uid}, cancellation already pending`);
    return ctx.respond('Subscription is already pending cancellation', { code: 400 });
  }

  const provider = subscription.payment?.provider;
  const resourceId = subscription.payment?.resourceId;

  if (!provider || !resourceId) {
    ctx.log(`Cancel rejected: uid=${uid}, missing provider=${provider} or resourceId=${resourceId}`);
    return ctx.respond('Subscription payment details not found', { code: 400 });
  }

  // Load the provider module
  let providerModule;
  try {
    providerModule = loadProvider(path.join(import.meta.dirname, 'providers'), provider);
  } catch (e) {
    return ctx.respond(`Unknown provider: ${provider}`, { code: 400 });
  }

  // Cancel at period end via the provider
  try {
    await providerModule.cancelAtPeriodEnd({ resourceId, uid, subscription, ctx });
  } catch (e) {
    // A suspended subscription the provider says NO LONGER EXISTS is a dead
    // record on our side alone: reset it directly so the user can re-subscribe.
    // The classification is the whole guard — every transient or unrecognized
    // failure falls through to the caller with NOTHING written, so a network
    // blip can never fabricate a cancellation ([#212]).
    if (subscription.status === 'suspended' && isAlreadyGone(e)) {
      ctx.log(`Provider reports the suspended subscription is already gone (${e.message}), resetting directly`);
      const admin = ctx.omega.firebase.admin;
      const now = powertools.timestamp(new Date(), { output: 'string' });
      const nowUNIX = powertools.timestamp(now, { output: 'unix' });

      await admin.firestore().doc(`users/${uid}`).set({
        subscription: {
          status: 'cancelled',
          product: { id: 'basic', name: 'Basic' },
          cancellation: { pending: false, date: { timestamp: now, timestampUNIX: nowUNIX } },
        },
      }, { merge: true });

      ctx.log(`Directly cancelled suspended subscription for uid=${uid}`);
      return ctx.respond({ success: true });
    }

    // The provider's own words stay in the logs — a client gets one neutral
    // sentence, never an SDK message naming our internals ([#212]).
    ctx.error(`Failed to cancel subscription via ${provider}: uid=${uid}, sub=${resourceId}, error=${e.message}`);
    return ctx.respond('We could not cancel your subscription right now. Please try again shortly.', { code: 500 });
  }

  // Store cancellation reason/feedback on the order doc
  const orderId = subscription.payment?.orderId;

  if (orderId) {
    const admin = ctx.omega.firebase.admin;
    const now = powertools.timestamp(new Date(), { output: 'string' });
    const nowUNIX = powertools.timestamp(now, { output: 'unix' });

    await admin.firestore().doc(`payments-orders/${orderId}`).set({
      requests: {
        cancellation: {
          reason: data.reason || null,
          feedback: data.feedback || null,
          date: {
            timestamp: now,
            timestampUNIX: nowUNIX,
          },
        },
      },
    }, { merge: true });

    ctx.log(`Stored cancellation request on payments-orders/${orderId}: reason=${data.reason}`);
  }

  ctx.log(`Cancel ${trialing ? 'immediate (trialing)' : 'scheduled'}: uid=${uid}, provider=${provider}, sub=${resourceId}, reason=${data.reason}`);

  return ctx.respond({ success: true });
};
