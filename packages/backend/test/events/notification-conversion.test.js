/**
 * Test: the notification subscribe/unsubscribe events are CANONICAL conversions
 * ([#328](https://github.com/Omega-JS-Stack/omega/issues/328)).
 *
 * The handler used to reach `Analytics(...).event()` directly with
 * hyphenated names of its own invention — `notification-subscribe` and
 * `notification-unsubscribe`, which appear in no catalog and therefore in no
 * other surface's vocabulary. Both now go through `deliverConversion`, which is
 * what gives them the three things the raw call had none of: the catalog's
 * name, the consent gate, and the per-provider walk (GA4 only, by catalog
 * design — no ad platform maps a push subscription).
 *
 * THE DEDUPE ID IS `<event>.<token>`. The doc id IS the push token, and it is
 * the only stable key this doc has: `owner` is null on an anonymous subscribe,
 * so a uid-derived id would collapse every anonymous device onto one id.
 *
 * Real handler, real omega, real ctx, real Firestore counter write. The
 * `change` pair is built by hand — the trigger's own shape — so no notification
 * doc has to exist for the branch under test.
 *
 * Run: npx omega test framework:events/notification-conversion
 */
const { loadHandler } = require('../../dist/omega/libraries/load-handler.js');
const onWrite = loadHandler(require.resolve('../../dist/omega/events/firestore/notifications/on-write.js'));
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');
const Context = require('../../dist/omega/context.js');

const TOKEN = '_test-notification-conversion-token';

const EVENT_CONTEXT = {
  resource: { service: 'firestore.googleapis.com' },
  params: { token: TOKEN },
};

// A subscription doc in the shape the client writes it.
function subscriptionDoc({ owner = null, attribution } = {}) {
  return {
    token: TOKEN,
    owner: owner,
    tags: ['general'],
    attribution: attribution,
    context: { client: {} },
  };
}

/** The Change pair the Firestore trigger hands the handler. */
function change({ before, after }) {
  return {
    before: { data: () => before },
    after: { data: () => after },
  };
}

// Record every console call the handler makes, restoring console afterward.
async function withConsoleRecorder(fn) {
  const calls = { log: [], debug: [], error: [] };
  const original = { log: console.log, debug: console.debug, error: console.error };

  console.log = (...args) => calls.log.push(args);
  console.debug = (...args) => calls.debug.push(args);
  console.error = (...args) => calls.error.push(args);

  try {
    await fn();
    return calls;
  } finally {
    console.log = original.log;
    console.debug = original.debug;
    console.error = original.error;
  }
}

/** Run the real handler for one change pair; hand back its delivery lines. */
async function runHandler({ omega, before, after }) {
  const ctx = new Context(omega, {}, { functionName: 'omega_notificationsOnWrite' });
  const admin = omega.firebase.admin;

  const calls = await withConsoleRecorder(async () => {
    await onWrite({
      omega: omega,
      ctx: ctx,
      change: change({ before: before, after: after }),
      context: EVENT_CONTEXT,
    });
  });

  const delivery = calls.log
    .map((args) => String(args[1]))
    .filter((line) => line.startsWith('deliverConversion: '));

  return { calls: calls, delivery: delivery };
}

module.exports = defineCases({
  description: 'notifications:on-write fires canonical notification conversions',
  type: 'group',
  timeout: 30000,

  tests: [
    {
      name: 'a-new-subscription-fires-the-canonical-notification-subscribe',
      async run({ expect, omega }) {
        const { delivery } = await runHandler({
          omega: omega,
          before: undefined,
          after: subscriptionDoc({ owner: '_test-notification-owner' }),
        });

        expect(delivery.length, `expected one conversion delivery, got ${delivery.length}: ${delivery.join(' | ')}`).toBe(1);
        expect(delivery[0].startsWith('deliverConversion: notification_subscribe →'), `the canonical catalog name, not the hyphenated invention: ${delivery[0]}`).toBe(true);
        expect(delivery[0].includes(`(event_id=notification_subscribe.${TOKEN})`), `the token is the stable per-doc key: ${delivery[0]}`).toBe(true);

        // GA4 only — no ad platform maps a push subscription, and an unmapped
        // provider is a decision the catalog makes, not an event to invent.
        for (const provider of ['meta', 'tiktok']) {
          expect(delivery[0].includes(`${provider} skipped (no mapping)`), `${provider} has no mapping for this event: ${delivery[0]}`).toBe(true);
        }
      },
    },

    {
      name: 'a-deleted-subscription-fires-the-canonical-notification-unsubscribe',
      async run({ expect, omega }) {
        const { delivery } = await runHandler({
          omega: omega,
          before: subscriptionDoc({ owner: '_test-notification-owner' }),
          after: undefined,
        });

        expect(delivery.length, `expected one conversion delivery, got ${delivery.length}: ${delivery.join(' | ')}`).toBe(1);
        expect(delivery[0].startsWith('deliverConversion: notification_unsubscribe →'), `the canonical catalog name: ${delivery[0]}`).toBe(true);
        expect(delivery[0].includes(`(event_id=notification_unsubscribe.${TOKEN})`), `the token keys the unsubscribe too: ${delivery[0]}`).toBe(true);
      },
    },

    {
      name: 'an-update-fires-nothing',
      async run({ expect, omega }) {
        // Re-tagging a device is not a subscription event. The handler returns
        // at its update branch, before any tracking.
        const { delivery } = await runHandler({
          omega: omega,
          before: subscriptionDoc(),
          after: subscriptionDoc({ owner: '_test-notification-owner' }),
        });

        expect(delivery.length, `an update must fire no conversion: ${delivery.join(' | ')}`).toBe(0);
      },
    },

    {
      name: 'an-anonymous-subscribe-still-fires-and-still-keys-on-the-token',
      async run({ expect, omega }) {
        // `owner: null` is the anonymous-subscribe shape the rules explicitly
        // allow. There is no uid to key on and no identity to match — which is
        // exactly why the doc id is the id.
        const { delivery } = await runHandler({
          omega: omega,
          before: undefined,
          after: subscriptionDoc({ owner: null }),
        });

        expect(delivery.length, `an anonymous device is still a subscription: ${delivery.join(' | ')}`).toBe(1);
        expect(delivery[0].includes(`(event_id=notification_subscribe.${TOKEN})`), delivery[0]).toBe(true);
      },
    },

    {
      name: 'a-declined-analytics-snapshot-blocks-the-fire',
      async run({ expect, omega }) {
        // The gate is the whole point of routing through deliverConversion: a
        // raw analytics call asked nobody anything.
        const doc = subscriptionDoc({ owner: '_test-notification-owner' });
        doc.trackingConsent = { analytics: false, marketing: false, region: 'opt-in', version: 1 };

        const { delivery } = await runHandler({ omega: omega, before: undefined, after: doc });

        expect(delivery.length, delivery.join(' | ')).toBe(1);
        expect(delivery[0].includes('google skipped (consent: analytics)'), `an opted-out device reaches no platform: ${delivery[0]}`).toBe(true);
      },
    },
  ],
});
