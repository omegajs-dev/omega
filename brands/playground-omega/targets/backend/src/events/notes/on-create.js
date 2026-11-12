/**
 * Surface: event, a consumer Firestore trigger (notesOnCreate in src/index.js)
 * run through omega.events.run('notes/on-create'): bumps the owner's counter
 * Doc: node_modules/@omega.js/manager/docs/backend/routes.md (New Event Handler)
 */
import { FieldValue } from 'firebase-admin/firestore';

export default async ({ ctx, omega, snapshot }) => {
  const note = snapshot.data();

  // Every writer (the notes route, the on-create auth hook, the owner through
  // the rules) stamps an owner, so a note without one is a writer bug
  if (!note.owner) {
    throw new Error(`notes/on-create: note ${snapshot.id} has no owner`);
  }

  // The counter rides on the user doc: the account schema passes a brand's own
  // top-level key through, so users/{uid}.notes reaches the User every surface
  // reads, and the rules keep the owner from writing it
  await omega.firebase.admin.firestore().doc(`users/${note.owner}`).set({
    notes: { created: FieldValue.increment(1) },
  }, { merge: true });

  ctx.log(`notes/on-create: counted note ${snapshot.id} for ${note.owner}`);
};
