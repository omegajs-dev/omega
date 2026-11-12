/**
 * Test: POST /payments/webhook — the test provider's production guard
 * ([#50](https://github.com/Omega-JS-Stack/omega/issues/50)).
 *
 * The shared `?key=OMEGA_WEBHOOK_KEY` compare is the whole verification story for
 * the webhook door. The `test` provider fabricates Stripe-shaped events, so it is
 * non-production only — the same rule the intent side enforces inside
 * `intent/providers/test.js`. The webhook providers receive only the raw req
 * (no ctx), so the guard lives at the route's dispatch layer.
 *
 * The handler is called directly with a real ctx a real Context;
 * only `res` is a stand-in (the external sink), per the no-mock doctrine.
 *
 * Run: npx omega test backend:routes/payments/webhook-test-provider
 */

// Run the thunk with the environment resolving to production. getEnvironment() reads
// these vars live on every call, so swapping them is the real switch — the test
// lane's OMEGA_ENVIRONMENT=testing is overwritten, and the ambient signals come off.

const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');
const Context = require('../../../dist/omega/context.js');
function withProductionEnvironment(fn) {
  const original = {
    OMEGA_ENVIRONMENT: process.env.OMEGA_ENVIRONMENT,
    ENVIRONMENT: process.env.ENVIRONMENT,
    TERM_PROGRAM: process.env.TERM_PROGRAM,
    FUNCTIONS_EMULATOR: process.env.FUNCTIONS_EMULATOR,
  };

  delete process.env.TERM_PROGRAM;
  delete process.env.FUNCTIONS_EMULATOR;
  // The ONE environment input (#817), named the way a deployed lane names it.
  process.env.OMEGA_ENVIRONMENT = 'production';
  process.env.ENVIRONMENT = 'production';

  try {
    return fn();
  } finally {
    Object.entries(original).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }
}

// A minimal express-shaped response recorder — the one external sink respond() writes to.
function recordingResponse() {
  const sent = { code: null, body: null, headers: {} };

  return {
    sent,
    headersSent: false,
    status(code) {
      sent.code = code;
      return this;
    },
    set(key, value) {
      sent.headers[key] = value;
      return this;
    },
    json(payload) {
      sent.body = payload;
      return this;
    },
    send(payload) {
      sent.body = payload;
      return this;
    },
  };
}

// Build a real ctx for a webhook request, then run the handler against it.
async function callWebhook({ omega, query, body }) {
  const res = recordingResponse();
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    query: query,
    body: body,
  };
  const ctx = new Context(omega, { req, res }, { functionName: 'payments-webhook' });
  const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
  const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/webhook/post.js'));

  await handler({ ctx, omega });

  return res.sent;
}

const VALID_KEY = () => process.env.OMEGA_WEBHOOK_KEY;

module.exports = defineCases({
  description: 'Webhook test provider is non-production only',
  type: 'group',

  tests: [
    {
      name: 'test-provider-is-blocked-in-production',
      async run({ expect, omega }) {
        const sent = await withProductionEnvironment(() => callWebhook({
          omega,
          query: { provider: 'test', key: VALID_KEY() },
          body: { id: '_test-evt-prod-guard', type: 'customer.subscription.updated', data: { object: { id: 'sub_guard' } } },
        }));

        expect(sent.code, `Test provider should be forbidden in production, got ${sent.code}`).toBe(403);
      },
    },

    {
      name: 'real-providers-are-untouched-in-production',
      async run({ expect, omega }) {
        const sent = await withProductionEnvironment(() => callWebhook({
          omega,
          query: { provider: 'stripe', key: VALID_KEY() },
          // An unsupported event type — the handler ignores it before any Firestore write.
          body: { id: '_test-evt-prod-stripe', type: 'ping.unsupported', data: { object: {} } },
        }));

        expect(sent.code, `Stripe should still be accepted in production, got ${sent.code}`).toBe(200);
        expect(sent.body.ignored, 'Unsupported event should be ignored').toBe(true);
      },
    },

    {
      name: 'test-provider-is-allowed-outside-production',
      async run({ expect, omega, ctx }) {
        expect(ctx.isProduction(), 'the suite must run outside production for this test').toBe(false);

        const sent = await callWebhook({
          omega,
          query: { provider: 'test', key: VALID_KEY() },
          // An unsupported event type — proves dispatch got past the guard without a write.
          body: { id: '_test-evt-nonprod-guard', type: 'ping.unsupported', data: { object: {} } },
        });

        expect(sent.code, `Test provider should be accepted outside production, got ${sent.code}`).toBe(200);
        expect(sent.body.ignored, 'Unsupported event should be ignored').toBe(true);
      },
    },

    {
      name: 'the-key-still-gates-before-the-provider-guard',
      async run({ expect, omega }) {
        const sent = await withProductionEnvironment(() => callWebhook({
          omega,
          query: { provider: 'test', key: 'wrong-key' },
          body: { id: '_test-evt-prod-badkey', type: 'customer.subscription.updated', data: { object: { id: 'sub_guard' } } },
        }));

        expect(sent.code, `A wrong key should still be the first rejection, got ${sent.code}`).toBe(401);
      },
    },
  ],
});
