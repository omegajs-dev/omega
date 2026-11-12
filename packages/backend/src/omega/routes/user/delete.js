import fetch from 'wonderful-fetch';
import env from '../../libraries/env.js';

/**
 * DELETE /user - Delete user account
 * Requires admin auth or self-deletion with admin override
 */
export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Get target UID and reason
  const uid = data.uid;
  const reason = (data.reason || '').replace(/<[^>]*>/g, '').trim().substring(0, 500);

  // Require admin to delete other users
  if (uid !== user.auth.uid && !user.roles.admin) {
    return ctx.respond('Admin required', { code: 403 });
  }

  // Fetch user to check subscription status
  const userDoc = await admin.firestore().doc(`users/${uid}`).get();

  if (!userDoc.exists) {
    return ctx.respond('User not found', { code: 404 });
  }

  const userData = userDoc.data();

  // Disallow deleting users with active or suspended paid subscriptions
  const subStatus = userData?.subscription?.status;
  const subId = userData?.subscription?.product?.id;
  if (
    (subStatus === 'active' || subStatus === 'suspended')
    && subId !== 'basic'
  ) {
    return ctx.respond(
      'This account cannot be deleted because it has a paid subscription attached to it. In order to delete the account, you must first cancel the paid subscription.',
      { code: 400 }
    );
  }

  // Sign out of all sessions first
  ctx.log(`Signing out of all sessions for ${uid}...`);

  await fetch(`${omega.getApiUrl()}/omega/user/sessions`, {
    method: 'delete',
    timeout: 60000,
    response: 'json',
    tries: 2,
    // NO `log: true`: wonderful-fetch prints its whole configuration, headers
    // included, and this request's omega-admin-key header IS the live admin key
    // ([#702](https://github.com/Omega-JS-Stack/omega/issues/702)).
    headers: {
      'omega-admin-key': env.get('OMEGA_ADMIN_KEY'),
    },
    body: {
      uid,
    },
  })
    .then((json) => {
      ctx.log(`Sign out of all sessions success`, json);
    })
    .catch((e) => {
      ctx.error(`Sign out of all sessions failed`, e);
    });

  // Get the user's email before deleting (for confirmation email)
  const email = uid === user.auth.uid
    ? user.auth.email
    : await admin.auth().getUser(uid).then(r => r.email).catch(() => null);

  // Delete the user
  try {
    await admin.auth().deleteUser(uid);
  } catch (e) {
    return ctx.respond(`Failed to delete user: ${e}`, { code: 500 });
  }

  ctx.log(`Account deleted: ${uid}${reason ? `, reason: ${reason}` : ''}`);

  // Send confirmation email (fire-and-forget). No testing-mode gate — the mailer's
  // own seam captures a testing send instead of delivering it
  // ([#774](https://github.com/Omega-JS-Stack/omega/issues/774)).
  if (email) {
    sendConfirmationEmail(ctx, email, uid, reason, userData?.personal?.name?.first);
  }

  return ctx.respond({ success: true });
};

/**
 * Send account deletion confirmation email (fire-and-forget)
 */
function sendConfirmationEmail(ctx, email, uid, reason, firstName) {
  const omega = ctx.omega;
  const brandName = omega.config.brand.name;
  const mailer = ctx.email;
  const greeting = firstName ? `Hey ${firstName}, your` : 'Your';
  const reasonLine = reason
    ? `\n\n**Reason provided:** ${reason}`
    : '';
  const deletionDate = new Date().toUTCString();

  mailer.send({
    to: email,
    sender: 'account',
    categories: ['account/delete'],
    subject: `Your ${brandName} account has been deleted`,
    template: 'card',
    copy: true,
    data: {
      email: {
        preview: `Your ${brandName} account has been permanently deleted. All associated data has been removed.`,
      },
      content: {
        title: 'Account Deleted',
        message: `${greeting} **${brandName}** account and all associated personal data have been permanently deleted from our systems. This action is irreversible.${reasonLine}

**Deletion details:**

- **Account email:** ${email}
- **Account UID:** ${uid}
- **Deletion date:** ${deletionDate}

**What this means:**

- Your account credentials and profile information have been removed.
- Any pending data requests have been cancelled.
- Subscription and billing records have been deleted.
- You will no longer be able to sign in with this account.

If you did not request this deletion, please contact us immediately by replying to this email.

If you wish to use ${brandName} again in the future, you are welcome to create a new account at any time.`,
      },
    },
  })
    .then((result) => {
      ctx.log(`sendConfirmationEmail(): Success, status=${result.status}`);
    })
    .catch((e) => {
      ctx.error(`sendConfirmationEmail(): Failed: ${e.message}`);
    });
}
