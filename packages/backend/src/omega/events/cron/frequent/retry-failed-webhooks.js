// A failed webhook is put back to pending until it has burned this many attempts.
// With the 10-minute cron cycle, 5 retries ≈ 50 minutes of recovery window.
const MAX_RETRIES = 5;

// Bounded sweep. The query filters on status ALONE (one equality filter, no composite
// index to deploy) so dead-lettered docs stay in the result set — they are filtered
// out here and never written again.
const SWEEP_LIMIT = 100;

/**
 * Failed payment webhook retry cron job
 *
 * The webhook route answers the provider 200 the moment the event is stored, so a
 * doc the onWrite trigger marked `failed` is never delivered again: a transient fault
 * (a provider API blip, a lost Firestore write) drops the payment silently.
 *
 * This flips those docs back to `pending`, which is exactly what the trigger picks
 * up. Reprocessing is safe — the trigger's staleness guard and its previously-completed
 * guard make a second pass a no-op rather than a second charge or a second email.
 *
 * At the ceiling the doc is dead-lettered ONCE, loudly, and left alone: something
 * permanent is wrong with it and it needs a human, not another pass.
 */
export default async ({ ctx, omega, context }) => {
  const admin = omega.firebase.admin;

  // Query failed webhooks (dead-lettered ones are filtered below)
  const snapshot = await admin.firestore()
    .collection('payments-webhooks')
    .where('status', '==', 'failed')
    .limit(SWEEP_LIMIT)
    .get();

  if (snapshot.empty) {
    ctx.log('No failed webhooks to retry');
    return;
  }

  ctx.log(`Sweeping ${snapshot.size} failed webhook(s)...`);

  let retried = 0;
  let deadLettered = 0;
  let terminal = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const retryCount = data.retryCount || 0;

    // Already dead-lettered — stamped once, never re-flipped
    if (data.deadLetter) {
      terminal++;
      continue;
    }

    if (retryCount >= MAX_RETRIES) {
      ctx.error(`Dead-lettering webhook ${doc.id} after ${retryCount} failed attempts (provider=${data.provider}, event=${data.event?.type || 'unknown'}, owner=${data.owner || 'null'}, orderId=${data.orderId || 'null'}): ${data.error || 'no error recorded'} — it will NOT be retried again and needs manual reconciliation`);

      await doc.ref.set({ deadLetter: true }, { merge: true });
      deadLettered++;
      continue;
    }

    ctx.log(`Retrying webhook ${doc.id} (attempt ${retryCount + 1}/${MAX_RETRIES}): ${data.error || 'no error recorded'}`);

    await doc.ref.set({ status: 'pending' }, { merge: true });
    retried++;
  }

  ctx.log(`Completed! (${retried} retried, ${deadLettered} dead-lettered, ${terminal} already dead-lettered)`);
};
