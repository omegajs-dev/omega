import powertools from 'node-powertools';

/**
 * DELETE /user/sessions - Sign out of all sessions
 * Signs user out of all active sessions and revokes refresh tokens
 */
export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Get target UID
  const uid = data.uid;

  // Require admin to sign out other users
  if (uid !== user.auth.uid && !user.roles.admin) {
    return ctx.respond('Admin required', { code: 403 });
  }

  const sessionId = data.id;
  const sessionPath = `sessions/${sessionId}`;

  let count = 0;

  // Sign out of main session
  count += await signOutOfSession(ctx, uid, sessionPath);

  // The session path Somiibo and older desktop apps still write
  count += await signOutOfSession(ctx, uid, 'gatherings/online');

  // Revoke Firebase refresh tokens
  try {
    await admin.auth().revokeRefreshTokens(uid);
  } catch (e) {
    return ctx.respond(`Failed to sign out of all sessions: ${e}`, { code: 500 });
  }

  return ctx.respond({
    sessions: count,
    message: `Successfully signed ${uid} out of all sessions`,
  });
};

/**
 * Sign out of a specific session path
 */
async function signOutOfSession(ctx, uid, sessionPath) {
  const admin = ctx.omega.firebase.admin;
  let count = 0;

  const snapshot = await admin.database().ref(sessionPath)
    .orderByChild('uid')
    .equalTo(uid)
    .once('value')
    .catch((e) => {
      ctx.error(`Session query error for session ${sessionPath}: ${e}`);
      return null;
    });

  if (!snapshot) {
    return 0;
  }

  const sessions = snapshot.val() || {};
  const keys = Object.keys(sessions);

  ctx.log(`Signing out of ${keys.length} active sessions for ${uid} @ ${sessionPath}`);

  const promises = keys.map(async (key) => {
    ctx.log(`Signing out ${sessionPath}/${key}...`);

    // Send signout command
    await admin.database().ref(`${sessionPath}/${key}/command`)
      .set('signout')
      .catch((e) => ctx.error(`Failed to signout of session ${key}`, e));

    // Delay so the client has time to react to the command
    await powertools.wait(5000);

    // Delete session
    await admin.database().ref(`${sessionPath}/${key}`)
      .remove()
      .catch((e) => ctx.error(`Failed to delete session ${key}`, e));

    ctx.log(`Signed out successfully: ${key}`);
    count++;
  });

  await Promise.all(promises);

  return count;
}
