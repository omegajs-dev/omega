/**
 * Transition: new-subscription
 * Triggered when a user subscribes for the first time (basic/null → active paid)
 * Check after.trial.claimed to determine if this is a trial subscription
 */
import { sendOrderEmail, formatDate } from '../send-email.js';
import discountCodes from '../../../../../libraries/payment/discount-codes.js';

export default async function ({ ctx, before, after, order, uid, userDoc }) {
  const isTrial = after.trial?.claimed === true;
  const brandName = ctx.omega.config.brand?.name || '';
  const planName = after.product?.name || '';

  // Pre-compute discount values for the email template. The totals go through
  // applyToAmount() — its one home — for BOTH coupon shapes: gating them on a
  // percent quoted the full list price on an amount code's receipt
  // ([#239](https://github.com/Omega-JS-Stack/omega/issues/239)).
  // The promo LINE is keyed off the shape the code actually carries. An order
  // written before the amount field existed comes back valid with NEITHER, and
  // this handler is dispatched fire-and-forget — reading a shape that isn't
  // there would cost the customer their confirmation email, silently.
  const price = parseFloat(order.unified?.payment?.price || 0);
  const discount = order.discount;
  const hasPromoDiscount = discount?.valid === true;
  const promoShape = discountCodes.promoShape(discount);
  const firstCharge = discountCodes.applyToAmount(price, discount);

  ctx.log(`Transition [subscription/new-subscription]: uid=${uid}, product=${after.product?.id}, frequency=${after.payment?.frequency}, trial=${isTrial}, discount=${hasPromoDiscount ? discount.code : 'none'}`);

  sendOrderEmail({
    template: 'order',
    subject: `Your ${brandName} ${planName} order #${order?.id || ''}`,
    categories: ['order/confirmation'],
    userDoc,
    ctx,
    data: {
      content: { event: 'confirmation',
        ...order,
        _computed: {
          date: formatDate(new Date().toISOString()),
          ...(isTrial && after.trial?.expires?.timestamp && {
            trialExpires: formatDate(after.trial.expires.timestamp),
          }),
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
          // Amount charged on the first real payment (after trial if applicable)
          firstChargeAmount: firstCharge.toFixed(2),
          totalToday: isTrial
            ? '0.00'
            : firstCharge.toFixed(2),
        },
      },
    },
  });
};
