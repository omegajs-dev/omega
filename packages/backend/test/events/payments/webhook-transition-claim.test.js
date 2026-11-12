/**
 * Test: a transition is claimed per order, so concurrent webhooks dispatch it once
 *
 * Transition detection is a DIFF — the user's stored subscription against the
 * unified state the event carries — so it is only correct while one webhook is in
 * flight. Stripe sent `customer.subscription.created` and
 * `invoice.payment_succeeded` one second apart for the same checkout: both runs
 * read `users/{uid}` while it still said `basic` (the first run's write landed 11
 * seconds later), both detected `subscription/new-subscription`, and both
 * dispatched it — two order emails to one customer, two `trial_start` fires
 * ([#665](https://github.com/Omega-JS-Stack/omega/issues/665)).
 *
 * The fix is a CLAIM on the order, taken in a transaction before the dispatch:
 * `payments-orders/{orderId}.transitions.<name>`. Per order per transition NAME,
 * so the order's own later transitions — a cancellation, a plan change — still
 * fire; only a second run of the SAME transition on the SAME order is suppressed.
 *
 * Plain-node (no emulator, no network), for the reason the atomic-writes and
 * sweep-staleness suites are: the emulator cannot run two triggers for one order
 * interleaved on demand, and this bug only exists in the interleaving. The shared
 * in-memory stand-in models Firestore's real transaction contract — versioned
 * reads, staged writes, and a re-run of the whole block when a read document
 * changed underneath — so the claim is genuinely contended rather than assumed.
 *
 * A claim gates all THREE things the transition drives — the handler, the analytics
 * fire, and the marketing sync — because the live sighting duplicated all three: two
 * order emails, two `trial_start`s (GA4 counted both), two marketing syncs.
 *
 * Each is counted through the runner's own testing-mode seam: `ctx.isTesting()` is
 * true here, so the pipeline logs `… skipped (testing mode)` at exactly the point it
 * would otherwise email a real customer, post a real conversion, or write to a real
 * marketing list. Those lines ARE the three effects, counted.
 *
 * Run: npx omega test backend:events/payments/webhook-transition-claim
 */
