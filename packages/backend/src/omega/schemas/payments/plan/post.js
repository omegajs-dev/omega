/**
 * Schema: POST /payments/plan
 * Validates the target plan of a subscription plan switch
 */
export default() => ({
  productId: { type: 'string', required: true },
  frequency: { type: 'string', required: true },
  confirmed: { type: 'boolean', required: true },
});
