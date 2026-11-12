/**
 * GET /admin/database - Read Realtime Database
 * Admin-only endpoint to read any path
 */
export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Require admin
  if (!user.roles.admin) {
    return ctx.respond('Admin required.', { code: 403 });
  }

  // Require path
  if (!data.path) {
    return ctx.respond('Path parameter required.', { code: 400 });
  }

  ctx.log('main(): Read', data.path);

  // Read from Realtime Database
  const snapshot = await admin.database().ref(data.path).once('value')
    .catch((e) => e);

  if (snapshot instanceof Error) {
    return ctx.respond(snapshot.message, { code: 500 });
  }

  // Return empty object if path doesn't exist (snapshot.val() returns null)
  return ctx.respond(snapshot.val() || {});
};
