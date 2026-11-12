/**
 * Surface: route, POST /notes (create one note from data.text)
 * Doc: node_modules/@omega.js/manager/docs/backend/routes.md
 */
export default async ({ ctx, omega, user, data }) => {
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // The id comes from the schema (a forced value), never from the caller
  const note = {
    id: data.id,
    owner: user.uid,
    text: data.text,
    metadata: {
      created: {
        timestamp: ctx.meta.startTime.timestamp,
        timestampUNIX: ctx.meta.startTime.timestampUNIX,
      },
      updated: {
        timestamp: ctx.meta.startTime.timestamp,
        timestampUNIX: ctx.meta.startTime.timestampUNIX,
      },
    },
  };

  // This write fires the notesOnCreate trigger (src/index.js), which runs
  // src/events/notes/on-create.js
  await omega.firebase.admin.firestore().doc(`notes/${note.id}`).set(note);

  return ctx.respond({ note });
};
