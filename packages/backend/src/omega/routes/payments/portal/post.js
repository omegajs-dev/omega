import path from 'path';
import loadProvider from '../../../libraries/load-provider.js';

// Where a portal session returns to when the caller names no URL of its own, or
// names one that is not the brand's — the account page's billing section, the
// same destination the transactional emails link to.
const DEFAULT_RETURN_PATH = '/dashboard/account#billing';

/**
 * POST /payments/portal
 * Creates a Stripe Billing Portal session for the authenticated user.
 * The portal allows managing payment methods and viewing invoices,
 * but does NOT allow cancellation (users must use POST /payments/cancel).
 * Requires authentication.
 */
export default async ({ ctx, omega, user, data }) => {
  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  const uid = user.auth.uid;
  const returnUrl = resolveReturnUrl(omega, ctx, data.returnUrl, uid);
  const subscription = user.subscription;

  // Require a paid subscription (any status — suspended users can still manage billing)
  if (!subscription || subscription.product?.id === 'basic') {
    ctx.log(`Portal rejected: uid=${uid}, product=${subscription?.product?.id}`);
    return ctx.respond('No paid subscription found', { code: 400 });
  }

  const provider = subscription.payment?.provider;

  if (!provider) {
    ctx.log(`Portal rejected: uid=${uid}, no provider set`);
    return ctx.respond('Subscription payment provider not found', { code: 400 });
  }

  // Load the provider module
  let providerModule;
  try {
    providerModule = loadProvider(path.join(import.meta.dirname, 'providers'), provider);
  } catch (e) {
    return ctx.respond(`Unknown provider: ${provider}`, { code: 400 });
  }

  // Create the portal session via the provider
  const email = user.auth?.email || null;
  let result;
  try {
    result = await providerModule.createPortalSession({ uid, email, returnUrl, ctx });
  } catch (e) {
    // The provider's own words stay in the logs — a client gets one neutral
    // sentence, never an SDK message naming our internals ([#212]).
    ctx.error(`Failed to create ${provider} portal session: uid=${uid}, error=${e.message}`);
    return ctx.respond('We could not open your billing portal right now. Please try again shortly.', { code: 500 });
  }

  ctx.log(`Portal session created: uid=${uid}, provider=${provider}`);

  return ctx.respond({ url: result.url });
};

/**
 * Resolve the URL the provider sends the user back to.
 *
 * `returnUrl` is client-settable and lands in the provider's hosted page, so an
 * arbitrary host would make the brand's own billing portal a redirector to
 * anywhere. Only the brand's OWN origins pass — the resolved website URL (which
 * is localhost during a dev/test run) and the configured brand URL. Anything
 * else, and anything unparseable, falls back to the brand's account page with a
 * warning ([#212]).
 *
 * @param {object} omega - The Omega instance
 * @param {object} ctx - Assistant instance for logging
 * @param {string|null} returnUrl - The caller's requested return URL
 * @param {string} uid - User's UID (for logging)
 * @returns {string} A URL on one of the brand's own origins
 */
function resolveReturnUrl(omega, ctx, returnUrl, uid) {
  const websiteUrl = omega.project.websiteUrl;
  const fallback = new URL(DEFAULT_RETURN_PATH, websiteUrl).toString();

  if (!returnUrl) {
    return fallback;
  }

  const allowedOrigins = [websiteUrl, omega.config.brand?.url]
    .filter(Boolean)
    .map((url) => safeOrigin(url))
    .filter(Boolean);

  const requestedOrigin = safeOrigin(returnUrl);

  if (requestedOrigin && allowedOrigins.includes(requestedOrigin)) {
    return returnUrl;
  }

  ctx.warn(`Ignoring off-brand portal returnUrl "${returnUrl}" from uid=${uid} (allowed: ${allowedOrigins.join(', ') || 'none'}) — returning to ${fallback}`);

  return fallback;
}

/**
 * The origin of a URL, or null when it does not parse as one.
 */
function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return null;
  }
}
