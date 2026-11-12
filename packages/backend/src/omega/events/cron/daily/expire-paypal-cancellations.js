import powertools from 'node-powertools';

/**
 * Expire PayPal pending cancellations
 *
 * PayPal has no cancel_at_period_end like Stripe — cancellation is immediate on PayPal's side.
 * @omega.js/backend keeps users active with cancellation.pending=true until the billing period ends.
 * Since PayPal does NOT fire a webhook at period end, this cron job transitions those
 * users to 'cancelled' status once their paid period has expired.
 *
 * Flow:
 * 1. Query users with PayPal subscriptions where cancellation.pending=true
 * 2. Check if subscription.expires.timestampUNIX < now
 * 3. Re-read the user + order, and skip anything a newer webhook has since written
 * 4. Update status to 'cancelled' and cancellation.pending to false — on the user doc
 *    AND on payments-orders/{orderId}, whose `unified` mirror is what handlers and the
 *    UI read; the two land together in one batch
 * 5. Dispatch 'subscription-cancelled' transition (sends email)
 *
 * The staleness discipline is the webhook trigger's: the batch below is read once and
 * written to one user at a time, so a webhook may land between the read and the write.
 * Anything stamped after this run's read time is the newer truth, and the cron stands
 * down rather than overwriting it ([#221]).
 */
export default async ({ ctx, omega, context }) => {
  const admin = omega.firebase.admin;
  const { default: transitions } = await import('../../firestore/payments-webhooks/transitions/index.js');

  const now = new Date();
  const nowStr = powertools.timestamp(now, { output: 'string' });
  const nowUNIX = powertools.timestamp(nowStr, { output: 'unix' });

  // The read stamp: any payment write newer than this landed AFTER this run's snapshot
  const sweepReadUNIX = nowUNIX;

  ctx.log('Checking for expired PayPal pending cancellations...');

  let processed = 0;
  let skipped = 0;

  await omega.utilities.iterateCollection(async (batch, index) => {
    for (const doc of batch.docs) {
      const uid = doc.id;

      // Re-read: the batch snapshot above may be many writes old by the time this
      // candidate's turn comes, and the doc in hand is the one being written to
      const fresh = await doc.ref.get();
      const data = fresh.data() || {};
      const sub = data.subscription;

      // Double-check: skip if expires is in the future
      if (!sub?.expires?.timestampUNIX || sub.expires.timestampUNIX > nowUNIX) {
        ctx.log(`skip ${uid}: expires=${sub?.expires?.timestamp || 'null'} is still in the future (now=${nowStr})`);
        skipped++;
        continue;
      }

      // The candidate may have been answered since the snapshot — by a webhook, or by
      // the user re-subscribing. Only the two facts the query selected on are checked:
      // the status the cron would write, and the pending flag it would clear.
      if (sub.status === 'cancelled' || sub.cancellation?.pending !== true) {
        ctx.log(`skip ${uid}: no longer a pending cancellation (status=${sub.status}, pending=${sub.cancellation?.pending})`);
        skipped++;
        continue;
      }

      // A subscription written after this run's read is the newer truth
      const subUpdatedUNIX = sub.payment?.updatedBy?.date?.timestampUNIX || 0;

      if (subUpdatedUNIX > sweepReadUNIX) {
        ctx.log(`skip ${uid}: a newer subscription write landed (updatedBy=${subUpdatedUNIX} > read=${sweepReadUNIX})`);
        skipped++;
        continue;
      }

      const orderId = sub.payment?.orderId || null;
      let orderSnap = null;

      if (orderId) {
        orderSnap = await admin.firestore().doc(`payments-orders/${orderId}`).get();

        // Same guard on the order, the same way the webhook trigger applies it
        const orderUpdatedUNIX = orderSnap.exists ? (orderSnap.data()?.metadata?.updated?.timestampUNIX || 0) : 0;

        if (orderUpdatedUNIX > sweepReadUNIX) {
          ctx.log(`skip ${uid}: a newer webhook already wrote payments-orders/${orderId} (updated=${orderUpdatedUNIX} > read=${sweepReadUNIX})`);
          skipped++;
          continue;
        }

        if (!orderSnap.exists) {
          ctx.warn(`expire ${uid}: payments-orders/${orderId} does not exist — the subscription expires, but there is no order record to mirror it onto`);
        }
      } else {
        ctx.warn(`expire ${uid}: subscription carries no orderId — nothing mirrors this expiry on the order side, and the order-level staleness guard cannot run`);
      }

      ctx.log(`expire ${uid}: expires=${sub.expires.timestamp}, product=${sub.product?.id}, provider=${sub.payment?.provider}, orderId=${orderId || 'null'}`);

      // Snapshot the before state for transition detection
      const before = { ...sub };

      // Build the after state — transition to cancelled
      const after = {
        ...sub,
        status: 'cancelled',
        cancellation: {
          ...sub.cancellation,
          pending: false,
        },
      };

      // The user doc and the order move TOGETHER, and each is written as the DELTA this
      // cron owns — never the whole map read from a snapshot, which would restore every
      // other field to the value it had at read time and undo a concurrent write.
      const writes = admin.firestore().batch();

      writes.set(doc.ref, {
        subscription: {
          status: 'cancelled',
          cancellation: { pending: false },
        },
      }, { merge: true });

      if (orderSnap?.exists) {
        writes.set(orderSnap.ref, {
          unified: {
            status: 'cancelled',
            cancellation: { pending: false },
          },
          metadata: {
            updated: {
              timestamp: nowStr,
              timestampUNIX: nowUNIX,
            },
            updatedBy: {
              event: {
                name: 'cron/daily/expire-paypal-cancellations',
                id: null,
              },
            },
          },
        }, { merge: true });
      }

      await writes.commit();

      ctx.log(`expire ${uid}: Updated status=cancelled, cancellation.pending=false${orderSnap?.exists ? ` (and payments-orders/${orderId})` : ''}`);

      // Detect and dispatch transition (should fire 'subscription-cancelled')
      const transitionName = transitions.detectTransition('subscription', before, after, null);

      if (transitionName) {
        ctx.log(`expire ${uid}: Transition detected: subscription/${transitionName}`);

        // Build minimal order context for the handler
        const order = {
          id: orderId,
          type: 'subscription',
          owner: uid,
          provider: 'paypal',
          resourceId: sub.payment?.resourceId || null,
          unified: after,
        };

        transitions.dispatch(transitionName, 'subscription', {
          before,
          after,
          order,
          uid,
          userDoc: data,
          ctx,
        });
      } else {
        ctx.log(`expire ${uid}: No transition detected (before.status=${before.status}, after.status=${after.status})`);
      }

      processed++;
    }
  }, {
    collection: 'users',
    where: [
      { field: 'subscription.payment.provider', operator: '==', value: 'paypal' },
      { field: 'subscription.cancellation.pending', operator: '==', value: true },
    ],
    batchSize: 5000,
    log: true,
  });

  ctx.log(`Completed! Processed=${processed}, Skipped=${skipped}`);
};
