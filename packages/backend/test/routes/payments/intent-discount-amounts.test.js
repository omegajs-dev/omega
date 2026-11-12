/**
 * Test: the test intent provider applies a validated discount to the amounts
 *
 * The route validates the code and records it, and the Stripe provider hands it
 * to Stripe as a coupon — Stripe then does the math on its own checkout page. The
 * test provider has no such page, so a discounted checkout moved no number a
 * human could see: the confirmation URL still quoted the full price
 * ([#239](https://github.com/Omega-JS-Stack/omega/issues/239)).
 *
 * Each case calls the handler DIRECTLY through the shared route harness, as its
 * OWN seeded persona (`intent-discount-<case>`, declared in the seed roster —
 * #406): every case buys a subscription, so one account per case is what keeps
 * the checkout guard from rejecting the next one. Everything
 * downstream — the provider, the auto-fired webhook, the webhook route, the
 * on-write trigger — is the real pipeline.
 *
 * Product-agnostic: resolves the first paid product from config.payment.products.
 *
 * Run: npx omega test framework:routes/payments/intent-discount-amounts
 */
const { buildUser, callHandler } = require('./_route-harness.js');
const discountCodes = require('../../../dist/omega/libraries/payment/discount-codes.js');
const analytics = require('../../../dist/omega/events/firestore/payments-webhooks/analytics.js');

