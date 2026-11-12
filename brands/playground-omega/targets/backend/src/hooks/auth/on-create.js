/**
 * Surface: auth hook, on-create (non-blocking: seeds the new user's first note)
 * Doc: node_modules/@omega.js/manager/docs/backend/auth-hooks.md
 */
const WELCOME_TEXT = 'Welcome to the playground';

export default async ({ ctx, omega, user }) => {
  const id = omega.utilities.randomId();

  await omega.firebase.admin.firestore().doc(`notes/${id}`).set({
    id: id,
    owner: user.uid,
    text: WELCOME_TEXT,
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
  });

  ctx.log(`hook/on-create: seeded welcome note ${id} for ${user.uid}`);
};
