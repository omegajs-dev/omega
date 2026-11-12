/**
 * Test: routes/user/connections — the ROUTE owns identity uniqueness
 * ([#793](https://github.com/Omega-JS-Stack/omega/issues/793),
 * [#791](https://github.com/Omega-JS-Stack/omega/issues/791)).
 *
 * Run (from the framework repo): npm test routes/user/connections-identity
 *
 * The "this account is already connected" guard used to be copied into every
 * provider, and every copy matched the CONNECTING user's own document too: a
 * user reconnecting — to widen a scope, or after a failed refresh left the
 * record behind — was told their own account belonged to somebody else. The
 * check lives in `tokenize` now, it runs ONE query, and it refuses only a
 * document that is not the connecting user's.
 *
 * What it also pins: an `identity()` that answers no string `id` is a
 * PROGRAMMER error (it throws naming the file, never a 400 the user could act
 * on), Google matches on `sub` rather than the email an account can change,
 * and every packaged provider satisfies the shape the lane asserts at load.
 *
 * Everything is offline: the routes are called directly with a hand-rolled ctx
 * and a recording Firestore stand-in, and the fixture provider overrides every
 * step that would leave the machine.
 */

const path = require('path');
const jetpack = require('fs-jetpack');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const postRoute = loadHandler(require.resolve('../../../dist/omega/routes/user/connections/post.js'));
const { encryptState } = require('../../../dist/omega/routes/user/connections/_state.js');
const { assertProviderShape } = require('../../../dist/omega/routes/user/connections/_providers.js');
const google = require('../../../dist/omega/routes/user/connections/providers/google.js');
const discord = require('../../../dist/omega/routes/user/connections/providers/discord.js');
const spotify = require('../../../dist/omega/routes/user/connections/providers/spotify.js');
const twitch = require('../../../dist/omega/routes/user/connections/providers/twitch.js');
const kick = require('../../../dist/omega/routes/user/connections/providers/kick.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');
const { recordingFirestore } = require('../../helpers/_recording-firestore.js');

const PROVIDER_ID = 'identity-fixture-793';
const OWNER_UID = 'owner-793';
const OTHER_UID = 'stranger-793';
const IDENTITY_ID = 'provider-account-793';

/** The fixture provider: every network step is an override, `identity` included. */
function providerSource({ identity = `{ id: '${IDENTITY_ID}', name: 'Fixture User' }` } = {}) {
  return [
    'module.exports = {',
    `  provider: '${PROVIDER_ID}',`,
    "  name: 'Identity Fixture',",
    "  urls: { authorize: 'https://provider.test/a', token: 'https://provider.test/t' },",
    "  async exchange() { return { access_token: 'access-793', refresh_token: 'refresh-793', token_type: 'Bearer', expires_in: 3600, scope: 'identify' }; },",
    `  async identity() { return ${identity}; },`,
    '};',
  ].join('\n');
}

/** The lane, wired: a brand provider dir, a recording Firestore, and a ctx. */
function lane({ source = providerSource(), matches = [] } = {}) {
  const cwd = jetpack.tmpDir({ prefix: 'omega-connections-793' }).path();

  jetpack.write(path.join(cwd, 'connections', `${PROVIDER_ID}.js`), source);

  const { admin, writes, queries } = recordingFirestore({
    docs: { [`usage/${OWNER_UID}`]: { connections: { [PROVIDER_ID]: { csrf: 'csrf-793', verifier: null, createdAt: Date.now() } } } },
    matches,
  });

  const omega = {
    cwd,
    firebase: { admin },
    project: { websiteUrl: 'https://brand.test' },
    config: { brand: { name: 'Test Brand' } },
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
    meta: { startTime: { timestamp: 'now', timestampUNIX: 1 } },
  };

  return { ctx, writes, queries, responses };
}

/** One tokenize leg against the fixture provider. */
async function tokenize(options) {
  const wired = lane(options);

  const encryptedState = encryptState({ provider: PROVIDER_ID, uid: OWNER_UID, csrf: 'csrf-793', ts: Date.now() });

  const thrown = await postRoute({
    ctx: wired.ctx,
    user: {},
    data: { action: 'tokenize', code: 'auth-code-793', encryptedState },
  }).catch((e) => e);

  return { ...wired, thrown, answer: wired.responses[wired.responses.length - 1] || {} };
}

/** A matched user document, as a query snapshot carries it. */
function matchedDoc(uid) {
  return { id: uid, data: () => ({ connections: { [PROVIDER_ID]: { [IDENTITY_ID]: { identity: { id: IDENTITY_ID } } } } }) };
}

/** A JWT with the given payload — Google's id_token, as jwt-decode reads it. */
function idToken(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

  return `${part({ alg: 'RS256' })}.${part(payload)}.signature`;
}

