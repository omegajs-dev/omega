/**
 * POST /marketing/contact - Add marketing contact
 * Public endpoint to subscribe to newsletter, with admin options
 */
import recaptcha from '../../../libraries/recaptcha.js';
import { validate as validateEmail, ALL_CHECKS } from '../../../libraries/email/validation.js';
import { inferContact } from '../../../libraries/infer-contact.js';
import rateLimits from '../../../libraries/rate-limits.js';

const { MARKETING_RATE_LIMIT } = rateLimits;

export default async ({ ctx, data, analytics }) => {

  const isAdmin = ctx.user.roles?.admin;

  // Extract parameters
  const email = (data.email || '').trim().toLowerCase();
  let firstName = (data.firstName || '').trim();
  let lastName = (data.lastName || '').trim();
  const source = data.source;

  // Admin-only options
  const tags = isAdmin ? data.tags : [];
  const skipValidation = isAdmin ? data.skipValidation : false;

  // Email validation — run free checks before reCAPTCHA/rate limit
  const shouldCallExternalAPIs = !ctx.isTesting() || process.env.TEST_EXTENDED_MODE;

  // skipValidation (admin-only) reduces to just format + disposable
  // Admin gets full checks including mailbox verification when external APIs are enabled
  const checks = skipValidation
    ? ['format']
    : (isAdmin && shouldCallExternalAPIs ? ALL_CHECKS : undefined);

  const validation = await validateEmail(email, { checks });

  if (!validation.valid) {
    // For public requests, return generic success to prevent email enumeration
    if (!isAdmin) {
      return ctx.respond({ success: true });
    }

    const { format, localPart, disposable, corporate } = validation.checks;

    if (format && !format.valid) {
      return ctx.respond('Invalid email format', { code: 400 });
    }

    if (localPart && !localPart.valid) {
      return ctx.respond(`Blocked email local part: ${localPart.localPart}`, { code: 400 });
    }

    if (disposable && !disposable.valid) {
      return ctx.respond(`Disposable email domain not allowed: ${disposable.domain}`, { code: 400 });
    }

    if (corporate && !corporate.valid) {
      return ctx.respond(`Corporate/social-media domain not allowed: ${corporate.domain}`, { code: 400 });
    }

    // Name the failing check (admin-only branch — public callers already got a
    // generic success above, so email-enumeration protection is untouched)
    const failedCheck = Object.keys(validation.checks).find((name) => validation.checks[name]?.valid === false);
    return ctx.respond(`Email validation failed (${failedCheck})`, { code: 400 });
  }

  // Public access protection (after validation so we don't waste reCAPTCHA on garbage)
  if (!isAdmin) {
    // Verify reCAPTCHA (skip during automated tests). verify() owns the
    // whole decision: no RECAPTCHA_SECRET_KEY configured → pass (unkeyed
    // brands are a sanctioned population — cp257: keys are optional and
    // per-brand); secret + missing/bad token → fail. No pre-check here — an
    // empty-token 403 before verify() would permanently reject every
    // subscribe from a brand that never configured reCAPTCHA.
    if (!ctx.isTesting()) {
      const recaptchaValid = await recaptcha.verify(data['g-recaptcha-response']);
      if (!recaptchaValid) {
        return ctx.respond('Request could not be verified', { code: 403 });
      }
    }

    // Rate limit — consume() is check, count and write in ONE call and throws
    // the 429 itself ([#647](https://github.com/Omega-JS-Stack/omega/issues/647)).
    // An EXPLICIT limit: this is a framework anti-abuse gate on a public route,
    // not a plan feature a brand prices in its features catalog.
    // Counted per CALLER IP: this lane is public, so an EXPLICIT keyed counter
    // is the honest one — a signed-in subscriber and a stranger cost the brand
    // the same, and forKey() can never move a signed-in user's own counters.
    try {
      await ctx.usage.forKey(ctx.request.geolocation.ip).consume('marketing-subscribe', 1, { limit: MARKETING_RATE_LIMIT });
    } catch (e) {
      // Only a rate limit is a rate limit — a 500 from consume() (a Firestore
      // outage, a misconfigured catalog) must not come back as one
      if (e.code !== 429) {
        throw e;
      }

      return ctx.respond('Rate limit exceeded', { code: 429 });
    }
  }

  // Infer contact info if name not provided
  let nameInferred = null;
  let company = '';
  if (!firstName && !lastName) {
    nameInferred = await inferContact(email, ctx);
    firstName = nameInferred.firstName;
    lastName = nameInferred.lastName;
    company = nameInferred.company;
  }

  // Add to providers
  let providerResults = {};

  if (!shouldCallExternalAPIs) {
    ctx.log('marketing/contact: Skipping providers (OMEGA_ENVIRONMENT=testing, TEST_EXTENDED_MODE not set)');
  } else {
    const mailer = ctx.email;
    providerResults = await mailer.add({
      email,
      firstName,
      lastName,
      company,
      source,
    });
  }

  // Log result
  ctx.log('marketing/contact result:', {
    email,
    providers: providerResults,
    validation,
    nameInferred,
  });

  // Track analytics
  analytics.event('marketing/contact', { action: 'add' });

  // Return response based on auth level
  if (isAdmin) {
    return ctx.respond({
      success: true,
      providers: providerResults,
      validation,
      nameInferred,
    });
  }

  // Public: generic response
  return ctx.respond({ success: true });
};
