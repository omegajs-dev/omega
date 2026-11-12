/**
 * GET /user/sessions - Get active sessions
 * Returns all active sessions for a user
 */
export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Get target UID
  const uid = data.uid;

  // Require admin to view other users' sessions
  if (uid !== user.auth.uid && !user.roles.admin) {
    return ctx.respond('Admin required', { code: 403 });
  }

  const sessionId = data.id;
  const sessionPath = `sessions/${sessionId}`;

  ctx.log(`Getting active sessions for ${uid} @ ${sessionPath}`);

  // Query sessions
  const snapshot = await admin.database().ref(sessionPath)
    .orderByChild('uid')
    .equalTo(uid)
    .once('value')
    .catch((e) => e);

  if (snapshot instanceof Error) {
    return ctx.respond(`Session query error: ${snapshot}`, { code: 500 });
  }

  const sessions = snapshot.val() || {};

  return ctx.respond(sessions);
};
