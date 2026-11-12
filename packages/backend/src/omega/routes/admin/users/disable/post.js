/**
 * POST /admin/users/disable - Disable or re-enable a user at the Firebase
 * Auth level. Disabling blocks new sign-ins AND revokes refresh tokens so
 * live sessions end at their next token refresh; `disabled: false` restores
 * access. The flag is invisible to client SDKs — read it back through
 * GET /admin/users/list (the auth join).
 */
export default async ({ ctx, omega, user, data, analytics }) => {
  const admin = omega.firebase.admin;

  // Require authentication (allow in dev)
  if (!user.authenticated && ctx.isProduction()) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Require admin (allow in dev)
  if (!user.roles.admin && ctx.isProduction()) {
    return ctx.respond('Admin required.', { code: 403 });
  }

  const uid = String(data.uid || '').trim();
  const disabled = data.disabled !== false;

  if (!uid) {
    return ctx.respond('uid is required', { code: 400 });
  }

  // An admin locking their own account out is never what anyone meant
  if (disabled && uid === user.auth.uid) {
    return ctx.respond('You cannot disable your own account.', { code: 400 });
  }

  const record = await admin.auth().updateUser(uid, { disabled }).catch((e) => e);

  if (record instanceof Error) {
    const code = record.code === 'auth/user-not-found' ? 404 : 500;
    return ctx.respond(`Failed to update user: ${record.message}`, { code });
  }

  // Disabling alone lets existing sessions ride until token expiry — revoke
  // refresh tokens so the account is actually out
  if (disabled) {
    await admin.auth().revokeRefreshTokens(uid).catch(() => null);
  }

  // Track analytics
  analytics.event('admin/users/disable', { disabled });

  return ctx.respond({ uid, disabled: record.disabled === true });
};
