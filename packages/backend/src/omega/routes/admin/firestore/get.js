/**
 * GET /admin/firestore - Read Firestore document
 * Admin-only endpoint to read any document
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

  ctx.log('main(): Reading', data.path);

  // Read from Firestore
  const doc = await admin.firestore().doc(data.path).get()
    .catch((e) => e);

  if (doc instanceof Error) {
    return ctx.respond(doc.message, { code: 500 });
  }

  // Return empty object if document doesn't exist (doc.data() returns undefined)
  return ctx.respond(doc.data() || {});
};
