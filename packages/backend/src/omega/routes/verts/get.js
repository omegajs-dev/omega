/**
 * GET /omega/verts - List or get house verts
 * Admin-only. Used by the admin dashboard.
 *
 * Query params:
 *   id    — Get a single vert by ID
 *   limit — Max results (default 100)
 */
export default async ({ ctx, omega, user, data }) => {

  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }
  if (!user.roles.admin) {
    return ctx.respond('Admin access required', { code: 403 });
  }

  const admin = omega.firebase.admin;

  // Single vert by ID
  if (data.id) {
    const doc = await admin.firestore().doc(`verts/${data.id}`).get();

    if (!doc.exists) {
      return ctx.respond('Vert not found', { code: 404 });
    }

    return ctx.respond({
      success: true,
      vert: { id: doc.id, ...doc.data() },
    });
  }

  // List verts
  const snapshot = await admin.firestore().collection('verts')
    .limit(parseInt(data.limit, 10) || 100)
    .get();

  const verts = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
  }));

  return ctx.respond({
    success: true,
    verts,
    count: verts.length,
  });
};
