/**
 * GET /admin/users/list - Paginated user directory with the AUTH-record join
 * the client can never do itself (provider, disabled, email verification,
 * last sign-in come from Firebase Auth, not Firestore). Powers the admin
 * users table and the list_users MCP tool.
 *
 * Params (query):
 *   limit      - page size (default 20, max 100)
 *   search     - email/uid prefix filter (Firestore range scan on auth.email)
 *   startAfter - uid cursor from the previous page's nextCursor
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

  const limit = Math.min(Math.max(parseInt(data.limit, 10) || 20, 1), 100);
  const search = String(data.search || '').trim().toLowerCase();
  const startAfter = String(data.startAfter || '').trim();

  // Build the Firestore page. Search is an email prefix range scan (the
  // users schema stores auth.email lowercased); a bare uid search falls
  // back to a direct doc read.
  let query = admin.firestore().collection('users');

  if (search) {
    query = query
      .orderBy('auth.email')
      .startAt(search)
      // upper bound carries the literal U+F8FF prefix-scan sentinel
      .endAt(`${search}`);
  } else {
    query = query.orderBy('metadata.created.timestampUNIX', 'desc');
  }

  if (startAfter) {
    const cursorDoc = await admin.firestore().doc(`users/${startAfter}`).get().catch(() => null);
    if (cursorDoc && cursorDoc.exists) {
      query = query.startAfter(cursorDoc);
    }
  }

  const snapshot = await query.limit(limit).get().catch((e) => e);

  if (snapshot instanceof Error) {
    return ctx.respond(snapshot.message, { code: 500 });
  }

  let docs = snapshot.docs;

  // A search that looks like a UID and matched nothing → try the direct doc
  if (search && !docs.length && !search.includes('@')) {
    const direct = await admin.firestore().doc(`users/${data.search.trim()}`).get().catch(() => null);
    if (direct && direct.exists) {
      docs = [direct];
    }
  }

  // Join the auth records in ONE batch call — this is the data the client
  // SDK can't reach (disabled, providers, verification, last sign-in)
  const identifiers = docs.map((doc) => ({ uid: doc.id }));
  const authRecords = new Map();

  if (identifiers.length) {
    const authResult = await admin.auth().getUsers(identifiers).catch((e) => e);
    if (!(authResult instanceof Error)) {
      authResult.users.forEach((record) => authRecords.set(record.uid, record));
    }
  }

  const users = docs.map((doc) => {
    const stored = doc.data() || {};
    const auth = authRecords.get(doc.id) || null;

    return {
      uid: doc.id,
      email: stored.auth?.email || auth?.email || null,
      created: stored.metadata?.created?.timestamp || auth?.metadata?.creationTime || null,
      plan: stored.subscription?.product?.id || 'basic',
      subscriptionStatus: stored.subscription?.status || null,
      roles: stored.roles || {},
      // The auth-record join
      auth: auth
        ? {
          disabled: auth.disabled === true,
          emailVerified: auth.emailVerified === true,
          lastSignIn: auth.metadata?.lastSignInTime || null,
          providers: (auth.providerData || []).map((p) => p.providerId),
        }
        : null,
    };
  });

  // Track analytics
  analytics.event('admin/users/list', { count: users.length, search: !!search });

  return ctx.respond({
    users,
    count: users.length,
    nextCursor: docs.length === limit ? docs[docs.length - 1].id : null,
  });
};
