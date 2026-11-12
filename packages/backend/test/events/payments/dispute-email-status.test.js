/**
 * Test: dispute alert email outcome
 *
 * The dispute doc's actions.email is an operator's record of whether the brand was
 * told about a chargeback. It used to be written 'success' unconditionally while the
 * send was fire-and-forget — including when the send never happened at all, because
 * the brand has no contact email configured.
 *
 * sendDisputeEmail() now resolves the outcome the caller records. This proves the
 * skipped outcome, which is the one a config gap produces (an actual send needs
 * TEST_EXTENDED_MODE and a real provider, so the delivered outcomes are not
 * exercised here).
 */
const { sendDisputeEmail } = require('../../../dist/omega/events/firestore/payments-disputes/send-dispute-email.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const ALERT = {
  provider: 'stripe',
  alertType: 'chargeback',
  amount: '9.99',
  card: { last4: '4242', brand: 'visa' },
  transactionDate: '2026-01-15',
  reasonCode: 'fraudulent',
  customerEmail: '_test.dispute@test.com',
  isRefunded: false,
};

module.exports = defineCases({
  description: 'Dispute alert email outcome reporting',
  type: 'group',
  timeout: 30000,

  tests: [
    {
      name: 'reports-skipped-without-a-brand-contact-email',
      async run({ ctx, omega, expect }) {
        // The real config, with the real gap the brand would have. Restored below —
        // nothing else in the run may see a brand without a contact email.
        const contact = omega.config.brand?.contact || {};
        const original = contact.email;
        delete contact.email;

        try {
          const status = await sendDisputeEmail({ alert: ALERT, match: null, result: null, alertId: '_test-dispute-email-status', ctx });

          expect(status, 'A send that never happened must report skipped, never success').toBe('skipped');
        } finally {
          if (original !== undefined) {
            contact.email = original;
          }
        }
      },
    },
  ],
});
