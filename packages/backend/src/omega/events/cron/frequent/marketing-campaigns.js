/**
 * Marketing campaigns cron job
 *
 * Picks up campaigns from the `marketing-campaigns` collection that are
 * past their sendAt time and still pending. Dispatches based on type:
 *   - email: fires through mailer.sendCampaign()
 *   - push: fires through notification.send()
 *
 * Claim/lease lifecycle (prevents double-sends across overlapping runs):
 *   - Each due campaign is CLAIMED by transactionally flipping status
 *     'pending' → 'processing' before any work happens. A campaign another
 *     run already claimed is skipped.
 *   - Every terminal path writes a final status: 'sent'/'failed' for
 *     one-offs, back to 'pending' (with an advanced sendAt) for recurring.
 *   - If a run dies mid-flight (crash, function timeout), the doc stays
 *     'processing' until the stale-lease reclaim flips it back to 'pending'
 *     after PROCESSING_LEASE_SECONDS — a natural retry backoff.
 *
 * Generator campaigns (has `generator` field, e.g. 'newsletter'):
 *   - Runs the content generation pipeline (AI content, images, uploads)
 *   - Sends the generated content immediately
 *   - Stores a history record with the generated content + send results
 *   - When generation yields nothing, retries next run — up to
 *     GENERATOR_MAX_ATTEMPTS total, then the occurrence is skipped
 *     (recurring) or the campaign is marked failed (one-off)
 *
 * Recurring campaigns (has `recurrence` field):
 *   - Creates a history doc in the same collection with results
 *   - Advances the recurring doc's sendAt to the next FUTURE occurrence
 *     (missed occurrences are skipped — no catch-up bursts)
 *   - Status returns to 'pending' on the recurring doc
 *
 * Unknown campaign types / generators are marked 'failed' (they can never
 * succeed — usually a config typo — so retrying forever just burns runs).
 *
 * A CODED 400 anywhere in a campaign's work — thrown by the send, thrown by
 * the generator pipeline, or carried back in a provider result (sendCampaign()
 * converts a provider's throw to { success: false, error, code }) — is the same
 * kind of permanent fault and is finalized the same way: a brand-config hole or
 * a bad prompt cannot heal itself, so retrying it would run forever. Every
 * other failure is treated as transient and keeps its existing path (the
 * stale-at-'processing' reclaim, or the success:false bookkeeping).
 *
 * Runs on omega_cronFrequent (every 10 minutes).
 */
import moment from 'moment';
import pushid from 'pushid';
import notification from '../../../libraries/notification.js';
import { getNextFutureOccurrence } from '../../../libraries/email/constants.js';
// firebase-admin v13 dropped the admin.firestore.FieldValue static: import
// the modular way (same pattern as admin/send-email.js).
import { FieldValue } from 'firebase-admin/firestore';
import { PROCESSING_LEASE_SECONDS, GENERATOR_MAX_ATTEMPTS, loadGenerators } from '../helpers/marketing-campaigns.js';

