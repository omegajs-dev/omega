/**
 * Test: the trial-lapse sweep never writes over a newer webhook
 *
 * The sweep is a BACKSTOP for a trial-end webhook that never landed — so the one
 * thing it must never do is undo a webhook that DID. Its guard re-reads the
 * subscription and compares the write stamp against the second the run took its
 * snapshot, and the Stage 1 review found two holes in that
 * ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)):
 *
 *   1. The stamp is a whole SECOND. A webhook that wrote inside the same second as
 *      the sweep's read carries an EQUAL number, and a strict `>` read equal as
 *      older — so the exact write the guard exists to protect was the one it let
 *      through.
 *   2. A bare read followed by a separate `set` leaves a window between them. A
 *      webhook landing IN that window was clobbered anyway: the guard proved
 *      freshness at a moment that had already passed.
 *
 * Plain-node control-flow test (no emulator, no network), for the same reason the
 * atomic-writes suite is one: the emulator cannot land a contending write inside
 * another client's transaction on demand. The shared in-memory stand-in models
 * Firestore's real transaction contract — versioned reads, staged writes, and a
 * re-run of the whole block when a read document changed underneath — so the retry
 * is exercised rather than assumed. The emulator suite (trial-lapse-sweep.test.js)
 * stays the integration surface for the sweep's happy paths.
 *
 * Run: npx omega test backend:events/payments/trial-lapse-sweep-staleness
 */
const expect = require('../../../dist/vendor/devkit/test/expect.js');
const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const sweep = loadHandler(require.resolve('../../../dist/omega/events/cron/daily/trial-lapse-sweep.js'));
const { isNewerThanSweep } = require('../../../dist/omega/events/cron/helpers/trial-lapse-sweep.js');
const { buildAdmin, CONFIG } = require('./_webhook-harness.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const DAY = 24 * 60 * 60;

const UID = '_test-sweep-staleness-uid';
const RESOURCE_ID = '_test-sweep-staleness-sub';

/** A `$timestamp` pair from a UNIX second */
function stamp(unix) {
  return { timestamp: new Date(unix * 1000).toISOString(), timestampUNIX: unix };
}

/**
 * A candidate the sweep will select and decide to LAPSE: its trial ended 5 days ago
 * (inside the window, past the grace), it is still active on a paid product, and the
 * provider has no record of the subscription (no payments-orders doc to answer from).
 */
function candidate(extraSubscription = {}) {
  const expiredUNIX = Math.floor(Date.now() / 1000) - 5 * DAY;

  return {
    subscription: {
      product: { id: 'premium', name: 'Premium' },
      status: 'active',
      expires: stamp(expiredUNIX),
      trial: { claimed: true, expires: stamp(expiredUNIX) },
      cancellation: { pending: false },
      payment: { provider: 'test', orderId: null, resourceId: RESOURCE_ID, frequency: 'monthly', price: 4.99 },
      ...extraSubscription,
    },
  };
}

/**
 * Run the real sweep against the in-memory stand-in
 *
 * @param {object} options
 * @param {object} options.user - The seeded users/{uid} document
 * @param {function|null} options.onRead - The contention seam
 * @returns {Promise<{ store: Map, logs: string[] }>}
 */
async function runSweep({ user, onRead = null } = {}) {
  const { admin, store } = buildAdmin({
    seed: { [`users/${UID}`]: user },
    authUids: [UID],
    onRead: onRead,
  });

  const logs = [];
  const omega = { config: CONFIG, firebase: { admin } };
  const ctx = {
    omega,
    isTesting: () => true,
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
  };

  await sweep({ omega, ctx, context: {} });

  return { store, logs };
}

module.exports = defineCases({
  description: 'Trial-lapse sweep: the staleness guard and its write are one transaction',
  type: 'group',
  timeout: 30000,

  tests: [
    {
      name: 'a-write-in-the-same-second-as-the-read-counts-as-newer',

      async run() {
        // The guard's whole predicate, at the resolution the stamps actually carry.
        // Under the strict `>` this replaced, the equal case answered false — the
        // sweep called a webhook from its own second "older" and wrote over it.
        expect(isNewerThanSweep(1000, 1000), 'a write inside the sweep read\'s own second is NEWER, not older').toBe(true);
        expect(isNewerThanSweep(1001, 1000), 'a later write is newer').toBe(true);
        expect(isNewerThanSweep(999, 1000), 'a write from before the read is genuinely older').toBe(false);
        expect(isNewerThanSweep(0, 1000), 'a subscription nobody has stamped is not newer').toBe(false);
        expect(isNewerThanSweep(undefined, 1000), 'an unstamped subscription reads as 0, not NaN').toBe(false);
      },
    },

    {
      name: 'an-uncontended-candidate-still-lapses',

      async run() {
        const { store } = await runSweep({ user: candidate() });
        const swept = store.get(`users/${UID}`);

        expect(swept.subscription.trial.outcome, 'the provider has no such subscription — the trial lapsed').toBe('lapsed');
        expect(swept.subscription.status, 'a lapsed trial ends cancelled').toBe('cancelled');
        expect(swept.subscription.product.id, 'a lapsed trial ends on basic').toBe('basic');
      },
    },

    {
      name: 'a-webhook-landing-between-the-guard-and-the-write-is-never-clobbered',

      async run() {
        // The window the transaction closes: the sweep re-reads a candidate that is
        // still a candidate, and the provider's own trial-end webhook commits before
        // the sweep's write goes out. Written THROUGH the stand-in, so the document
        // version moves and the transaction is genuinely contended.
        let contended = false;

        const { store, logs } = await runSweep({
          user: candidate(),
          onRead: (path, { write }) => {
            if (contended || path !== `users/${UID}`) {
              return;
            }

            contended = true;

            // What the webhook pipeline writes when it converts the trial itself:
            // the term moved out past the trial end, and the write is stamped.
            write(path, {
              subscription: {
                status: 'active',
                product: { id: 'premium', name: 'Premium' },
                expires: stamp(Math.floor(Date.now() / 1000) + 25 * DAY),
                payment: { updatedBy: { date: stamp(Math.floor(Date.now() / 1000) + 5) } },
              },
            }, { merge: true });
          },
        });

        const swept = store.get(`users/${UID}`);

        expect(contended, 'the contending write must actually have run — otherwise this proves nothing').toBeTruthy();
        expect(swept.subscription.status, 'the webhook\'s state survives: the subscriber is still active').toBe('active');
        expect(swept.subscription.product.id, 'the webhook\'s product survives — the sweep did not reset it to basic').toBe('premium');
        expect(swept.subscription.trial.outcome, 'and no lapse was stamped over it').toBe(undefined);
        expect(logs.some((line) => line.includes('a newer subscription write landed')), `the re-run must SAY it skipped on staleness, got: ${logs.join(' | ')}`).toBeTruthy();
      },
    },
  ],
});
