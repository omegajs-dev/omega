/**
 * DELETE /marketing/campaign - Delete a marketing campaign
 * Admin-only. Can only delete pending campaigns.
 */
export default async ({ ctx, omega, user, data, analytics }) => {

  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }
  if (!user.roles.admin) {
    return ctx.respond('Admin access required', { code: 403 });
  }

  const admin = omega.firebase.admin;
  const campaignId = (data.id || '').trim();

  if (!campaignId) {
    return ctx.respond('Campaign ID is required', { code: 400 });
  }

  const docRef = admin.firestore().doc(`marketing-campaigns/${campaignId}`);
  const doc = await docRef.get();

  if (!doc.exists) {
    return ctx.respond('Campaign not found', { code: 404 });
  }

  const existing = doc.data();

  // Can only delete pending campaigns (sent/failed are historical records)
  if (existing.status !== 'pending') {
    return ctx.respond(`Cannot delete campaign with status "${existing.status}"`, { code: 400 });
  }

  await docRef.delete();

  ctx.log('marketing/campaign deleted:', { campaignId });

  analytics.event('marketing/campaign', { action: 'delete' });

  return ctx.respond({
    success: true,
    deleted: campaignId,
  });
};
