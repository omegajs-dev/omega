import _ from 'lodash';

/**
 * GET /admin/stats - Get application stats
 * Admin-only endpoint to retrieve and optionally update app statistics
 */
export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Require admin
  if (!user.roles.admin) {
    return ctx.respond('Admin required.', { code: 403 });
  }

  const stats = admin.firestore().doc('meta/stats');

  // Get current stats
  let doc = await stats.get().catch((e) => e);

  if (doc instanceof Error) {
    return ctx.respond(`Failed to get stats: ${doc.message}`, { code: 500 });
  }

  let current = doc.data() || {};

  // Ensure document exists with initial values
  if (!doc.exists) {
    await stats.set({
      users: { total: 0 },
      brand: omega.config?.brand?.id || null,
    });
    current = { users: { total: 0 } };
  }

  // Update stats if requested
  if (data.update) {
    const error = await updateStats(ctx, current, data.update);

    if (error) {
      return ctx.respond(error.message, { code: 500 });
    }

    // Retrieve stats again after updating
    doc = await stats.get().catch((e) => e);

    if (doc instanceof Error) {
      return ctx.respond(`Failed to get stats: ${doc.message}`, { code: 500 });
    }

    current = doc.data() || {};
  }

  return ctx.respond(current);
};

async function updateStats(ctx, existingData, update) {
  const omega = ctx.omega;
  const admin = omega.firebase.admin;
  const stats = admin.firestore().doc('meta/stats');
  const newData = {
    brand: omega.config?.brand?.id || null,
  };

  ctx.log('updateStats(): Starting...');

  let error = null;

  // Update notification stats
  if (update === true || update?.notifications) {
    const count = await getAllNotifications(ctx).catch((e) => e);

    if (count instanceof Error) {
      error = new Error(`Failed getting notifications: ${count.message}`);
    } else {
      _.set(newData, 'notifications.total', count);
    }
  }

  // Update subscription stats
  if (!error && (update === true || update?.subscriptions)) {
    const subscriptions = await getAllSubscriptions(ctx).catch((e) => e);

    if (subscriptions instanceof Error) {
      error = new Error(`Failed getting subscriptions: ${subscriptions.message}`);
    } else {
      _.set(newData, 'subscriptions', subscriptions);
    }
  }

  // Update user stats
  if (!error && (!existingData?.users?.total || update === true || update?.users)) {
    const users = await getAllUsers(ctx).catch((e) => e);

    if (users instanceof Error) {
      error = new Error(`Failed getting users: ${users.message}`);
    } else {
      _.set(newData, 'users.total', users.length);
    }
  }

  // Update online users
  if (!error && (update === true || update?.online)) {
    const online = await countOnlineUsers(ctx);

    _.set(newData, 'users.online', online);
  }

  if (error) {
    return error;
  }

  // Set metadata
  newData.metadata = ctx.metadata({ tag: 'admin/stats' });

  ctx.log('updateStats(): newData', newData);

  // Save stats
  await stats.set(newData, { merge: true }).catch((e) => {
    error = new Error(`Failed saving stats: ${e.message}`);
  });

  return error;
}

async function getAllUsers(ctx) {
  const admin = ctx.omega.firebase.admin;

  ctx.log('getAllUsers(): Starting...');

  const users = [];
  let nextPageToken;

  do {
    const result = await admin.auth().listUsers(1000, nextPageToken);
    users.push(...result.users);
    nextPageToken = result.pageToken;
  } while (nextPageToken);

  ctx.log(`getAllUsers(): Completed with ${users.length} users`);

  return users;
}

async function getAllNotifications(ctx) {
  const admin = ctx.omega.firebase.admin;

  ctx.log('getAllNotifications(): Starting...');

  const snap = await admin.firestore().collection('notifications').count().get();
  const count = snap.data().count;

  ctx.log(`getAllNotifications(): Completed with ${count} notifications`);

  return count;
}

async function getAllSubscriptions(ctx) {
  const admin = ctx.omega.firebase.admin;

  ctx.log('getAllSubscriptions(): Starting...');

  const snapshot = await admin.firestore().collection('users')
    .where('subscription.expires.timestampUNIX', '>=', Date.now() / 1000)
    .get();

  const stats = {
    totals: { total: 0, exempt: 0 },
    plans: {},
  };

  snapshot.forEach((doc) => {
    const data = doc.data();
    const planId = data?.subscription?.product?.id || 'basic';
    const frequency = data?.subscription?.payment?.frequency || 'unknown';
    const isAdmin = data?.roles?.admin || false;
    const isVip = data?.roles?.vip || false;

    // Initialize plan
    if (!stats.plans[planId]) {
      stats.plans[planId] = { total: 0, monthly: 0, annually: 0, exempt: 0 };
    }

    // Count exempt users
    if (isAdmin || isVip) {
      stats.totals.exempt++;
      stats.plans[planId].exempt++;
      return;
    }

    // Count subscribers
    stats.totals.total++;
    stats.plans[planId].total++;
    stats.plans[planId][frequency] = (stats.plans[planId][frequency] || 0) + 1;
  });

  ctx.log(`getAllSubscriptions(): Completed with ${stats.totals.total} subscriptions`, stats);

  return stats;
}

async function countOnlineUsers(ctx) {
  const admin = ctx.omega.firebase.admin;
  let online = 0;

  const paths = ['gatherings/online', 'sessions/app', 'sessions/online'];

  for (const path of paths) {
    const snap = await admin.database().ref(path).once('value').catch(() => null);

    if (snap) {
      const data = snap.val() || {};
      online += Object.keys(data).length;
    }
  }

  return online;
}
