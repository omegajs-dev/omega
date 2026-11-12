/**
 * Test: POST /payments/portal — `returnUrl` must be the brand's own
 * ([#212](https://github.com/Omega-JS-Stack/omega/issues/212)).
 *
 * `returnUrl` is client-settable and lands inside the provider's hosted billing
 * page as the "back to the site" link. An arbitrary host there turns the brand's
 * own billing portal into a redirector to anywhere — a phishing hop that wears
 * the brand's checkout. The route now accepts only the brand's own resolved
 * origins and falls back to the brand's account page, with a warning, otherwise.
 *
 * The `test` portal provider answers with the returnUrl it was handed, so the
 * response IS the assertion about what the provider would have received.
 *
 * Run: npx omega test backend:routes/payments/portal-return-url
 */
const { buildUser, callHandler } = require('./_route-harness.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/portal/post.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

// Where the route sends a caller whose returnUrl it refused.
const DEFAULT_RETURN = (omega) => new URL('/dashboard/account#billing', omega.project.websiteUrl).toString();

function subscriber(omega) {
  return buildUser({
    auth: { uid: '_test-portal-return-url', email: '_test.portal-return-url@example.com' },
    roles: {},
    subscription: {
      product: { id: 'premium', name: 'Premium' },
      status: 'active',
      payment: { provider: 'test', resourceId: 'sub_test_portal_return_url' },
    },
  });
}

function openPortal(omega, returnUrl) {
  return callHandler({
    omega,
    handler,
    functionName: 'payments-portal',
    user: subscriber(omega),
    data: { returnUrl: returnUrl },
  });
}

module.exports = defineCases({
  description: 'Payment portal endpoint: returnUrl is same-origin only',
  type: 'group',
  timeout: 15000,

  tests: [
    {
      name: 'an-off-brand-return-url-falls-back',
      auth: 'none',
      async run({ expect, omega }) {
        const sent = await openPortal(omega, 'https://evil.example/steal');

        expect(sent.code, `The portal should still open, got ${sent.code}: ${JSON.stringify(sent.body)}`).toBe(200);
        expect(sent.body.url, 'An off-brand host must never reach the provider').toBe(DEFAULT_RETURN(omega));
      },
    },

    {
      name: 'a-look-alike-host-falls-back',
      auth: 'none',
      async run({ expect, omega }) {
        // The classic near-miss: the brand's origin as a prefix of somebody else's host
        const origin = new URL(omega.project.websiteUrl).origin;
        const sent = await openPortal(omega, `${origin}.evil.example/dashboard/account`);

        expect(sent.body.url, 'A host that merely starts with the brand origin must not pass').toBe(DEFAULT_RETURN(omega));
      },
    },

    {
      name: 'an-unparseable-return-url-falls-back',
      auth: 'none',
      async run({ expect, omega }) {
        const sent = await openPortal(omega, 'not a url at all');

        expect(sent.body.url, 'An unparseable value must fall back, never be forwarded').toBe(DEFAULT_RETURN(omega));
      },
    },

    {
      name: 'a-missing-return-url-falls-back',
      auth: 'none',
      async run({ expect, omega }) {
        const sent = await openPortal(omega, null);

        expect(sent.body.url, 'No returnUrl should still return to the brand').toBe(DEFAULT_RETURN(omega));
      },
    },

    {
      name: 'the-brands-own-return-url-passes-through',
      auth: 'none',
      async run({ expect, omega }) {
        const returnUrl = new URL('/dashboard/account?tab=invoices', omega.project.websiteUrl).toString();

        const sent = await openPortal(omega, returnUrl);

        expect(sent.body.url, "The brand's own URL should be honored exactly as asked").toBe(returnUrl);
      },
    },
  ],
});
