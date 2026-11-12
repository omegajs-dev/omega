/**
 * The confirmation redirect POST /payments/intent hands every provider. Its
 * discounted `amount` is a provider-independent promise of the route.
 */
const discountCodes = require('../../../libraries/payment/discount-codes.js');

/**
 * Build the confirmation/success redirect URL
 *
 * `amount` is what the customer is charged TODAY, not the list price: the
 * confirmation page hands that param straight to the client's analytics modules.
 * The discount comes off HERE rather than in a provider, because a real provider
 * applies the coupon on its own hosted page and never revisits this URL.
 */
function buildConfirmationUrl(baseUrl, { product, productId, productType, frequency, provider, trial, orderId, discount }) {
  const listPrice = productType === 'subscription'
    ? (product.prices?.[frequency] || 0)
    : (product.prices?.once || 0);

  // A trial charges nothing today; otherwise a validated coupon comes off the
  // first charge (every code is duration: 'once', so the renewal stays full price)
  const amount = trial && product.trial?.days
    ? 0
    : discountCodes.applyToAmount(listPrice, discount);

  const url = new URL('/payment/confirmation', baseUrl);
  url.searchParams.set('productId', productId);
  url.searchParams.set('productName', product.name || productId);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('currency', 'USD');
  // What was BOUGHT, said outright rather than inferred from the cadence beside
  // it: the confirmation page holds nothing else about the product
  url.searchParams.set('type', productType);
  url.searchParams.set('frequency', frequency || 'once');
  url.searchParams.set('paymentMethod', provider);
  url.searchParams.set('trial', String(!!trial && !!product.trial?.days));
  url.searchParams.set('orderId', orderId);
  url.searchParams.set('track', 'true');

  return url.toString();
}

module.exports = { buildConfirmationUrl };
