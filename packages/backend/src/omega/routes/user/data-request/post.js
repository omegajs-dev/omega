/**
 * POST /user/data-request - Create a new GDPR data request
 * Creates a pending data request record for the authenticated user.
 */
import { v4 as uuidv4 } from 'uuid';

export default async ({ ctx, omega, user, data }) => {
  const admin = omega.firebase.admin;

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Require confirmation
  if (!data.confirmed) {
    return ctx.respond('You must confirm the data request acknowledgments.', { code: 400 });
  }

  const uid = user.auth.uid;

  // Sanitize reason — strip HTML tags and trim
  const reason = (data.reason || '').replace(/<[^>]*>/g, '').trim().substring(0, 500);

  // Get the most recent request
  const mostRecentSnapshot = await admin.firestore()
    .collection('data-requests')
    .where('owner', '==', uid)
    .orderBy('metadata.created.timestampUNIX', 'desc')
    .limit(1)
    .get();

  if (!mostRecentSnapshot.empty) {
    const mostRecent = mostRecentSnapshot.docs[0].data();

    // Reject if there's already a pending request
    if (mostRecent.status === 'pending') {
      return ctx.respond('You already have a pending data request. Please wait for it to be processed.', { code: 409 });
    }

    // Reject if last request was created within 30 days (cooldown)
    const THIRTY_DAYS = 30 * 24 * 60 * 60;
    const elapsedSeconds = Math.round(Date.now() / 1000) - mostRecent.metadata.created.timestampUNIX;

    if (elapsedSeconds < THIRTY_DAYS) {
      return ctx.respond('You have already received a data export within the last 30 days. Please try again later.', { code: 429 });
    }
  }

  // Create the request document
  const requestId = uuidv4();
  const now = ctx.meta.startTime.timestamp;
  const nowUNIX = ctx.meta.startTime.timestampUNIX;

  const docData = {
    status: 'pending',
    reason: reason,
    downloads: 0,
    owner: uid,
    metadata: {
      ...ctx.metadata({ tag: 'user/data-request' }),
      created: {
        timestamp: now,
        timestampUNIX: nowUNIX,
      },
      completed: {
        timestamp: null,
        timestampUNIX: 0,
      },
    },
  };

  await admin.firestore()
    .doc(`data-requests/${requestId}`)
    .set(docData, { merge: true });

  ctx.log(`Data request created: ${requestId} for user ${uid}`);

  // Send confirmation email (fire-and-forget)
  sendConfirmationEmail(ctx, user, requestId, reason);

  return ctx.respond({
    request: { id: requestId, ...docData },
  });
};

/**
 * Send data request confirmation email (fire-and-forget)
 */
function sendConfirmationEmail(ctx, user, requestId, reason) {
  const omega = ctx.omega;
  const mailer = ctx.email;
  const uid = user.auth.uid;
  const firstName = user.personal?.name?.first;
  const greeting = firstName ? `Hey ${firstName}, we've` : `We've`;
  const reasonLine = reason
    ? `\n\n**Reason provided:** ${reason}`
    : '';

  mailer.send({
    to: user,
    sender: 'account',
    categories: ['account/data-request'],
    subject: `Your data request has been received #${requestId}`,
    template: 'card',
    copy: true,
    data: {
      email: {
        preview: `We've received your data export request. Your data will be available for download within 14 business days.`,
      },
      content: {
        title: 'Data Request Received',
        message: `${greeting} received your request for a copy of your personal data.${reasonLine}

**What happens next:**

- Your request is now being processed.
- Processing takes up to **14 business days**.
- Once ready, you must return to your **account page** to download your data. We will not send the data via email for security reasons.
- Your data will be available as a JSON file download.
- Only one request can be active at a time, and you may submit a new request once every 30 days.

If you did not make this request, please contact us immediately by replying to this email.

- **Reference:** #${requestId}
- **Account UID:** ${uid}`,
      },
    },
  })
    .then((result) => {
      ctx.log(`sendConfirmationEmail(): Success, status=${result.status}`);
    })
    .catch((e) => {
      ctx.error(`sendConfirmationEmail(): Failed: ${e.message}`);
    });
}
