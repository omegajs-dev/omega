/**
 * The marketing prune's three stages (events/cron/daily/marketing-prune.js). They
 * live outside the schedule's folder, whose every file the cron runner runs as a job.
 * The contract: docs/backend/marketing-campaigns.md § Contact Pruning.
 */
const Marketing = require('../../../libraries/email/marketing/index.js');
const { User } = require('../../../helpers/account.js');

// The Beehiiv lane's inactivity rule, mirroring the SendGrid engagement_inactive_6m
// segment (libraries/email/constants.js) with Beehiiv's own numbers: `received_gte: 5`
// (a quiet channel prunes nobody, which is the guard working) and the segment's
// `signup_date not_within 180d` grace period.
const NEWSLETTER_RECEIVED_FLOOR = 5;
const NEWSLETTER_MIN_AGE_DAYS = 180;

// How many Beehiiv subscribers are deleted at once. Each removal is TWO API
// calls (look up the subscription, then delete it), so 50 keeps the in-flight
// call count at the same 100 the SendGrid batch loop already uses.
const NEWSLETTER_DELETE_CHUNK = 50;

/**
 * Stage 1: Send re-engagement email to contacts inactive 5+ months
 * (excluding 6+ months, which stage 2 prunes). It goes through the campaigns
 * role alone, whose provider holds the engagement segments, and sendCampaign
 * scopes the audience to the brand.
 */
async function stageReengage(omega, ctx) {
  ctx.log('Marketing prune: Stage 1: Re-engagement');

  const mailer = ctx.email;
  const brand = omega.config?.brand;

  const result = await mailer.sendCampaign({
    name: 'Re-engagement: Are you still with us?',
    subject: `We miss you at ${brand?.name || 'our service'}!`,
    preheader: 'Update your preferences or say goodbye',
    data: {
      content: {
        message: [
          '# We miss you!',
          '',
          'It\'s been a while since you\'ve opened one of our emails. We want to make sure we\'re sending you content you actually want.',
          '',
          '**If you\'d like to keep hearing from us**, simply open this email: no action needed!',
          '',
          'If we don\'t hear from you, we\'ll remove you from our mailing list next month to keep your inbox clean.',
          '',
          `Thanks for being part of the ${brand?.name || ''} community.`,
        ].join('\n'),
      },
    },
    sender: 'hello',
    segments: ['engagement_inactive_5m'],
    excludeSegments: ['engagement_inactive_6m'],
    // The engagement segments live on the campaigns provider alone
    providers: ['campaigns'],
    sendAt: 'now',
  });

  ctx.log('Marketing prune: Re-engagement result:', result);
}

/**
 * Stage 2: Delete SENDGRID contacts inactive 6+ months in SENDGRID (brand-scoped).
 *
 * Uses createBrandScopedSegment to AND the engagement_inactive_6m query
 * with brand_id = '<brandId>', so each brand only prunes its own contacts.
 * Excludes paying customers (subscription_paid segment).
 * Logs deleted emails to Firestore for recoverability.
 *
 * Stops at SendGrid: the same emails stay in Beehiiv, which prunes on its own
 * engagement in stage 3.
 */
