/**
 * POST /admin/database - Write Realtime Database
 * Admin-only endpoint to write any path
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

  ctx.log('main(): Write', data.path, data.document);

  // Write to Realtime Database
  const write = await admin.database().ref(data.path).set(data.document)
    .catch((e) => e);

  if (write instanceof Error) {
    return ctx.respond(write.message, { code: 500 });
  }

  return ctx.respond(data.document);
};
