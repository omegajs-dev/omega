import powertools from 'node-powertools';
import cartConfig from '../../../libraries/abandoned-cart-config.js';
import account from '../../../helpers/account.js';

const { REMINDER_DELAYS, COLLECTION } = cartConfig;
const { User } = account;

/**
 * Abandoned cart reminder cron job
 *
 * Queries payments-carts where status is pending and nextReminderAt has passed,
 * sends escalating email reminders, and advances or completes the tracker.
 */
export default async ({ ctx, omega, context }) => {
  const admin = omega.firebase.admin;
  const nowUNIX = Math.floor(Date.now() / 1000);

  // Query all pending carts that are due for a reminder
  const snapshot = await admin.firestore()
    .collection(COLLECTION)
    .where('status', '==', 'pending')
    .where('nextReminderAt', '<=', nowUNIX)
    .get();

  if (snapshot.empty) {
    ctx.log('No abandoned carts due for reminders');
    return;
  }

  ctx.log(`Processing ${snapshot.size} abandoned cart reminder(s)...`);

  const email = ctx.email;
  let sent = 0;
  let completed = 0;
  let skipped = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const uid = data.owner;
    const reminderIndex = data.reminderIndex || 0;

    try {
      // A cart with checkout activity inside its own reminder window is not
      // abandoned — the shopper asked for a provider session and is working
      // through the checkout right now. The sweep mailed one of them 2 minutes
      // before the purchase went through: the clock was set ONCE, when the
      // checkout page opened, and nothing ever moved it
      // ([#655](https://github.com/Omega-JS-Stack/omega/issues/655)).
      //
      // The window is the CURRENT reminder's own delay, so activity restarts the
      // same clock the reminder was already waiting on rather than adding a
      // second rule beside it. A cart nobody ever took to a checkout carries no
      // activity at all and reads exactly as it did.
      const lastActivityAt = data.lastActivityAt || 0;
      const dueAfterActivity = lastActivityAt + REMINDER_DELAYS[reminderIndex];

      if (dueAfterActivity > nowUNIX) {
        ctx.log(`Cart for uid=${uid} had checkout activity ${nowUNIX - lastActivityAt}s ago, deferring reminder #${reminderIndex + 1} to ${dueAfterActivity}`);
        await deferTo(doc, dueAfterActivity, nowUNIX);
        skipped++;
        continue;
      }

      // Fetch user doc for email sending
      const userSnap = await admin.firestore().doc(`users/${uid}`).get();

      if (!userSnap.exists) {
        ctx.log(`User ${uid} not found, marking cart completed`);
        await markCompleted(doc, admin, nowUNIX);
        skipped++;
        continue;
      }

      const userDoc = userSnap.data();

      // Belt-and-suspenders: skip if user already has active paid subscription
      if (new User(userDoc).active) {
        ctx.log(`User ${uid} now has active subscription, marking cart completed`);
        await markCompleted(doc, admin, nowUNIX);
        skipped++;
        continue;
      }

      // Build checkout URL from cart data
      const checkoutUrl = buildCheckoutUrl(omega.project.websiteUrl, data);

      // Resolve product name from config
      const product = (omega.config.payment?.products || []).find(p => p.id === data.productId);
      const productName = product?.name || data.productId;
      const brandName = omega.config.brand?.name || '';

      // Send reminder email
      ctx.log(`Sending abandoned cart reminder #${reminderIndex + 1} to uid=${uid}, product=${data.productId}`);

      email.send({
        sender: 'marketing',
        to: userDoc,
        template: 'order',
        subject: `Complete your ${brandName} ${productName} checkout`,
        categories: ['order/abandoned-cart', `order/abandoned-cart/reminder-${reminderIndex + 1}`],
        copy: false,
        data: {
          content: { event: 'abandoned-cart' },
          abandonedCart: {
            productId: data.productId,
            productName: productName,
            brandName: brandName,
            type: data.type,
            frequency: data.frequency,
            reminderNumber: reminderIndex + 1,
            totalReminders: REMINDER_DELAYS.length,
            checkoutUrl: checkoutUrl,
          },
        },
      })
        .then(() => ctx.log(`Abandoned cart email sent for uid=${uid}`))
        .catch((e) => ctx.error(`Abandoned cart email failed for uid=${uid}: ${e.message}`));

      sent++;

      // Advance to next reminder or mark completed if this was the last one
      const nextIndex = reminderIndex + 1;

      if (nextIndex >= REMINDER_DELAYS.length) {
        ctx.log(`Last reminder sent for uid=${uid}, marking cart completed`);
        await markCompleted(doc, admin, nowUNIX);
        completed++;
      } else {
        const now = powertools.timestamp(new Date(), { output: 'string' });
        const updatedNowUNIX = powertools.timestamp(now, { output: 'unix' });

        await doc.ref.set({
          reminderIndex: nextIndex,
          nextReminderAt: updatedNowUNIX + REMINDER_DELAYS[nextIndex],
          metadata: {
            updated: {
              timestamp: now,
              timestampUNIX: updatedNowUNIX,
            },
          },
        }, { merge: true });

        ctx.log(`Advanced uid=${uid} to reminder index ${nextIndex}, next at ${updatedNowUNIX + REMINDER_DELAYS[nextIndex]}`);
      }
    } catch (e) {
      ctx.error(`Error processing abandoned cart for uid=${uid}: ${e.message}`, e);
      // Continue to next document
    }
  }

  ctx.log(`Completed! (${sent} sent, ${completed} completed, ${skipped} skipped)`);
};

/**
 * Push a cart's next reminder out, leaving everything else as it is
 *
 * The reminder is DEFERRED, never spent: the index does not advance, so the
 * shopper still gets reminder #1 if this checkout goes nowhere.
 *
 * @param {object} doc - The cart's query snapshot
 * @param {number} nextReminderAt - The second the reminder becomes due again
 * @param {number} nowUNIX - The second this run took its snapshot
 */
async function deferTo(doc, nextReminderAt, nowUNIX) {
  const now = powertools.timestamp(new Date(), { output: 'string' });

  await doc.ref.set({
    nextReminderAt: nextReminderAt,
    metadata: {
      updated: {
        timestamp: now,
        timestampUNIX: nowUNIX,
      },
    },
  }, { merge: true });
}

/**
 * Mark a cart document as completed
 */
async function markCompleted(doc, admin, nowUNIX) {
  const now = powertools.timestamp(new Date(), { output: 'string' });

  await doc.ref.set({
    status: 'completed',
    metadata: {
      updated: {
        timestamp: now,
        timestampUNIX: nowUNIX,
      },
    },
  }, { merge: true });
}

/**
 * Build checkout URL from cart data
 */
function buildCheckoutUrl(baseUrl, data) {
  const url = new URL('/payment/checkout', baseUrl);
  url.searchParams.set('product', data.productId);

  if (data.frequency) {
    url.searchParams.set('frequency', data.frequency);
  }

  return url.toString();
}
