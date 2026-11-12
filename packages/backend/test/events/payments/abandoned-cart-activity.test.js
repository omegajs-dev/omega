/**
 * Test: a cart with checkout activity inside its window is not abandoned
 * ([#655](https://github.com/Omega-JS-Stack/omega/issues/655)).
 *
 * Seen in the playground logs: the sweep mailed "Complete your … checkout" at
 * 01:50:28Z, the intent POST followed at 01:52:54Z and the purchase completed at
 * 01:53:35Z. The cart's reminder clock was set ONCE, when the checkout page
 * opened, and nothing ever moved it — so a shopper still working through the
 * checkout was nudged about the cart they were paying for.
 *
 * The signal is the intent route's own: asking for a provider session is the
 * loudest "I am buying this right now" the backend ever hears, and it stamps
 * `lastActivityAt` on the cart. The sweep restarts the current reminder's clock
 * from that touch instead of mailing.
 *
 * Plain-node: the real cron against the webhook suites' in-memory Firestore
 * stand-in, with the email library RECORDED (it is an external sink).
 *
 * Run: npx omega test backend:events/payments/abandoned-cart-activity
 */
const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const sweep = loadHandler(require.resolve('../../../dist/omega/events/cron/frequent/abandoned-carts.js'));
const { REMINDER_DELAYS, COLLECTION } = require('../../../dist/omega/libraries/abandoned-cart-config.js');
const { buildAdmin, CONFIG } = require('./_webhook-harness.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const UID = '_test-abandoned-cart-activity-uid';

/** A pending cart whose first reminder is due right now */
function dueCart(extra) {
  const nowUNIX = Math.floor(Date.now() / 1000);

  return {
    id: UID,
    owner: UID,
    status: 'pending',
    productId: 'premium',
    type: 'subscription',
    frequency: 'monthly',
    reminderIndex: 0,
    nextReminderAt: nowUNIX - 5,
    ...(extra || {}),
  };
}

/**
 * Run the real sweep over one seeded cart
 *
 * @param {object} cart - The payments-carts document
 * @returns {Promise<{ store: Map, logs: string[], sent: object[] }>}
 */
async function runSweep(cart) {
  const { admin, store } = buildAdmin({
    seed: {
      [`${COLLECTION}/${UID}`]: cart,
      [`users/${UID}`]: { auth: { uid: UID, email: 'shopper@test.dev' }, subscription: { product: { id: 'basic' }, status: 'active' } },
    },
    authUids: [UID],
  });

  const logs = [];
  const sent = [];
  const omega = {
    config: { ...CONFIG, brand: { name: 'Test Brand' } },
    project: { websiteUrl: 'https://test.dev' },
    firebase: { admin },
  };
  const ctx = {
    omega,
    email: { send: async (payload) => { sent.push(payload); return { status: 'sent' }; } },
    isTesting: () => true,
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
  };

  await sweep({ omega, ctx, context: {} });

  return { store, logs, sent };
}

module.exports = defineCases({
  description: 'Abandoned-cart sweep: checkout activity inside the window defers the reminder',
  type: 'group',
  timeout: 15000,

  tests: [
    {
      name: 'a-cart-whose-checkout-just-started-is-never-mailed',
      async run({ expect }) {
        const nowUNIX = Math.floor(Date.now() / 1000);

        // The shopper asked for a session a minute ago and is at the provider's
        // page right now — which is exactly the state that got mailed.
        const { store, sent, logs } = await runSweep(dueCart({ lastActivityAt: nowUNIX - 60 }));

        expect(sent.length, `A shopper mid-checkout owes no nudge, got ${sent.length}: ${logs.join(' | ')}`).toBe(0);

        const cart = store.get(`${COLLECTION}/${UID}`);

        expect(cart.status, 'The cart is still open — deferring is not completing it').toBe('pending');
        expect(cart.reminderIndex, 'And it did not spend a reminder it never sent').toBe(0);
        expect(cart.nextReminderAt, 'The reminder clock restarts from the activity, so the same window is measured from the last touch').toBe((nowUNIX - 60) + REMINDER_DELAYS[0]);
      },
    },

    {
      name: 'a-cart-whose-activity-has-gone-quiet-is-still-mailed',
      async run({ expect }) {
        const nowUNIX = Math.floor(Date.now() / 1000);

        // A checkout started and went nowhere: past the window, this IS the
        // abandonment the sweep exists for.
        const { sent } = await runSweep(dueCart({ lastActivityAt: nowUNIX - REMINDER_DELAYS[0] - 60 }));

        expect(sent.length, `A cart quiet longer than the window is abandoned, got ${sent.length}`).toBe(1);
        expect(sent[0].data.content.event, 'And it is the abandoned-cart mail that goes out').toBe('abandoned-cart');
      },
    },

    {
      name: 'a-cart-that-never-reached-a-checkout-is-mailed-as-before',
      async run({ expect }) {
        // Every cart written before this stamp existed carries no activity at
        // all — the sweep must read that as "nothing happened", not as "just now"
        const { sent } = await runSweep(dueCart());

        expect(sent.length, `An untouched cart is the ordinary abandoned one, got ${sent.length}`).toBe(1);
      },
    },
  ],
});
