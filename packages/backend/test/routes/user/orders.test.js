/**
 * Test: GET /user/orders — the account page's read path into payments-orders
 * ([#672](https://github.com/Omega-JS-Stack/omega/issues/672)).
 *
 * `payments-orders` is admin-only to clients and a one-time purchase writes
 * nothing to users/{uid}, so no browser could see a one-time purchase at all —
 * while the confirmation copy and the receipt email both told the customer to
 * find it in their account. This route is the way in, and it is server-side
 * through the admin SDK: the Firestore rules are untouched, so the ownership
 * filter here IS the authorization.
 *
 * Called directly against the webhook suites' in-memory Firestore stand-in (no
 * emulator): the subject is which orders come back, in what order, and how
 * little of each one does.
 *
 * Run: npx omega test backend:routes/user/orders
 */
const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/user/orders/get.js'));
const { buildAdmin } = require('../../events/payments/_webhook-harness.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const OWNER = '_test-orders-owner';
const STRANGER = '_test-orders-stranger';

const DAY = 24 * 60 * 60;

/** An order as the webhook pipeline writes it, with the noise a browser must never see */
function order(id, { owner = OWNER, type = 'one-time', ago = DAY, status = 'completed', extra = {} } = {}) {
  const createdUNIX = Math.floor(Date.now() / 1000) - ago;

  return {
    id: id,
    type: type,
    owner: owner,
    productId: 'credits-100',
    provider: 'stripe',
    resourceId: `_test-cs-${id}`,
    unified: {
      product: { id: 'credits-100', name: '100 Credits' },
      status: status,
      payment: { provider: 'stripe', orderId: id, resourceId: `_test-cs-${id}`, price: 9.99, currency: 'USD' },
    },
    // The material the summary must leave behind
    raw: { object: 'checkout.session', customer_details: { email: 'buyer@test.dev' } },
    request: { ip: '203.0.113.7', userAgent: 'Mozilla/5.0' },
    attribution: { source: 'newsletter' },
    metadata: { created: { timestamp: new Date(createdUNIX * 1000).toISOString(), timestampUNIX: createdUNIX } },
    ...extra,
  };
}

function caller(uid, { admin: isAdmin = false, authenticated = true } = {}) {
  return { authenticated, auth: { uid: uid }, roles: { admin: isAdmin } };
}

/**
 * Run the route against a seeded store
 *
 * @param {object} options
 * @param {object} options.seed - payments-orders documents by path
 * @param {object} options.user - The resolved caller
* @param {object} options.settings - The resolved request input
 * @returns {Promise<{ code: number|null, body: any, logs: string[] }>}
 */
async function callRoute({ seed, user, settings }) {
  const { admin } = buildAdmin({ seed: seed });
  const logs = [];
  const sent = { code: null, body: null };

  const ctx = {
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
    respond: (body, options) => {
      sent.body = body;
      sent.code = options?.code || 200;
      return sent;
    },
  };

  await handler({ ctx, omega: { firebase: { admin } }, user, data: settings });

  return { ...sent, logs };
}

module.exports = defineCases({
  description: 'GET /user/orders: a caller reads their own purchase history',
  type: 'group',
  timeout: 15000,

  tests: [
    {
      name: 'lists-the-callers-own-orders-newest-first',
      async run({ expect }) {
        const { code, body } = await callRoute({
          seed: {
            'payments-orders/1111-1111-1111': order('1111-1111-1111', { ago: 3 * DAY }),
            'payments-orders/2222-2222-2222': order('2222-2222-2222', { ago: 1 * DAY }),
            'payments-orders/3333-3333-3333': order('3333-3333-3333', { ago: 10 * DAY }),
          },
          user: caller(OWNER),
          settings: { uid: OWNER, limit: 25 },
        });

        expect(code, `The caller's own history is theirs to read, got ${code}: ${body}`).toBe(200);
        expect(body.orders.map((entry) => entry.id), 'Newest purchase first — the account page lists a history, not a set').toEqual(['2222-2222-2222', '1111-1111-1111', '3333-3333-3333']);
      },
    },

    {
      name: 'never-lists-somebody-elses-purchase',
      async run({ expect }) {
        const { body } = await callRoute({
          seed: {
            'payments-orders/4444-4444-4444': order('4444-4444-4444'),
            'payments-orders/5555-5555-5555': order('5555-5555-5555', { owner: STRANGER }),
          },
          user: caller(OWNER),
          settings: { uid: OWNER, limit: 25 },
        });

        expect(body.orders.map((entry) => entry.id), 'Only the caller\'s own order comes back').toEqual(['4444-4444-4444']);
      },
    },

    {
      name: 'a-non-admin-cannot-ask-about-another-account',
      async run({ expect }) {
        const { code, body } = await callRoute({
          seed: { 'payments-orders/6666-6666-6666': order('6666-6666-6666', { owner: STRANGER }) },
          user: caller(OWNER),
          settings: { uid: STRANGER, limit: 25 },
        });

        expect(code, `Reading another account's purchases is an admin act, got ${code}`).toBe(403);
        expect(`${body}`, 'And it says so').toMatch(/admin/i);
      },
    },

    {
      name: 'an-unauthenticated-caller-is-refused',
      async run({ expect }) {
        const { code } = await callRoute({
          seed: {},
          user: caller(OWNER, { authenticated: false }),
          settings: { uid: OWNER, limit: 25 },
        });

        expect(code, `A purchase history is never public, got ${code}`).toBe(401);
      },
    },

    {
      name: 'the-summary-carries-what-the-page-shows-and-nothing-else',
      async run({ expect }) {
        const { body } = await callRoute({
          seed: { 'payments-orders/7777-7777-7777': order('7777-7777-7777') },
          user: caller(OWNER),
          settings: { uid: OWNER, limit: 25 },
        });

        const entry = body.orders[0];

        expect(entry.productName, 'What was bought').toBe('100 Credits');
        expect(entry.amount, 'For how much').toBe(9.99);
        expect(entry.currency, 'In what currency').toBe('USD');
        expect(entry.status, 'And what state it is in').toBe('completed');
        expect(entry.date.timestampUNIX > 0, 'And when — the list is ordered by it').toBeTruthy();

        // The order doc carries the provider's whole raw resource, the request's
        // IP and user agent, and the attribution that sold it. None of it is the
        // browser's business.
        const serialized = JSON.stringify(entry);

        expect(entry.raw, 'The provider payload never leaves the backend').toBe(undefined);
        expect(entry.request, 'Nor the request context').toBe(undefined);
        expect(entry.attribution, 'Nor the attribution').toBe(undefined);
        expect(!serialized.includes('203.0.113.7'), `No IP rides the summary: ${serialized}`).toBeTruthy();
        expect(!serialized.includes('buyer@test.dev'), `No provider-side email either: ${serialized}`).toBeTruthy();
      },
    },

    {
      name: 'refundable-answers-what-the-refund-route-would-answer',
      async run({ expect }) {
        const { body } = await callRoute({
          seed: {
            'payments-orders/8888-0001-0001': order('8888-0001-0001'),
            'payments-orders/8888-0002-0002': order('8888-0002-0002', { status: 'refunded' }),
            'payments-orders/8888-0003-0003': order('8888-0003-0003', { ago: 300 * DAY }),
            'payments-orders/8888-0004-0004': order('8888-0004-0004', { type: 'subscription' }),
            'payments-orders/8888-0005-0005': order('8888-0005-0005', { status: 'open' }),
          },
          user: caller(OWNER),
          settings: { uid: OWNER, limit: 25 },
        });

        const refundable = Object.fromEntries(body.orders.map((entry) => [entry.id, entry.refundable]));

        expect(refundable['8888-0001-0001'], 'A recent, unrefunded one-time purchase is refundable').toBe(true);
        expect(refundable['8888-0002-0002'], 'One already refunded is not offered again').toBe(false);
        expect(refundable['8888-0003-0003'], 'Nor one past the 6-month window').toBe(false);
        expect(refundable['8888-0004-0004'], 'A subscription order refunds through the subscription lane, not this one').toBe(false);

        // A checkout that was opened and never paid keeps its provider and its
        // resourceId, so every other refusal passes it — and the button it used
        // to earn asks the provider to reverse a charge that never happened
        expect(refundable['8888-0005-0005'], 'A purchase that never completed has nothing to refund').toBe(false);
      },
    },

    {
      name: 'the-limit-cuts-the-list-at-the-newest',
      async run({ expect }) {
        const { body } = await callRoute({
          seed: {
            'payments-orders/9999-0001-0001': order('9999-0001-0001', { ago: 1 * DAY }),
            'payments-orders/9999-0002-0002': order('9999-0002-0002', { ago: 2 * DAY }),
            'payments-orders/9999-0003-0003': order('9999-0003-0003', { ago: 3 * DAY }),
          },
          user: caller(OWNER),
          settings: { uid: OWNER, limit: 2 },
        });

        expect(body.orders.map((entry) => entry.id), 'The newest two, not an arbitrary two').toEqual(['9999-0001-0001', '9999-0002-0002']);
      },
    },
  ],
});
