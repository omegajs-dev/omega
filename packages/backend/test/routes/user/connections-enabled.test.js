/**
 * Test: routes/user/connections, a provider the brand turned off.
 * Run (from the framework repo): npm test routes/user/connections-enabled
 *
 * With `connections.<provider>.enabled` false, `authorize`, `tokenize` and
 * `refresh` answer one 400 naming that key and run no grant step, while
 * `status` and `delete` still answer, so a user can remove the connection.
 *
 * Offline: the routes are called directly with a hand-rolled ctx, a recording
 * Firestore stand-in, and a brand-directory fixture provider whose steps are
 * overrides that record their calls.
 */

const path = require('path');
const jetpack = require('fs-jetpack');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const getRoute = loadHandler(require.resolve('../../../dist/omega/routes/user/connections/get.js'));
const postRoute = loadHandler(require.resolve('../../../dist/omega/routes/user/connections/post.js'));
const deleteRoute = loadHandler(require.resolve('../../../dist/omega/routes/user/connections/delete.js'));
const { encryptState } = require('../../../dist/omega/routes/user/connections/_state.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');
const { recordingFirestore } = require('../../helpers/_recording-firestore.js');

const PROVIDER_ID = 'enabled-fixture-1071';
const PROVIDER_ENV_KEY = 'ENABLED_FIXTURE_1071';
const USER_UID = 'user-1071';

// The provider module is loaded from a file, so its steps report through a
// global the cases read and reset.
const CALL_STATE = '__omegaConnectionsEnabled1071';

// The credentials the lane resolves for the fixture provider. Restored in
// cleanup(): a run that leaves them behind changes what the next file reads.
const originalEnv = {
  [`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_ID`]: process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_ID`],
  [`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_SECRET`]: process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_SECRET`],
};

process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_ID`] = 'client-id-1071';
process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_SECRET`] = 'client-secret-1071';

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

const record = (step) => `(global['${CALL_STATE}'] = global['${CALL_STATE}'] || []).push('${step}');`;

// Every network step is an override that records itself, so "no step ran" is a
// count and the lane needs no authorization server behind it.
const PROVIDER_SOURCE = [
  'module.exports = {',
  `  provider: '${PROVIDER_ID}',`,
  "  name: 'Enabled Fixture',",
  "  urls: { authorize: 'https://provider.test/a', token: 'https://provider.test/t' },",
  `  authorize() { ${record('authorize')} return 'https://provider.test/a?state=x'; },`,
  `  async exchange() { ${record('exchange')} return { access_token: 'access-1071', refresh_token: 'refresh-1071', token_type: 'Bearer', expires_in: 3600, scope: 'identify' }; },`,
  `  async refresh() { ${record('refresh')} return { access_token: 'refreshed-1071', refresh_token: 'refresh-1071', token_type: 'Bearer', expires_in: 3600, scope: 'identify' }; },`,
  `  async revoke() { ${record('revoke')} },`,
  `  async identity() { ${record('identity')} return { id: 'fixture-user-1071' }; },`,
  '};',
].join('\n');

/** The steps the provider ran since the last reset, in order. */
function stepsRun() {
  return global[CALL_STATE] || [];
}

function resetSteps() {
  global[CALL_STATE] = [];
}

// The one linked account, keyed by the identity id the fixture provider answers
const IDENTITY_ID = 'fixture-user-1071';

/** The stored connection record a status, a refresh or a delete acts on. */
function storedConnections() {
  return {
    [PROVIDER_ID]: {
      [IDENTITY_ID]: {
        type: 'oauth2',
        token: { access_token: 'access-old', refresh_token: 'refresh-1071' },
        identity: { id: IDENTITY_ID },
      },
    },
  };
}

