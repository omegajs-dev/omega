/**
 * The order summary GET /user/orders answers: this route's promise about what a
 * browser may see, independent of who is asking.
 */
const { oneTimeRefundRefusal } = require('../../../libraries/payment/refund-policy.js');

/**
 * What the account page is allowed to know about one order.
 *
 * A summary, deliberately: the order doc carries the provider's whole raw
 * resource, the request's IP and user agent, and the attribution that sold it.
 * None of that belongs in a browser: the page shows what was bought, when, for
 * how much, and what state it is in.
 *
 * @param {string} id - The payments-orders document id (the order id)
 * @param {object} order - The document data
 * @returns {object} The client-safe order summary
 */
function summarize(id, order) {
  const unified = order.unified || {};
  const payment = unified.payment || {};
  const refunded = !!order.requests?.refund || unified.status === 'refunded';

  return {
    id: order.id || id,
    type: order.type || 'subscription',
    productId: unified.product?.id || order.productId || null,
    productName: unified.product?.name || unified.product?.id || order.productId || null,
    // The purchase's own state, as the webhook pipeline last wrote it
    status: unified.status || 'unknown',
    refunded: refunded,
    // Whether the refund route would take this order: decided by the policy
    // module both sides read, never by a rule of this route's own
    refundable: !oneTimeRefundRefusal(order),
    amount: typeof payment.price === 'number' ? payment.price : null,
    currency: payment.currency || 'USD',
    frequency: payment.frequency || null,
    provider: payment.provider || order.provider || null,
    date: {
      timestamp: order.metadata?.created?.timestamp || null,
      timestampUNIX: order.metadata?.created?.timestampUNIX || 0,
    },
  };
}

module.exports = { summarize };
