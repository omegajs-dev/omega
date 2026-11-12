/**
 * Transition: payment-refunded
 * Triggered when a payment refund webhook is received.
 *
 * Provider-agnostic — refund details are extracted by the provider library's
 * getRefundDetails() method and passed as a unified { amount, currency, reason } object.
 *
 * This is webhook-driven so it fires regardless of how the refund originated
 * (admin dashboard, user self-service, or direct provider action).
 */
import { sendOrderEmail, formatDate } from '../send-email.js';

export default async function ({ ctx, before, after, order, uid, userDoc, refundDetails }) {
  ctx.log(`Transition [subscription/payment-refunded]: uid=${uid}, product=${after?.product?.id}, amount=${refundDetails?.amount} ${refundDetails?.currency}, reason=${refundDetails?.reason || 'none'}`);

  sendOrderEmail({
    template: 'order',
    subject: `Your payment has been refunded #${order?.id || ''}`,
    categories: ['order/refunded'],
    userDoc,
    ctx,
    data: {
      content: { event: 'refunded',
        ...order,
        _computed: {
          date: formatDate(new Date().toISOString()),
          refundAmount: refundDetails?.amount || null,
          refundCurrency: refundDetails?.currency || 'USD',
          refundReason: refundDetails?.reason || null,
        },
      },
    },
  });
};
