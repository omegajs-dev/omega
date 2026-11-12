/**
 * Test: routes/user/connections — which actions honor an admin's `uid`
 * ([#782](https://github.com/Omega-JS-Stack/omega/issues/782)).
 *
 * Run (from the framework repo): npm test routes/user/connections-uid
 *
 * Every action used to take `uid`. Two of them cannot mean anything for somebody
 * else: `authorize` hands back a URL the CONNECTING user's own browser has to
 * open, and `tokenize` spends a code that browser came back with. A `uid` on
 * those two is a stale caller acting on the wrong user, so the route answers 400
 * NAMING the argument instead of quietly using the caller's own record.
 * `status`, `refresh` and `delete` keep it: each acts AT THE PROVIDER on a
 * user's behalf — checking a connection (and dropping a dead one), refreshing,
 * revoking — which a trusted server does with no browser in the loop.
 *
 * The doc case belongs here too: the section that told a trusted service to read
 * a stored token with `GET /user` + `uid` described a parameter that route never
 * had (the bug this issue opened on), and the read it names now is the admin
 * firestore route.
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
const deleteRoute = loadHandler(require.resolve('../../../dist/omega/routes/user/connections/delete.js'));
const { encryptState } = require('../../../dist/omega/routes/user/connections/_state.js');
const { validate } = require('../../../dist/omega/helpers/schema.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');
const { frameworkDoc } = require('../../helpers/_framework-doc.js');
const { recordingFirestore } = require('../../helpers/_recording-firestore.js');

const PROVIDER_ID = 'uid-fixture-782';
const PROVIDER_ENV_KEY = 'UID_FIXTURE_782';
const CALLER_UID = 'caller-782';
const OTHER_UID = 'other-782';
const DOC_PATH = frameworkDoc('backend', 'connections.md');

// The credentials the lane resolves for the fixture provider. Restored in
// cleanup() — a run that leaves them behind changes what the next file reads.
const originalEnv = {
  [`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_ID`]: process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_ID`],
  [`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_SECRET`]: process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_SECRET`],
};

process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_ID`] = 'client-id-782';
process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_SECRET`] = 'client-secret-782';

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
  "  name: 'Uid Fixture',",
  "  urls: { authorize: 'https://provider.test/a', token: 'https://provider.test/t' },",
  "  async exchange() { return { access_token: 'access-782', refresh_token: 'refresh-782', token_type: 'Bearer', expires_in: 3600, scope: 'identify' }; },",
  "  async refresh() { return { access_token: 'refreshed-782', refresh_token: 'refresh-782', token_type: 'Bearer', expires_in: 3600, scope: 'identify' }; },",
  "  async identity() { return { id: 'fixture-user' }; },",
  '};',
].join('\n');

// The one linked account, keyed by the identity the fixture provider answers
const IDENTITY_ID = 'fixture-user';

/** The stored connection record a refresh or a delete acts on. */
function storedUser(uid) {
  return {
    id: uid,
    connections: {
      [PROVIDER_ID]: {
        [IDENTITY_ID]: {
          type: 'oauth2',
          token: { access_token: 'access-old', refresh_token: 'refresh-782' },
          identity: { id: IDENTITY_ID },
        },
      },
    },
  };
}

/** The account record a write carries, whether set as a nested map or by a dotted key. */
function writtenRecord(write) {
  return write.payload.connections?.[PROVIDER_ID]?.[IDENTITY_ID] ?? write.payload[`connections.${PROVIDER_ID}.${IDENTITY_ID}`];
}

/** A write that stores (or deletes) a user record: a plain write or one inside the transaction. */
const STORING = ['set', 'update', 'transaction.set', 'transaction.update'];

