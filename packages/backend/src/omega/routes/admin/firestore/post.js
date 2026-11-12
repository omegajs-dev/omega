import pushid from 'pushid';

/**
 * POST /admin/firestore - Write Firestore document
 * Admin-only endpoint to write any document
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

  // Process path placeholders
  let path = data.path;

  if (path.includes('{pushId}')) {
    path = path.replace(/\{pushId\}/gi, pushid());
  } else if (path.includes('{nanoId}')) {
    path = path.replace(/\{nanoId\}/gi, omega.utilities.randomId());
  }

  // Prepare document
  const document = {
    ...data.document,
    metadata: ctx.metadata({ tag: data.metadataTag }),
  };

  // Build options
  const options = {
    merge: data.merge,
  };

  ctx.log('main(): Writing', path, document, options);

  // Write to Firestore
  const write = await admin.firestore().doc(path).set(document, options)
    .catch((e) => e);

  if (write instanceof Error) {
    return ctx.respond(write.message, { code: 500 });
  }

  return ctx.respond({ path });
};
