/**
 * Test: the one-time purchase-failed handler tells the customer their payment
 * failed ([#673](https://github.com/Omega-JS-Stack/omega/issues/673)).
 *
 * The transition IS reachable, which is what decided this: a Stripe
 * `invoice.payment_failed` whose `billing_reason` is not a subscription one
 * parses as category `one-time` (routes/payments/webhook/providers/stripe.js),
 * and `detectOneTimeTransition()` maps that event to `purchase-failed`. The
 * population behind it is a MANUAL invoice that failed — nobody is standing at a
 * checkout watching it, which is the reason its subscription cousin
 * `checkout-declined` deliberately sends nothing — so the failure only reaches
 * the customer if this handler tells them.
 *
 * Called directly, and the email library is RECORDED rather than run, for the
 * same reasons its purchase-refunded twin is.
 *
 * Run: npx omega test backend:events/payments/purchase-failed-handler
 */
const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/events/firestore/payments-webhooks/transitions/one-time/purchase-failed.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const ORDER_ID = '5544-3322-1100';

function context(logs, sent) {
  return {
    before: null,
    after: { product: { id: 'credits-100', name: '100 Credits' }, status: 'failed' },
    order: { id: ORDER_ID, type: 'one-time', unified: { product: { id: 'credits-100' }, payment: { price: 9.99 } } },
    uid: '_test-purchase-failed-uid',
    userDoc: { auth: { uid: '_test-purchase-failed-uid', email: 'buyer@test.dev' } },
    ctx: {
      log: (line) => logs.push(line),
      error: (line) => logs.push(line),
      email: { send: async (payload) => { sent.push(payload); return { status: 'sent' }; } },
      omega: {
        config: { brand: { name: 'Test Brand' } },
      },
    },
  };
}

module.exports = defineCases({
  description: 'One-time purchase-failed handler',
  type: 'group',

  tests: [
    {
      name: 'records-the-order-that-failed',
      async run({ expect }) {
        const logs = [];

        await handler(context(logs, []));

        const line = logs.find((entry) => entry.includes('one-time/purchase-failed'));

        expect(line, `The handler should log the transition, got: ${logs.join(' | ')}`).toBeTruthy();
        expect(line, 'The line should name the order that failed').toMatch(new RegExp(`orderId=${ORDER_ID}`));
      },
    },

    {
      name: 'sends-the-failed-payment-email-the-subscription-twin-sends',
      async run({ expect }) {
        const sent = [];

        await handler(context([], sent));

        expect(sent.length, `A failed purchase owes the customer exactly one email, got ${sent.length}`).toBe(1);

        const email = sent[0];

        expect(email.template, 'It rides the one order template, like every other transition').toBe('order');
        expect(email.categories, 'Filed under the same category the subscription failure is').toEqual(['order/payment-failed']);
        expect(email.data.content.event, 'The order template renders the payment-failed variant off this event').toBe('payment-failed');
        expect(email.subject, 'The subject should name the order that failed').toMatch(new RegExp(ORDER_ID));
        expect(email.data.content.id, 'The order rides the payload, so the mail can quote what was being bought').toBe(ORDER_ID);
      },
    },
  ],
});
