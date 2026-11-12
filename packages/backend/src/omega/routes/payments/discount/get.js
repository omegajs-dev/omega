/**
 * GET /payments/discount?code=FLASH20
 * Validates a discount code and returns the discount details
 */
import discountCodes from '../../../libraries/payment/discount-codes.js';

export default async ({ ctx, user, data }) => {
  const result = discountCodes.validate(data.code, user.authenticated ? user : undefined);

  ctx.log(`Discount validation: code=${result.code}, valid=${result.valid}`);

  if (!result.valid) {
    return ctx.respond({ valid: false }, { code: 200 });
  }

  // A code is percent-based or amount-based (Stripe's two coupon shapes) — the
  // caller reads whichever field is present
  return ctx.respond({
    valid: true,
    code: result.code,
    percent: result.percent,
    amount: result.amount,
    duration: result.duration,
  });
};
