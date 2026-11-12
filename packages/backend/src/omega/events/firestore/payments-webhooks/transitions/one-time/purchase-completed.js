/**
 * Transition: purchase-completed
 * Triggered when a one-time payment checkout completes (checkout.session.completed with mode=payment)
 */
import { sendOrderEmail, formatDate } from '../send-email.js';
import discountCodes from '../../../../../libraries/payment/discount-codes.js';

export default async function ({ ctx, before, after, order, uid, userDoc }) {
  const brandName = ctx.omega.config.brand?.name || '';
  const productName = after.product?.name || '';

  // Pre-compute discount values for the email template. The total goes through
  // applyToAmount() — its one home — for BOTH coupon shapes: gating it on a
  // percent quoted the full list price on an amount code's receipt
  // ([#239](https://github.com/Omega-JS-Stack/omega/issues/239)).
  // The promo LINE is keyed off the shape the code actually carries. An order
  // written before the amount field existed comes back valid with NEITHER, and
  // this handler is dispatched fire-and-forget — reading a shape that isn't
  // there would cost the customer their confirmation email, silently.
  const price = parseFloat(after.payment?.price || 0);
  const discount = order.discount;
  const hasPromoDiscount = discount?.valid === true;
  const promoShape = discountCodes.promoShape(discount);
  const firstCharge = discountCodes.applyToAmount(price, discount);

  ctx.log(`Transition [one-time/purchase-completed]: uid=${uid}, resourceId=${after.payment?.resourceId}, discount=${hasPromoDiscount ? discount.code : 'none'}`);

  sendOrderEmail({
    template: 'order',
    subject: `Your ${brandName} ${productName} order #${order?.id || ''}`,
    categories: ['order/confirmation'],
    userDoc,
    ctx,
    data: {
      content: { event: 'confirmation',
        ...order,
        _computed: {
          date: formatDate(new Date().toISOString()),
          ...(promoShape && {
            promoCode: discount.code,
            // The savings line quotes the code's own terms; the flat-dollar one
            // is what it actually took off, which floors at the charge itself
            ...(promoShape === 'percent'
              ? {
                promoPercent: discount.percent,
                promoSavings: (price * discount.percent / 100).toFixed(2),
              }
              : {
                promoAmount: discount.amount.toFixed(2),
                promoSavings: (price - firstCharge).toFixed(2),
              }),
          }),
          totalToday: firstCharge.toFixed(2),
        },
      },
    },
  });
};
