/**
 * Schema: POST /payments/uncancel
 * Validates the request to withdraw a scheduled subscription cancellation
 */
export default() => ({
  confirmed: { type: 'boolean', required: true },
});