export default async ({ ctx, omega }) => {
  const admin = omega.firebase.admin;
  const now = Math.round(Date.now() / 1000);
  const collection = admin.firestore().collection('marketing-campaigns');

  // --- Reclaim stale processing leases (crashed or timed-out runs) ---
  // Single-equality query + in-memory cutoff — no composite index required.
  const processingSnapshot = await collection
    .where('status', '==', 'processing')
    .limit(50)
    .get();

  for (const doc of processingSnapshot.docs) {
    const startedAt = doc.data().processingStartedAt || 0;

    if (startedAt > now - PROCESSING_LEASE_SECONDS) {
      continue;
    }

    await doc.ref.set({
      status: 'pending',
      metadata: { updated: stamp() },
    }, { merge: true });

    ctx.log(`Reclaimed stale processing lease on ${doc.id} (started ${moment.unix(startedAt).toISOString()})`);
  }

  // --- Query campaigns that are ready to send ---
  const snapshot = await collection
    .where('status', '==', 'pending')
    .where('sendAt', '<=', now)
    .limit(20)
    .get();

  if (snapshot.empty) {
    ctx.log('No pending campaigns ready to send');
    return;
  }

  ctx.log(`Processing ${snapshot.size} campaign(s)...`);

  const email = ctx.email;

  const results = await Promise.allSettled(snapshot.docs.map(async (doc) => {
    const data = doc.data();
    const { settings, type, recurrence, generator } = data;
    const campaignId = doc.id;

    // Claim the campaign before doing ANY work. If another (overlapping) run
    // already claimed it, skip — this is what makes double-sends impossible.
    const claimed = await claimCampaign(admin, doc, now);

    if (!claimed) {
      ctx.log(`Campaign ${campaignId} already claimed by another run, skipping`);
      return;
    }

    ctx.log(`Processing campaign ${campaignId} (${type}): ${settings.name}`);

    // --- Generator campaigns: generate content + send in one shot ---
    if (generator) {
      const generators = loadGenerators();

      if (!generators[generator]) {
        await doc.ref.set({
          status: 'failed',
          error: `Unknown generator "${generator}"`,
          metadata: { updated: stamp() },
        }, { merge: true });

        ctx.log(`Unknown generator "${generator}" on ${campaignId} — marked failed`);
        return;
      }

      ctx.log(`Running generator "${generator}" for ${campaignId}...`);

      const generatedId = pushid();
      let generated;

      // The attempts ladder below only counts EMPTY generations — a throw never
      // reaches it. A coded 400 out of the pipeline (a bad prompt, a missing
      // image prompt — the AI library's invalid-request convention) is as
      // permanent as a brand-config hole, so it is finalized here rather than
      // reclaimed forever. Rate limits, 5xx and network faults are code-less
      // and keep the retry.
      try {
        generated = await generators[generator].generate(omega, ctx, settings, {
          campaignId: generatedId,
          imageHost: 'github',
          publishArticle: omega.isProduction(),
        });
      } catch (e) {
        if (!isConfigFault(e)) {
          throw e;
        }

        await failConfigFault(doc, ctx, campaignId, e.message);
        return;
      }

      // Nothing generated (no sources, filter dropped everything, disabled in
      // test mode, ...). Retry next run — up to the attempts cap.
      if (!generated) {
        const attempts = (data.generatorAttempts || 0) + 1;

        if (attempts >= GENERATOR_MAX_ATTEMPTS) {
          if (recurrence) {
            const nextSendAt = getNextFutureOccurrence(data.sendAt, recurrence, now);

            await doc.ref.set({
              status: 'pending',
              sendAt: nextSendAt,
              generatorAttempts: FieldValue.delete(),
              metadata: { updated: stamp() },
            }, { merge: true });

            ctx.log(`Generator "${generator}" yielded nothing ${attempts}x on ${campaignId} — skipping to next occurrence: ${moment.unix(nextSendAt).toISOString()}`);
          } else {
            await doc.ref.set({
              status: 'failed',
              error: `Generator "${generator}" yielded no content after ${attempts} attempts`,
              metadata: { updated: stamp() },
            }, { merge: true });

            ctx.log(`Generator "${generator}" yielded nothing ${attempts}x on one-off ${campaignId} — marked failed`);
          }

          return;
        }

        await doc.ref.set({
          status: 'pending',
          generatorAttempts: attempts,
          metadata: { updated: stamp() },
        }, { merge: true });

        ctx.log(`Generator "${generator}" returned no content for ${campaignId}, will retry next run (attempt ${attempts}/${GENERATOR_MAX_ATTEMPTS})`);
        return;
      }

      // Strip generation byproducts: bulky debug/asset fields stay OUT of the
      // send payload and the history doc's settings (article carries the full
      // post body; assets/meta are stored as their own fields below).
      const {
        images: _images,
        mjml: _mjml,
        structure: _structure,
        contentMarkdown: _contentMarkdown,
        article: _article,
        report,
        assets,
        meta,
        ...generatedSettings
      } = generated;

      ctx.log(`Generated content for ${campaignId}: "${generated.subject}"`);

      // Send immediately. The same coded-400 config faults reach this send as
      // the plain email dispatch below (identical sendCampaign() call), so it
      // gets the identical permanent-fault finalization.
      let campaignResults;

      try {
        campaignResults = await email.sendCampaign({ ...generatedSettings, sendAt: 'now' });
      } catch (e) {
        if (!isConfigFault(e)) {
          throw e;
        }

        // The report still goes out, carrying the fault as the post's failure
        if (report) {
          await generators[generator].sendReport(omega, ctx, report, { success: false, error: e.message, code: e.code });
        }

        await failConfigFault(doc, ctx, campaignId, e.message);
        return;
      }

      // The report names the post this send published, so it waits for the send
      if (report) {
        await generators[generator].sendReport(omega, ctx, report, campaignResults.newsletter);
      }

      const generatorFault = findConfigFault(campaignResults);

      if (generatorFault) {
        await failConfigFault(doc, ctx, campaignId, generatorFault);
        return;
      }

      const success = Object.values(campaignResults).some(r => r.success || r.sent > 0);

      // Store history record
      const historyId = pushid();
      await admin.firestore().doc(`marketing-campaigns/${historyId}`).set({
        settings: generatedSettings,
        assets: assets || null,
        meta: meta || null,
        type,
        sendAt: data.sendAt,
        status: success ? 'sent' : 'failed',
        results: campaignResults,
        generatedFrom: campaignId,
        metadata: { created: stamp(), updated: stamp() },
      });

      if (recurrence) {
        // Advance sendAt to the next FUTURE occurrence
        const nextSendAt = getNextFutureOccurrence(data.sendAt, recurrence, now);

        await doc.ref.set({
          status: 'pending',
          sendAt: nextSendAt,
          generatorAttempts: FieldValue.delete(),
          metadata: { updated: stamp() },
        }, { merge: true });

        ctx.log(`${success ? 'Sent' : 'Failed'} generator campaign ${campaignId}, next: ${moment.unix(nextSendAt).toISOString()}`);
      } else {
        // One-off: finalize so it is never picked up again
        await doc.ref.set({
          status: success ? 'sent' : 'failed',
          results: campaignResults,
          generatorAttempts: FieldValue.delete(),
          metadata: { updated: stamp() },
        }, { merge: true });

        ctx.log(`${success ? 'Sent' : 'Failed'} generator campaign ${campaignId} (one-off)`);
      }

      return;
    }

    // --- Dispatch by type ---
    let campaignResults;

    try {
      if (type === 'email') {
        campaignResults = await email.sendCampaign({ ...settings, sendAt: 'now' });
      } else if (type === 'push') {
        const pushFilters = settings.test
          ? { owner: settings._testUid || null, ...settings.filters }
          : (settings.filters || {});

        campaignResults = {
          push: await notification.send(ctx, {
            title: settings.name,
            body: settings.subject || settings.body,
            icon: settings.icon || omega.config.brand?.images?.brandmark,
            clickAction: settings.clickAction || omega.config.brand?.url,
            filters: pushFilters,
          }),
        };
      } else {
        await doc.ref.set({
          status: 'failed',
          error: `Unknown campaign type "${type}"`,
          metadata: { updated: stamp() },
        }, { merge: true });

        ctx.log(`Unknown campaign type "${type}" on ${campaignId} — marked failed`);
        return;
      }
    } catch (e) {
      // Transient faults rethrow into the stale-lease reclaim; a config hole
      // never heals, so it is finalized here instead of retried forever.
      if (!isConfigFault(e)) {
        throw e;
      }

      await failConfigFault(doc, ctx, campaignId, e.message);
      return;
    }

    // sendCampaign() never throws a provider's error — it converts each one to
    // { success: false, error, code }. A carried 400 is the same permanent config
    // hole as a thrown one (missing brand.contact.email) and must not ride the
    // success:false path, which would advance a recurring campaign into the same failure.
    const configFault = findConfigFault(campaignResults);

    if (configFault) {
      await failConfigFault(doc, ctx, campaignId, configFault);
      return;
    }

    const success = Object.values(campaignResults).some(r => r.success || r.sent > 0);

    // --- Handle recurring vs one-off ---
    if (recurrence) {
      // Create history record
      const historyId = pushid();

      await admin.firestore().doc(`marketing-campaigns/${historyId}`).set({
        settings,
        type,
        sendAt: data.sendAt,
        status: success ? 'sent' : 'failed',
        results: campaignResults,
        recurringId: campaignId,
        metadata: { created: stamp(), updated: stamp() },
      });

      // Advance sendAt to the next FUTURE occurrence
      const nextSendAt = getNextFutureOccurrence(data.sendAt, recurrence, now);

      await doc.ref.set({
        status: 'pending',
        sendAt: nextSendAt,
        metadata: { updated: stamp() },
      }, { merge: true });

      ctx.log(`Recurring campaign ${campaignId} ${success ? 'sent' : 'failed'}, next: ${moment.unix(nextSendAt).toISOString()}`);
    } else {
      // One-off: update status directly
      await doc.ref.set({
        status: success ? 'sent' : 'failed',
        results: campaignResults,
        metadata: { updated: stamp() },
      }, { merge: true });

      ctx.log(`Campaign ${campaignId} ${success ? 'sent' : 'failed'}`);
    }
  }));

  const sent = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  for (const r of results) {
    if (r.status === 'rejected') {
      // The campaign doc stays 'processing' — the stale-lease reclaim retries
      // it after PROCESSING_LEASE_SECONDS instead of every 10 minutes.
      ctx.error(`Failed to process campaign: ${r.reason?.message}`, r.reason);
    }
  }

  ctx.log(`Completed! (${sent} processed, ${failed} failed)`);
};

