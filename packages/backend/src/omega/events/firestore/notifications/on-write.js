import { FieldValue } from 'firebase-admin/firestore';
import { deliverConversion } from '../../../libraries/analytics/conversions.js';
import { buildAttributionContext, buildIdentity } from '../../../libraries/analytics/match-data.js';

/**
 * Notification subscription write handler
 *
 * Handles create, update, and delete events for notification subscriptions.
 * Updates stats counters and sends analytics events.
 */
export default async ({ ctx, omega, context, change }) => {
  const admin = omega.firebase.admin;

  // Shortcuts
  const dataBefore = change.before.data();
  const dataAfter = change.after.data();

  // Determine event type
  let eventType;
  if (dataAfter === undefined) {
    eventType = 'delete';
  } else if (dataBefore && dataAfter) {
    eventType = 'update';
  } else if (!dataBefore && dataAfter) {
    eventType = 'create';
  }

  // Log
  ctx.log('Notification subscription write:', {
    after: dataAfter,
    before: dataBefore,
    eventType: eventType,
    resource: context.resource,
    params: context.params,
  });

  // Delete event
  if (eventType === 'delete') {
    await admin.firestore().doc('meta/stats')
      .set({
        notifications: { total: FieldValue.increment(-1) },
      }, { merge: true });

    trackNotification({
      omega: omega,
      ctx: ctx,
      event: 'notification_unsubscribe',
      token: context.params.token,
      data: dataBefore,
    });

    ctx.log('Notification subscription deleted:', dataBefore);

    return dataBefore;
  }

  // Update event
  if (eventType === 'update') {
    return;
  }

  // Create event
  if (eventType === 'create') {
    await admin.firestore().doc('meta/stats')
      .set({
        notifications: { total: FieldValue.increment(1) },
      }, { merge: true });

    trackNotification({
      omega: omega,
      ctx: ctx,
      event: 'notification_subscribe',
      token: context.params.token,
      data: dataAfter,
    });

    ctx.log('Notification subscription created:', dataAfter);

    return dataAfter;
  }
};

/**
 * Fire the canonical subscribe/unsubscribe conversion (non-blocking).
 *
 * The handler used to call `Analytics(...).event()` with hyphenated
 * names of its own — `notification-subscribe` / `notification-unsubscribe` —
 * which appear in no catalog, so no other surface could ever say the same
 * thing. Going through `deliverConversion` buys the three things that raw call
 * had none of: the catalog's name, the consent gate, and the per-provider walk
 * (GA4 only here — no ad platform maps a push subscription, and the catalog
 * says so rather than the caller inventing one).
 *
 * THE DEDUPE ID IS `<event>.<token>`. The doc id IS the push token, and it is
 * the only stable key this doc has: `owner` is null on an anonymous subscribe,
 * so a uid-derived id would collapse every anonymous device onto one id.
 *
 * Fire-and-forget, like every other call site: a subscription is already
 * written when this runs, and an ad platform must never fail a doc write.
 *
 * @param {object} options
 * @param {object} options.omega - The Omega instance.
 * @param {object} options.ctx - The event context.
 * @param {string} options.event - The canonical event name.
 * @param {string} options.token - The doc id, which is the push token.
 * @param {object} [options.data] - The subscription doc this is about.
 * @returns {void}
 */
function trackNotification({ omega, ctx, event, token, data }) {
  try {
    deliverConversion({
      event: event,
      attribution: buildAttributionContext(data?.attribution),
      identity: buildIdentity({ uid: data?.owner }),
      trackingConsent: data?.trackingConsent,
      eventId: `${event}.${token}`,
      ctx: ctx,
      omega: omega,
    });
  } catch (e) {
    ctx.error(`Notification ${event} tracking failed for ${token}:`, e);
  }
}
