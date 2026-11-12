/**
 * GET /marketing/campaign - List or get marketing campaigns
 * Admin-only. Used by calendar frontend.
 *
 * Query params:
 *   id       — Get a single campaign by ID
 *   start    — Filter campaigns with sendAt >= start (unix timestamp)
 *   end      — Filter campaigns with sendAt <= end (unix timestamp)
 *   status   — Filter by status (pending, sent, failed)
 *   type     — Filter by type (email, push)
 *   limit    — Max results (default 100)
 */
export default async ({ ctx, omega, user, data }) => {

  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }
  if (!user.roles.admin) {
    return ctx.respond('Admin access required', { code: 403 });
  }

  const admin = omega.firebase.admin;

  // Single campaign by ID
  if (data.id) {
    const doc = await admin.firestore().doc(`marketing-campaigns/${data.id}`).get();

    if (!doc.exists) {
      return ctx.respond('Campaign not found', { code: 404 });
    }

    return ctx.respond({
      success: true,
      campaign: { id: doc.id, ...doc.data() },
    });
  }

  // List campaigns with filters
  let query = admin.firestore().collection('marketing-campaigns');

  if (data.status) {
    query = query.where('status', '==', data.status);
  }
  if (data.type) {
    query = query.where('type', '==', data.type);
  }
  if (data.start) {
    query = query.where('sendAt', '>=', parseInt(data.start, 10));
  }
  if (data.end) {
    query = query.where('sendAt', '<=', parseInt(data.end, 10));
  }

  query = query.orderBy('sendAt', 'asc');
  query = query.limit(parseInt(data.limit, 10) || 100);

  const snapshot = await query.get();

  const campaigns = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
  }));

  return ctx.respond({
    success: true,
    campaigns,
    count: campaigns.length,
  });
};
