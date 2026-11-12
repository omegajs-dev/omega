import powertools from 'node-powertools';

/**
 * GET /user/subscription - Get user subscription info
 * Returns subscription, expiry, trial, and payment status
 */
export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Get target UID
  const uid = data.uid;

  // Require admin to view other users' subscriptions
  if (uid !== user.auth.uid && !user.roles.admin) {
    return ctx.respond('Admin required', { code: 403 });
  }

  // Get user data
  let userData = user;

  if (uid !== user.auth.uid) {
    const doc = await admin.firestore().doc(`users/${uid}`).get();

    if (!doc.exists) {
      return ctx.respond('User not found', { code: 404 });
    }

    userData = doc.data();
  }

  // Build response
  const oldDate = powertools.timestamp(new Date(0), { output: 'string' });
  const oldDateUNIX = powertools.timestamp(oldDate, { output: 'unix' });

  const result = {
    subscription: {
      product: {
        id: userData?.subscription?.product?.id || 'basic',
        name: userData?.subscription?.product?.name || 'Basic',
      },
      status: userData?.subscription?.status || 'active',
      expires: {
        timestamp: userData?.subscription?.expires?.timestamp || oldDate,
        timestampUNIX: userData?.subscription?.expires?.timestampUNIX || oldDateUNIX,
      },
      trial: {
        claimed: userData?.subscription?.trial?.claimed ?? false,
        expires: {
          timestamp: userData?.subscription?.trial?.expires?.timestamp || oldDate,
          timestampUNIX: userData?.subscription?.trial?.expires?.timestampUNIX || oldDateUNIX,
        },
      },
      cancellation: {
        pending: userData?.subscription?.cancellation?.pending ?? false,
        date: {
          timestamp: userData?.subscription?.cancellation?.date?.timestamp || oldDate,
          timestampUNIX: userData?.subscription?.cancellation?.date?.timestampUNIX || oldDateUNIX,
        },
      },
      payment: {
        provider: userData?.subscription?.payment?.provider || null,
        frequency: userData?.subscription?.payment?.frequency || null,
        startDate: {
          timestamp: userData?.subscription?.payment?.startDate?.timestamp || oldDate,
          timestampUNIX: userData?.subscription?.payment?.startDate?.timestampUNIX || oldDateUNIX,
        },
      },
    },
  };

  return ctx.respond(result);
};