const PayPal = require('../../../dist/omega/libraries/payment/providers/paypal.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/intent/post.js'));
const { buildConfirmationUrl } = require('../../../dist/omega/routes/payments/intent/confirmation-url.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

// What each code is worth, pinned against the discount-codes SSOT below so a
// repriced code fails here instead of silently changing what the test asserts.
// Stripe coupons come in two shapes and the seeded set now carries both: a
// percent_off code and an amount_off one
// ([#239](https://github.com/Omega-JS-Stack/omega/issues/239)).
const PERCENT_CODE = 'WELCOME15';
const ONE_TIME_CODE = 'FLASH20';
const AMOUNT_CODE = 'WELCOME10OFF';
const AMOUNT_OFF = 10;

/**
 * This suite's purchaser for one case, from the seed roster
 * ([#406](https://github.com/Omega-JS-Stack/omega/issues/406)). Every case here
 * BUYS a subscription and the checkout guard rejects a caller who already holds
 * one, so each case drives its own account — declared up front as
 * `intent-discount-<case>`, never minted mid-test. The caller is built from the
 * seeded DOC, so it is the record the route reads, not a shape invented here.
 */
async function purchaser(accounts, firestore, omega, name) {
  const account = accounts[`intent-discount-${name}`];

  if (!account) {
    throw new Error(`No seeded persona for the intent-discount case '${name}'`);
  }

  const doc = await firestore.get(`users/${account.uid}`);

  if (!doc) {
    throw new Error(`The seeded persona for '${name}' has no user doc — the checkout guard would refuse it`);
  }

  return { uid: account.uid, user: buildUser(doc) };
}

/**
 * What schemas/payments/intent/post.js resolves a bare checkout request to — the
 * handler receives settings already defaulted
 */
function checkoutSettings(overrides) {
  return {
    provider: 'test',
    frequency: null,
    trial: false,
    verification: {},
    attribution: {},
    trackingConsent: null,
    discount: null,
    supplemental: {},
    simulate: null,
    ...overrides,
  };
}

function amountFromUrl(url) {
  return new URL(url).searchParams.get('amount');
}

/**
 * The webhook doc the test provider's auto-fired event lands in
 */
async function waitForWebhook(waitFor, firestore, eventId) {
  return waitFor(async () => {
    const doc = await firestore.get(`payments-webhooks/${eventId}`);
    return doc || null;
  }, 30000, 500);
}

function eventIdFor(sessionId) {
  return sessionId.replace('_test-cs-', '_test-evt-');
}

module.exports = defineCases({
  description: 'Test intent provider: discounts move the first-charge amounts',
  type: 'group',
  timeout: 90000,

  tests: [
    {
      name: 'setup',
      async run({ expect, config, state, skip }) {
        const paidProduct = (config.payment?.products || []).find((p) => p.id !== 'basic' && p.type === 'subscription' && p.prices);

        if (!paidProduct) {
          skip('No paid subscription product configured in this brand');
        }

        state.product = paidProduct;
        state.frequency = Object.keys(paidProduct.prices)[0];
        state.price = paidProduct.prices[state.frequency];
        state.oneTimeProduct = (config.payment?.products || []).find((p) => p.type === 'one-time' && p.prices?.once);

        // The other end of the same code: a frequency it covers WHOLE, which is
        // the checkout PayPal and Coinbase cannot be handed at all (#786)
        state.fullCoverFrequency = Object.keys(paidProduct.prices).find((f) => paidProduct.prices[f] > 0 && paidProduct.prices[f] <= AMOUNT_OFF) || null;
        state.fullCoverPrice = state.fullCoverFrequency ? paidProduct.prices[state.fullCoverFrequency] : null;

        // A flat-dollar code only MOVES a number on a charge bigger than it is —
        // on anything smaller it floors at $0, which is also what a trial quotes.
        // Bill the amount cases against a frequency that can show the difference.
        state.amountFrequency = Object.keys(paidProduct.prices).find((f) => paidProduct.prices[f] > AMOUNT_OFF) || null;
        state.amountPrice = state.amountFrequency ? paidProduct.prices[state.amountFrequency] : null;

        // The codes this suite spends, straight from the SSOT
        expect(discountCodes.DISCOUNT_CODES[PERCENT_CODE].percent, `${PERCENT_CODE} should be 15% off`).toBe(15);
        expect(discountCodes.DISCOUNT_CODES[ONE_TIME_CODE].percent, `${ONE_TIME_CODE} should be 20% off`).toBe(20);
        expect(discountCodes.DISCOUNT_CODES[AMOUNT_CODE].amount, `${AMOUNT_CODE} should be $${AMOUNT_OFF} off`).toBe(AMOUNT_OFF);
        expect(discountCodes.DISCOUNT_CODES[AMOUNT_CODE].percent, `${AMOUNT_CODE} should be amount-based, not percent-based`).toBe(undefined);
      },
    },

    {
      name: 'a-percent-discount-lands-in-the-confirmation-url',
      async run({ accounts, expect, firestore, omega, state }) {
        const { user } = await purchaser(accounts, firestore, omega, 'percent-url');
        const expected = parseFloat((state.price * 0.85).toFixed(2));

        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-intent',
          user,
          data: checkoutSettings({ productId: state.product.id, frequency: state.frequency, discount: PERCENT_CODE }),
        });

        expect(sent.code, `Checkout should succeed, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(amountFromUrl(sent.body.url), `The confirmation URL should quote the discounted first charge ($${expected}), not the full $${state.price}`).toBe(String(expected));
      },
    },

    {
      name: 'the-route-discounts-the-url-for-every-provider',
      async run({ expect, state }) {
        // WHERE this happens is the whole point. A real provider applies its
        // coupon on its own hosted page and never revisits this URL, so doing the
        // math provider-side left a discounted Stripe checkout landing on the
        // confirmation page quoting the LIST price — and the client's tracking
        // modules read that param straight into GA4/pixel revenue. Calling the
        // route's own builder with provider=stripe is what proves the discount
        // is the ROUTE's promise and not the test provider's.
        const args = {
          product: state.product,
          productId: state.product.id,
          productType: 'subscription',
          frequency: state.frequency,
          provider: 'stripe',
          trial: false,
          orderId: '0000-0000-0000',
        };
        const discount = discountCodes.validate(PERCENT_CODE);
        const expected = parseFloat((state.price * 0.85).toFixed(2));

        const discounted = buildConfirmationUrl('https://example.com', { ...args, discount });
        expect(amountFromUrl(discounted), `A Stripe checkout should quote the discounted first charge ($${expected}) too`).toBe(String(expected));

        const undiscounted = buildConfirmationUrl('https://example.com', { ...args, discount: null });
        expect(amountFromUrl(undiscounted), 'An undiscounted checkout should be left at the list price').toBe(String(state.price));

        if (state.product.trial?.days) {
          const trialing = buildConfirmationUrl('https://example.com', { ...args, trial: true, discount });
          expect(amountFromUrl(trialing), 'A trial charges nothing today, coupon or not').toBe('0');
        }
      },
    },

    {
      name: 'a-percent-discount-lands-on-the-webhook-subscription',
      async run({ accounts, expect, firestore, omega, state, waitFor }) {
        const { user } = await purchaser(accounts, firestore, omega, 'percent-payload');

        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-intent',
          user,
          data: checkoutSettings({ productId: state.product.id, frequency: state.frequency, discount: PERCENT_CODE }),
        });

        expect(sent.code, `Checkout should succeed, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);

        // Stripe attaches the coupon it applied to the subscription — the synthetic
        // payload carries the same thing, so a reader of the webhook can see WHICH
        // code moved the money
        const webhookDoc = await waitForWebhook(waitFor, firestore, eventIdFor(sent.body.id));
        const coupon = webhookDoc.raw?.data?.object?.discount?.coupon;

        expect(coupon, `The fired subscription should carry the discount, got ${JSON.stringify(webhookDoc.raw?.data?.object?.discount)}`).toBeTruthy();
        expect(coupon.percent_off, 'The coupon should be 15% off').toBe(15);
        expect(coupon.duration, 'The coupon should apply to the first charge only').toBe('once');
        expect(coupon.name, 'The coupon should name the code that was redeemed').toBe(PERCENT_CODE);
      },
    },

    {
      name: 'a-declined-first-invoice-bills-the-discounted-amount',
      async run({ accounts, expect, firestore, omega, state, waitFor }) {
        // The subscription event carries the coupon; the INVOICE is where Stripe
        // reports the money — and the declined checkout is the one path that fires
        // one, so it is where the discounted first charge is provable end to end
        const { user } = await purchaser(accounts, firestore, omega, 'percent-invoice');
        const expectedCents = Math.round(parseFloat((state.price * 0.85).toFixed(2)) * 100);

        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-intent',
          user,
          data: checkoutSettings({ productId: state.product.id, frequency: state.frequency, discount: PERCENT_CODE, simulate: 'decline' }),
        });

        expect(sent.code, `A declined checkout still starts, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);

        const invoiceDoc = await waitForWebhook(waitFor, firestore, `${eventIdFor(sent.body.id)}-invoice`);

        expect(invoiceDoc.raw?.data?.object?.amount_due, `The failed first invoice should bill the discounted ${expectedCents} cents, not the full ${Math.round(state.price * 100)}`).toBe(expectedCents);
      },
    },

    {
      name: 'a-one-time-purchase-is-discounted-in-the-url-and-the-session',
      async run({ accounts, expect, firestore, omega, state, waitFor, skip }) {
        if (!state.oneTimeProduct) {
          skip('No one-time product configured in this brand');
        }

        const { user } = await purchaser(accounts, firestore, omega, 'one-time');
        const price = state.oneTimeProduct.prices.once;
        const expected = parseFloat((price * 0.8).toFixed(2));

        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-intent',
          user,
          // A cadence the caller had no business sending on a one-time product —
          // the shape the live checkout really sent
          // ([#668](https://github.com/Omega-JS-Stack/omega/issues/668)). The
          // route is what decides a one-time buy bills on `once`.
          data: checkoutSettings({ productId: state.oneTimeProduct.id, frequency: 'annually', discount: ONE_TIME_CODE }),
        });

        expect(sent.code, `Checkout should succeed, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(amountFromUrl(sent.body.url), `The confirmation URL should quote $${expected}, not the full $${price}`).toBe(String(expected));

        // What the caller asked for never reaches the record: the intent doc is
        // what the webhook and every reader after it read back (#668)
        const intentDoc = await firestore.get(`payments-intents/${sent.body.orderId}`);

        expect(intentDoc.frequency, `A one-time intent should record 'once', got '${intentDoc.frequency}'`).toBe('once');
        expect(new URL(sent.body.url).searchParams.get('frequency'), 'And the confirmation URL should say the same').toBe('once');
        expect(new URL(sent.body.url).searchParams.get('type'), 'The confirmation URL should name the product type outright').toBe('one-time');

        const webhookDoc = await waitForWebhook(waitFor, firestore, eventIdFor(sent.body.id));
        const session = webhookDoc.raw?.data?.object;

        expect(session?.amount_total, `The session should charge ${Math.round(expected * 100)} cents`).toBe(Math.round(expected * 100));
        expect(session?.total_details?.amount_discount, 'The session should report what the coupon took off').toBe(Math.round((price - expected) * 100));
      },
    },

    {
      name: 'no-discount-leaves-the-amounts-alone',
      async run({ accounts, expect, firestore, omega, state, waitFor }) {
        const { user } = await purchaser(accounts, firestore, omega, 'none');

        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-intent',
          user,
          data: checkoutSettings({ productId: state.product.id, frequency: state.frequency }),
        });

        expect(sent.code, `Checkout should succeed, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(amountFromUrl(sent.body.url), 'An undiscounted checkout should still quote the full price').toBe(String(state.price));

        const webhookDoc = await waitForWebhook(waitFor, firestore, eventIdFor(sent.body.id));

        expect(webhookDoc.raw?.data?.object?.discount, 'An undiscounted subscription should carry no coupon').toBe(undefined);
      },
    },

    {
      name: 'a-trial-with-a-discount-still-charges-nothing-now',
      async run({ accounts, expect, firestore, omega, state, skip }) {
        if (!state.product.trial?.days) {
          skip('The paid product configures no trial');
        }

        const { user } = await purchaser(accounts, firestore, omega, 'trial');

        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-intent',
          user,
          data: checkoutSettings({ productId: state.product.id, frequency: state.frequency, trial: true, discount: PERCENT_CODE }),
        });

        expect(sent.code, `Checkout should succeed, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(amountFromUrl(sent.body.url), 'A trial charges nothing today — a coupon takes its cut off nothing').toBe('0');
      },
    },

    {
      name: 'an-amount-discount-lands-in-the-confirmation-url',
      async run({ accounts, expect, firestore, omega, state, skip }) {
        if (!state.amountFrequency) {
          skip(`No configured price is bigger than the $${AMOUNT_OFF} code`);
        }

        const { user } = await purchaser(accounts, firestore, omega, 'amount-url');
        const expected = parseFloat((state.amountPrice - AMOUNT_OFF).toFixed(2));

        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-intent',
          user,
          data: checkoutSettings({ productId: state.product.id, frequency: state.amountFrequency, discount: AMOUNT_CODE }),
        });

        expect(sent.code, `Checkout should succeed, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(amountFromUrl(sent.body.url), `The confirmation URL should quote the discounted first charge ($${expected}), not the full $${state.amountPrice}`).toBe(String(expected));
      },
    },

    {
      name: 'an-amount-discount-lands-on-the-webhook-subscription-in-cents',
      async run({ accounts, expect, firestore, omega, state, waitFor, skip }) {
        if (!state.amountFrequency) {
          skip(`No configured price is bigger than the $${AMOUNT_OFF} code`);
        }

        const { user } = await purchaser(accounts, firestore, omega, 'amount-payload');

        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-intent',
          user,
          data: checkoutSettings({ productId: state.product.id, frequency: state.amountFrequency, discount: AMOUNT_CODE }),
        });

        expect(sent.code, `Checkout should succeed, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);

        // Stripe's `amount_off` is CENTS while ours is dollars — the synthetic
        // payload has to convert, or a reader of the webhook sees a $10 coupon
        // as 10 cents
        const webhookDoc = await waitForWebhook(waitFor, firestore, eventIdFor(sent.body.id));
        const coupon = webhookDoc.raw?.data?.object?.discount?.coupon;

        expect(coupon, `The fired subscription should carry the discount, got ${JSON.stringify(webhookDoc.raw?.data?.object?.discount)}`).toBeTruthy();
        expect(coupon.amount_off, `The coupon should be ${AMOUNT_OFF * 100} cents off`).toBe(AMOUNT_OFF * 100);
        expect(coupon.percent_off, 'An amount-based coupon carries no percent').toBe(null);
        expect(coupon.duration, 'The coupon should apply to the first charge only').toBe('once');
        expect(coupon.name, 'The coupon should name the code that was redeemed').toBe(AMOUNT_CODE);
      },
    },

    {
      name: 'a-trial-with-an-amount-discount-still-charges-nothing-now',
      async run({ accounts, expect, firestore, omega, state, skip }) {
        if (!state.product.trial?.days) {
          skip('The paid product configures no trial');
        }

        const { user } = await purchaser(accounts, firestore, omega, 'amount-trial');

        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-intent',
          user,
          data: checkoutSettings({ productId: state.product.id, frequency: state.amountFrequency || state.frequency, trial: true, discount: AMOUNT_CODE }),
        });

        expect(sent.code, `Checkout should succeed, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(amountFromUrl(sent.body.url), 'A trial charges nothing today — a flat-dollar coupon comes off nothing').toBe('0');
      },
    },

    {
      name: 'analytics-reports-the-amount-discount-and-a-full-price-renewal',
      async run({ expect, state, skip }) {
        if (!state.amountFrequency) {
          skip(`No configured price is bigger than the $${AMOUNT_OFF} code`);
        }

        // Revenue is reported off the same first-charge math the URL quotes. The
        // gate in front of it read `discount.percent > 0`, so an amount-based
        // code would have tracked the LIST price as revenue while the customer
        // paid less.
        const unified = {
          product: { id: state.product.id, name: state.product.name },
          status: 'active',
          trial: { claimed: false },
          payment: { frequency: state.amountFrequency, price: state.amountPrice, resourceId: 'sub_test_analytics_amount' },
        };
        const order = { discount: discountCodes.validate(AMOUNT_CODE) };
        const expected = parseFloat((state.amountPrice - AMOUNT_OFF).toFixed(2));

        const resolved = analytics.resolvePaymentEvent('subscription', 'new-subscription', 'customer.subscription.created', unified, order);
        expect(resolved.value, `Tracked revenue should be the discounted $${expected}, not the list $${state.amountPrice}`).toBe(expected);

        // A renewal is deliberately full price — a 'once' coupon is spent
        const renewal = analytics.resolvePaymentEvent('subscription', null, 'invoice.payment_succeeded', unified, order);
        expect(renewal.value, 'Renewals still track the full price').toBe(state.amountPrice);
      },
    },

    {
      name: 'analytics-reports-the-discounted-amount-as-revenue',
      async run({ expect, state }) {
        // The same first-charge math the URL quotes is what analytics reports as
        // revenue, and both now come from applyToAmount(). The existing analytics
        // suite only covers full-price events, so the discounted branch is pinned
        // here — a divergence between the two would mean the confirmation page and
        // the server-side purchase event disagree about what the customer paid.
        const unified = {
          product: { id: state.product.id, name: state.product.name },
          status: 'active',
          trial: { claimed: false },
          payment: { frequency: state.frequency, price: state.price, resourceId: 'sub_test_analytics_discount' },
        };
        const order = { discount: discountCodes.validate(PERCENT_CODE) };
        const expected = parseFloat((state.price * 0.85).toFixed(2));

        const resolved = analytics.resolvePaymentEvent('subscription', 'new-subscription', 'customer.subscription.created', unified, order);

        expect(resolved.reason, 'A discounted first checkout is still a first purchase').toBe('first-purchase');
        expect(resolved.value, `Tracked revenue should be the discounted $${expected}, not the list $${state.price}`).toBe(expected);

        // A renewal is deliberately full price — a 'once' coupon is spent
        const renewal = analytics.resolvePaymentEvent('subscription', null, 'invoice.payment_succeeded', unified, order);
        expect(renewal.value, 'Renewals still track the full price').toBe(state.price);
      },
    },

    {
      name: 'validate-returns-the-amount-a-flat-dollar-code-is-worth',
      async run({ expect }) {
        // Everything downstream reads a validate() RESULT, never the raw table —
        // a validated amount code that reported no amount would have quietly
        // charged full price everywhere.
        const result = discountCodes.validate(AMOUNT_CODE.toLowerCase());

        expect(result.valid, 'The seeded amount code should validate').toBe(true);
        expect(result.code, 'It should normalize to the uppercase code').toBe(AMOUNT_CODE);
        expect(result.amount, `It should report $${AMOUNT_OFF} off`).toBe(AMOUNT_OFF);
        expect(result.duration, 'It should apply to the first charge only').toBe('once');
        expect(result.percent, 'It should carry no percent').toBe(undefined);

        // A percent code is unchanged — it reports a percent and no amount
        const percent = discountCodes.validate(PERCENT_CODE);
        expect(percent.percent, 'The percent code still reports its percent').toBe(15);
        expect(percent.amount, 'The percent code carries no amount').toBe(undefined);
      },
    },

    {
      name: 'a-code-that-covers-the-whole-price-answers-400-and-never-calls-paypal',
      async run({ accounts, expect, firestore, omega, state, skip }) {
        if (!state.fullCoverFrequency) {
          skip(`No configured price is small enough for the $${AMOUNT_OFF} code to cover whole`);
        }

        // The WIRE half of #786: the refusal is thrown by `chargeableAmount()`
        // in libraries/payment/discount-codes.js and coded 400, and this route
        // is what turns that into the buyer's answer — the one provider-path
        // error it repeats instead of hiding behind its neutral 500 sentence.
        // Everything else about this checkout is real; only PayPal's HTTP door
        // is watched, and it must never open.
        const { user } = await purchaser(accounts, firestore, omega, 'zero-total');
        const calls = [];
        const realRequest = PayPal.request;

        PayPal.request = async (endpoint) => {
          calls.push(endpoint);
          throw new Error(`PayPal was called at ${endpoint} for a $0.00 checkout`);
        };

        let sent;

        try {
          sent = await callHandler({
            omega,
            handler,
            functionName: 'payments-intent',
            user,
            data: checkoutSettings({ provider: 'paypal', productId: state.product.id, frequency: state.fullCoverFrequency, discount: AMOUNT_CODE }),
          });
        } finally {
          PayPal.request = realRequest;
        }

        expect(sent.code, `A fully covered price is the buyer's own 400, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(400);
        expect(String(sent.body), 'The answer names the code they entered').toMatch(new RegExp(AMOUNT_CODE));
        expect(String(sent.body), `And the $${state.fullCoverPrice} price it covered`).toMatch(new RegExp(`\\$${state.fullCoverPrice.toFixed(2)}`));
        expect(String(sent.body), 'And the payment method that cannot take it').toMatch(/PayPal/);
        expect(!/could not start your checkout/i.test(String(sent.body)), 'Never the neutral sentence a real provider fault gets').toBeTruthy();
        expect(calls.length, `PayPal was never called, got ${JSON.stringify(calls)}`).toBe(0);
      },
    },

    {
      name: 'an-amount-discount-comes-off-the-first-charge',
      async run({ expect }) {
        // Stripe coupons come in both shapes (percent_off, amount_off), so the math
        // the test provider runs handles both — pinned here on the pure function
        // across the edges the seeded codes do not reach.
        expect(discountCodes.applyToAmount(99.99, { valid: true, code: 'X', amount: 15, duration: 'once' }), '$15 off $99.99 should be $84.99').toBe(84.99);
        expect(discountCodes.applyToAmount(99.99, { valid: true, code: 'X', percent: 15, duration: 'once' }), '15% off $99.99 should be $84.99').toBe(84.99);
        expect(discountCodes.applyToAmount(9.99, { valid: true, code: 'X', amount: 50, duration: 'once' }), 'A discount bigger than the charge should floor at $0, never go negative').toBe(0);
        expect(discountCodes.applyToAmount(9.99, null), 'No discount should leave the charge alone').toBe(9.99);
        expect(discountCodes.applyToAmount(0, { valid: true, code: 'X', percent: 15 }), 'A $0 charge stays $0').toBe(0);
      },
    },
  ],
});
