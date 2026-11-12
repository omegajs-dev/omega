/**
 * Test: POST /payments/winback — the cancel-flow save offer's apply path
 * ([#268](https://github.com/Omega-JS-Stack/omega/issues/268)).
 *
 * The offer is pitched before the cancellation questionnaire and accepting it
 * discounts the next cycle instead of ending the subscription. What that offer
 * IS belongs to the brand (`payment.winback`, resolved by @omega.js/config with a
 * 50%-off default), so this suite reads the brand's own resolution rather than
 * asserting a number.
 *
 * Two layers, the same split cancel.test.js and plan.test.js use:
 *  - the wire guards and the happy path over `http.as(...)`, which is what
 *    proves the route is registered, auth-gated and schema-validated at all;
 *  - the per-subscription guards and the provider capability gate through
 *    DIRECT handler calls (the _route-harness technique), so one test can choose
 *    a provider and a subscription shape without minting a persona each.
 *
 * The offer is claimed ONCE: the claim lives on
 * payments-orders/{orderId}.requests.winback, so the second call is refused
 * against the same document the first one wrote.
 *
 * EVERY refusal carries a branchable code on `omega-properties`
 * ([#311](https://github.com/Omega-JS-Stack/omega/issues/311)): the client
 * pitches the offer off the account alone, so any refusal it cannot name leaves
 * the customer in a dialog arming a retry that can never succeed. Each guard
 * below asserts its own code for that reason.
 *
 * Run: npx omega test framework:routes/payments/winback
 */
const { buildUser, recordingResponse } = require('./_route-harness.js');
const winback = require('../../../dist/omega/libraries/payment/winback.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/winback/post.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');
const { User } = require('../../../dist/omega/helpers/account.js');
const Context = require('../../../dist/omega/context.js');

function providerModule(name) {
  return require(`../../../dist/omega/routes/payments/winback/providers/${name}.js`);
}

const YEAR = 365 * 24 * 60 * 60;

/**
 * A paying subscriber the offer can be made to.
 *
 * @param {object} omega - The Omega instance
 * @param {object} options - uid, product, provider, resourceId, and the state overrides
 */
function subscriber(omega, { uid, product, provider, resourceId, orderId, pending, trial, status }) {
  const lastYearUNIX = Math.floor(Date.now() / 1000) - YEAR;
  const nextMonthUNIX = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);

  return buildUser({
    auth: { uid: uid, email: `${uid}@example.com` },
    roles: {},
    subscription: {
      product: { id: product.id, name: product.name || product.id },
      status: status === undefined ? 'active' : status,
      cancellation: { pending: pending === true },
      expires: trial
        ? { timestamp: new Date(nextMonthUNIX * 1000).toISOString(), timestampUNIX: nextMonthUNIX }
        : { timestamp: new Date(nextMonthUNIX * 1000).toISOString(), timestampUNIX: nextMonthUNIX },
      ...(trial
        ? { trial: { claimed: true, expires: { timestamp: new Date(nextMonthUNIX * 1000).toISOString(), timestampUNIX: nextMonthUNIX } } }
        : {}),
      payment: {
        provider: provider === undefined ? 'test' : provider,
        resourceId: resourceId === undefined ? 'sub_test_winback_guard' : resourceId,
        orderId: orderId === undefined ? null : orderId,
        frequency: 'monthly',
        startDate: { timestamp: new Date(lastYearUNIX * 1000).toISOString(), timestampUNIX: lastYearUNIX },
      },
    },
  });
}

/**
 * A direct call with the `omega-properties` header captured — the
 * branchable half of a 4xx rides that header, so a test asserting a CODE reads
 * it (plan.test.js's technique, for the same gate).
 *
 * @returns {Promise<{ sent: object, properties: object|null }>}
 */
async function acceptOfferReadingProperties(omega, user, settings) {
  const res = recordingResponse();
  const headers = {};

  res.header = (key, value) => {
    headers[key] = value;
    return res;
  };
  res.get = (key) => headers[key];

  const req = { method: 'POST', headers: { 'content-type': 'application/json' }, query: {}, body: {} };
  const ctx = new Context(omega, { req, res }, { functionName: 'payments-winback' });

  await handler({ ctx, omega, user, data: { confirmed: true, ...(settings || {}) } });

  return {
    sent: res.sent,
    properties: headers['omega-properties'] ? JSON.parse(headers['omega-properties']) : null,
  };
}