const expect = require('../../../dist/vendor/devkit/test/expect.js');
const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const onWrite = loadHandler(require.resolve('../../../dist/omega/events/firestore/payments-webhooks/on-write.js'));
const { CLAIM_WINDOW_MS } = require('../../../dist/omega/events/firestore/payments-webhooks/transitions/index.js');
const { buildAdmin, CONFIG, subscriptionPayload } = require('./_webhook-harness.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const UID = '_test-claim-uid';
const ORDER_ID = '_test-claim-order';
const RESOURCE_ID = '_test-claim-sub';

const CREATED_EVENT = '_test-claim-subscription-created';
const INVOICE_EVENT = '_test-claim-invoice-succeeded';

const nowUNIX = () => Math.floor(Date.now() / 1000);

/** A `$timestamp` pair from a UNIX second */
function stamp(unix) {
  return { timestamp: new Date(unix * 1000).toISOString(), timestampUNIX: unix };
}

/** A brand-new subscriber, still on basic — what BOTH racing runs read */
function basicUser() {
  return {
    auth: { email: 'claim@example.com' },
    personal: { name: { first: 'Claim', last: 'Tester' } },
    subscription: { product: { id: 'basic', name: 'Basic' }, status: 'active' },
  };
}

/** An established paid subscriber, for the transition that comes AFTER the first one */
function paidUser() {
  return {
    auth: { email: 'claim@example.com' },
    personal: { name: { first: 'Claim', last: 'Tester' } },
    subscription: {
      product: { id: 'premium', name: 'Premium' },
      status: 'active',
      cancellation: { pending: false },
      payment: { provider: 'test', resourceId: RESOURCE_ID, frequency: 'monthly', price: 4.99 },
    },
  };
}

/**
 * A pending webhook doc for this order, as the webhook route writes one
 *
 * @param {string} eventId - The webhook doc id
 * @param {string} eventType - The provider's event name
 * @param {object} [overrides] - Overrides for the subscription resource it carries
 * @returns {object}
 */
function webhookDoc(eventId, eventType, overrides = {}) {
  const resource = { ...subscriptionPayload({ uid: UID, orderId: ORDER_ID, resourceId: RESOURCE_ID }), ...overrides };

  return {
    id: eventId,
    provider: 'test',
    status: 'pending',
    raw: { id: eventId, type: eventType, data: { object: resource } },
    owner: UID,
    event: { type: eventType, category: 'subscription', resourceType: 'subscription', resourceId: RESOURCE_ID, refundId: null },
    metadata: { created: { timestampUNIX: nowUNIX() } },
  };
}

/**
 * Run the real trigger over one or more webhook docs against ONE store — the whole
 * point of this suite, which `runTrigger` cannot serve: it builds a store per call,
 * and two events that never share an order can never contend for its claim.
 *
 * @param {object} options
 * @param {object[]} options.events - The pending webhook docs to process
 * @param {object} options.seed - Extra documents the run starts from
 * @param {boolean} [options.concurrent] - Process them together (the race) or one after the other
 * @param {string|function|null} [options.failPath] - The document path whose write rejects, so a
 *   run can be made to fail AFTER it claimed — the state its own retry has to get past
 * @returns {Promise<{ store: Map, logs: string[], run: function }>} `run` re-enters the trigger
 *   against this same store, which is how a retry of an event is played
 */
async function runTriggers({ events, seed = {}, concurrent = true, failPath = null }) {
  const webhooks = Object.fromEntries(events.map((event) => [`payments-webhooks/${event.id}`, event]));
  const { admin, store } = buildAdmin({ seed: { ...webhooks, ...seed }, authUids: [UID], failPath: failPath });

  const logs = [];
  const omega = { config: CONFIG, firebase: { admin }, sentry: null };
  const ctx = {
    omega,
    isTesting: () => true,
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
  };

  // The doc the trigger is handed is a point-in-time snapshot, exactly as a real
  // trigger's `change` is — it stays `pending` even after the run flips the stored doc
  const run = (event) => onWrite({
    ctx,
    change: { before: { data: () => event }, after: { data: () => event } },
    context: { params: { eventId: event.id } },
  });

  if (concurrent) {
    await Promise.all(events.map(run));
  } else {
    for (const event of events) {
      await run(event);
    }
  }

  return { store, logs, run };
}

/** How many times the pipeline reached the dispatch point for this transition */
function dispatchCount(logs, transitionName) {
  return logs.filter((line) => line.includes(`Transition handler skipped (testing mode): subscription/${transitionName}`)).length;
}

/** How many runs reached a testing-mode seam — the effect that would have gone out for real */
function seamCount(logs, seam) {
  return logs.filter((line) => line.includes(`${seam} skipped (testing mode)`)).length;
}

module.exports = defineCases({
  description: 'Payment transitions: one claim per order per transition name gates the dispatch',
  type: 'group',
  timeout: 30000,

  tests: [
    {
      name: 'two-concurrent-webhooks-for-one-order-dispatch-new-subscription-once',

      async run() {
        // The live sighting, reproduced: the subscription and the invoice event for
        // ONE checkout, in flight together, both reading a user doc that still says
        // basic. Detection is expected to fire twice — that is not the bug and is
        // not what this fixes. Exactly one of them may ACT on it.
        const { store, logs } = await runTriggers({
          events: [
            webhookDoc(CREATED_EVENT, 'customer.subscription.created'),
            webhookDoc(INVOICE_EVENT, 'invoice.payment_succeeded'),
          ],
          seed: { [`users/${UID}`]: basicUser() },
        });

        const detected = logs.filter((line) => line.includes('Transition detected: subscription/new-subscription'));
        expect(detected.length, `both runs must detect the transition — otherwise they never raced, got: ${logs.join(' | ')}`).toBe(2);

        expect(dispatchCount(logs, 'new-subscription'), `exactly one run may dispatch new-subscription, got: ${logs.join(' | ')}`).toBe(1);

        // The other two effects of the same transition, which the live sighting
        // duplicated alongside the email: one conversion (GA4 deduplicates neither a
        // custom `trial_start` nor a second event id) and one marketing sync.
        expect(seamCount(logs, 'Payment analytics'), `exactly one run may fire payment analytics, got: ${logs.join(' | ')}`).toBe(1);
        expect(seamCount(logs, 'Marketing sync'), `exactly one run may sync the marketing contact, got: ${logs.join(' | ')}`).toBe(1);
        expect(logs.some((line) => line.includes('Payment analytics suppressed (claimed by')), `the loser says why it tracked nothing, got: ${logs.join(' | ')}`).toBeTruthy();
        expect(logs.some((line) => line.includes('Marketing sync suppressed (claimed by')), `and why it synced nothing, got: ${logs.join(' | ')}`).toBeTruthy();

        const claim = store.get(`payments-orders/${ORDER_ID}`).transitions['new-subscription'];
        expect([CREATED_EVENT, INVOICE_EVENT].includes(claim.eventId), 'the claim names the event that won it').toBeTruthy();
        expect(claim.timestampUNIX > 0, 'the claim is stamped').toBeTruthy();

        const suppressed = logs.filter((line) => line.includes('Transition suppressed (claimed by'));
        expect(suppressed.length, `the loser says so, once, got: ${logs.join(' | ')}`).toBe(1);
        expect(suppressed[0].includes(`Transition suppressed (claimed by ${claim.eventId}): subscription/new-subscription on payments-orders/${ORDER_ID}`), `the suppression names the winner and the order, got: ${suppressed[0]}`).toBeTruthy();

        // Everything the claim does NOT change: both events are still acknowledged
        // (a provider must stop redelivering them), both still record what they saw,
        // and the subscriber is on the plan they paid for.
        expect(store.get(`payments-webhooks/${CREATED_EVENT}`).status, 'the first event completes').toBe('completed');
        expect(store.get(`payments-webhooks/${INVOICE_EVENT}`).status, 'the second event completes too — suppression is not a failure').toBe('completed');
        expect(store.get(`users/${UID}`).subscription.product.id, 'the subscriber is on the plan they bought').toBe('premium');
        expect(store.get(`payments-orders/${ORDER_ID}`).requests, 'the order still gets its requests node — the claim writes the order doc first, so a bare existence test would have skipped it').toEqual({ cancellation: null, refund: null });
      },
    },

    {
      name: 'a-claim-already-on-the-order-suppresses-a-later-detection',

      async run() {
        // The claim is durable, not just a tiebreaker for one instant: a redelivery
        // that re-detects new-subscription (the user doc write never landed, so the
        // diff still reads basic → premium) finds the claim and stays quiet. Taken a
        // minute ago and still running, so it is well inside the claim window.
        const claimedUNIX = nowUNIX() - 60;

        const { store, logs } = await runTriggers({
          events: [webhookDoc(INVOICE_EVENT, 'invoice.payment_succeeded')],
          seed: {
            [`users/${UID}`]: basicUser(),
            [`payments-orders/${ORDER_ID}`]: {
              id: ORDER_ID,
              type: 'subscription',
              owner: UID,
              resourceId: RESOURCE_ID,
              transitions: { 'new-subscription': { eventId: CREATED_EVENT, status: 'claimed', ...stamp(claimedUNIX) } },
              metadata: { created: stamp(claimedUNIX), updated: stamp(claimedUNIX) },
            },
          },
        });

        expect(dispatchCount(logs, 'new-subscription'), `nothing may dispatch against a claim, got: ${logs.join(' | ')}`).toBe(0);
        expect(seamCount(logs, 'Payment analytics'), `nor track against one, got: ${logs.join(' | ')}`).toBe(0);
        expect(seamCount(logs, 'Marketing sync'), `nor sync against one, got: ${logs.join(' | ')}`).toBe(0);
        expect(logs.some((line) => line.includes(`Transition suppressed (claimed by ${CREATED_EVENT})`)), `the skip names the event holding the claim, got: ${logs.join(' | ')}`).toBeTruthy();
        expect(store.get(`payments-orders/${ORDER_ID}`).transitions['new-subscription'].eventId, 'the standing claim is left exactly as it was — a loser never overwrites the winner').toBe(CREATED_EVENT);
      },
    },

    {
      name: 'a-different-transition-on-the-same-order-still-fires',

      async run() {
        // The claim is per NAME, not per order. The same subscription's later life —
        // a cancellation here — has its own transition to send, and a spent
        // new-subscription claim must not swallow it.
        const claimedUNIX = nowUNIX() - 3600;

        const { store, logs } = await runTriggers({
          events: [webhookDoc('_test-claim-subscription-deleted', 'customer.subscription.deleted', { status: 'canceled' })],
          seed: {
            [`users/${UID}`]: paidUser(),
            [`payments-orders/${ORDER_ID}`]: {
              id: ORDER_ID,
              type: 'subscription',
              owner: UID,
              resourceId: RESOURCE_ID,
              requests: { cancellation: null, refund: null },
              transitions: { 'new-subscription': { eventId: CREATED_EVENT, ...stamp(claimedUNIX) } },
              metadata: { created: stamp(claimedUNIX), updated: stamp(claimedUNIX) },
            },
          },
        });

        expect(dispatchCount(logs, 'subscription-cancelled'), `the cancellation dispatches on its own name, got: ${logs.join(' | ')}`).toBe(1);
        expect(seamCount(logs, 'Payment analytics'), `and tracks, got: ${logs.join(' | ')}`).toBe(1);
        expect(seamCount(logs, 'Marketing sync'), `and syncs — a spent claim gates only its own name, got: ${logs.join(' | ')}`).toBe(1);

        const claims = store.get(`payments-orders/${ORDER_ID}`).transitions;
        expect(claims['subscription-cancelled'].eventId, 'the cancellation takes its own claim').toBe('_test-claim-subscription-deleted');
        expect(claims['new-subscription'].eventId, 'and the earlier claim stands beside it').toBe(CREATED_EVENT);
      },
    },

    {
      name: 'a-claim-older-than-the-window-is-a-spent-one-and-the-transition-repeats',

      async run() {
        // The order id is stable for the subscription's LIFE, so every transition
        // that can happen twice re-detects a name the order already carries: a
        // second dunning cycle's payment-failed, a re-cancellation after an
        // uncancel, a second plan change. Keyed on order + name alone, the first
        // claim swallowed all of them — no dunning email, no analytics, no sync,
        // for as long as the subscription lasted. The claim only speaks for its
        // window; the race it settles is seconds wide.
        const spentUNIX = nowUNIX() - (30 * 86400);

        const { store, logs } = await runTriggers({
          events: [webhookDoc('_test-claim-invoice-failed-2', 'invoice.payment_failed')],
          seed: {
            [`users/${UID}`]: paidUser(),
            [`payments-orders/${ORDER_ID}`]: {
              id: ORDER_ID,
              type: 'subscription',
              owner: UID,
              resourceId: RESOURCE_ID,
              requests: { cancellation: null, refund: null },
              // What the FIRST dunning cycle left behind a month ago, finished
              transitions: { 'payment-failed': { eventId: '_test-claim-invoice-failed-1', status: 'done', ...stamp(spentUNIX) } },
              metadata: { created: stamp(spentUNIX), updated: stamp(spentUNIX) },
            },
          },
        });

        expect(dispatchCount(logs, 'payment-failed'), `the second dunning cycle dispatches, got: ${logs.join(' | ')}`).toBe(1);
        expect(seamCount(logs, 'Payment analytics'), `and tracks, got: ${logs.join(' | ')}`).toBe(1);
        expect(seamCount(logs, 'Marketing sync'), `and syncs, got: ${logs.join(' | ')}`).toBe(1);

        const claim = store.get(`payments-orders/${ORDER_ID}`).transitions['payment-failed'];
        expect(claim.eventId, 'the spent claim is retaken by the event that repeated the transition').toBe('_test-claim-invoice-failed-2');
        expect(claim.status, 'and settles like any other').toBe('done');
        expect(claim.timestampUNIX > spentUNIX, 'restamped, so it speaks for its own window and no longer for the first cycle').toBeTruthy();
        expect(CLAIM_WINDOW_MS < 30 * 86400 * 1000, 'the fixture has to be older than the window it is testing').toBeTruthy();
      },
    },

    {
      name: 'a-run-that-failed-after-claiming-is-not-refused-by-its-own-claim',

      async run() {
        // A claim can outlive the run that took it: the winner claims, then its state
        // write fails. The webhook doc goes `failed` and the frequent cron re-runs
        // THAT SAME event id (events/cron/frequent/retry-failed-webhooks.js) — and a
        // claim carrying no outcome refused the retry forever, so the customer who
        // paid got no order email, no conversion, no marketing sync, and no
        // subscription. `failed` is the one reclaimable state, exactly as it is for
        // the webhook doc itself and for a dispute alert.
        const faulty = { writes: true };

        const { store, logs, run } = await runTriggers({
          events: [webhookDoc(CREATED_EVENT, 'customer.subscription.created')],
          seed: { [`users/${UID}`]: basicUser() },
          // The batch — everything the run writes AFTER it claimed
          failPath: (path) => faulty.writes && path === `users/${UID}`,
        });

        expect(store.get(`payments-webhooks/${CREATED_EVENT}`).status, 'the run failed after it claimed').toBe('failed');
        expect(store.get(`users/${UID}`).subscription.product.id, 'and wrote no subscription — that is what the retry is for').toBe('basic');

        const claim = store.get(`payments-orders/${ORDER_ID}`).transitions['new-subscription'];
        expect(claim.status, 'the claim records how the run ended, so a retry can tell abandoned from finished').toBe('failed');
        expect(claim.eventId, 'and still names the event that took it').toBe(CREATED_EVENT);

        // The sweep flips the failed doc back to pending, and the trigger sees the
        // same event id a second time — with the fault cleared.
        faulty.writes = false;
        const mark = logs.length;
        await run(webhookDoc(CREATED_EVENT, 'customer.subscription.created'));
        const retryLogs = logs.slice(mark);

        expect(dispatchCount(retryLogs, 'new-subscription'), `the retry reclaims and dispatches once, got: ${retryLogs.join(' | ')}`).toBe(1);
        expect(seamCount(retryLogs, 'Payment analytics'), `and tracks once, got: ${retryLogs.join(' | ')}`).toBe(1);
        expect(seamCount(retryLogs, 'Marketing sync'), `and syncs once, got: ${retryLogs.join(' | ')}`).toBe(1);

        expect(store.get(`users/${UID}`).subscription.product.id, 'the subscriber ends up on the plan they paid for').toBe('premium');
        expect(store.get(`payments-webhooks/${CREATED_EVENT}`).status, 'and the event completes').toBe('completed');
        expect(store.get(`payments-orders/${ORDER_ID}`).transitions['new-subscription'].status, 'the claim that finished says so — a third run finds it spent, not retakeable').toBe('done');
      },
    },
  ],
});
