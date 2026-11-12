/**
 * Schema: POST /payments/cancel
 * Validates subscription cancellation parameters
 */
export default() => ({
  reason: { type: 'string', default: null },
  feedback: { type: 'string', default: null },
  confirmed: { type: 'boolean', required: true },
  // REQUEST to bypass route-level guards (e.g. 24-hour subscription age). Any client
  // can send it; the route honors it only for an admin or outside a real deployment,
  // and ignores it with a warning otherwise ([#212]).
  skipGuards: { type: 'boolean', default: false },
});
