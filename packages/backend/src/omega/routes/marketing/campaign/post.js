/**
 * POST /marketing/campaign - Create a marketing campaign
 * Admin-only. Saves to marketing-campaigns collection.
 *
 * - sendAt defaults to 'now' (immediate send)
 * - Future sendAt → saved as 'pending' for cron pickup
 * - Past/now sendAt → fires immediately, saved as 'sent'/'failed'
 * - Supports type: 'email' (default) or 'push' (future)
 *
 * Content is markdown — converted to HTML at send time per provider.
 */
import pushid from 'pushid';
import { buildCampaignDoc } from './utils.js';
import prepare from '../../../libraries/email/prepare.js';

export default async ({ ctx, omega, user, data, analytics }) => {

  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }
  if (!user.roles.admin) {
    return ctx.respond('Admin access required', { code: 403 });
  }

  // The raw-HTML fields are internal-caller only — a campaign authored over this
  // route (or the MCP create_campaign tool) sends markdown through the escaped lane.
  // Rejecting BEFORE buildCampaignDoc() is what keeps the field out of the stored
  // doc, which the cron sender reads later.
  const internalOnlyFault = prepare.internalOnlyFieldFault(data);

  if (internalOnlyFault) {
    // The field name only, never the payload it tried to smuggle.
    ctx.log(`Rejected: ${internalOnlyFault.message}`);

    return ctx.respond(internalOnlyFault.message, { code: internalOnlyFault.code });
  }

  const admin = omega.firebase.admin;
  const campaignId = data.id || pushid();
  const { docFields, campaignSettings, now } = buildCampaignDoc(data);

  if (campaignSettings.test) {
    campaignSettings._testUid = user.auth.uid;
  }

  const isFuture = docFields.sendAt > now.unix();

  const doc = {
    ...docFields,
    settings: campaignSettings,
    status: 'pending',
    metadata: {
      created: {
        timestamp: now.toISOString(),
        timestampUNIX: now.unix(),
      },
      updated: {
        timestamp: now.toISOString(),
        timestampUNIX: now.unix(),
      },
    },
  };

  // Save to Firestore
  await admin.firestore().doc(`marketing-campaigns/${campaignId}`).set(doc);

  ctx.log('marketing/campaign created:', { campaignId, sendAt: docFields.sendAt, isFuture, type: docFields.type });

  // If sendAt is now/past, fire immediately
  let results = null;

  if (!isFuture) {
    if (docFields.type === 'email') {
      const mailer = ctx.email;
      results = await mailer.sendCampaign({ ...campaignSettings, sendAt: 'now' });
    } else if (docFields.type === 'push') {
      const { default: notification } = await import('../../../libraries/notification.js');
      const pushFilters = campaignSettings.test
        ? { owner: campaignSettings._testUid || null, ...campaignSettings.filters }
        : (campaignSettings.filters || {});

      results = {
        push: await notification.send(ctx, {
          title: campaignSettings.name,
          body: campaignSettings.subject,
          icon: campaignSettings.icon || omega.config.brand?.images?.brandmark,
          clickAction: campaignSettings.clickAction || omega.config.brand?.url,
          filters: pushFilters,
        }),
      };
    }

    if (results) {
      const status = Object.values(results).some(r => r.success || r.sent > 0) ? 'sent' : 'failed';

      await admin.firestore().doc(`marketing-campaigns/${campaignId}`).set({
        status,
        results,
        metadata: {
          updated: {
            timestamp: new Date().toISOString(),
            timestampUNIX: Math.round(Date.now() / 1000),
          },
        },
      }, { merge: true });

      ctx.log('marketing/campaign sent:', { campaignId, status, results });
    }
  }

  // Analytics
  analytics.event('marketing/campaign', {
    action: isFuture ? 'schedule' : 'send',
    type: docFields.type,
  });

  return ctx.respond({
    success: true,
    id: campaignId,
    status: isFuture ? 'pending' : (results ? 'sent' : 'pending'),
    sendAt: docFields.sendAt,
    providers: results,
  });
};
