import { retryWrite, runAuthHook, MAX_RETRIES } from './utils.js';
import { deliverConversion } from '../../libraries/analytics/conversions.js';
import { buildAttributionContext, buildIdentity } from '../../libraries/analytics/match-data.js';

/**
 * onDelete - Delete user doc
 *
 * This function fires when a user is deleted from Firebase Auth.
 * It deletes the user doc from Firestore.
 *
 * Key behaviors:
 * - Checks if user doc exists before attempting delete
 * - Retries up to 3 times with exponential backoff on failure
 * - Logs timing for performance monitoring
 *
 * Available parameters (1st gen):
 *
 * user (UserRecord — firebase-admin):
 *   uid, email, emailVerified, displayName, photoURL, phoneNumber, disabled,
 *   metadata: { creationTime, lastSignInTime, lastRefreshTime },
 *   providerData: [{ uid, displayName, email, photoURL, providerId, phoneNumber }],
 *   passwordHash, passwordSalt, customClaims, tenantId, tokensValidAfterTime, multiFactor
 *
 * context (EventContext — NOT AuthEventContext, no ipAddress/userAgent/locale):
 *   eventId, eventType, timestamp, resource: { service, name }, params
 */
export default async ({ ctx, omega, user, context }) => {
  const startTime = Date.now();
  const admin = omega.firebase.admin;

  // The UID and nothing else. The UserRecord carries the email, the display name,
  // the provider data and the password hash, and a backend line lands in Cloud
  // Logging for the whole retention window — so none of it rides this line
  // ([#657](https://github.com/Omega-JS-Stack/omega/issues/657)). The record and
  // the event context stay reachable one level down, at debug.
  ctx.log(`onDelete: ${user.uid}`);
  ctx.debug(`onDelete: ${user.uid} record`, user, context);

  // Check if user doc exists before attempting delete
  const existingDoc = await admin.firestore().doc(`users/${user.uid}`)
    .get()
    .catch(e => {
      ctx.error(`onDelete: Failed to check existing doc for ${user.uid}:`, e);
      return null;
    });

  if (!existingDoc || !existingDoc.exists) {
    ctx.log(`onDelete: User doc does not exist for ${user.uid}, skipping (${Date.now() - startTime}ms)`);
    return;
  }

  // Read the doc BEFORE it goes: the consent snapshot and the campaign that won
  // this account are the only record of either, and the delete below is the
  // moment they stop existing.
  const userDoc = existingDoc.data();

  // Delete user doc with retry
  try {
    await retryWrite(ctx, 'onDelete', async () => {
      await admin.firestore().doc(`users/${user.uid}`).delete();
    });

    ctx.log(`onDelete: Successfully deleted user doc for ${user.uid}`);
  } catch (error) {
    ctx.error(`onDelete: Failed to delete user doc after ${MAX_RETRIES} retries:`, error);

    // Don't reject - the user was already deleted from Auth
    // Just log the error and continue
    return;
  }

  // Remove marketing contact from all providers (non-blocking)
  if (user.email) {
    const email = ctx.email;
    email.remove(user.email)
      .then((r) => {
        // The uid and how many providers answered. The results object carries
        // each provider's own payload — a contact record, a subscriber — and
        // every one of them carries the deleted user's address back, into the
        // Cloud Logging retention window the headline above stopped writing to
        // ([#710](https://github.com/Omega-JS-Stack/omega/issues/710)).
        ctx.log(`onDelete: Marketing remove for ${user.uid}: ${Object.keys(r).length} provider(s)`);
        ctx.debug('onDelete: Marketing remove:', r);
      })
      .catch((e) => ctx.error('onDelete: Marketing remove failed:', e));
  }

  // Send delete analytics (server-side only event)
  trackDelete({ omega, ctx, user, userDoc });

  // Run consumer hook (non-blocking — errors logged but don't fail)
  await runAuthHook('on-delete', { omega, ctx, user, context }).catch(e => {
    ctx.error('onDelete: Consumer hook error:', e);
  });

  ctx.log(`onDelete: Completed for ${user.uid} (${Date.now() - startTime}ms)`);
};

/**
 * Fire the canonical `user_delete` conversion (non-blocking).
 *
 * The same treatment `notification_subscribe` gets, and for the same reason: a
 * raw `Analytics(...).event()` reaches GA4 without ever asking the
 * consent gate, and names an event no catalog knows. `user_delete` is a
 * `placement: 'server'`, GA4-only entry — nothing else can observe an account
 * ending, and no ad platform has anything to do with it.
 *
 * THE DEDUPE ID IS `user_delete.<uid>` — an account is deleted once, and the
 * uid is what the deletion is about, so a redelivered trigger reports the same
 * event rather than a second one.
 *
 * The consent snapshot and the attribution come off the doc read BEFORE the
 * delete — the last moment either exists. An ABSENT snapshot grants: a legacy
 * account predating the consent system still gets counted, which is the
 * standing rule for every server conversion (conversions.js).
 *
 * @param {object} options
 * @param {object} options.omega - The Omega instance.
 * @param {object} options.ctx - The event context.
 * @param {object} options.user - The deleted Auth UserRecord.
 * @param {object} [options.userDoc] - The user doc as it stood before deletion.
 * @returns {void}
 */
function trackDelete({ omega, ctx, user, userDoc }) {
  try {
    deliverConversion({
      event: 'user_delete',
      attribution: buildAttributionContext(userDoc?.attribution),
      // The doc as it stood, through the ONE match reader: a deletion is an
      // exclusion audience, and an exclusion nobody can be matched to excludes
      // nobody ([#577](https://github.com/Omega-JS-Stack/omega/issues/577)).
      identity: buildIdentity({ uid: user.uid, user: userDoc, email: user.email, telephone: user.phoneNumber }),
      trackingConsent: userDoc?.trackingConsent,
      eventId: `user_delete.${user.uid}`,
      ctx: ctx,
      omega: omega,
    });
  } catch (e) {
    ctx.error(`onDelete: user_delete tracking failed for ${user.uid}:`, e);
  }
}
