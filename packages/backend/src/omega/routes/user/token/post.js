/**
 * POST /user/token - Create custom Firebase token
 * Creates a custom auth token for the authenticated user
 */
export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Get target UID
  const uid = data.uid;

  // Require admin to create tokens for other users
  if (uid !== user.auth.uid && !user.roles.admin) {
    return ctx.respond('Admin required', { code: 403 });
  }

  // Create custom token
  const token = await admin.auth().createCustomToken(uid)
    .catch((e) => e);

  if (token instanceof Error) {
    return ctx.respond(`Failed to create custom token: ${token}`, { code: 500 });
  }

  return ctx.respond({ token });
};
