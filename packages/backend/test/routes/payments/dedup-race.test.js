/**
 * Test: the webhook and dispute-alert doors deduplicate ATOMICALLY
 * ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
 *
 * Both routes used to read the doc, then write it. Providers retry, and a retry
 * can arrive while the first delivery is still in flight — in that window both
 * deliveries see no doc and both write, and the pipeline runs the same event
 * twice (for a dispute, that is two refunds). Both routes now claim the doc
 * inside a transaction, so exactly one delivery wins.
 *
 * The race can only be proven by running two deliveries CONCURRENTLY, which is
 * why these ride the direct-handler harness: two handlers in one process,
 * started together, are a real same-instant pair — an HTTP pair would race the
 * network instead of the code.
 *
 * The concurrent pair runs on the WEBHOOK door only, and that is a property of
 * the emulator, not of the fix. The dispute door's own onWrite trigger fails
 * every synthetic alert (no STRIPE_SECRET_KEY, so the charge search throws), and
 * a `failed` doc is by contract RECLAIMABLE — so the losing transaction, which
 * correctly blocks and re-reads, finds a failed doc and legitimately retries.
 * That sanctioned retry is indistinguishable from the bug, so racing it would
 * assert the trigger's timing rather than the claim. The dispute door's claim is
 * the same transaction as the webhook's, and its reclaim contract is pinned
 * below; its duplicate contract is pinned in dispute-alert.test.js.
 *
 * Run: npx omega test backend:routes/payments/dedup-race
 */
const { callHandler } = require('./_route-harness.js');
const { TEST_ACCOUNTS } = require('../../../dist/test/test-accounts.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const webhookHandler = loadHandler(require.resolve('../../../dist/omega/routes/payments/webhook/post.js'));
const disputeHandler = loadHandler(require.resolve('../../../dist/omega/routes/payments/dispute-alert/post.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const VALID_KEY = () => process.env.OMEGA_WEBHOOK_KEY;

// The `test` provider fabricates Stripe-shaped events locally and signs nothing,
// so a webhook delivery here never needs a secret or the network.
function deliverWebhook(omega, eventId) {
  return callHandler({
    omega,
    handler: webhookHandler,
    functionName: 'payments-webhook',
    req: {
      query: { provider: 'test', key: VALID_KEY() },
      body: {
        id: eventId,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_test_dedup_race',
            metadata: { uid: TEST_ACCOUNTS.basic.uid },
            status: 'active',
          },
        },
      },
    },
  });
}

function deliverDisputeAlert(omega, alertId) {
  return callHandler({
    omega,
    handler: disputeHandler,
    functionName: 'payments-dispute-alert',
    req: {
      query: { key: VALID_KEY() },
      body: {
        id: alertId,
        card: '4242',
        amount: 19.99,
        transactionDate: '2026-03-07',
      },
    },
  });
}

// Exactly one of the two deliveries may be the one that processed.
function assertExactlyOneProcessed(expect, sent, label) {
  sent.forEach((response, index) => {
    expect(response.code, `${label} delivery ${index + 1} should answer 200, got ${response.code}: ${JSON.stringify(response.body)}`).toBe(200);
  });

  const processed = sent.filter((response) => !response.body?.duplicate);
  const duplicates = sent.filter((response) => response.body?.duplicate === true);

  expect(processed.length, `${label}: exactly one delivery may process, got ${processed.length}`).toBe(1);
  expect(duplicates.length, `${label}: the other delivery must be told it is a duplicate, got ${duplicates.length}`).toBe(1);
}

module.exports = defineCases({
  description: 'Payment webhook + dispute alert: same-instant deliveries deduplicate',
  type: 'group',
  timeout: 30000,

  tests: [
    {
      name: 'two-same-instant-webhook-deliveries-process-once',
      auth: 'none',
      async run({ expect, omega }) {
        const eventId = '_test-evt-dedup-race';

        const sent = await Promise.all([
          deliverWebhook(omega, eventId),
          deliverWebhook(omega, eventId),
        ]);

        assertExactlyOneProcessed(expect, sent, 'webhook');
      },
    },

    {
      name: 'a-failed-webhook-is-still-reclaimable',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        const eventId = '_test-evt-dedup-race-retry';

        // The retry path the atomic claim must preserve: a previously FAILED
        // delivery is the one existing state a new delivery may take over.
        await firestore.set(`payments-webhooks/${eventId}`, { id: eventId, status: 'failed', error: 'Previous error' });

        const sent = await deliverWebhook(omega, eventId);

        expect(sent.code, `A retry should answer 200, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(!sent.body?.duplicate, 'A failed webhook must not be reported as a duplicate').toBeTruthy();
      },
    },

    {
      // The reclaim's OTHER half, and the one nothing pinned: the claim is a full
      // `set`, not a merge, so taking over a failed doc wipes the retry ledger the
      // frequent sweep built up — `retryCount`, `deadLetter` and the previous
      // error all go. That is the documented escape hatch, ruled on #220: a
      // provider REDELIVERY is fresh evidence, so it starts a new bounded ladder
      // and a dead-lettered doc becomes processable again. Ruled, but only
      // reachable through the claim, so a future merge-instead-of-set would have
      // taken the escape hatch away silently
      // ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
      name: 'a-reclaimed-webhook-starts-a-fresh-retry-ladder',
      auth: 'none',
      async run({ expect, omega, firestore, waitFor }) {
        const eventId = '_test-evt-dedup-race-deadlettered';

        // A doc the sweep gave up on: the ceiling burned, stamped once, terminal.
        await firestore.set(`payments-webhooks/${eventId}`, {
          id: eventId,
          status: 'failed',
          error: 'Previous error',
          retryCount: 5,
          deadLetter: true,
        });

        const sent = await deliverWebhook(omega, eventId);

        expect(sent.code, `A redelivery should answer 200, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(!sent.body?.duplicate, 'A dead-lettered webhook must still be reclaimable — redelivery is the escape hatch').toBeTruthy();

        // The trigger takes it from here; either terminal state proves the claim
        // landed and the pipeline ran it again.
        const settled = await waitFor(async () => {
          const doc = await firestore.get(`payments-webhooks/${eventId}`);
          return ['completed', 'failed'].includes(doc?.status) ? doc : null;
        }, 20000, 250);

        expect(!settled.deadLetter, 'The reclaim clears the dead-letter stamp — the doc is live again').toBeTruthy();
        expect((settled.retryCount || 0) < 5, `The reclaim restarts the ladder rather than resuming a burned one, got retryCount=${settled.retryCount}`).toBeTruthy();
        expect(settled.error, 'The reclaim replaces the record wholesale — the previous failure does not survive it').not.toBe('Previous error');
      },
    },

    {
      name: 'a-failed-dispute-alert-is-still-reclaimable',
      auth: 'none',
      async run({ expect, omega, firestore }) {
        const alertId = '_test-dispute-dedup-race-retry';

        await firestore.set(`payments-disputes/${alertId}`, { id: alertId, status: 'failed', error: 'Previous error' });

        const sent = await deliverDisputeAlert(omega, alertId);

        expect(sent.code, `A retry should answer 200, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(!sent.body?.duplicate, 'A failed dispute alert must not be reported as a duplicate').toBeTruthy();
      },
    },
  ],
});