/** The lane, wired: a brand provider dir, a recording Firestore, and a ctx. */
function lane(docs) {
  const cwd = jetpack.tmpDir({ prefix: 'omega-connections-782' }).path();

  jetpack.write(path.join(cwd, 'connections', `${PROVIDER_ID}.js`), PROVIDER_SOURCE);

  const { admin, writes } = recordingFirestore({ docs: docs || {} });

  const omega = {
    cwd,
    firebase: { admin },
    project: { websiteUrl: 'https://brand.test' },
    config: {},
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

  return { ctx, omega, writes, responses, redirects };
}

/**
 * The caller, as authenticate() resolved them — the resolved user IS the record
 * the lane reads on the self path (it only goes to Firestore for another uid),
 * so a self case that needs a stored connection carries it here.
 */
function userFor(uid, isAdmin, connected) {
  return {
    authenticated: true,
    auth: { uid },
    roles: { admin: !!isAdmin },
    ...(connected ? { connections: storedUser(uid).connections } : {}),
  };
}

/** The last thing the route answered. */
function answered(responses) {
  return responses[responses.length - 1] || {};
}

module.exports = defineCases({
  description: 'Connections: which actions honor an admin uid, and which refuse it',
  type: 'group',

  cleanup() {
    restoreEnv();
  },

  tests: [
    {
      name: 'authorize-with-a-passed-uid-answers-400-naming-it',

      async run({ expect }) {
        const { ctx, writes, responses } = lane();

        await getRoute({
          ctx,
          user: userFor(CALLER_UID, true),
          data: { provider: PROVIDER_ID, action: 'authorize', redirect: false, uid: OTHER_UID },
        });

        const response = answered(responses);

        expect(response.options.code, `even an ADMIN gets the 400: ${response.message}`).toBe(400);
        expect(response.message, `and the message names the dropped argument: ${response.message}`).toMatch(/uid/);
        expect(response.message, `and names every action that DOES take one, so the 400 is a redirection: ${response.message}`).toMatch(/`status`, `refresh` or `delete`/);
        expect(response.message.includes(OTHER_UID), "the caller's value is not echoed back").toBe(false);
        expect(writes.length, 'nothing was written — no session was minted for anybody').toBe(0);
      },
    },

    {
      name: 'status-with-a-uid-as-an-admin-reads-that-users-record',

      async run({ expect }) {
        const { ctx, responses } = lane({ [`users/${OTHER_UID}`]: storedUser(OTHER_UID) });

        // The admin has no connection of their OWN — a status that answered for
        // the caller would say disconnected, so 'connected' can only have come
        // from the passed user's document.
        await getRoute({
          ctx,
          user: userFor(CALLER_UID, true),
          data: { provider: PROVIDER_ID, action: 'status', uid: OTHER_UID },
        });

        const response = answered(responses);

        expect(response.options.code, `status checks a connection AT THE PROVIDER, so a trusted server may run it: ${response.message}`).toBe(undefined);
        expect(response.message.status, "and the record it read is the PASSED user's").toBe('connected');
      },
    },

    {
      name: 'tokenize-with-a-passed-uid-answers-400-naming-it',

      async run({ expect }) {
        const { ctx, writes, responses } = lane();

        await postRoute({
          ctx,
          user: userFor(CALLER_UID, true),
          data: {
            action: 'tokenize',
            code: 'auth-code-782',
            encryptedState: encryptState({ provider: PROVIDER_ID, uid: CALLER_UID, csrf: 'csrf-782', ts: Date.now() }),
            uid: OTHER_UID,
          },
        });

        const response = answered(responses);

        expect(response.options.code, `the code belongs to the browser that carried it: ${response.message}`).toBe(400);
        expect(response.message, `and the message names the dropped argument: ${response.message}`).toMatch(/uid/);
        expect(writes.length, 'the exchange never ran, so no record was written for either user').toBe(0);
      },
    },

    {
      name: 'refresh-with-a-uid-as-an-admin-acts-on-that-user',

      async run({ expect }) {
        const { ctx, writes, responses } = lane({ [`users/${OTHER_UID}`]: storedUser(OTHER_UID) });

        await postRoute({
          ctx,
          user: userFor(CALLER_UID, true),
          data: { provider: PROVIDER_ID, action: 'refresh', uid: OTHER_UID },
        });

        const response = answered(responses);

        expect(response.options.code, `a trusted server may refresh on a user's behalf: ${response.message}`).toBe(undefined);
        expect(response.message.success, 'and the refresh reports success').toBe(true);
        expect(response.message.token.access_token, 'carrying the token it stored ([#783](https://github.com/Omega-JS-Stack/omega/issues/783))').toBe('refreshed-782');

        const write = writes.find((entry) => entry.path === `users/${OTHER_UID}` && entry.verb === 'set');

        expect(write, "the new token landed on the PASSED user's document").toBeTruthy();
        expect(writtenRecord(write).token.access_token, 'and it is the refreshed token').toBe('refreshed-782');
        expect(writes.some((entry) => entry.path === `users/${CALLER_UID}`), "and nothing landed on the admin's own — not even the lease").toBe(false);
      },
    },

    {
      name: 'delete-with-a-uid-as-an-admin-acts-on-that-user',

      async run({ expect }) {
        const { ctx, writes, responses } = lane({ [`users/${OTHER_UID}`]: storedUser(OTHER_UID) });

        await deleteRoute({
          ctx,
          user: userFor(CALLER_UID, true),
          data: { provider: PROVIDER_ID, uid: OTHER_UID },
        });

        const response = answered(responses);

        expect(response.options.code, `a trusted server may revoke on a user's behalf: ${response.message}`).toBe(undefined);

        const write = writes.find((entry) => entry.path === `users/${OTHER_UID}`);

        expect(write, "the deletion hit the PASSED user's document").toBeTruthy();
        expect(writtenRecord(write)?.methodName, `and it is the one account's record that went: ${JSON.stringify(write.payload)}`).toBe('FieldValue.delete');
        expect(writes.some((entry) => entry.path === `users/${CALLER_UID}`), "and nothing touched the admin's own").toBe(false);
      },
    },

    {
      name: 'status-refresh-and-delete-with-a-uid-as-a-non-admin-answer-403',

      async run({ expect }) {
        const docs = { [`users/${OTHER_UID}`]: storedUser(OTHER_UID) };

        const statusLane = lane(docs);

        await getRoute({
          ctx: statusLane.ctx,
          user: userFor(CALLER_UID, false),
          data: { provider: PROVIDER_ID, action: 'status', uid: OTHER_UID },
        });

        expect(answered(statusLane.responses).options.code, "only an admin reads somebody else's connection status").toBe(403);
        expect(statusLane.writes.length, 'and nothing was removed from their record').toBe(0);

        const refreshLane = lane(docs);

        await postRoute({
          ctx: refreshLane.ctx,
          user: userFor(CALLER_UID, false),
          data: { provider: PROVIDER_ID, action: 'refresh', uid: OTHER_UID },
        });

        expect(answered(refreshLane.responses).options.code, 'only an admin refreshes for somebody else').toBe(403);
        expect(refreshLane.writes.length, 'and nothing was written').toBe(0);

        const deleteLane = lane(docs);

        await deleteRoute({
          ctx: deleteLane.ctx,
          user: userFor(CALLER_UID, false),
          data: { provider: PROVIDER_ID, uid: OTHER_UID },
        });

        expect(answered(deleteLane.responses).options.code, 'only an admin revokes for somebody else').toBe(403);
        expect(deleteLane.writes.length, 'and nothing was deleted').toBe(0);
      },
    },

    {
      name: 'the-self-path-of-authorize-and-status-is-unchanged',

      async run({ expect }) {
        const authorizeLane = lane();

        await getRoute({
          ctx: authorizeLane.ctx,
          user: userFor(CALLER_UID, false),
          data: { provider: PROVIDER_ID, action: 'authorize', redirect: false },
        });

        const authorized = answered(authorizeLane.responses);

        expect(authorized.options.code, `no uid, no 400: ${authorized.message}`).toBe(undefined);
        expect(authorized.message.url, "the provider's authorize url comes back").toMatch(/^https:\/\/provider\.test\/a\?/);

        const session = authorizeLane.writes.find((entry) => entry.path === `usage/${CALLER_UID}`);

        expect(session, "the one-time session was minted on the CALLER's usage document").toBeTruthy();
        expect(session.payload.connections[PROVIDER_ID].csrf, 'with its CSRF token').toBeTruthy();

        const statusLane = lane();

        await getRoute({
          ctx: statusLane.ctx,
          user: userFor(CALLER_UID, false, true),
          data: { provider: PROVIDER_ID, action: 'status' },
        });

        const status = answered(statusLane.responses);

        expect(status.options.code, `status still answers the caller: ${status.message}`).toBe(undefined);
        expect(status.message.status, 'and the stored record reads connected').toBe('connected');
      },
    },

    {
      name: 'the-self-path-of-tokenize-refresh-and-delete-is-unchanged',

      async run({ expect }) {
        const tokenizeLane = lane({
          [`usage/${CALLER_UID}`]: { connections: { [PROVIDER_ID]: { csrf: 'csrf-782', verifier: null, createdAt: Date.now() } } },
        });

        await postRoute({
          ctx: tokenizeLane.ctx,
          user: userFor(CALLER_UID, false),
          data: {
            action: 'tokenize',
            code: 'auth-code-782',
            encryptedState: encryptState({ provider: PROVIDER_ID, uid: CALLER_UID, csrf: 'csrf-782', ts: Date.now() }),
          },
        });

        const tokenized = answered(tokenizeLane.responses);

        expect(tokenized.options.code, `the callback page's call still completes: ${tokenized.message}`).toBe(undefined);
        expect(tokenized.message.success, 'reporting success').toBe(true);

        const record = tokenizeLane.writes.find((entry) => entry.path === `users/${CALLER_UID}` && STORING.includes(entry.verb) && writtenRecord(entry));

        expect(record, "and the record landed on the state's user, under the identity id").toBeTruthy();
        expect(writtenRecord(record).token.access_token, 'carrying the exchanged token').toBe('access-782');

        // The refresh reads the record in its lease TRANSACTION
        // ([#783](https://github.com/Omega-JS-Stack/omega/issues/783)), so the
        // caller's own document is what it spends — seeded here like any other
        const refreshLane = lane({ [`users/${CALLER_UID}`]: storedUser(CALLER_UID) });

        await postRoute({
          ctx: refreshLane.ctx,
          user: userFor(CALLER_UID, false, true),
          data: { provider: PROVIDER_ID, action: 'refresh' },
        });

        expect(answered(refreshLane.responses).options.code, 'a user still refreshes their own token').toBe(undefined);
        expect(answered(refreshLane.responses).message.token.access_token, 'and gets it back in the answer').toBe('refreshed-782');
        expect(refreshLane.writes.find((entry) => entry.path === `users/${CALLER_UID}` && entry.verb === 'set'), 'on their own document').toBeTruthy();

        const deleteLane = lane();

        await deleteRoute({
          ctx: deleteLane.ctx,
          user: userFor(CALLER_UID, false, true),
          data: { provider: PROVIDER_ID },
        });

        expect(answered(deleteLane.responses).options.code, 'and still disconnects their own').toBe(undefined);
        expect(deleteLane.writes.find((entry) => entry.path === `users/${CALLER_UID}`), 'on their own document').toBeTruthy();
      },
    },

    {
      // The 400 above can only ever fire because `uid` carries NO default: a
      // default (the caller's own uid) would make `settings.uid` set on every
      // request, and droppedUidError() fires on any value — every self
      // `authorize` and every callback-page `tokenize` would answer 400.
      // Restoring one is the regression this case exists to catch.
      name: 'the-schemas-declare-uid-with-no-default',

      async run({ expect }) {
        // Resolved the way services/settings.js does: the module is a function
        // of the request's raw parts answering a declaration, validated by
        // helpers/schema.js. GET requires a provider, so every GET names one.
        const context = { user: null, body: {}, query: {}, path: '', method: 'POST', headers: {}, geolocation: {} };
        const getDeclaration = loadHandler(require.resolve('../../../dist/omega/schemas/user/connections/get.js'))(context);
        const postDeclaration = loadHandler(require.resolve('../../../dist/omega/schemas/user/connections/post.js'))(context);
        const get = (input) => validate(getDeclaration, { provider: 'google', ...input }).data;
        const post = (input) => validate(postDeclaration, input).data;

        // An absent optional string resolves to the empty value (the powertools
        // parity the field pipeline keeps), which is what droppedUidError() reads
        // as "no uid was passed". A DEFAULT here would be a real uid instead.
        for (const [label, resolved] of [
          ['GET', get({})],
          ['GET authorize', get({ action: 'authorize' })],
          ['POST', post({})],
          ['POST tokenize', post({ action: 'tokenize' })],
        ]) {
          expect(resolved.uid, `${label} resolves uid to the empty value, never a uid of its own`).toBe('');
          expect(!!resolved.uid, `${label} reads as "no uid was passed", so the self path is not the 400`).toBe(false);
        }

        // The field stays DECLARED, or a stale caller's value would be stripped
        // as an unknown key and never reach the 400 that names it
        expect(post({ uid: OTHER_UID }).uid, 'a passed uid still reaches the handler').toBe(OTHER_UID);
        expect(get({ uid: OTHER_UID }).uid, 'on both methods').toBe(OTHER_UID);

        // The defaults that DO exist are untouched
        expect(get({}).action, "GET's default action").toBe('authorize');
        expect(post({}).action, "and POST's").toBe('tokenize');
      },
    },

    {
      // The bug this issue opened on: the doc sent a trusted service to a
      // parameter `GET /user` never had.
      name: 'the-doc-sends-a-trusted-read-to-the-admin-firestore-route',

      async run({ expect }) {
        const doc = jetpack.read(DOC_PATH);

        expect(doc, `the doc is where the test expects it: ${DOC_PATH}`).toBeTruthy();
        expect(doc, 'the trusted read is the admin firestore route').toMatch(/admin\/firestore/);
        expect(doc, 'and the doc says plainly how the token is stored').toMatch(/plain text/);

        const readSection = doc.slice(doc.indexOf('## Reading the token from another target'));

        expect(readSection.startsWith('## Reading the token from another target'), 'the section is still there to be read').toBeTruthy();
        expect(readSection, 'and it is the admin firestore read a trusted service is sent to').toMatch(/admin\/firestore\?path=users\//);

        // Every line of the section that names `GET /omega/user` (the route
        // itself, not `/omega/user/connections`) either says nothing about a
        // uid or says it takes none — never that it accepts one.
        const userLines = readSection.split('\n').filter((line) => /\/omega\/user\b(?!\/)/.test(line));

        expect(userLines.length > 0, 'the read as the user is still documented').toBe(true);

        for (const line of userLines) {
          const claimsUid = /uid/.test(line) && !/\bno `?uid`?/i.test(line);

          expect(claimsUid, `GET /user is never described as taking a uid: ${line}`).toBe(false);
        }

        // The exact claim that opened the issue: "As an admin — the same call
        // with `uid`", where "the same call" was the GET /user above it.
        expect(/same call[^\n]*uid/i.test(readSection), 'no bullet sends an admin back to that call with a uid').toBe(false);
      },
    },
  ],
});
