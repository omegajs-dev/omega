/**
 * POST /admin/infer-contact - Infer contact info from email addresses
 * Admin-only endpoint for testing/debugging the inferContact pipeline
 */
import { inferContact } from '../../../libraries/infer-contact.js';

export default async ({ ctx, user, data }) => {

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Require admin
  if (!user.roles.admin) {
    return ctx.respond('Admin required.', { code: 403 });
  }

  // Accept single email or array of emails. Schema defaults `emails` to [], so check length:
  // an empty default should NOT shadow a provided single `email`.
  const emails = Array.isArray(data.emails) && data.emails.length > 0
    ? data.emails
    : [data.email];

  const results = await Promise.all(
    emails
      .filter(Boolean)
      .map(async (email) => {
        const result = await inferContact(email, ctx);
        return { email, ...result };
      })
  );

  return ctx.respond({ results });
};