/** Run the thunk with the brand's save offer replaced, restoring it after. */
async function withOffer(omega, winbackConfig, fn) {
  const payment = omega.config.payment;
  const original = payment.winback;

  if (winbackConfig === null) delete payment.winback;
  else payment.winback = winbackConfig;

  try {
    return await fn();
  } finally {
    if (original === undefined) delete payment.winback;
    else payment.winback = original;
  }
}

// The paid subscription product the offer is made against.
function paidProduct(config, skip) {
  const paid = (config.payment?.products || []).find((p) => p.id !== 'basic' && p.type === 'subscription' && p.prices?.monthly);

  if (!paid) {
    skip('No paid subscription product with a monthly price configured in this brand');
  }

  return paid;
}

module.exports = defineCases({
  description: 'Payment winback endpoint: the save offer apply path',
  type: 'group',
  timeout: 30000,

  tests: [
    // ─── the wire guards ───

    {
      name: 'rejects-unauthenticated',
      async run({ http, expect }) {
        const response = await http.as('none').post('omega/payments/winback', {
          confirmed: true,
        });

        expect(response, 'Should reject unauthenticated request').toBeError(401);
      },
    },

    {
      name: 'rejects-missing-confirmed',
      async run({ http, expect }) {
        const response = await http.as('basic').post('omega/payments/winback', {});

        expect(response, 'Should reject a request that confirms nothing').toBeError(400);
      },
    },

    {
      name: 'rejects-basic-user',
      async run({ http, expect }) {
        const response = await http.as('basic').post('omega/payments/winback', {
          confirmed: true,
        });

        expect(response, 'Should reject a user with no paid subscription to keep').toBeError(400);
      },
    },

    // ─── the offer itself ───

    {
      name: 'resolves-the-brand-offer-with-the-framework-default',
      async run({ omega, expect }) {
        // The 50% default has ONE home (@omega.js/config). A brand that
        // configures nothing still has an offer, and it is that one.
        await withOffer(omega, null, async () => {
          const offer = winback.resolveOffer(omega.config);

          expect(offer.enabled, 'the offer is on by default').toBe(true);
          expect(offer.percent, 'and it is 50% off').toBe(50);
          expect(offer.duration, 'for one cycle').toBe('once');

          const discount = winback.toDiscount(offer);

          expect(discount.valid, 'it hands downstream a validate()-shaped discount').toBe(true);
          expect(discount.code, 'named for what it is').toBe('WINBACK50');
          expect(discount.amount, 'a percent offer declares no amount at all').toBe(undefined);
        });
      },
    },

    {
      name: 'refuses-when-the-brand-disabled-the-offer',
      async run({ omega, expect, config, skip }) {
        const product = paidProduct(config, skip);

        await withOffer(omega, { enabled: false }, async () => {
          const user = subscriber(omega, { uid: '_test-winback-disabled', product });
          const { sent, properties } = await acceptOfferReadingProperties(omega, user);

          expect(sent.code, 'Should refuse an offer the brand turned off').toBe(400);
          expect(properties?.additional?.code, 'the refusal carries a code the billing card can branch on').toBe('offer-disabled');
        });
      },
    },

    {
      name: 'refuses-an-unconfirmed-request',
      async run({ omega, expect, config, skip }) {
        const product = paidProduct(config, skip);
        const user = subscriber(omega, { uid: '_test-winback-unconfirmed', product });
        const { sent, properties } = await acceptOfferReadingProperties(omega, user, { confirmed: false });

        expect(sent.code, 'Should refuse a request that confirms nothing').toBe(400);
        expect(properties?.additional?.code, 'and says which refusal it was — the ONE code a retry can actually fix').toBe('confirmation-required');
      },
    },

    // ─── the per-subscription guards ───

    {
      name: 'refuses-a-trial',
      async run({ omega, expect, config, skip }) {
        // A trial cancel ends access immediately (#267) and nothing has been
        // paid, so there is no next cycle to discount. The billing card gates
        // the same way, off the same rule.
        const product = paidProduct(config, skip);
        const user = subscriber(omega, { uid: '_test-winback-trial', product, trial: true });

        const { sent, properties } = await acceptOfferReadingProperties(omega, user);

        expect(sent.code, 'Should refuse a subscription still inside its free trial').toBe(400);
        expect(properties?.additional?.code, 'the refusal carries a code the billing card can branch on').toBe('trial-not-eligible');
      },
    },

    {
      name: 'refuses-a-scheduled-cancellation',
      async run({ omega, expect, config, skip }) {
        const product = paidProduct(config, skip);
        const user = subscriber(omega, { uid: '_test-winback-pending', product, pending: true });

        const { sent, properties } = await acceptOfferReadingProperties(omega, user);

        expect(sent.code, 'Should refuse when the cancellation is already scheduled').toBe(400);
        expect(properties?.additional?.code, 'the refusal carries the same code the plan switch refuses that state with').toBe('cancellation-pending');
      },
    },

    {
      name: 'refuses-a-suspended-subscription',
      async run({ omega, expect, config, skip }) {
        const product = paidProduct(config, skip);
        const user = subscriber(omega, { uid: '_test-winback-suspended', product, status: 'suspended' });

        const { sent, properties } = await acceptOfferReadingProperties(omega, user);

        expect(sent.code, 'Should refuse a subscription that is not active').toBe(400);
        expect(properties?.additional?.code, 'the refusal carries a code the billing card can branch on').toBe('no-active-subscription');
      },
    },

    {
      name: 'refuses-missing-payment-details',
      async run({ omega, expect, config, skip }) {
        // An ADMIN-GRANTED or imported subscription is paid and active with no
        // provider details on it at all, and the client pitches what it can
        // read — so this refusal needs a code as much as the capability gate
        // does ([#311]): without one, accepting shows an error toast and leaves
        // the dialog armed for a retry that can never succeed. HALF the details
        // is the same dead end, so each half is proven on its own.
        const product = paidProduct(config, skip);
        const halves = [
          { what: 'provider', provider: null, resourceId: 'sub_test_winback_guard' },
          { what: 'resourceId', provider: 'test', resourceId: null },
          { what: 'both', provider: null, resourceId: null },
        ];

        for (const { what, provider, resourceId } of halves) {
          const user = subscriber(omega, { uid: `_test-winback-no-${what}`, product, provider, resourceId });
          const { sent, properties } = await acceptOfferReadingProperties(omega, user);

          expect(sent.code, `missing ${what}: Should refuse a subscription the route cannot reach a provider with`).toBe(400);
          expect(properties?.additional?.code, `missing ${what}: the refusal carries a code the billing card can branch on`).toBe('missing-payment-details');
        }
      },
    },

    {
      name: 'refuses-an-unknown-provider',
      async run({ omega, expect, config, skip }) {
        const product = paidProduct(config, skip);
        const user = subscriber(omega, { uid: '_test-winback-unknown', product, provider: 'not-a-provider' });

        const { sent, properties } = await acceptOfferReadingProperties(omega, user);

        expect(sent.code, 'Should refuse a provider that does not exist').toBe(400);
        expect(properties?.additional?.code, 'the refusal carries a code the billing card can branch on').toBe('unknown-provider');
      },
    },

    {
      name: 'refuses-when-the-claim-has-nowhere-to-be-recorded',
      async run({ omega, expect, config, skip }) {
        // "Claimed once" is only true while there is a document to record the
        // claim on. A subscription carrying no orderId (dashboard-created,
        // imported, a metadata backfill that never landed) has none, so the
        // offer is refused BEFORE dispatch rather than becoming takeable on
        // every cancel dialog — each accept re-couponing the subscription.
        const product = paidProduct(config, skip);
        const user = subscriber(omega, { uid: '_test-winback-no-order', product });
        const provider = providerModule('test');
        const applied = [];
        const realApplyOffer = provider.applyOffer;

        provider.applyOffer = async (options) => applied.push(options);

        try {
          const { sent, properties } = await acceptOfferReadingProperties(omega, user);

          expect(sent.code, 'Should refuse an offer whose claim cannot be recorded').toBe(400);
          expect(properties?.additional?.code, 'the refusal carries a code the billing card can branch on').toBe('offer-not-claimable');
          expect(applied.length, 'and nothing reached the provider').toBe(0);
        } finally {
          provider.applyOffer = realApplyOffer;
        }
      },
    },

    {
      name: 'refuses-a-second-claim-with-a-branchable-code',
      async run({ omega, expect, config, firestore, skip }) {
        // The offer is claimed ONCE, and a past claimant who opens the cancel
        // dialog again is pitched it anyway — the client reads the account, not
        // the order doc. So the refusal carries a code the billing card can
        // branch on ([#310]): without one, accepting shows an error toast and
        // leaves the dialog armed for a retry that can never succeed.
        const product = paidProduct(config, skip);
        const orderId = '_test-winback-claimed-order';
        const user = subscriber(omega, { uid: '_test-winback-claimed', product, orderId });
        const provider = providerModule('test');
        const applied = [];
        const realApplyOffer = provider.applyOffer;

        // The first claim, written where the route records it
        await firestore.set(`payments-orders/${orderId}`, {
          requests: {
            winback: {
              discount: winback.toDiscount(winback.resolveOffer(omega.config)),
              date: { timestamp: new Date().toISOString(), timestampUNIX: Math.floor(Date.now() / 1000) },
            },
          },
        }, { merge: true });

        provider.applyOffer = async (options) => applied.push(options);

        try {
          const { sent, properties } = await acceptOfferReadingProperties(omega, user);

          expect(sent.code, 'Should refuse an offer this subscription already took').toBe(400);
          expect(properties?.additional?.code, 'the refusal carries a code the billing card can branch on').toBe('offer-already-claimed');
          expect(applied.length, 'and the provider is never asked to discount twice').toBe(0);
        } finally {
          provider.applyOffer = realApplyOffer;
          await firestore.delete(`payments-orders/${orderId}`);
        }
      },
    },

    // ─── the claim on the account ───

    {
      name: 'records-the-applied-discount-on-the-account',
      async run({ omega, expect, config, firestore, skip }) {
        // The order doc is the offer's MEMORY — what a second claim is refused
        // against — but the billing card reads the ACCOUNT, and a saving that
        // vanishes on reload was never announced at all ([#325]). So the claim
        // lands on both, and the account's copy has to survive the SAME resolver
        // the client reads it through (which strips every key the schema does
        // not name).
        const product = paidProduct(config, skip);
        const uid = '_test-winback-account';
        const orderId = '_test-winback-account-order';
        const user = subscriber(omega, { uid, product, orderId });
        const provider = providerModule('test');
        const realApplyOffer = provider.applyOffer;
        const applied = [];

        provider.applyOffer = async (options) => applied.push(options);

        try {
          const { sent } = await acceptOfferReadingProperties(omega, user);

          expect(sent.code, 'Should apply the save offer').toBe(200);
          expect(applied.length, 'and the provider discounted the live subscription once').toBe(1);

          const userDoc = await firestore.get(`users/${uid}`);
          const discount = userDoc?.subscription?.discount;

          expect(discount?.valid, 'The account carries the discount that was applied').toBe(true);
          expect(discount.code, 'the same one the route answered with').toBe(sent.body.discount.code);
          expect(discount.duration, 'for the same duration').toBe(sent.body.discount.duration);
          expect(discount.percent > 0 || discount.amount > 0, 'and it is worth something — both shapes are written, so a merge can never leave half of an older discount behind').toBe(true);

          // The source is the whole reason this is safe to read as a CLAIM: a
          // checkout code sets the same node, and a winback pitch suppressed by
          // someone else's promo is an offer silently withheld.
          expect(discount.source, 'and it says which system applied it').toBe('winback');

          // And WHICH subscription it was applied to ([#333]). Nothing cleared
          // this node, so a customer who churned and resubscribed carried the
          // old claim into the new subscription and was never pitched the save
          // again. The stamp is what the webhook pipeline compares the incoming
          // subscription against, so the claim can end with the subscription it
          // was made on.
          expect(discount.resourceId, 'stamped with the subscription it discounted').toBe(user.subscription.payment.resourceId);

          // Through the resolver, exactly as the client reads it
          const resolved = new User(userDoc).toJSON().subscription.discount;

          expect(resolved.valid, 'The discount survives account resolution').toBe(true);
          expect(resolved.source, 'source and all').toBe('winback');
          expect(resolved.resourceId, 'stamp and all').toBe(user.subscription.payment.resourceId);

          // The claim is still recorded where the refusal reads it
          const orderDoc = await firestore.get(`payments-orders/${orderId}`);
          expect(orderDoc.requests.winback.discount.code, 'The order doc keeps the offer memory').toBe(discount.code);

          // A second accept changes NOTHING: it is refused before dispatch, and
          // the account's discount is not doubled, re-stamped or cleared.
          const { sent: second, properties } = await acceptOfferReadingProperties(omega, user);

          expect(second.code, 'Should refuse a second claim').toBe(400);
          expect(properties?.additional?.code, 'with the branchable code').toBe('offer-already-claimed');
          expect(applied.length, 'the provider is never asked twice').toBe(1);

          const after = (await firestore.get(`users/${uid}`))?.subscription?.discount;

          expect(after, 'and the account carries exactly the one discount it already had').toEqual(discount);
        } finally {
          provider.applyOffer = realApplyOffer;
          await firestore.delete(`payments-orders/${orderId}`);
          await firestore.delete(`users/${uid}`);
        }
      },
    },

    // ─── the provider capability gate ───

    {
      name: 'declares-which-providers-can-apply-the-offer',
      async run({ expect }) {
        // The export IS the declaration. Stripe rides the coupon plumbing the
        // checkout already uses; the test provider mirrors it. PayPal has no
        // discount object at all, and Chargebee has coupons but no way to reach
        // a LIVE subscription with one through plumbing that exists here — both
        // say so by exporting nothing.
        expect(typeof providerModule('stripe').applyOffer, 'Stripe applies the offer').toBe('function');
        expect(typeof providerModule('test').applyOffer, 'the test provider applies the offer').toBe('function');
        expect(typeof providerModule('paypal').applyOffer, 'PayPal declares it cannot').toBe('undefined');
        expect(typeof providerModule('chargebee').applyOffer, 'Chargebee declares it cannot').toBe('undefined');
      },
    },

    {
      name: 'refuses-a-provider-that-cannot-discount-with-a-branchable-code',
      async run({ omega, expect, config, skip }) {
        const product = paidProduct(config, skip);

        for (const provider of ['paypal', 'chargebee']) {
          const user = subscriber(omega, { uid: `_test-winback-${provider}`, product, provider, resourceId: `sub_${provider}_winback` });
          const { sent, properties } = await acceptOfferReadingProperties(omega, user);

          expect(sent.code, `${provider}: Should refuse before dispatch`).toBe(400);
          expect(properties?.additional?.code, `${provider}: the refusal carries the code the billing card branches on`).toBe('not-supported-by-provider');
        }
      },
    },

    // ─── the happy path, over the wire ───

    {
      name: 'applies-the-offer-and-claims-it-once',
      async run({ http, expect, config, accounts, firestore, waitFor, skip }) {
        const uid = accounts['route-winback-success'].uid;
        const product = paidProduct(config, skip);

        // Step 1: a real paid subscription on the test provider
        const intentResponse = await http.as('route-winback-success').post('omega/payments/intent', {
          provider: 'test',
          productId: product.id,
          frequency: 'monthly',
        });

        expect(intentResponse, 'Intent should succeed').toBeSuccess();

        // Step 2: the auto-webhook activates it
        await waitFor(async () => {
          const userDoc = await firestore.get(`users/${uid}`);
          return userDoc?.subscription?.payment?.provider === 'test'
            && userDoc?.subscription?.payment?.resourceId
            && userDoc?.subscription?.status === 'active';
        }, 15000, 500);

        // Step 3: the customer starts cancelling and takes the offer instead
        const response = await http.as('route-winback-success').post('omega/payments/winback', {
          confirmed: true,
        });

        expect(response, 'Should apply the save offer').toBeSuccess();
        expect(response.data.success, 'Should return success: true').toBe(true);
        expect(response.data.discount.valid, 'Should answer with the discount it applied').toBe(true);

        // Step 4: the subscription is UNCHANGED — the cancel never happened and
        // a coupon does not move the plan, the cadence or the renewal
        const userDoc = await firestore.get(`users/${uid}`);
        expect(userDoc.subscription.status, 'The subscription is still active').toBe('active');
        expect(userDoc.subscription.cancellation?.pending, 'and nothing is scheduled to cancel').toBe(false);

        // Step 5: the claim is on the order doc — the offer's whole memory
        const orderId = userDoc.subscription.payment.orderId;
        const orderDoc = await firestore.get(`payments-orders/${orderId}`);

        expect(orderDoc.requests.winback.discount.code, 'The claim records the discount applied').toBe(response.data.discount.code);
        expect(orderDoc.requests.winback.date.timestampUNIX > 0, 'and when it was claimed').toBeTruthy();

        // …and on the ACCOUNT, which is what the billing card reads ([#325])
        expect(userDoc.subscription.discount.code, 'The account carries the applied discount').toBe(response.data.discount.code);
        expect(userDoc.subscription.discount.source, 'stamped with the system that applied it').toBe('winback');

        // Step 6: it is claimed ONCE — an offer takeable on every cancel dialog
        // is a permanent discount nobody agreed to
        const second = await http.as('route-winback-success').post('omega/payments/winback', {
          confirmed: true,
        });

        expect(second, 'Should refuse a second claim on the same subscription').toBeError(400);
      },
    },
  ],
});
