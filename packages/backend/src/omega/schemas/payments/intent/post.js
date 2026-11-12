/**
 * Schema: POST /payments/intent
 * Validates intent creation parameters
 */
export default() => ({
  provider: { type: 'string', required: true },
  productId: { type: 'string', required: true },
  frequency: { type: 'string', default: null },
  trial: { type: 'boolean', default: false },
  verification: { type: 'object', default: {} },
  attribution: { type: 'object', default: {} },
  // The client's tracking-consent snapshot, stored verbatim beside attribution and
  // folded onto the order — never interpreted here. Absent when nothing was captured.
  trackingConsent: { type: 'object', default: null },
  discount: { type: 'string', default: null },
  supplemental: { type: 'object', default: {} },
  // Checkout simulation — honored ONLY by the test provider (itself
  // non-production), ignored everywhere else. Request-only: it is never
  // persisted onto the intent or the order.
  //
  // `abandon` is the checkout nobody finishes: the session is created and the
  // provider never sends an event, because none happened. It is the only way to
  // reach the state the abandoned-cart lane exists for
  // ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
  simulate: { type: 'string', default: null, enum: ['decline', 'abandon'] },
});
