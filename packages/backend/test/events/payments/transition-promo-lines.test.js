/**
 * Test: the promo line + totals the order-confirmation transitions compute
 * ([#239](https://github.com/Omega-JS-Stack/omega/issues/239)).
 *
 * `new-subscription` and `purchase-completed` pre-compute `_computed` for the order
 * email. Three shapes reach them: a percent code, a flat-amount code, and — from an
 * order written before the amount field existed — a valid discount carrying
 * NEITHER. The third must not render a promo line and must not throw: these
 * handlers are dispatched fire-and-forget, so a TypeError in here silently costs
 * the customer their confirmation email.
 *
 * The totals go through applyToAmount() for every shape, so `totalToday` is what
 * was actually charged rather than the list price.
 *
 * Run: npx omega test framework:events/payments/transition-promo-lines
 *
 * The REAL transition modules run. The one thing swapped is the email door
 * (`ctx.email`), sending would hit the real provider, and it is swapped on the
 * test ctx alone, so the runner's own omega is never touched. Everything else
 * (the discount validation, the arithmetic, the template data) is the real path.
 */
const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const newSubscription = loadHandler(require.resolve('../../../dist/omega/events/firestore/payments-webhooks/transitions/subscription/new-subscription.js'));
const purchaseCompleted = loadHandler(require.resolve('../../../dist/omega/events/firestore/payments-webhooks/transitions/one-time/purchase-completed.js'));
const discountCodes = require('../../../dist/omega/libraries/payment/discount-codes.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const PRICE = 49.99;
const UID = '_test-transition-promo';

// What an order written before the amount field existed looks like coming back
// out of Firestore: valid, named, and carrying no shape either reader can use
const LEGACY_SHAPELESS_DISCOUNT = { valid: true, code: 'LEGACYCODE', duration: 'once' };

const USER_DOC = { auth: { uid: UID, email: `${UID}@example.com` } };

/**
 * A ctx on the real omega with ONLY the email door swapped, so the
 * transition's own `sendOrderEmail()` path runs for real up to the send.
 */
function buildCtx(omega, captured) {
  return {
    omega: omega,
    email: {
      send: async (payload) => {
        captured.sent = payload;
        return { status: 'captured' };
      },
    },
    log: () => {},
    error: (message) => captured.errors.push(message),
  };
}

async function runSubscription(omega, discount, { isTrial = false } = {}) {
  const captured = { errors: [] };
  const order = {
    id: 'ORD-PROMO-SUB',
    type: 'subscription',
    discount: discount,
    unified: { product: { id: 'premium', name: 'Premium' }, payment: { price: PRICE, frequency: 'monthly' } },
  };

  await newSubscription({
    before: {},
    after: {
      product: { id: 'premium', name: 'Premium' },
      payment: { frequency: 'monthly' },
      trial: { claimed: isTrial },
    },
    order,
    uid: UID,
    userDoc: USER_DOC,
    ctx: buildCtx(omega, captured),
  });

  return { computed: captured.sent?.data?.content?._computed, captured };
}

async function runOneTime(omega, discount) {
  const captured = { errors: [] };
  const order = {
    id: 'ORD-PROMO-ONE',
    type: 'one-time',
    discount: discount,
    unified: { product: { id: 'credits-100', name: '100 Credits' }, payment: { price: PRICE } },
  };

  await purchaseCompleted({
    before: {},
    after: { product: { id: 'credits-100', name: '100 Credits' }, payment: { price: PRICE, resourceId: 'ch_test_promo' } },
    order,
    uid: UID,
    userDoc: USER_DOC,
    ctx: buildCtx(omega, captured),
  });

  return { computed: captured.sent?.data?.content?._computed, captured };
}

module.exports = defineCases({
  description: 'Order-confirmation transitions: promo line + totals per discount shape',
  type: 'group',
  timeout: 15000,

  tests: [
    {
      name: 'a-percent-code-renders-a-percent-line',
      async run({ expect, omega }) {
        const { computed } = await runSubscription(omega, discountCodes.validate('WELCOME15'));

        expect(computed, 'The transition should have composed the email').toBeTruthy();
        expect(computed.promoCode, 'The line names the code').toBe('WELCOME15');
        expect(computed.promoPercent, 'A percent code quotes its percent').toBe(15);
        expect(computed.promoSavings, 'It saved 15% of the price').toBe('7.50');
        expect(computed.totalToday, 'The total is what was actually charged').toBe('42.49');
        expect(computed.firstChargeAmount, 'The first charge matches').toBe('42.49');
        expect('promoAmount' in computed, 'A percent code quotes no dollar amount').toBe(false);
      },
    },

    {
      name: 'an-amount-code-renders-a-money-line-and-the-discounted-total',
      async run({ expect, omega }) {
        const { computed } = await runSubscription(omega, discountCodes.validate('WELCOME10OFF'));

        expect(computed.promoCode, 'The line names the code').toBe('WELCOME10OFF');
        expect(computed.promoAmount, 'A flat-dollar code quotes its dollars').toBe('10.00');
        expect(computed.promoSavings, 'It saved the full $10').toBe('10.00');
        expect(computed.totalToday, 'The receipt must not quote the list price').toBe('39.99');
        expect('promoPercent' in computed, 'An amount code quotes no percentage').toBe(false);
      },
    },

    {
      name: 'a-discount-with-neither-shape-renders-no-promo-line-and-does-not-throw',
      async run({ expect, omega }) {
        // An order written before the amount field existed. The handler is
        // dispatched fire-and-forget, so a throw here costs the email silently.
        const { computed, captured } = await runSubscription(omega, LEGACY_SHAPELESS_DISCOUNT);

        expect(computed, 'The email should still be composed').toBeTruthy();
        expect('promoCode' in computed, 'A shapeless discount renders no promo line').toBe(false);
        expect('promoPercent' in computed, 'Nothing to quote as a percentage').toBe(false);
        expect('promoAmount' in computed, 'Nothing to quote as an amount').toBe(false);
        expect(computed.totalToday, 'With no usable discount the full price stands').toBe('49.99');
        expect(captured.errors, 'The transition should log no error').toEqual([]);
      },
    },

    {
      name: 'a-trial-still-charges-nothing-today',
      async run({ expect, omega }) {
        const { computed } = await runSubscription(omega, discountCodes.validate('WELCOME10OFF'), { isTrial: true });

        expect(computed.totalToday, 'A trial charges nothing today').toBe('0.00');
        expect(computed.firstChargeAmount, 'The first real charge is still the discounted one').toBe('39.99');
      },
    },

    {
      name: 'the-one-time-transition-behaves-the-same-for-every-shape',
      async run({ expect, omega }) {
        const percent = await runOneTime(omega, discountCodes.validate('FLASH20'));
        expect(percent.computed.promoPercent, 'A percent code quotes its percent').toBe(20);
        expect(percent.computed.totalToday, '20% off 49.99 is 39.99').toBe('39.99');

        const amount = await runOneTime(omega, discountCodes.validate('WELCOME10OFF'));
        expect(amount.computed.promoAmount, 'A flat-dollar code quotes its dollars').toBe('10.00');
        expect(amount.computed.totalToday, '$10 off 49.99 is 39.99').toBe('39.99');

        const shapeless = await runOneTime(omega, LEGACY_SHAPELESS_DISCOUNT);
        expect('promoCode' in shapeless.computed, 'A shapeless discount renders no promo line').toBe(false);
        expect(shapeless.computed.totalToday, 'The full price stands').toBe('49.99');
        expect(shapeless.captured.errors, 'The transition should log no error').toEqual([]);
      },
    },

    {
      name: 'no-discount-at-all-is-unchanged',
      async run({ expect, omega }) {
        const { computed } = await runSubscription(omega, null);

        expect('promoCode' in computed, 'No code, no promo line').toBe(false);
        expect(computed.totalToday, 'The customer pays the list price').toBe('49.99');
      },
    },
  ],
});
