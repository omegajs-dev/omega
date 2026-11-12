/**
 * PUT /marketing/campaign - Update a marketing campaign
 * Admin-only. Used by calendar frontend for edits and rescheduling.
 *
 * Accepts any field from the POST schema. Only provided fields are updated.
 * Changing sendAt reschedules the campaign (if still pending).
 */
import { buildCampaignDoc } from './utils.js';
import prepare from '../../../libraries/email/prepare.js';

export default async ({ ctx, omega, user, data, analytics }) => {

  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }
  if (!user.roles.admin) {
    return ctx.respond('Admin access required', { code: 403 });
  }

  // The raw-HTML fields are internal-caller only — an edit over this route (or the
  // MCP update_campaign tool) sends markdown through the escaped lane. Rejecting
  // BEFORE buildCampaignDoc() is what keeps the field out of the stored doc, which
  // the cron sender reads later.
  const internalOnlyFault = prepare.internalOnlyFieldFault(data);

  if (internalOnlyFault) {
    // The field name only, never the payload it tried to smuggle.
    ctx.log(`Rejected: ${internalOnlyFault.message}`);

    return ctx.respond(internalOnlyFault.message, { code: internalOnlyFault.code });
  }

  const admin = omega.firebase.admin;
  const campaignId = (data.id || '').trim();

  if (!campaignId) {
    return ctx.respond('Campaign ID is required', { code: 400 });
  }

  // Fetch existing
  const docRef = admin.firestore().doc(`marketing-campaigns/${campaignId}`);
  const doc = await docRef.get();

  if (!doc.exists) {
    return ctx.respond('Campaign not found', { code: 404 });
  }

  const existing = doc.data();

  // Can only edit pending campaigns
  if (existing.status !== 'pending') {
    return ctx.respond(`Cannot edit campaign with status "${existing.status}"`, { code: 400 });
  }

  // Build update from provided fields using shared utility
  const { docFields, campaignSettings } = buildCampaignDoc(data);

  const update = {
    ...docFields,
    metadata: {
      updated: {
        timestamp: new Date().toISOString(),
        timestampUNIX: Math.round(Date.now() / 1000),
      },
    },
  };

  // Merge provided settings into existing
  if (Object.keys(campaignSettings).length) {
    update.settings = { ...existing.settings, ...campaignSettings };
  }

  await docRef.set(update, { merge: true });

  ctx.log('marketing/campaign updated:', { campaignId, update });

  analytics.event('marketing/campaign', { action: 'update' });

  // Fetch updated doc
  const updated = await docRef.get();

  return ctx.respond({
    success: true,
    campaign: { id: campaignId, ...updated.data() },
  });
};
