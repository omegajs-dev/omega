/**
 * Surface: route, GET /notes (list the caller's notes, newest first)
 * Doc: node_modules/@omega.js/manager/docs/backend/routes.md
 */
export default async ({ ctx, omega, user, data }) => {
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // owner + created order is a compound query: its composite index lives in
  // firestore.indexes.json
  const snapshot = await omega.firebase.admin.firestore()
    .collection('notes')
    .where('owner', '==', user.uid)
    .orderBy('metadata.created.timestampUNIX', 'desc')
    .limit(data.limit)
    .get();

  const notes = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  return ctx.respond({ notes });
};
