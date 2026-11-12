/**
 * Transition: payment-recovered
 * Triggered when a suspended subscription is recovered (suspended → active)
 */
import { sendOrderEmail, formatDate } from '../send-email.js';

export default async function ({ ctx, before, after, order, uid, userDoc }) {
  ctx.log(`Transition [subscription/payment-recovered]: uid=${uid}, product=${after.product?.id}`);

  sendOrderEmail({
    template: 'order',
    subject: `Payment received for order #${order?.id || ''}`,
    categories: ['order/payment-recovered'],
    internalOnly: true,
    userDoc,
    ctx,
    data: {
      content: { event: 'payment-recovered',
        ...order,
        _computed: {
          date: formatDate(new Date().toISOString()),
        },
      },
    },
  });
};
