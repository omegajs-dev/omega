/**
 * Surface: route, DELETE /notes (delete one note by data.id, owner only)
 * Doc: node_modules/@omega.js/manager/docs/backend/routes.md
 */
export default async ({ ctx, omega, user, data }) => {
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  const ref = omega.firebase.admin.firestore().doc(`notes/${data.id}`);
  const doc = await ref.get();

  if (!doc.exists) {
    return ctx.respond('Note not found', { code: 404 });
  }

  if (doc.data().owner !== user.uid) {
    return ctx.respond('Not authorized', { code: 403 });
  }

  await ref.delete();

  return ctx.respond({ id: data.id });
};
