/**
 * GET /user - Resolve user account info
 * Returns the full resolved user object for authenticated users
 */
export default async ({ ctx, user }) => {

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Return full resolved user object
  return ctx.respond({ user });
};
