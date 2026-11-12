/**
 * Test: POST /payments/cancel — `skipGuards` is a privileged request
 * ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
 *
 * `skipGuards` arrives in the request BODY, so any client can send it. It waives
 * the 24-hour subscription-age guard, which exists to stop a cancellation racing
 * a checkout that is still settling — a guard a caller must not be able to waive
 * for itself. The route honors it for an admin, or anywhere outside a real
 * deployment (the suites and the dev palette cancel seeded subscriptions minutes
 * old), and ignores it with a warning otherwise.
 *
 * The whole matrix therefore has to be driven in a PRODUCTION environment: in a
 * testing run every caller is permitted by design, so a testing-run assertion
 * would prove nothing. getEnvironment() reads the env live, so swapping it is
 * the real switch — the same technique webhook-test-provider.test.js uses.
 *
 * Both verdicts land as a 400 with DIFFERENT text: the age rejection means the
 * guard ran, and "Unknown provider" means the request got past it (the persona
 * carries a deliberately unknown provider so nothing external is ever reached).
 *
 * Run: npx omega test backend:routes/payments/cancel-skip-guards
 */
const { buildUser, callHandler, withEnvironment, PRODUCTION_ENVIRONMENT } = require('./_route-harness.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/cancel/post.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

// A paid subscriber whose subscription is minutes old — the shape the age guard exists for.
function youngSubscriber(omega, { uid, admin }) {
  const nowUNIX = Math.floor(Date.now() / 1000);

  return buildUser({
    auth: { uid: uid, email: `${uid}@example.com` },
    roles: { admin: !!admin },
    subscription: {
      product: { id: 'premium', name: 'Premium' },
      status: 'active',
      cancellation: { pending: false },
      payment: {
        // Deliberately unknown: getting PAST the age guard must not reach a real provider
        provider: 'unknown-provider',
        resourceId: 'sub_test_skip_guards',
        startDate: { timestamp: new Date(nowUNIX * 1000).toISOString(), timestampUNIX: nowUNIX },
      },
    },
  });
}

function cancel(omega, user) {
  return callHandler({
    omega,
    handler,
    functionName: 'payments-cancel',
    user,
    data: { confirmed: true, skipGuards: true, reason: null, feedback: null },
  });
}

module.exports = defineCases({
  description: 'Payment cancel endpoint: skipGuards is privileged',
  type: 'group',
  timeout: 15000,

  tests: [
    {
      name: 'skip-guards-is-ignored-for-an-ordinary-caller',
      auth: 'none',
      async run({ expect, omega }) {
        const user = youngSubscriber(omega, { uid: '_test-skip-guards-plain', admin: false });

        const sent = await withEnvironment(PRODUCTION_ENVIRONMENT, () => cancel(omega, user));

        expect(sent.code, `An ordinary caller's skipGuards must not waive the age guard, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'The age guard should be the rejection').toMatch(/still being set up/i);
      },
    },

    {
      name: 'skip-guards-is-honored-for-an-admin',
      auth: 'none',
      async run({ expect, omega }) {
        const user = youngSubscriber(omega, { uid: '_test-skip-guards-admin', admin: true });

        const sent = await withEnvironment(PRODUCTION_ENVIRONMENT, () => cancel(omega, user));

        expect(sent.code, `An admin should reach the provider lookup, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'An admin should get PAST the age guard').toMatch(/Unknown provider/i);
      },
    },

    {
      name: 'skip-guards-is-honored-outside-production',
      auth: 'none',
      async run({ expect, omega, ctx }) {
        expect(ctx.isProduction(), 'the suite must run outside production for this test').toBe(false);

        const user = youngSubscriber(omega, { uid: '_test-skip-guards-nonprod', admin: false });

        const sent = await cancel(omega, user);

        expect(sent.code, `A non-production run should reach the provider lookup, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'A non-production run should get PAST the age guard').toMatch(/Unknown provider/i);
      },
    },

    {
      name: 'the-age-guard-still-runs-without-skip-guards',
      auth: 'none',
      async run({ expect, omega }) {
        const user = youngSubscriber(omega, { uid: '_test-skip-guards-absent', admin: true });

        // An admin who never asked to bypass gets the guard like anybody else
        const sent = await callHandler({
          omega,
          handler,
          functionName: 'payments-cancel',
          user,
          data: { confirmed: true, skipGuards: false, reason: null, feedback: null },
        });

        expect(sent.code, `The age guard should reject, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'The age guard should be the rejection').toMatch(/still being set up/i);
      },
    },
  ],
});