/**
 * Transactionally claim a pending campaign by flipping status to 'processing'.
 * Returns false when another run (or an earlier claim) got there first.
 */
function claimCampaign(admin, doc, now) {
  return admin.firestore().runTransaction(async (tx) => {
    const fresh = await tx.get(doc.ref);

    if (!fresh.exists || fresh.data().status !== 'pending') {
      return false;
    }

    tx.set(doc.ref, {
      status: 'processing',
      processingStartedAt: now,
      metadata: { updated: stamp() },
    }, { merge: true });

    return true;
  });
}

/**
 * A coded 400 is the framework's config-fault convention (the email library's
 * errorWithCode(..., 400), notification.js's missing-brand.url throw, the AI
 * library's invalid-request rejects). It marks a permanent fault — nothing
 * heals it but a human editing the config or the prompt.
 *
 * Takes a thrown error OR a provider result: sendCampaign() converts a
 * provider's throw into { success: false, error, code }, so the same fault
 * arrives either way.
 */
function isConfigFault(subject) {
  return subject?.code === 400;
}

/**
 * The message of the first config fault carried by a provider results object,
 * or undefined when there is none.
 */
function findConfigFault(campaignResults) {
  return Object.values(campaignResults).find(isConfigFault)?.error;
}

/**
 * Finalize a campaign that hit a permanent config fault, exactly like the
 * unknown-type/unknown-generator branches. Recurring campaigns fail outright
 * too: advancing to the next occurrence would just meet the same hole.
 */
async function failConfigFault(doc, ctx, campaignId, message) {
  await doc.ref.set({
    status: 'failed',
    error: message,
    metadata: { updated: stamp() },
  }, { merge: true });

  ctx.log(`Config fault on ${campaignId} — marked failed: ${message}`);
}

function stamp() {
  return {
    timestamp: new Date().toISOString(),
    timestampUNIX: Math.round(Date.now() / 1000),
  };
}
