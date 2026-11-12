import path from 'path';
import powertools from 'node-powertools';
import loadProvider from '../../../libraries/load-provider.js';
import { deliverConversion } from '../../../libraries/analytics/conversions.js';
import { buildAttributionContext, buildIdentity } from '../../../libraries/analytics/match-data.js';
import { isNewerThanSweep, resolveTrialOutcomeConversion } from '../helpers/trial-lapse-sweep.js';

const PROVIDERS_DIR = path.join(import.meta.dirname, '../../../libraries/payment/providers');

// The candidate window, at both edges.
//
// GRACE — a trial that ended within the last 24 hours is left alone. Webhook lag at
// trial end is normal, and PayPal's stored trial expiry is a COMPUTED ESTIMATE
// (PayPal fires no trial-end event), so acting the minute the stored date passes
// would cancel subscriptions the provider is about to confirm.
//
// FLOOR — a trial that ended more than 30 days ago ages out of the sweep. This is a
// BACKSTOP for missed webhooks, not the primary path (Stripe and Chargebee fire real
// events at trial end); without a floor every trial ever claimed is re-examined for
// the life of the brand.
const GRACE_SECONDS = 24 * 60 * 60;
const FLOOR_SECONDS = 30 * 24 * 60 * 60;

// Bounded per run. The window keeps the set small on its own; this is the ceiling.
const SWEEP_LIMIT = 200;

/**
 * Trial lapse sweep: the backstop for a missed trial-end webhook, which leaves a
 * user on a paid product never paid for (`trial.claimed` never says "converted").
 * Every candidate is CONFIRMED against live provider state before a write, never
 * inferred from dates: active stamps `trial.outcome` converted and nothing else;
 * gone or cancelled resets to basic and stamps lapsed; dunning waits for the next
 * run. Each write re-reads in a transaction so a newer webhook is never clobbered.
 *
 * No email is sent from here. The outcome is reported through `deliverConversion`,
 * the only signal PayPal ever gives (it fires no trial-end event); the guard against
 * double-counting is `resolveTrialOutcomeConversion()` (../helpers/trial-lapse-sweep.js).
 */
