/**
 * Test: the one-time purchase-refunded handler's record of the refund, and the
 * mail it owes the customer
 * ([#212](https://github.com/Omega-JS-Stack/omega/issues/212),
 * [#673](https://github.com/Omega-JS-Stack/omega/issues/673)).
 *
 * The handler's log line is the operator's record: it used to name the order and
 * nothing else, because on-write.js resolved the provider's refund details for the
 * subscription transition only. The CUSTOMER got nothing at all — the handler was
 * a log-only stub, so somebody refunded on a one-time purchase heard about it from
 * their bank statement. It now sends through the same generator its subscription
 * twin uses (`order` template, `refunded` event).
 *
 * The handler is called directly — the dispatch that calls it is fire-and-forget
 * and skipped in testing mode, so the emulator journey cannot see either.
 *
 * The email library is RECORDED rather than run: it is an external sink (SendGrid),
 * the same treatment the webhook harness gives the Sentry handle.
 *
 * Run: npx omega test backend:events/payments/purchase-refunded-handler
 */
const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/events/firestore/payments-webhooks/transitions/one-time/purchase-refunded.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const ORDER_ID = '9090-8080-7070';

function context(logs, sent) {
  return {
    before: null,
    after: { product: { id: 'credits-100', name: '100 Credits' }, status: 'refunded' },
    order: { id: ORDER_ID, type: 'one-time', unified: { product: { id: 'credits-100' }, payment: { price: 9.99 } } },
    uid: '_test-purchase-refunded-uid',
    userDoc: { auth: { uid: '_test-purchase-refunded-uid', email: 'buyer@test.dev' } },
    ctx: {
      log: (line) => logs.push(line),
      error: (line) => logs.push(line),
      email: { send: async (payload) => { sent.push(payload); return { status: 'sent' }; } },
      omega: {
        config: { brand: { name: 'Test Brand' } },
      },
    },
    refundDetails: { amount: '9.99', currency: 'USD', reason: 'requested_by_customer' },
  };
}

module.exports = defineCases({
  description: 'One-time purchase-refunded handler',
  type: 'group',

  tests: [
    {
      name: 'records-the-amount-that-came-back',
      async run({ expect }) {
        const logs = [];

        await handler(context(logs, []));

        const line = logs.find((entry) => entry.includes('one-time/purchase-refunded'));

        expect(line, `The handler should log the transition, got: ${logs.join(' | ')}`).toBeTruthy();
        expect(line, 'The line should name the order refunded').toMatch(new RegExp(`orderId=${ORDER_ID}`));
        expect(line, 'The line should say how much came back').toMatch(/amount=9\.99 USD/);
        expect(line, 'The line should carry the provider reason').toMatch(/reason=requested_by_customer/);
        expect(line, 'The line should name what was refunded').toMatch(/product=credits-100/);
      },
    },

    {
      name: 'stays-readable-without-refund-details',
      async run({ expect }) {
        // A provider library with no getRefundDetails() leaves them null — the
        // record must still say which order was refunded
        const logs = [];
        const ctx = context(logs, []);
        ctx.refundDetails = null;

        await handler(ctx);

        const line = logs.find((entry) => entry.includes('one-time/purchase-refunded'));

        expect(line, 'The line should still name the order').toMatch(new RegExp(`orderId=${ORDER_ID}`));
        expect(line, 'An unresolved amount should read as unknown, never as undefined').toMatch(/amount=unknown USD/);
      },
    },

    {
      name: 'sends-the-refunded-email-the-subscription-twin-sends',
      async run({ expect }) {
        const sent = [];

        await handler(context([], sent));

        expect(sent.length, `A refunded purchase owes the customer exactly one email, got ${sent.length}`).toBe(1);

        const email = sent[0];

        expect(email.template, 'It rides the one order template, like every other transition').toBe('order');
        expect(email.categories, 'Filed under the same category the subscription refund is').toEqual(['order/refunded']);
        expect(email.data.content.event, 'The order template renders the refunded variant off this event').toBe('refunded');
        expect(email.subject, 'The subject should name the order refunded').toMatch(new RegExp(ORDER_ID));
        expect(email.data.content.id, 'The order rides the payload, so the receipt can quote it').toBe(ORDER_ID);
        expect(email.data.content._computed.refundAmount, 'The refund amount is what the mail is about').toBe('9.99');
        expect(email.data.content._computed.refundCurrency, 'And its currency').toBe('USD');
        expect(email.data.content._computed.refundReason, 'The provider reason rides along, as the twin sends it').toBe('requested_by_customer');
      },
    },
  ],
});
