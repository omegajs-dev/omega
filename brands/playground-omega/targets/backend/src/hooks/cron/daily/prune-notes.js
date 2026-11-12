/**
 * Surface: cron job, daily (deletes notes older than 30 days)
 * Doc: node_modules/@omega.js/manager/docs/backend/routes.md (New Cron Job)
 */
const MAX_AGE_DAYS = 30;
const BATCH_SIZE = 500;

export default async ({ ctx, omega }) => {
  const firestore = omega.firebase.admin.firestore();
  const cutoff = ctx.meta.startTime.timestampUNIX - (MAX_AGE_DAYS * 24 * 60 * 60);
  let pruned = 0;

  // Each pass deletes what it read, so the next pass starts from what is left:
  // no cursor is needed, and an empty page means nothing old remains
  while (true) {
    const snapshot = await firestore
      .collection('notes')
      .where('metadata.created.timestampUNIX', '<', cutoff)
      .limit(BATCH_SIZE)
      .get();

    if (snapshot.empty) {
      break;
    }

    const batch = firestore.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    pruned += snapshot.size;
  }

  ctx.log(`prune-notes: deleted ${pruned} note(s) older than ${MAX_AGE_DAYS} days`);

  return { pruned };
};