export default async ({ ctx, omega, context }) => {
  const admin = omega.firebase.admin;

  // The read stamp: any subscription write newer than this landed AFTER our snapshot,
  // which means a webhook has since spoken and this sweep's answer is stale.
  const now = powertools.timestamp(new Date(), { output: 'string' });
  const nowUNIX = powertools.timestamp(now, { output: 'unix' });
  const sweepReadUNIX = nowUNIX;

  const ceilingUNIX = nowUNIX - GRACE_SECONDS;
  const floorUNIX = nowUNIX - FLOOR_SECONDS;

  ctx.log(`Checking for lapsed trials (expired between ${floorUNIX} and ${ceilingUNIX})...`);

  const snapshot = await admin.firestore()
    .collection('users')
    .where('subscription.trial.claimed', '==', true)
    .where('subscription.status', '==', 'active')
    .where('subscription.trial.expires.timestampUNIX', '>=', floorUNIX)
    .where('subscription.trial.expires.timestampUNIX', '<=', ceilingUNIX)
    .limit(SWEEP_LIMIT)
    .get();

  if (snapshot.empty) {
    ctx.log('No expired trials to check');
    return;
  }

  ctx.log(`Sweeping ${snapshot.size} expired trial(s)...`);

  let lapsed = 0;
  let converted = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of snapshot.docs) {
    const uid = doc.id;

    // Per-candidate isolation, like the runner's per-job isolation: one user whose
    // provider is unreachable must not cost every user behind them in the batch.
    try {
      const sub = doc.data().subscription || {};

      // Already answered — the outcome is stamped once and never revisited
      if (sub.trial?.outcome) {
        ctx.log(`skip ${uid}: trial already stamped ${sub.trial.outcome}`);
        skipped++;
        continue;
      }

      // Nothing to lapse — basic IS the lapsed end state
      if (sub.product?.id === 'basic') {
        ctx.log(`skip ${uid}: already on basic`);
        skipped++;
        continue;
      }

      const provider = sub.payment?.provider;
      const resourceId = sub.payment?.resourceId;

      if (!provider || !resourceId) {
        ctx.log(`skip ${uid}: no provider to confirm with (provider=${provider || 'null'}, resourceId=${resourceId || 'null'})`);
        skipped++;
        continue;
      }

      let library;

      try {
        library = loadProvider(PROVIDERS_DIR, provider);
      } catch (e) {
        ctx.warn(`skip ${uid}: unknown provider library '${provider}' — nothing can confirm this trial`);
        skipped++;
        continue;
      }

      // Ask the provider. Its answer is the only thing this sweep acts on — a fetch
      // that cannot answer throws rather than handing back anything older.
      let live = null;

      try {
        live = await library.fetchResource('subscription', resourceId, { admin, ctx, config: omega.config });
      } catch (e) {
        // A provider that cannot answer is not a provider saying "cancelled". Only
        // "no such subscription" means gone; everything else is transient and waits
        // for the next run rather than fabricating a cancellation.
        if (!e.notFound) {
          ctx.warn(`skip ${uid}: provider ${provider} could not confirm ${resourceId} (${e.message}) — retrying next run`);
          skipped++;
          continue;
        }
      }

      // No resource, or one with no status, is the provider saying it is gone
      const gone = !live || !live.status;
      const liveStatus = gone ? null : library.toUnifiedSubscription(live, { config: omega.config }).status;

      let outcome;

      if (!gone && liveStatus === 'active') {
        outcome = 'converted';
      } else if (gone || liveStatus === 'cancelled') {
        outcome = 'lapsed';
      } else {
        // Dunning (suspended): the provider still holds the subscription and is still
        // trying. Neither outcome is true yet, so nothing is stamped and the next run
        // asks again.
        ctx.log(`skip ${uid}: provider ${provider} reports ${liveStatus} — no outcome yet`);
        skipped++;
        continue;
      }

      // The trial converted into a paid subscription: stamp the outcome and touch
      // NOTHING else — the subscription the user is paying for is correct as it is.
      // A lapse writes the same end state the cancel route does for a subscription
      // the provider no longer has: cancelled, back on basic, nothing pending.
      const write = outcome === 'converted'
        ? { subscription: { trial: { outcome: 'converted' } } }
        : {
          subscription: {
            status: 'cancelled',
            product: { id: 'basic', name: 'Basic' },
            cancellation: { pending: false, date: { timestamp: now, timestampUNIX: nowUNIX } },
            trial: { outcome: 'lapsed' },
          },
        };

      // Re-read and write in ONE transaction. The snapshot above is from the top of
      // the run; a webhook may have written this subscription since, and that write
      // is the newer truth — the sweep must never clobber it. As a bare read followed
      // by a separate set, a webhook landing BETWEEN the two was clobbered anyway:
      // the guard proved freshness at a moment that had already passed by the time
      // the write went out. A transaction re-runs the whole block when the document
      // changes under it, so the guard and the write see one state
      // ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
      const result = await admin.firestore().runTransaction(async (transaction) => {
        const fresh = await transaction.get(doc.ref);
        const freshSub = fresh.data()?.subscription || {};
        const freshStampUNIX = freshSub.payment?.updatedBy?.date?.timestampUNIX || 0;

        if (isNewerThanSweep(freshStampUNIX, sweepReadUNIX)) {
          return { skipped: `a newer subscription write landed (updatedBy=${freshStampUNIX} >= read=${sweepReadUNIX})` };
        }

        if (freshSub.status !== 'active' || freshSub.trial?.outcome) {
          return { skipped: `no longer a candidate (status=${freshSub.status}, outcome=${freshSub.trial?.outcome || 'null'})` };
        }

        transaction.set(doc.ref, write, { merge: true });

        return { userData: fresh.data() || {}, sub: freshSub };
      });

      if (result.skipped) {
        ctx.log(`skip ${uid}: ${result.skipped}`);
        skipped++;
        continue;
      }

      if (outcome === 'converted') {
        ctx.log(`convert ${uid}: provider ${provider} reports the subscription is active, trial.outcome=converted`);
        trackOutcome({ outcome, uid, userData: result.userData, sub: result.sub, omega, ctx });
        converted++;
        continue;
      }

      ctx.log(`lapse ${uid}: provider ${provider} reports ${gone ? 'the subscription is gone' : liveStatus}, reset to basic, trial.outcome=lapsed`);
      trackOutcome({ outcome, uid, userData: result.userData, sub: result.sub, omega, ctx });
      lapsed++;
    } catch (e) {
      ctx.error(`Failed to sweep ${uid}: ${e.message}`);
      failed++;
    }
  }

  ctx.log(`Completed! (${lapsed} lapsed, ${converted} converted, ${skipped} skipped, ${failed} failed)`);
};

/**
 * Report a trial outcome this sweep decided (non-blocking, never throws at the sweep)
 *
 * @param {object} options
 * @param {string} options.outcome - 'converted' | 'lapsed'
 * @param {string} options.uid - The owner
 * @param {object} options.userData - The user doc (attribution + consent + match data)
 * @param {object} options.sub - The subscription as it stood before the write
 * @param {object} options.omega - The Omega instance
 * @param {object} options.ctx - The event context
 */
function trackOutcome({ outcome, uid, userData, sub, omega, ctx }) {
  try {
    const conversion = resolveTrialOutcomeConversion(sub, outcome, omega.config.payment?.currency || 'USD');

    if (!conversion) {
      ctx.log(`skip analytics ${uid}: the term has moved past the trial end (expires=${sub.expires?.timestampUNIX || 'null'}, trial.expires=${sub.trial?.expires?.timestampUNIX || 'null'})`);
      return;
    }

    deliverConversion({
      ...conversion,
      attribution: buildAttributionContext(userData.attribution),
      // The whole doc, read by the ONE match reader (#577)
      identity: buildIdentity({ uid: uid, user: userData }),
      trackingConsent: userData.trackingConsent,
      ctx: ctx,
      omega: omega,
    });
  } catch (e) {
    ctx.error(`Trial outcome tracking failed for ${uid}: ${e.message}`, e);
  }
}
