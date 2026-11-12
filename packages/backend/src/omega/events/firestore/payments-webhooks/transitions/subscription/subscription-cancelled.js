/**
 * Transition: subscription-cancelled
 * Triggered when a subscription is fully cancelled (any non-cancelled → cancelled)
 */
import { sendOrderEmail, formatDate } from '../send-email.js';

export default async function ({ ctx, before, after, order, uid, userDoc }) {
  ctx.log(`Transition [subscription/subscription-cancelled]: uid=${uid}, previousProduct=${before?.product?.id}, previousStatus=${before?.status}`);

  // Check if subscription has a future expiry (e.g., cancelled at period end)
  // Trials don't get future access — cancelling a trial revokes access immediately
  const isTrial = after.trial?.claimed;
  const hasFutureExpiry = !isTrial && after.expires?.timestamp && new Date(after.expires.timestamp) > new Date();

  sendOrderEmail({
    template: 'order',
    subject: `Your subscription has been cancelled #${order?.id || ''}`,
    categories: ['order/cancelled'],
    userDoc,
    ctx,
    data: {
      content: { event: 'cancelled',
        ...order,
        _computed: {
          date: formatDate(new Date().toISOString()),
          ...(hasFutureExpiry && {
            expiresDate: formatDate(after.expires.timestamp),
          }),
        },
      },
    },
  });
};
