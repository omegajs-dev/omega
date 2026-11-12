import { v4 as uuid4 } from 'uuid';
import UIDGenerator from 'uid-generator';
import powertools from 'node-powertools';
const uidgen = new UIDGenerator(256);

/**
 * POST /user/api-keys - Regenerate API keys
 * Regenerates clientId and/or privateKey for the user
 */
export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Get target UID
  const uid = data.uid;

  // Require admin to regenerate other users' keys
  if (uid !== user.auth.uid && !user.roles.admin) {
    return ctx.respond('Admin required', { code: 403 });
  }

  // Determine which keys to regenerate
  const keys = powertools.arrayify(data.keys);
  const newKeys = {};

  keys.forEach((key) => {
    if (key.match(/client/i)) {
      newKeys.clientId = uuid4();
    } else if (key.match(/private/i)) {
      newKeys.privateKey = uidgen.generateSync();
    }
  });

  // Update user document
  const write = await admin.firestore().doc(`users/${uid}`)
    .set({
      api: newKeys,
      metadata: ctx.metadata({ tag: 'user/api-keys' }),
    }, { merge: true })
    .catch((e) => e);

  if (write instanceof Error) {
    return ctx.respond(`Failed to generate keys: ${write}`, { code: 500 });
  }

  return ctx.respond(newKeys);
};