/** The lane, wired with the provider switched to `enabled`. */
function lane(enabled, docs) {
  const cwd = jetpack.tmpDir({ prefix: 'omega-connections-1071' }).path();

  jetpack.write(path.join(cwd, 'connections', `${PROVIDER_ID}.js`), PROVIDER_SOURCE);

  const { admin, writes } = recordingFirestore({ docs: docs || {} });

  const omega = {
    cwd,
    firebase: { admin },
    project: { websiteUrl: 'https://brand.test' },
    config: {
      brand: { name: 'Test Brand' },
      connections: { [PROVIDER_ID]: { enabled } },
    },
  };

  const responses = [];
  const redirects = [];

  const ctx = {
    omega,
    metadata: () => ({}),
    log() {},
    respond: (message, options) => {
      responses.push({ message, options: options || {} });
      return { message, options: options || {} };
    },
    redirect: (url) => {
      redirects.push(url);
      return { url };
    },
    meta: { startTime: { timestamp: 'now', timestampUNIX: 1 } },
  };

  resetSteps();

  return { ctx, writes, responses, redirects };
}

function userFor(connected) {
  return {
    authenticated: true,
    auth: { uid: USER_UID },
    roles: { admin: false },
    ...(connected ? { connections: storedConnections() } : {}),
  };
}

/** The last thing the route answered. */
function answered(responses) {
  return responses[responses.length - 1] || {};
}

/** The tokenize input and the usage document its valid state matches. */
function tokenizeInput() {
  return {
    docs: { [`usage/${USER_UID}`]: { connections: { [PROVIDER_ID]: { csrf: 'csrf-1071', verifier: null, createdAt: Date.now() } } } },
    data: {
      action: 'tokenize',
      code: 'auth-code-1071',
      encryptedState: encryptState({ provider: PROVIDER_ID, uid: USER_UID, csrf: 'csrf-1071', ts: Date.now() }),
    },
  };
}

/** A refusal is a 400 naming the config key that turns the provider on. */
function assertRefused(expect, response) {
  const message = typeof response.message === 'string' ? response.message : JSON.stringify(response.message);

  expect(response.options.code, `the refusal is a 400: ${message}`).toBe(400);
  expect(message.includes(`connections.${PROVIDER_ID}.enabled`), `the message names the key that turns it on: ${message}`).toBe(true);

  return message;
}

/** Each refused action run once against an off provider, answering its last response. */
async function refusedResponses() {
  const authorizeLane = lane(false);

  await getRoute({
    ctx: authorizeLane.ctx,
    user: userFor(false),
    data: { provider: PROVIDER_ID, action: 'authorize', redirect: false },
  });

  const { docs, data } = tokenizeInput();
  const tokenizeLane = lane(false, docs);

  await postRoute({ ctx: tokenizeLane.ctx, user: userFor(false), data });

  const refreshLane = lane(false, { [`users/${USER_UID}`]: { connections: storedConnections() } });

  await postRoute({
    ctx: refreshLane.ctx,
    user: userFor(true),
    data: { provider: PROVIDER_ID, action: 'refresh' },
  });

  return [authorizeLane, tokenizeLane, refreshLane].map((entry) => answered(entry.responses));
}

