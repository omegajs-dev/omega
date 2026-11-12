/**
 * Transition: cancellation-requested
 * Triggered when a user requests cancellation at period end (cancellation.pending flips to true)
 */
import { sendOrderEmail, formatDate } from '../send-email.js';

export default async function ({ ctx, before, after, order, uid, userDoc }) {
  ctx.log(`Transition [subscription/cancellation-requested]: uid=${uid}, product=${after.product?.id}, cancelDate=${after.cancellation?.date?.timestamp}`);

  sendOrderEmail({
    template: 'order',
    subject: `Your cancellation is confirmed #${order?.id || ''}`,
    categories: ['order/cancellation-requested'],
    userDoc,
    ctx,
    data: {
      content: { event: 'cancellation-requested',
        ...order,
        _computed: {
          date: formatDate(new Date().toISOString()),
          ...(after.cancellation?.date?.timestamp && {
            cancellationDate: formatDate(after.cancellation.date.timestamp),
          }),
        },
      },
    },
  });
};
