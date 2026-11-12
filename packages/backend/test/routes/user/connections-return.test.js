/**
 * Test: routes/user/connections — the optional `returnUrl` path on `authorize`
 * ([#784](https://github.com/Omega-JS-Stack/omega/issues/784)).
 *
 * Run (from the framework repo): npm test routes/user/connections-return
 *
 * The callback page used to land every connect on `/dashboard/account#connections`,
 * so a brand page that starts one from its own surface could not get the user
 * back to it. `authorize` takes a `returnUrl` now — a path on the site — which
 * rides the SAME encrypted state the CSRF token does and comes back out of
 * `tokenize`, the one answer the callback page reads.
 *
 * What it takes is a PATH, and the 400 is what makes it one: an absolute URL, a
 * protocol-relative `//host`, a backslash, whitespace or a `javascript:` scheme
 * is an off-site destination for a value the browser is about to be sent to.
 *
 * Everything is offline: the routes are called directly with a hand-rolled ctx,
 * a recording Firestore stand-in, and a brand-directory fixture provider whose
 * grant steps are overrides — no emulator, no network, no provider.
 */

const path = require('path');
const jetpack = require('fs-jetpack');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const getRoute = loadHandler(require.resolve('../../../dist/omega/routes/user/connections/get.js'));
const postRoute = loadHandler(require.resolve('../../../dist/omega/routes/user/connections/post.js'));
const { decryptState } = require('../../../dist/omega/routes/user/connections/_state.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');
const { recordingFirestore } = require('../../helpers/_recording-firestore.js');

const PROVIDER_ID = 'return-fixture-784';
const PROVIDER_ENV_KEY = 'RETURN_FIXTURE_784';
const CALLER_UID = 'caller-784';
const RETURN_URL = '/dashboard/channels?tab=live#connections';

// The credentials the lane resolves for the fixture provider. Restored in
// cleanup() — a run that leaves them behind changes what the next file reads.
const originalEnv = {
  [`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_ID`]: process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_ID`],
  [`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_SECRET`]: process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_SECRET`],
};

process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_ID`] = 'client-id-784';
process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_SECRET`] = 'client-secret-784';

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// A provider that overrides every network step, so the whole lane runs with no
// authorization server behind it.
const PROVIDER_SOURCE = [
  'module.exports = {',
  `  provider: '${PROVIDER_ID}',`,
  "  name: 'Return Fixture',",
  "  urls: { authorize: 'https://provider.test/a', token: 'https://provider.test/t' },",
  "  async exchange() { return { access_token: 'access-784', refresh_token: 'refresh-784', token_type: 'Bearer', expires_in: 3600, scope: 'identify' }; },",
  "  async identity() { return { id: 'return-fixture-user' }; },",
  '};',
].join('\n');

/** The lane, wired: a brand provider dir, a recording Firestore, and a ctx. */
function lane(docs) {
  const cwd = jetpack.tmpDir({ prefix: 'omega-connections-784' }).path();

  jetpack.write(path.join(cwd, 'connections', `${PROVIDER_ID}.js`), PROVIDER_SOURCE);

  const { admin, writes } = recordingFirestore({ docs: docs || {} });

  const omega = {
    cwd,
    firebase: { admin },
    project: { websiteUrl: 'https://brand.test' },
    config: {},
  };

  const responses = [];

  const ctx = {
    omega,
    metadata: () => ({}),
    log() {},
    respond: (message, options) => {
      responses.push({ message, options: options || {} });
      return { message, options: options || {} };
    },
    redirect: (url) => ({ url }),
    meta: { startTime: { timestamp: 'now', timestampUNIX: 1 } },
  };

  return { ctx, writes, responses };
}

/** The caller, as authenticate() resolved them. */
function userFor(uid) {
  return { authenticated: true, auth: { uid }, roles: { admin: false } };
}

/** The last thing the route answered. */
function answered(responses) {
  return responses[responses.length - 1] || {};
}

/**
 * One authorize leg: the encrypted state it minted, and the CSRF token it
 * stored — everything tokenize needs to spend it.
 */
