/**
 * Test: POST /payments/webhook — Stripe renewals reach the pipeline
 * ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
 *
 * A subscription renewal produces NO state transition — active → active, same
 * product — so the invoice event is the only signal that money moved. Stripe's
 * webhook provider listed `invoice.payment_failed` but not
 * `invoice.payment_succeeded`, so every renewal was dropped at the door as an
 * unsupported event type and Stripe recurring revenue never reached analytics
 * (whose `isPaymentEvent()` had been expecting that exact string all along).
 *
 * The proof runs at both ends of the door: the parser's own mapping of a real
 * invoice payload, and the route accepting the delivery and landing the pipeline
 * doc it is supposed to land.
 *
 * `invoice.paid` stays OUT by design — Stripe fires it for the same paid invoice
 * and the analytics resolver has no per-invoice dedup, so ingesting both would
 * report a renewal's revenue twice. That exclusion is asserted here so it cannot
 * be added back by accident.
 *
 * Run: npx omega test backend:routes/payments/webhook-stripe-invoice
 */
const { callHandler } = require('./_route-harness.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/webhook/post.js'));
const stripeProvider = require('../../../dist/omega/routes/payments/webhook/providers/stripe.js');

const FIXTURE_INVOICE_RENEWAL = require('../../fixtures/stripe/invoice-subscription-payment-succeeded.json');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const VALID_KEY = () => process.env.OMEGA_WEBHOOK_KEY;

const renewalEvent = (id) => ({
  id: id,
  type: 'invoice.payment_succeeded',
  data: { object: FIXTURE_INVOICE_RENEWAL },
});

// This suite is about which event types get through the door at all.
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
  description: 'Payment webhook: Stripe invoice events',
  type: 'group',
  timeout: 30000,

  tests: [
    {
      name: 'supports-invoice-payment-succeeded',
      auth: 'none',
      async run({ expect }) {
        expect(stripeProvider.isSupported('invoice.payment_succeeded'), 'A Stripe renewal must be a supported event').toBeTruthy();
      },
    },

    {
      name: 'does-not-support-invoice-paid',
      auth: 'none',
      async run({ expect }) {
        // Stripe fires this alongside invoice.payment_succeeded for the same
        // invoice; ingesting both would double-count the renewal's revenue.
        expect(stripeProvider.isSupported('invoice.paid'), 'invoice.paid must stay out of the ingest').toBe(false);
      },
    },

    {
      name: 'maps-a-renewal-invoice-to-its-subscription',
      auth: 'none',
      async run({ expect }) {
        const parsed = stripeProvider.parseWebhook({ body: renewalEvent('_test-evt-renewal-parse') });

        expect(parsed.category, 'A subscription_cycle invoice is a subscription event').toBe('subscription');
        expect(parsed.resourceType, 'The pipeline must re-fetch the SUBSCRIPTION, not the invoice').toBe('subscription');
        expect(parsed.resourceId, 'The subscription id comes off the invoice parent').toBe('sub_test_renewal');
        expect(parsed.uid, 'The uid comes off the subscription details').toBe('test-uid-sub-renewal');
      },
    },

    {
      name: 'maps-a-manual-invoice-as-one-time',
      auth: 'none',
      async run({ expect }) {
        // A one-off invoice carries no subscription billing_reason
        const event = {
          id: '_test-evt-renewal-manual',
          type: 'invoice.payment_succeeded',
          data: { object: { id: 'in_test_manual', billing_reason: 'manual', metadata: { uid: 'test-uid-manual' } } },
        };

        const parsed = stripeProvider.parseWebhook({ body: event });

        expect(parsed.category, 'A manual invoice is a one-time event').toBe('one-time');
        expect(parsed.resourceType, 'A one-time invoice re-fetches as an invoice').toBe('invoice');
        expect(parsed.resourceId, 'The invoice id is the resource').toBe('in_test_manual');
      },
    },

    {
      name: 'a-renewal-delivery-lands-a-pipeline-doc',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        const eventId = '_test-evt-renewal-ingest';

        const sent = await deliver(omega, renewalEvent(eventId));

        expect(sent.code, `A renewal should be accepted, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(!sent.body?.ignored, 'A renewal must not be ignored as an unsupported event type').toBeTruthy();

        const doc = await firestore.get(`payments-webhooks/${eventId}`);

        expect(doc, 'The renewal should land a pipeline doc').toBeTruthy();
        expect(doc.event.type, 'The pipeline doc should carry the renewal event type').toBe('invoice.payment_succeeded');
        expect(doc.event.category, 'The pipeline doc should be categorized as a subscription event').toBe('subscription');
        expect(doc.event.resourceId, 'The pipeline doc should point at the subscription').toBe('sub_test_renewal');
      },
    },
  ],
});