async function stagePrune(omega, ctx) {
  ctx.log('Marketing prune: Stage 2: Prune (SendGrid)');

  const brand = omega.config?.brand;
  const admin = omega.firebase.admin;

  if (!brand?.id) {
    ctx.error('Marketing prune: brand.id is missing, aborting to prevent account-global deletion');
    return;
  }

  if (!Marketing.roleOn(omega.config, 'campaigns')) {
    ctx.log('Marketing prune: SendGrid not configured, skipping');
    return;
  }

  const campaignsProvider = Marketing.roleProvider('campaigns');
  const segmentIdMap = await campaignsProvider.resolveSegmentIds();
  const pruneSegmentId = segmentIdMap['engagement_inactive_6m'];

  if (!pruneSegmentId) {
    ctx.error('Marketing prune: engagement_inactive_6m segment not found in SendGrid');
    return;
  }

  // Brand-scope the prune segment
  const tempPrune = await campaignsProvider.createBrandScopedSegment(
    [pruneSegmentId],
    brand.id,
  );

  if (!tempPrune) {
    ctx.error('Marketing prune: Failed to create brand-scoped prune segment');
    return;
  }

  try {
    const exportResult = await campaignsProvider.getSegmentContacts(tempPrune.segmentId, 180000);

    if (!exportResult.success) {
      ctx.error('Marketing prune: Failed to export segment:', exportResult.error);
      return;
    }

    if (exportResult.contacts.length === 0) {
      ctx.log('Marketing prune: No contacts to prune');
      return;
    }

    // Exclude paying customers
    let contactsToPrune = exportResult.contacts;
    let skippedPaid = 0;

    const paidSegmentId = segmentIdMap['subscription_paid'];

    if (paidSegmentId) {
      const tempPaid = await campaignsProvider.createBrandScopedSegment(
        [paidSegmentId],
        brand.id,
      );

      // No paid segment to exclude means paying customers cannot be told apart
      if (!tempPaid) {
        ctx.error('Marketing prune: the subscription_paid segment has no usable query, so paying customers cannot be excluded; pruning nothing this run');
        return;
      }

      try {
        const paidExport = await campaignsProvider.getSegmentContacts(tempPaid.segmentId, 180000);

        // A failed export leaves paying customers unknown; an empty one has none
        if (!paidExport.success) {
          ctx.error(`Marketing prune: the subscription_paid export failed (${paidExport.error}), so paying customers cannot be excluded; pruning nothing this run`);
          return;
        }

        if (paidExport.contacts.length > 0) {
          const paidEmails = new Set(paidExport.contacts.map(c => c.email));
          contactsToPrune = contactsToPrune.filter(c => !paidEmails.has(c.email));
          skippedPaid = exportResult.contacts.length - contactsToPrune.length;
          ctx.log(`Marketing prune: Excluded ${skippedPaid} paying customers`);
        }
      } finally {
        await tempPaid.cleanup();
      }
    }

    if (contactsToPrune.length === 0) {
      ctx.log('Marketing prune: No contacts to prune after paid exclusion');
      return;
    }

    const emails = contactsToPrune.map(c => c.email).filter(Boolean);

    ctx.log(`Marketing prune: Deleting ${contactsToPrune.length} contacts for ${brand.id}`);

    // Delete from SendGrid
    const ids = contactsToPrune.map(c => c.id).filter(Boolean);
    let totalDeleted = 0;

    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const deleteResult = await campaignsProvider.bulkDeleteContacts(batch);

      if (deleteResult.success) {
        totalDeleted += batch.length;
      } else {
        ctx.error('Marketing prune: Batch delete failed:', deleteResult.error);
      }
    }

    ctx.log(`Marketing prune: Deleted ${totalDeleted} SendGrid contacts for ${brand.id}`);

    await logPrunedEmails(admin, ctx, brand.id, '', { emails, skippedPaid });
  } finally {
    await tempPrune.cleanup();
  }
}

/**
 * Stage 3: Delete BEEHIIV subscribers inactive by BEEHIIV's own engagement.
 *
 * Beehiiv reports lifetime per-subscriber stats, so a subscriber who has received
 * enough newsletters, has been on the list long enough, and has never once opened
 * or clicked is the Beehiiv-native shape of "gone". One publication belongs to one
 * brand, so the listing is brand-scoped by construction. Paying customers are
 * excluded as in stage 2, removal deletes the subscription (never unsubscribes it),
 * and the deleted emails are logged to Firestore for recoverability.
 */
async function stageNewsletterPrune(omega, ctx) {
  ctx.log('Marketing prune: Stage 3: Prune (Beehiiv)');

  const brand = omega.config?.brand;
  const admin = omega.firebase.admin;

  if (!brand?.id) {
    ctx.error('Marketing prune: brand.id is missing, aborting to prevent account-global deletion');
    return;
  }

  if (!Marketing.roleOn(omega.config, 'newsletter')) {
    ctx.log('Marketing prune: Beehiiv not configured, skipping');
    return;
  }

  const newsletterProvider = Marketing.roleProvider('newsletter');
  const listing = await newsletterProvider.listSubscriptions({
    status: 'active',
    expand: ['stats'],
  });

  if (!listing.success) {
    ctx.error('Marketing prune: Failed to list Beehiiv subscriptions:', listing.error);
    return;
  }

  const now = Date.now();
  const candidates = listing.subscriptions.filter(subscription => isNewsletterInactive(subscription, now));

  if (candidates.length === 0) {
    ctx.log(`Marketing prune: No Beehiiv subscribers to prune (${listing.subscriptions.length} scanned)`);
    return;
  }

  const { targets, skippedPaid } = await excludePayingSubscribers(admin, ctx, candidates);

  if (targets.length === 0) {
    ctx.log('Marketing prune: No Beehiiv subscribers to prune after paid exclusion');
    return;
  }

  ctx.log(`Marketing prune: Deleting ${targets.length} Beehiiv subscribers for ${brand.id} (${listing.subscriptions.length} scanned)`);

  const emails = [];

  for (let i = 0; i < targets.length; i += NEWSLETTER_DELETE_CHUNK) {
    const batch = targets.slice(i, i + NEWSLETTER_DELETE_CHUNK);
    const results = await Promise.allSettled(
      batch.map(subscription => newsletterProvider.removeContact(subscription.email))
    );

    results.forEach((result, index) => {
      const email = batch[index].email;

      // `deleted`, not `success`: a subscriber who vanished between the listing
      // and the delete comes back { success: true, skipped: true }, and counting
      // that as a prune would log an email this run never removed
      if (result.status === 'fulfilled' && result.value?.deleted) {
        emails.push(email);
      } else if (result.status === 'fulfilled' && result.value?.skipped) {
        ctx.log(`Marketing prune: Beehiiv subscriber already gone, skipping: ${email}`);
      } else {
        ctx.error(`Marketing prune: Beehiiv delete failed for ${email}:`, result.reason?.message || result.value?.error);
      }
    });
  }

  ctx.log(`Marketing prune: Deleted ${emails.length} Beehiiv subscribers for ${brand.id}`);

  await logPrunedEmails(admin, ctx, brand.id, '-newsletter', { emails, skippedPaid, provider: 'newsletter' });
}