async function authorize(settings) {
  const { ctx, writes, responses } = lane();

  await getRoute({
    ctx,
    user: userFor(CALLER_UID),
    data: { provider: PROVIDER_ID, action: 'authorize', redirect: false, ...settings },
  });

  const response = answered(responses);
  const session = writes.find((entry) => entry.path === `usage/${CALLER_UID}`);
  const url = response.message && response.message.url;

  return {
    response,
    writes,
    csrf: session && session.payload.connections[PROVIDER_ID].csrf,
    encryptedState: url ? new URL(url).searchParams.get('state') : null,
  };
}

/** The tokenize leg that spends an authorize leg's state. */
async function tokenize({ csrf, encryptedState }) {
  const { ctx, responses } = lane({
    [`usage/${CALLER_UID}`]: { connections: { [PROVIDER_ID]: { csrf, verifier: null, createdAt: Date.now() } } },
  });

  await postRoute({
    ctx,
    user: userFor(CALLER_UID),
    data: { action: 'tokenize', code: 'auth-code-784', encryptedState },
  });

  return answered(responses);
}

module.exports = defineCases({
  description: 'Connections: the optional returnUrl path on authorize',
  type: 'group',

  cleanup() {
    restoreEnv();
  },

  tests: [
    {
      name: 'a-valid-returnurl-rides-the-state-and-comes-back-at-tokenize',

      async run({ expect }) {
        const leg = await authorize({ returnUrl: RETURN_URL });

        expect(leg.response.options.code, `a path on the site is accepted: ${leg.response.message}`).toBe(undefined);
        expect(leg.encryptedState, 'the authorize url carries the encrypted state').toBeTruthy();

        // The path is CARRIED, not answered: the browser leaves for the provider
        // in between, and the state is the only thing that survives the trip
        const state = decryptState(leg.encryptedState);

        expect(state.returnUrl, 'the state carries the path, query and hash included').toBe(RETURN_URL);
        expect(JSON.stringify(leg.writes).includes(RETURN_URL), 'and the one-time session stores nothing of it').toBe(false);

        const tokenized = await tokenize(leg);

        expect(tokenized.options.code, `the exchange still completes: ${tokenized.message}`).toBe(undefined);
        expect(tokenized.message.success, 'reporting success').toBe(true);
        expect(tokenized.message.returnUrl, 'and the answer names where the callback page lands').toBe(RETURN_URL);
      },
    },

    {
      name: 'an-off-site-returnurl-answers-400-naming-the-rule',

      async run({ expect }) {
        // Which values break the rule is the client's site-path table; this is
        // the route refusing one, before anything is minted.
        const value = 'https://evil.test/steal';
        const leg = await authorize({ returnUrl: value });

        expect(leg.response.options.code, `an absolute URL is refused: ${leg.response.message}`).toBe(400);
        expect(leg.response.message, `and the message names the parameter: ${leg.response.message}`).toMatch(/returnUrl/);
        expect(leg.response.message, `and states the rule it broke: ${leg.response.message}`).toMatch(/\//);
        expect(leg.response.message.includes(value), "the caller's value is not echoed back into the page's error").toBe(false);
        expect(leg.writes.length, 'and nothing was minted: no session, no state').toBe(0);
      },
    },

    {
      name: 'status-refuses-a-returnurl-it-would-otherwise-ignore',

      async run({ expect }) {
        const leg = await authorize({ action: 'status', returnUrl: RETURN_URL });

        expect(leg.response.options.code, `status does not take a returnUrl: ${leg.response.message}`).toBe(400);
        expect(leg.response.message, 'and the message names the action that does').toMatch(/authorize/);
        expect(leg.writes.length, 'and nothing was written').toBe(0);
      },
    },

    {
      name: 'no-returnurl-means-no-returnurl-in-the-tokenize-answer',

      async run({ expect }) {
        const leg = await authorize();

        expect(leg.response.options.code, `the parameter is optional: ${leg.response.message}`).toBe(undefined);

        const state = decryptState(leg.encryptedState);

        expect('returnUrl' in state, 'the state carries no returnUrl key at all').toBe(false);

        const tokenized = await tokenize(leg);

        expect(tokenized.message.success, 'the exchange completes as it always did').toBe(true);
        expect('returnUrl' in tokenized.message, 'and the answer names no destination, so the page keeps its default').toBe(false);
      },
    },
  ],
});
