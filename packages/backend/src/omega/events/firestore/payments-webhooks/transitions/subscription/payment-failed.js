/**
 * Transition: payment-failed
 * Triggered when a subscription payment fails (active → suspended)
 */
import { sendOrderEmail, formatDate } from '../send-email.js';

export default async function ({ ctx, before, after, order, uid, userDoc }) {
  ctx.log(`Transition [subscription/payment-failed]: uid=${uid}, product=${after.product?.id}, previousStatus=${before?.status}`);

  sendOrderEmail({
    template: 'order',
    subject: `Payment failed for order #${order?.id || ''}`,
    categories: ['order/payment-failed'],
    userDoc,
    ctx,
    data: {
      content: { event: 'payment-failed',
        ...order,
        _computed: {
          date: formatDate(new Date().toISOString()),
        },
      },
    },
  });
};