module.exports = defineCases({
  description: 'Connections: a provider the brand turned off',
  type: 'group',

  cleanup() {
    restoreEnv();
    delete global[CALL_STATE];
  },

  tests: [
    {
      name: 'authorize-refuses-an-off-provider-and-returns-no-url',

      async run({ expect }) {
        const { ctx, responses, redirects } = lane(false);

        await getRoute({
          ctx,
          user: userFor(false),
          data: { provider: PROVIDER_ID, action: 'authorize', redirect: false },
        });

        const response = answered(responses);

        assertRefused(expect, response);
        expect(response.message?.url, 'no authorization URL comes back').toBe(undefined);
        expect(redirects.length, 'and nobody is redirected to one').toBe(0);
        expect(stepsRun(), 'the authorize step never ran').toEqual([]);
      },
    },

    {
      name: 'tokenize-refuses-an-off-provider-before-any-exchange',

      async run({ expect }) {
        const { docs, data } = tokenizeInput();
        const { ctx, writes, responses } = lane(false, docs);

        await postRoute({ ctx, user: userFor(false), data });

        assertRefused(expect, answered(responses));
        expect(stepsRun(), 'no token exchange was attempted').toEqual([]);
        expect(writes.some((write) => write.path.startsWith('users/')), 'and no connection was recorded').toBe(false);
      },
    },

    {
      name: 'refresh-refuses-an-off-provider-and-calls-no-refresh',

      async run({ expect }) {
        const { ctx, writes, responses } = lane(false, { [`users/${USER_UID}`]: { connections: storedConnections() } });

        await postRoute({
          ctx,
          user: userFor(true),
          data: { provider: PROVIDER_ID, action: 'refresh' },
        });

        assertRefused(expect, answered(responses));
        expect(stepsRun(), 'no refresh call reached the provider').toEqual([]);
        expect(writes.some((write) => write.verb === 'set' && write.path === `users/${USER_UID}`), 'and no token was stored').toBe(false);
      },
    },

    {
      name: 'the-three-refused-actions-answer-one-and-the-same-error',

      async run({ expect }) {
        const [authorize, tokenize, refresh] = (await refusedResponses()).map((response) => assertRefused(expect, response));

        expect(tokenize, 'tokenize answers the same message as authorize').toBe(authorize);
        expect(refresh, 'and so does refresh').toBe(authorize);
      },
    },

    {
      name: 'status-still-answers-for-an-off-provider',

      async run({ expect }) {
        const { ctx, responses } = lane(false);

        await getRoute({
          ctx,
          user: userFor(true),
          data: { provider: PROVIDER_ID, action: 'status' },
        });

        const response = answered(responses);

        expect(response.options.code, `status is not refused: ${JSON.stringify(response.message)}`).toBe(undefined);
        expect(response.message.status, 'and it reads the stored record').toBe('connected');
      },
    },

    {
      name: 'delete-still-removes-an-off-providers-connection',

      async run({ expect }) {
        const { ctx, writes, responses } = lane(false);

        await deleteRoute({
          ctx,
          user: userFor(true),
          data: { provider: PROVIDER_ID },
        });

        const response = answered(responses);

        expect(response.options.code, `delete is not refused: ${JSON.stringify(response.message)}`).toBe(undefined);
        expect(response.message.success, 'the disconnect succeeds').toBe(true);

        const deleted = writes.find((write) => write.path === `users/${USER_UID}`);
        const removed = deleted && (deleted.payload.connections?.[PROVIDER_ID]?.[IDENTITY_ID]
          ?? deleted.payload[`connections.${PROVIDER_ID}.${IDENTITY_ID}`]);

        expect(deleted, 'the record is deleted').toBeTruthy();
        expect(removed?.methodName, `and it is the one account's record that went: ${JSON.stringify(deleted?.payload)}`).toBe('FieldValue.delete');
      },
    },

    {
      name: 'authorize-tokenize-and-refresh-run-when-the-provider-is-on',

      async run({ expect }) {
        const authorizeLane = lane(true);

        await getRoute({
          ctx: authorizeLane.ctx,
          user: userFor(false),
          data: { provider: PROVIDER_ID, action: 'authorize', redirect: false },
        });

        const authorized = answered(authorizeLane.responses);

        expect(authorized.options.code, `authorize is not refused: ${JSON.stringify(authorized.message)}`).toBe(undefined);
        expect(authorized.message.url, "the provider's authorization URL comes back").toBe('https://provider.test/a?state=x');

        const { docs, data } = tokenizeInput();
        const tokenizeLane = lane(true, docs);

        await postRoute({ ctx: tokenizeLane.ctx, user: userFor(false), data });

        const tokenized = answered(tokenizeLane.responses);

        expect(tokenized.options.code, `tokenize is not refused: ${JSON.stringify(tokenized.message)}`).toBe(undefined);
        expect(stepsRun().includes('exchange'), 'and the exchange ran').toBe(true);

        const refreshLane = lane(true, { [`users/${USER_UID}`]: { connections: storedConnections() } });

        await postRoute({
          ctx: refreshLane.ctx,
          user: userFor(true),
          data: { provider: PROVIDER_ID, action: 'refresh' },
        });

        const refreshed = answered(refreshLane.responses);

        expect(refreshed.options.code, `refresh is not refused: ${JSON.stringify(refreshed.message)}`).toBe(undefined);
        expect(stepsRun(), 'and the refresh reached the provider once').toEqual(['refresh']);
      },
    },
  ],
});
