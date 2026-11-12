/**
 * Schema: POST /payments/refund
 * Validates refund parameters for both subjects a refund can have
 */
export default() => ({
  reason: { type: 'string', required: true },
  feedback: { type: 'string', default: null },
  confirmed: { type: 'boolean', required: true },
  // The payments-orders id of a ONE-TIME purchase. Present = refund that
  // purchase; absent = refund the caller's subscription ([#212]).
  orderId: { type: 'string', default: null },
});
