/**
 * Test: POST /payments/intent refuses a purchaser this project does not have
 *
 * A checkout begun for a uid with no auth user, or with no user doc behind it,
 * ends as a webhook with nowhere to write — the seam that minted a LIVE
 * users/{uid} holding nothing but a subscription block
 * ([#399](https://github.com/Omega-JS-Stack/omega/issues/399)). The route now
 * refuses before the provider is ever called, so there is no session, no intent
 * doc, and no half-written account.
 *
 * Direct handler calls against the REAL emulator (the _route-harness technique):
 * the auth store and the user doc are the actual ones, and a uid with only half
 * the pair is a state no persona can be seeded into.
 *
 * Run: npm test -- backend:routes/payments/intent-purchaser-guard
 */
const { buildUser, callHandler } = require('./_route-harness.js');
const { TEST_ACCOUNT_PASSWORD } = require('../../../dist/test/test-accounts.js');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const handler = loadHandler(require.resolve('../../../dist/omega/routes/payments/intent/post.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const NO_AUTH_UID = '_test-intent-no-auth-user';
const NO_DOC_UID = '_test-intent-no-user-doc';

/** A checkout request for a paid product, as a signed-in caller sends it */
function checkout(omega, uid, { productId }) {
  const doc = uid === null
    // The omega-admin-key lane: authenticated, carrying no user at all
    ? { roles: { admin: true } }
    : { auth: { uid: uid, email: `${uid}@example.com` } };

  return callHandler({
    omega,
    handler,
    functionName: 'payments-intent',
    user: buildUser(doc),
    data: {
      provider: 'test',
      productId: productId,
      frequency: 'monthly',
    },
  });
}

/** The brand's first paid product — the one a real checkout would name */
function paidProductId(config, skip) {
  const product = (config.payment?.products || []).find(p => p.id !== 'basic' && p.prices);

  if (!product) {
    skip('No paid product configured in this brand');
  }

  return product.id;
}

module.exports = defineCases({
  description: 'Payment intent refuses a purchaser without both an auth user and a user doc',
  type: 'group',
  timeout: 45000,

  tests: [
    {
      name: 'refuses a purchaser with no auth user',
      auth: 'none',

      async run({ expect, omega, config, firestore, skip }) {
        const sent = await checkout(omega, NO_AUTH_UID, { productId: paidProductId(config, skip) });

        expect(sent.code, `A uid this project has no auth user for must be refused, got ${sent.code}: ${sent.body}`).toBe(403);
        expect(await firestore.exists(`users/${NO_AUTH_UID}`), 'The refusal writes nothing — no user doc is created by a checkout').toBe(false);
      },
    },

    {
      name: 'refuses an authenticated caller carrying no uid at all',
      auth: 'none',

      async run({ expect, omega, config, skip }) {
        // The admin-key lane authenticates without a user token, so the uid the
        // guard looks up is empty — a lookup that THROWS, and a 500 is not a
        // refusal. It has to come back as the same loud 403.
        const sent = await checkout(omega, null, { productId: paidProductId(config, skip) });

        expect(sent.code, `A caller with no uid must be refused, got ${sent.code}: ${sent.body}`).toBe(403);
      },
    },

    {
      name: 'refuses a purchaser whose user doc is missing',
      auth: 'none',

      async run({ expect, omega, config, firestore, waitFor, skip }) {
        const productId = paidProductId(config, skip);
        const admin = omega.firebase.admin;

        await admin.auth().deleteUser(NO_DOC_UID).catch(() => null);
        // Seeding's own createUser shape, password included ON PURPOSE: a
        // passwordless record carries no providerData, which auth:on-create reads
        // as anonymous and skips — and the wait below would then never come back
        await admin.auth().createUser({
          uid: NO_DOC_UID,
          email: `${NO_DOC_UID}@example.com`,
          password: TEST_ACCOUNT_PASSWORD,
          emailVerified: true,
        });

        try {
          // auth:on-create writes the doc — wait for it, THEN remove it, so nothing
          // lands behind the delete and the handler reads a genuinely absent doc
          await waitFor(() => firestore.exists(`users/${NO_DOC_UID}`), 20000, 250);
          await firestore.delete(`users/${NO_DOC_UID}`);

          const sent = await checkout(omega, NO_DOC_UID, { productId: productId });

          expect(sent.code, `An auth user with no user doc must be refused, got ${sent.code}: ${sent.body}`).toBe(403);
          expect(await firestore.exists(`users/${NO_DOC_UID}`), 'The refusal writes nothing — the doc a signup owns is not created here').toBe(false);
        } finally {
          await admin.auth().deleteUser(NO_DOC_UID).catch(() => null);
          await firestore.delete(`users/${NO_DOC_UID}`).catch(() => null);
        }
      },
    },

    {
      name: 'a real account gets past the guard',
      auth: 'none',

      async run({ expect, omega, accounts }) {
        // A product the brand does not sell: the 400 it earns proves the request
        // reached the route's own validation, and no provider is ever called
        const sent = await checkout(omega, accounts['basic'].uid, { productId: '_test-nonexistent-product' });

        expect(sent.code, `A seeded persona has both halves and must get past the guard, got ${sent.code}: ${sent.body}`).toBe(400);
        expect(`${sent.body}`, 'The rejection should be the product lookup, not the purchaser guard').toMatch(/not found/i);
      },
    },
  ],
});
