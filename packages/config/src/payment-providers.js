/**
 * payment-providers.js: one capability descriptor per payment provider. Both
 * halves of a checkout act on it: the backend reads it through its provider
 * registry (libraries/payment/providers/index.js), and clientConfig() bakes it
 * into the browser config as `payment.capabilities` for the checkout buttons.
 * It lives here because this is the one package both surfaces reach.
 *
 * couponsHostedByProvider: the provider's page applies the coupon, else this
 * framework computes the discounted price and sends it.
 */

const { deepFreeze } = require('./deep-freeze.js');

const PAYMENT_PROVIDERS = deepFreeze({
  stripe: {
    id: 'stripe',
    name: 'Stripe',
    acceptsZeroCharge: true,
    refundable: true,
    couponsHostedByProvider: true,
    subscriptions: true,
    oneTime: true,
    trials: true,
  },
  chargebee: {
    id: 'chargebee',
    name: 'Chargebee',
    acceptsZeroCharge: true,
    refundable: true,
    couponsHostedByProvider: true,
    subscriptions: true,
    oneTime: true,
    trials: true,
  },
  paypal: {
    id: 'paypal',
    name: 'PayPal',
    acceptsZeroCharge: false,
    refundable: true,
    couponsHostedByProvider: false,
    subscriptions: true,
    oneTime: true,
    trials: true,
  },
  coinbase: {
    id: 'coinbase',
    name: 'Coinbase Commerce',
    acceptsZeroCharge: false,
    refundable: false,
    couponsHostedByProvider: false,
    subscriptions: false,
    oneTime: true,
    trials: false,
  },
  // The emulator's fixture provider: every capability on, so no test is ever
  // limited by the provider it runs through
  test: {
    id: 'test',
    name: 'Test',
    acceptsZeroCharge: true,
    refundable: true,
    couponsHostedByProvider: true,
    subscriptions: true,
    oneTime: true,
    trials: true,
  },
});

/**
 * The descriptor for a provider id, or null when no provider has that id.
 * An own-property read: the id often arrives on a request, and an inherited
 * name like `constructor` is never a provider.
 *
 * @param {string} id - The provider id (`stripe`, `paypal`, …)
 * @returns {object|null}
 */
function paymentProvider(id) {
  return Object.hasOwn(PAYMENT_PROVIDERS, id) ? PAYMENT_PROVIDERS[id] : null;
}

module.exports = { PAYMENT_PROVIDERS, paymentProvider };
