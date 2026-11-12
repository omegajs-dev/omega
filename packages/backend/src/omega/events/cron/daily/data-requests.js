/**
 * Data requests cron job
 *
 * Processes data request status transitions:
 * - pending → completed: 14 days after creation
 * - completed → expired: 30 days after becoming completed (44 days after creation)
 *
 * Scans the entire collection (no index required) since data-requests is small.
 */
export default async ({ ctx, omega, context }) => {
  const admin = omega.firebase.admin;
  const nowUNIX = Math.round(Date.now() / 1000);

  const FOURTEEN_DAYS = 14 * 24 * 60 * 60;
  const FORTY_FOUR_DAYS = 44 * 24 * 60 * 60;

  ctx.log('Starting...');

  // Only fetch requests created within the last 45 days (single-field filter, no composite index needed)
  const snapshot = await admin.firestore()
    .collection('data-requests')
    .where('metadata.created.timestampUNIX', '>', nowUNIX - FORTY_FOUR_DAYS - 86400)
    .get();

  ctx.log(`Found ${snapshot.size} total data requests`);

  let completed = 0;
  let expired = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const createdUNIX = data.metadata?.created?.timestampUNIX || 0;
    const age = nowUNIX - createdUNIX;

    if (data.status === 'pending' && age >= FOURTEEN_DAYS) {
      await doc.ref.update({ status: 'completed' })
        .then(() => {
          completed++;
          ctx.log(`Completed request ${doc.id} (age: ${Math.round(age / 86400)}d)`);
        })
        .catch((e) => {
          ctx.error(`Failed to complete request ${doc.id}: ${e.message}`);
        });
    } else if (data.status === 'completed' && age >= FORTY_FOUR_DAYS) {
      await doc.ref.update({ status: 'expired' })
        .then(() => {
          expired++;
          ctx.log(`Expired request ${doc.id} (age: ${Math.round(age / 86400)}d)`);
        })
        .catch((e) => {
          ctx.error(`Failed to expire request ${doc.id}: ${e.message}`);
        });
    }
  }

  ctx.log(`Completed! (${completed} completed, ${expired} expired)`);
};
