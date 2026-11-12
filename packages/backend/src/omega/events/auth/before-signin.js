/**
 * beforeUserSignedIn - Update activity + send sign-in analytics
 *
 * This function fires on every sign-in (including right after account creation).
 * It updates last activity and sends sign-in analytics.
 *
 * TODO: Add mailer.sync(uid) here with 1x/day rate limit to keep marketing
 * contact data (name, country, subscription fields) fresh between sessions.
 *
 * Available parameters (1st gen):
 *
 * user (AuthUserRecord):
 *   uid, email, emailVerified, displayName, photoURL, phoneNumber, disabled,
 *   metadata: { creationTime, lastSignInTime },
 *   providerData: [{ uid, displayName, email, photoURL, providerId, phoneNumber }],
 *   passwordHash, passwordSalt, customClaims, tenantId, tokensValidAfterTime, multiFactor
 *
 * context (AuthEventContext):
 *   ipAddress, userAgent, locale, eventId, eventType, authType, resource, timestamp,
 *   additionalUserInfo: { providerId, profile, username, isNewUser, recaptchaScore, email, phoneNumber },
 *   credential: { providerId, signInMethod, claims, idToken, accessToken, refreshToken, expirationTime, secret } | null,
 *   emailType, smsType, params
 *
 * Note: recaptchaScore requires reCAPTCHA Enterprise (Google Cloud level), NOT the Firebase SMS fraud toggle.
 * Note: credential tokens (idToken, accessToken, refreshToken) require opt-in via BlockingOptions.
 */
import { runAuthHook } from './utils.js';

export default async ({ ctx, omega, user, context }) => {
  const startTime = Date.now();
  const admin = omega.firebase.admin;

  // The UID and nothing else. The AuthUserRecord carries the email, the display
  // name and the provider data, the AuthEventContext carries the IP, the user
  // agent and the credential, and a backend line lands in Cloud Logging for the
  // whole retention window — so none of it rides this line
  // ([#657](https://github.com/Omega-JS-Stack/omega/issues/657)). Both stay
  // reachable one level down, at debug.
  ctx.log(`beforeSignIn: ${user.uid}`);
  ctx.debug(`beforeSignIn: ${user.uid} record`, user, context);

  const now = new Date();

  // Update last activity and geolocation
  const update = await admin.firestore().doc(`users/${user.uid}`)
    .set({
      metadata: {
        updated: {
          timestamp: now.toISOString(),
          timestampUNIX: Math.round(now.getTime() / 1000),
        },
      },
      activity: {
        geolocation: {
          ip: context.ipAddress,
        },
        client: {
          userAgent: context.userAgent,
          language: context.locale,
        },
      },
    }, { merge: true })
    .catch(e => e);

  if (update instanceof Error) {
    ctx.error(`beforeSignIn: Failed to update user ${user.uid}:`, update);
    // Don't block sign-in for activity update failure
  } else {
    ctx.log(`beforeSignIn: Updated user activity`);
  }

  // Run consumer hook (can throw HttpsError to block sign-in)
  await runAuthHook('before-signin', { omega, ctx, user, context });

  ctx.log(`beforeSignIn: Completed for ${user.uid} (${Date.now() - startTime}ms)`);
};