module.exports = defineCases({
  description: 'Connections: the route owns identity uniqueness',
  type: 'group',

  tests: [
    {
      // #791: the copies in the providers matched the caller's OWN document, so
      // this — the ordinary "connect again" — was refused as somebody else's
      name: 'reconnecting-your-own-account-passes',

      async run({ expect }) {
        const run = await tokenize({ matches: [matchedDoc(OWNER_UID)] });

        expect(run.answer.options.code, `a user reconnecting is not a conflict: ${run.answer.message}`).toBe(undefined);
        expect(run.answer.message.success, 'the exchange completes').toBe(true);

        const stored = run.writes.find((write) => write.path === `users/${OWNER_UID}` && write.payload.connections);

        expect(stored, 'and the record is written').toBeTruthy();
        expect(stored.payload.connections[PROVIDER_ID][IDENTITY_ID].identity.id, 'under the identity the provider answered').toBe(IDENTITY_ID);
      },
    },

    {
      name: 'the-query-is-one-lookup-on-the-identity-id',

      async run({ expect }) {
        const run = await tokenize({ matches: [] });

        expect(run.queries.length, `ONE query, whatever the answer: ${JSON.stringify(run.queries)}`).toBe(1);
        // The id is a map key, so the field is a FieldPath (an id may carry a `.`)
        const { field, ...rest } = run.queries[0];

        expect(rest, 'an equality on the identity id').toEqual({ collection: 'users', operator: '==', value: IDENTITY_ID });
        expect(typeof field === 'string' ? field.split('.') : field.segments, 'on the stored identity id, at its own record under the provider').toEqual(['connections', PROVIDER_ID, IDENTITY_ID, 'identity', 'id']);
      },
    },

    {
      name: 'another-users-account-is-refused-with-400',

      async run({ expect }) {
        const run = await tokenize({ matches: [matchedDoc(OTHER_UID)] });

        expect(run.answer.options.code, `a connection somebody else holds is refused: ${run.answer.message}`).toBe(400);
        expect(run.answer.message, "naming the provider by its human name").toMatch(/Identity Fixture/);
        expect(run.answer.message, 'and the brand it is already connected to').toMatch(/Test Brand/);
        expect(run.writes.some((write) => write.path.startsWith('users/')), 'and nothing is written to any user').toBe(false);
      },
    },

    {
      // Not a 400: a caller cannot fix this, and a connection the lane cannot
      // match would silently let two accounts hold one identity
      name: 'an-identity-with-no-string-id-throws-naming-the-provider-file',

      async run({ expect }) {
        const run = await tokenize({ source: providerSource({ identity: "{ name: 'No Id' }" }) });

        expect(run.thrown instanceof Error, 'a provider that answers no id is a programmer error, not a refusal').toBeTruthy();
        expect(run.thrown.message, `the message names the file: ${run.thrown.message}`).toMatch(new RegExp(`${PROVIDER_ID}\\.js`));
        expect(run.thrown.message, 'and the field it is missing').toMatch(/id/);
        expect(run.writes.some((write) => write.path.startsWith('users/')), 'nothing was stored').toBe(false);

        const numeric = await tokenize({ source: providerSource({ identity: '{ id: 12345 }' }) });

        expect(numeric.thrown instanceof Error, 'a number is not an id either — the query would never match one').toBeTruthy();
      },
    },

    {
      // #793: an email changes hands, a `sub` does not
      name: 'google-answers-its-id-from-sub',

      async run({ expect }) {
        const identity = await google.identity({
          ctx: { log() {} },
          uid: OWNER_UID,
          token: { access_token: 'access-793', id_token: idToken({ sub: '110000000000000000001', email: 'buyer@example.com', name: 'Ian' }) },
        });

        expect(identity.id, 'the id the route matches on is the sub').toBe('110000000000000000001');
        expect(identity.sub, 'and the decoded profile is stored whole').toBe('110000000000000000001');
        expect(identity.email, 'email included — it is just no longer the key').toBe('buyer@example.com');
      },
    },

    {
      name: 'every-packaged-provider-satisfies-the-shape',

      async run({ expect }) {
        for (const provider of [google, discord, spotify, twitch, kick]) {
          const file = `${provider.provider}.js`;

          expect(assertProviderShape(provider, file), `${file} loads`).toBe(provider);
          expect(typeof provider.identity, `${file} declares identity()`).toBe('function');
          expect(provider.urls.authorize, `${file} says where the user is sent`).toBeTruthy();
          expect(provider.urls.token, `${file} says how the code becomes a token`).toBeTruthy();
          expect(provider.urls.status, `${file} declares no dead urls.status`).toBe(undefined);
          expect(provider.urls.tokenize, `${file} has no urls.tokenize any more`).toBe(undefined);
          expect(provider.urls.refresh, `${file} has no urls.refresh any more`).toBe(undefined);
          expect(provider.authParams, `${file} names its extra params \`params\``).toBe(undefined);
          expect(provider.verifyIdentity, `${file} carries no verifyIdentity()`).toBe(undefined);
          expect(provider.revokeToken, `${file} carries no revokeToken()`).toBe(undefined);
          expect(provider.verifyConnection, `${file} carries no verifyConnection()`).toBe(undefined);
        }

        expect(typeof google.revoke, 'Google keeps its own revoke (the endpoint takes the token alone)').toBe('function');
        expect(typeof kick.revoke, 'and Kick (it wants a token hint)').toBe('function');
        expect(discord.revoke, 'Discord uses the RFC 7009 default').toBe(undefined);
        expect(twitch.revoke, 'and Twitch').toBe(undefined);
        expect(spotify.urls.revoke, 'Spotify declares no revoke url at all').toBe(undefined);
      },
    },
  ],
});
