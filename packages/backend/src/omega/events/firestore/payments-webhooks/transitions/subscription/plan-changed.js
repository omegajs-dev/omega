/**
 * Transition: plan-changed
 * Triggered when a user upgrades or downgrades their plan (product A → product B, both active + paid)
 */
import { sendOrderEmail, formatDate } from '../send-email.js';

export default async function ({ ctx, before, after, order, uid, userDoc }) {
  // Direction comes from what the plan costs, and only when the two prices are
  // comparable — different billing cadences are not, and product IDs never were.
  const beforePrice = Number(before.payment?.price) || 0;
  const afterPrice = Number(after.payment?.price) || 0;
  const comparable = before.payment?.frequency === after.payment?.frequency && beforePrice !== afterPrice;
  const direction = comparable
    ? (afterPrice > beforePrice ? 'upgrade' : 'downgrade')
    : 'change';

  ctx.log(`Transition [subscription/plan-changed]: uid=${uid}, ${before.product?.id} → ${after.product?.id} (${direction})`);

  sendOrderEmail({
    template: 'order',
    subject: `Your plan has been updated #${order?.id || ''}`,
    categories: ['order/plan-changed'],
    userDoc,
    ctx,
    data: {
      content: { event: 'plan-changed',
        ...order,
        // Inject previous plan info into the unified object for the template
        unified: {
          ...order.unified,
          previous: {
            product: before.product,
            price: before.payment?.price || 0,
          },
        },
        _computed: {
          date: formatDate(new Date().toISOString()),
        },
      },
    },
  });
};
