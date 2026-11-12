/**
 * The SERVER half of `sign_up`, the one home for the registration conversion.
 * `sign_up` fires on both halves, so they share the dedupe id `sign_up.<uid>`:
 * the uid is the one thing both sides hold before either fires.
 *
 * This half goes only to the providers whose row dedupes on event_id; GA4 has
 * no cross-source event_id dedupe, so the browser half owns it. It fires from
 * `routes/user/signup`, the post-auth request that carries the IP, the user
 * agent and the platform cookies, behind that route's `flags.signupProcessed`
 * gate. A surface that never posts that request (desktop, extension) fires no
 * server half. The contract: docs/shared/analytics.md (The placement rule).
 */
const { ANALYTICS_PROVIDERS } = require('@omega.js/config/analytics-providers');
const { deliverConversion } = require('./conversions.js');
const { buildAttributionContext, buildIdentity } = require('./match-data.js');

/**
 * Everything the fire is made of — pure, so the payload can be read without a
 * route, a request or a platform.
 *
 * @param {object} options
 * @param {object} options.authUser - The Firebase Auth record (uid, email, providerData).
 * @param {object} [options.userRecord] - The user doc as it was just written —
 *   the attribution (cookies included), the consent snapshot, and every personal
 *   match parameter the shared reader takes off it.
 * @param {object} [options.request] - The post-auth request's `{ ip, userAgent }`.
 * @returns {object} The `deliverConversion` payload, minus its ctx + omega.
 */
function buildSignupFire({ authUser, userRecord, request }) {
  const uid = authUser.uid;

  return {
    event: 'sign_up',
    params: {
      method: resolveSignupMethod(authUser),
      user_id: uid,
    },
    attribution: buildAttributionContext(userRecord?.attribution),
    identity: buildIdentity({
      uid: uid,
      user: userRecord,
      // Auth's own record beats the doc for these two: on a fresh signup the
      // doc's email came FROM it, and a phone-provider account has a number
      // Auth holds and the doc's `personal.telephone` does not.
      email: authUser.email,
      telephone: authUser.phoneNumber,
      request: request,
    }),
    trackingConsent: userRecord?.trackingConsent || null,
    // The providers that deduplicate on event_id (see the header): the rest are
    // the browser half's to fire.
    providers: Object.values(ANALYTICS_PROVIDERS).filter((row) => row.dedupesOnEventId).map((row) => row.id),
    eventId: `sign_up.${uid}`,
  };
}

/**
 * Fire it (non-blocking, and never at its caller: a registration that already
 * happened must not fail because an ad platform did).
 *
 * @param {object} options - `buildSignupFire`'s, plus the Omega instance and the ctx.
 * @returns {void}
 */
function trackSignup({ omega, ctx, authUser, userRecord, request }) {
  try {
    deliverConversion({
      ...buildSignupFire({ authUser, userRecord, request }),
      ctx: ctx,
      omega: omega,
    });
  } catch (e) {
    ctx.error(`trackSignup: sign_up tracking failed for ${authUser?.uid}:`, e);
  }
}

/**
 * How this account was created, in the same vocabulary the browser half sends:
 * 'email' for a password signup, otherwise the provider's own name ('google',
 * 'facebook', …) rather than its Firebase id ('google.com').
 *
 * @param {object} authUser - The Firebase Auth record.
 * @returns {string} The method name.
 */
function resolveSignupMethod(authUser) {
  const providerId = authUser?.providerData?.[0]?.providerId;

  if (!providerId || providerId === 'password') {
    return 'email';
  }

  return providerId.replace(/\.com$/, '');
}

module.exports = {
  trackSignup,
  // Exported for testing — the payload IS the contract with the browser half
  buildSignupFire,
  resolveSignupMethod,
};