/**
 * Split prune candidates into targets and paying customers to keep. Beehiiv
 * cannot see app subscriptions, so each email's user doc decides, by the User's
 * `active` (the subscription_paid segment's own conditions). No user doc, or a
 * failed lookup, keeps it a target: stage 2 likewise goes on when its paid
 * export is empty, though it stops when that export fails.
 * @param {object} admin - firebase-admin instance
 * @param {object} ctx - Assistant (for logging)
 * @param {Array<object>} candidates - Subscriptions inactive by Beehiiv's stats
 * @returns {{ targets: Array<object>, skippedPaid: number }}
 */
async function excludePayingSubscribers(admin, ctx, candidates) {
  const targets = [];
  let skippedPaid = 0;

  for (let i = 0; i < candidates.length; i += NEWSLETTER_DELETE_CHUNK) {
    const batch = candidates.slice(i, i + NEWSLETTER_DELETE_CHUNK);
    const userDocs = await Promise.all(
      batch.map(subscription => Marketing.findUserByEmail(admin, ctx, subscription.email))
    );

    userDocs.forEach((userDoc, index) => {
      // A user document the account model refuses (a legacy top-level `plan`)
      // cannot be judged paid or not, so its subscriber is kept and the rest
      // of the run goes on, the way abandoned-carts treats a bad document
      let paid;

      try {
        paid = !!userDoc && new User(userDoc).active;
      } catch (e) {
        ctx.error(`Marketing prune: Skipping ${batch[index].email}, its user document did not load:`, e.message);
        return;
      }

      if (paid) {
        skippedPaid++;
      } else {
        targets.push(batch[index]);
      }
    });
  }

  if (skippedPaid > 0) {
    ctx.log(`Marketing prune: Excluded ${skippedPaid} paying customers`);
  }

  return { targets, skippedPaid };
}

/**
 * Is this Beehiiv subscription prunable on BEEHIIV's own engagement?
 *
 * `expand[]=stats` reports lifetime counters, so "inactive" means never engaged at
 * all across a meaningful number of sends: stricter than SendGrid's 180-day window.
 * Stats the expand did not return leave the subscriber unjudgeable, and an
 * unjudgeable subscriber is never deleted.
 *
 * @param {object} subscription - A Beehiiv subscription with `stats` expanded
 * @param {number} now - Milliseconds since epoch
 * @returns {boolean}
 */
function isNewsletterInactive(subscription, now) {
  const stats = subscription?.stats;

  if (
    typeof stats?.emails_received !== 'number'
    || typeof stats?.open_rate !== 'number'
    || typeof stats?.click_through_rate !== 'number'
  ) {
    return false;
  }

  if (stats.emails_received < NEWSLETTER_RECEIVED_FLOOR) {
    return false;
  }

  // Beehiiv's `created` is unix SECONDS
  const createdAt = Number(subscription.created) * 1000;

  if (!createdAt || (now - createdAt) < (NEWSLETTER_MIN_AGE_DAYS * 24 * 60 * 60 * 1000)) {
    return false;
  }

  return stats.open_rate <= 0 && stats.click_through_rate <= 0;
}

/**
 * Log a lane's deleted emails to Firestore for recoverability: one doc per brand
 * per month per lane (`suffix` keeps the two lanes apart). Non-fatal: a failed
 * log must never abort a prune that already deleted.
 * @param {object} admin - firebase-admin instance
 * @param {object} ctx - Assistant (for logging)
 * @param {string} brandId
 * @param {string} suffix - Lane suffix on the run doc id ('' for SendGrid)
 * @param {object} payload - Extra fields to store alongside the emails
 */
async function logPrunedEmails(admin, ctx, brandId, suffix, payload) {
  try {
    const now = new Date();
    const logKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    await admin.firestore()
      .doc(`marketing-prune-logs/${brandId}/runs/${logKey}${suffix}`)
      .set({
        brandId,
        date: now.toISOString(),
        count: payload.emails.length,
        ...payload,
      });

    ctx.log(`Marketing prune: Logged ${payload.emails.length} pruned emails to Firestore (${logKey}${suffix})`);
  } catch (e) {
    ctx.error('Marketing prune: Failed to write Firestore log:', e.message);
  }
}

module.exports = {
  stageReengage,
  stagePrune,
  stageNewsletterPrune,
  isNewsletterInactive,
  NEWSLETTER_RECEIVED_FLOOR,
  NEWSLETTER_MIN_AGE_DAYS,
};
