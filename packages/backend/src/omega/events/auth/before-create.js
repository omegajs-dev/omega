import { isDisposable } from '../../libraries/email/validation.js';
import { runAuthHook, resolveSignupLimit } from './utils.js';

const ERROR_TOO_MANY_ATTEMPTS = 'Unable to create account at this time. Please try again later.';
const ERROR_DISPOSABLE_EMAIL = 'This email domain is not allowed. Please use a different email address.';

/**
 * beforeUserCreated - Disposable email blocking + IP rate limiting
 *
 * User doc creation is handled by on-create.js (which fires for all user creations including Admin SDK).
 *
 * Why not create user doc here?
 * - Admin SDK (used for tests) does NOT trigger beforeUserCreated
 * - on-create fires for ALL user creations, making it more reliable
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
export default async ({ ctx, omega, user, context }) => {
  const startTime = Date.now();
  const functions = omega.firebase.functions;
  const ipAddress = context.ipAddress || '';

  // The UID and nothing else. The AuthUserRecord carries the email, the display
  // name and the provider data, the AuthEventContext carries the IP, the user
  // agent and the credential, and a backend line lands in Cloud Logging for the
  // whole retention window — so none of it rides this line
  // ([#657](https://github.com/Omega-JS-Stack/omega/issues/657)). Both stay
  // reachable one level down, at debug.
  ctx.log(`beforeCreate: ${user.uid}`);
  ctx.debug(`beforeCreate: ${user.uid} record`, user, context);

  // Block disposable email domains
  if (isDisposable(user.email)) {
    ctx.error(`beforeCreate: Blocked disposable email ${user.email}`);

    throw new functions.auth.HttpsError('invalid-argument', ERROR_DISPOSABLE_EMAIL);
  }

  // Skip rate limiting if no IP (shouldn't happen in production)
  if (!ipAddress) {
    ctx.log(`beforeCreate: No IP address, skipping rate limit check (${Date.now() - startTime}ms)`);
    return;
  }

  // IP rate limiting — an EXPLICIT keyed counter, never the caller's own
  // ([#647](https://github.com/Omega-JS-Stack/omega/issues/647)). The limit is
  // this backend's own `auth.signup.maxPerIpPerDay`, not a plan number: a
  // signup gate is a security control and the caller has no account yet.
  // consume() is the whole gate — check, count, write — so a refusal is a
  // throw and there is nothing here to get half right.
  const usage = ctx.usage.configure({ log: true }).forKey(ipAddress);
  const maxSignupsPerDay = resolveSignupLimit(omega.config);

  try {
    await usage.consume('signups', 1, { limit: maxSignupsPerDay });
  } catch (e) {
    // ONLY a rate limit is a rate limit. consume() also throws 500s — a
    // Firestore outage, a feature the catalog does not define — and selling one
    // of those as "too many signups from your IP" is a diagnosis nobody can act
    // on, told to a user who did nothing wrong.
    if (e.code !== 429) {
      throw e;
    }

    ctx.error(`beforeCreate: Too many signups from ${ipAddress} (limit ${maxSignupsPerDay}/day)`);

    throw new functions.auth.HttpsError('resource-exhausted', ERROR_TOO_MANY_ATTEMPTS);
  }

  // Run consumer hook (can throw HttpsError to block signup)
  await runAuthHook('before-create', { omega, ctx, user, context });

  ctx.log(`beforeCreate: Completed for ${user.uid} (${Date.now() - startTime}ms)`);
};
