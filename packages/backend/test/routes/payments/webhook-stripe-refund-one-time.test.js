/**
 * Test: POST /payments/webhook — a ONE-TIME refund reaches the pipeline
 * ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
 *
 * `charge.refunded` for a charge that belongs to no subscription and no invoice
 * is the refund of a one-time purchase. The parser answered that shape with
 * `category: null`, and the route drops an uncategorized event at the door — so
 * the refund of a one-time purchase never entered the pipeline at all: no
 * transition, no order update, nothing said to the customer.
 *
 * The proof runs at both ends of the door: the parser's own mapping, and the
 * route landing the pipeline doc. The two subscription shapes are asserted
 * alongside, because the branch that categorizes a one-time refund sits directly
 * under them and must leave them exactly as they were.
 *
 * Run: npx omega test backend:routes/payments/webhook-stripe-refund-one-time
 */
const { callHandler } = require('./_route-harness.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/webhook/post.js'));
const stripeProvider = require('../../../dist/omega/routes/payments/webhook/providers/stripe.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const VALID_KEY = () => process.env.OMEGA_WEBHOOK_KEY;

// A refunded charge that carries no subscription and no invoice — a one-time purchase.
// Deliberately carries no orderId: this suite is about the door, and an orderId
// would pull the intent/order writes of a real purchase into it.
function oneTimeRefundedCharge() {
  return {
    id: 'ch_test_one_time_refund',
    object: 'charge',
    amount: 999,
    amount_refunded: 999,
    currency: 'usd',
    invoice: null,
    subscription: null,
    metadata: { uid: '_test-one-time-refund-uid' },
    refunds: { data: [{ id: 're_test_one_time', amount: 999, currency: 'usd', reason: 'requested_by_customer' }] },
  };
}

const refundEvent = (id, charge) => ({
  id: id,
  type: 'charge.refunded',
  data: { object: charge },
});

// This suite is about which events get through the door at all.
function deliver(omega, event) {
  return callHandler({
    omega,
    handler,
    functionName: 'payments-webhook',
    req: {
      query: { provider: 'stripe', key: VALID_KEY() },
      body: event,
      rawBody: Buffer.from(JSON.stringify(event)),
    },
  });
}

module.exports = defineCases({
  description: 'Payment webhook: Stripe one-time refunds',
  type: 'group',
  timeout: 30000,

  tests: [
    {
      name: 'maps-a-one-time-charge-refund-as-one-time',
      auth: 'none',
      async run({ expect }) {
        const parsed = stripeProvider.parseWebhook({ body: refundEvent('_test-evt-one-time-refund-parse', oneTimeRefundedCharge()) });

        expect(parsed.category, 'A charge with no subscription and no invoice is a one-time refund').toBe('one-time');
        expect(parsed.resourceType, 'The charge is the only resource the event carries').toBe('charge');
        expect(parsed.resourceId, 'The charge id is the resource').toBe('ch_test_one_time_refund');
        expect(parsed.uid, 'The uid comes off the charge metadata').toBe('_test-one-time-refund-uid');
      },
    },

    {
      name: 'keeps-a-subscription-charge-refund-on-the-subscription-path',
      auth: 'none',
      async run({ expect }) {
        const charge = { ...oneTimeRefundedCharge(), subscription: 'sub_test_refund' };

        const parsed = stripeProvider.parseWebhook({ body: refundEvent('_test-evt-sub-refund-parse', charge) });

        expect(parsed.category, 'A charge naming a subscription stays a subscription refund').toBe('subscription');
        expect(parsed.resourceType, 'The pipeline must re-fetch the subscription').toBe('subscription');
        expect(parsed.resourceId, 'The subscription id is the resource').toBe('sub_test_refund');
      },
    },

    {
      name: 'keeps-an-invoiced-charge-refund-on-the-subscription-path',
      auth: 'none',
      async run({ expect }) {
        const charge = { ...oneTimeRefundedCharge(), invoice: 'in_test_refund' };

        const parsed = stripeProvider.parseWebhook({ body: refundEvent('_test-evt-invoice-refund-parse', charge) });

        expect(parsed.category, 'A charge carrying an invoice stays on the subscription path').toBe('subscription');
        expect(parsed.resourceType, 'The invoice resolves the subscription downstream').toBe('invoice');
        expect(parsed.resourceId, 'The invoice id is the resource').toBe('in_test_refund');
      },
    },

    {
      name: 'a-one-time-refund-delivery-lands-a-pipeline-doc',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        const eventId = '_test-evt-one-time-refund-ingest';

        const sent = await deliver(omega, refundEvent(eventId, oneTimeRefundedCharge()));

        expect(sent.code, `A one-time refund should be accepted, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(!sent.body?.ignored, 'A one-time refund must not be ignored as an uncategorized event').toBeTruthy();

        const doc = await firestore.get(`payments-webhooks/${eventId}`);

        expect(doc, 'The refund should land a pipeline doc').toBeTruthy();
        expect(doc.event.type, 'The pipeline doc should carry the refund event type').toBe('charge.refunded');
        expect(doc.event.category, 'The pipeline doc should be categorized one-time').toBe('one-time');
        expect(doc.event.resourceId, 'The pipeline doc should point at the charge').toBe('ch_test_one_time_refund');
      },
    },
  ],
});
