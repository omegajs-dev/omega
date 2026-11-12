/**
 * Test: routes/user/connections — brand providers, PKCE, and the overridable
 * steps ([#771](https://github.com/Omega-JS-Stack/omega/issues/771),
 * [#793](https://github.com/Omega-JS-Stack/omega/issues/793)).
 *
 * Run (from the framework repo): npm test routes/user/connections-grant
 *
 * The lane used to be closed to every provider it did not ship: providers were
 * package files, the authorize URL and the token exchange were one hardcoded
 * shape, and a provider needing PKCE (Kick's OAuth 2.1) could not be connected
 * at all. What this pins is the extension points:
 *
 *   1. a BRAND file (`${omega.cwd}/connections/<name>.js`) wins over the package's
 *      own, and an unknown name is still the same 400;
 *   2. `pkce: 'S256'` is a DECLARATION — the verifier/challenge pair is the
 *      RFC 7636 one, the authorize URL carries the challenge and the exchange
 *      the verifier, and neither appears for a provider that declares nothing;
 *   3. `authorize` / `exchange` / `refresh` / `revoke` override the defaults and
 *      run as METHODS on the module, so `this.urls.*` keeps working;
 *   4. the default `revoke` is the RFC 7009 POST, and a provider with no
 *      `urls.revoke` answers "unsupported" instead of pretending.
 *
 * Everything here is pure: the one seam is `context.fetch`, which the defaults
 * call and a case hands a recorder. The provider identity checks (Twitch, Kick)
 * stand `wonderful-fetch` in through the require cache the way
 * `connections-log-privacy.test.js` does — the identity APIs are real external
 * services and a normal run never calls one.
 */

const path = require('path');
const jetpack = require('fs-jetpack');

// Stand wonderful-fetch in BEFORE the lane is required — `_grant.js` and the
// packaged providers reach it at module load. Restored in cleanup(), or the
// stub leaks into every file that runs later in this process.
const originalFetchPath = require.resolve('wonderful-fetch');
const originalFetchCacheEntry = require.cache[originalFetchPath];

const identityCalls = [];
let identityResponse = {};

require.cache[originalFetchPath] = {
  id: originalFetchPath,
  filename: originalFetchPath,
  loaded: true,
  exports: async (url, options) => {
    identityCalls.push({ url, options });
    return identityResponse;
  },
};

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const postRoute = loadHandler(require.resolve('../../../dist/omega/routes/user/connections/post.js'));
const deleteRoute = loadHandler(require.resolve('../../../dist/omega/routes/user/connections/delete.js'));
const twitch = require('../../../dist/omega/routes/user/connections/providers/twitch.js');
const kick = require('../../../dist/omega/routes/user/connections/providers/kick.js');
const spotify = require('../../../dist/omega/routes/user/connections/providers/spotify.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const {
  generatePkcePair,
  pkceChallenge,
  encryptState,
} = require('../../../dist/omega/routes/user/connections/_state.js');
const {
  defaultAuthorize,
  defaultExchange,
  defaultRefresh,
  defaultRevoke,
  runStep,
  REVOKE_UNSUPPORTED,
} = require('../../../dist/omega/routes/user/connections/_grant.js');
const { loadProvider } = require('../../../dist/omega/routes/user/connections/_providers.js');

function restoreFetch() {
  if (originalFetchCacheEntry) {
    require.cache[originalFetchPath] = originalFetchCacheEntry;
  } else {
    delete require.cache[originalFetchPath];
  }
}

// RFC 7636 appendix B — the one published verifier/challenge pair, so the S256
// math is checked against something other than itself.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const PLAIN_PROVIDER = {
  provider: 'plain-fixture',
  name: 'Plain Fixture',
  urls: {
    authorize: 'https://provider.test/authorize',
    token: 'https://provider.test/token',
    revoke: 'https://provider.test/revoke',
  },
  scope: ['identify'],
  params: { prompt: 'consent' },
  async identity() {
    return { id: 'plain-fixture-user' };
  },
};

const PKCE_PROVIDER = {
  ...PLAIN_PROVIDER,
  provider: 'pkce-fixture',
  name: 'PKCE Fixture',
  pkce: 'S256',
};

/** The context the routes hand a step, with a recording fetch seam. */
function stepContext(provider, extra) {
  const calls = [];

  const context = {
    provider,
    providerName: provider.provider,
    omega: null,
    ctx: { log() {} },
    uid: 'user-793',
    clientId: 'client-id-771',
    clientSecret: 'client-secret-771',
    redirectUri: 'https://brand.test/connections/callback',
    scope: provider.scope || [],
    state: 'encrypted-state-771',
    pkce: null,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { access_token: 'access-771', refresh_token: 'refresh-771' };
    },
    ...extra,
  };

  return { context, calls };
}

/** A throwaway brand provider directory: `${cwd}/connections/<name>.js`. */
function brandDir(files) {
  const dir = jetpack.tmpDir({ prefix: 'omega-connections-771' }).path();

  for (const [name, source] of Object.entries(files)) {
    jetpack.write(path.join(dir, 'connections', `${name}.js`), source);
  }

  return { cwd: dir };
}

/**
 * A Firestore stand-in that records every write — the offline lane has no
 * emulator, and what these cases are about are writes on paths that fail.
 */
function recordingFirestore(usageData) {
  const writes = [];

  const admin = {
    firestore: () => ({
      doc: (docPath) => ({
        get: async () => ({ exists: !!usageData, data: () => usageData }),
        update: async (payload) => writes.push({ verb: 'update', path: docPath, payload }),
        set: async (payload) => writes.push({ verb: 'set', path: docPath, payload }),
      }),
      collection: () => ({ where: () => ({ get: async () => ({ docs: [], size: 0 }) }) }),
    }),
  };

  return { admin, writes };
}

/** The body a step posted, as a plain object. */
function postedBody(call) {
  return Object.fromEntries(new URLSearchParams(call.options.body));
}

module.exports = defineCases({
  description: 'Connections grant: brand providers, PKCE, and the overridable steps',
  type: 'group',

  cleanup() {
    restoreFetch();
  },

  tests: [
    {
      name: 'the-pkce-pair-is-the-rfc-7636-one',

      async run({ expect }) {
        expect(pkceChallenge(RFC_VERIFIER), 'S256 of the published verifier is the published challenge').toBe(RFC_CHALLENGE);

        const pair = generatePkcePair();

        expect(pair.verifier.length, `32 random bytes base64url is 43 chars: ${pair.verifier.length}`).toBe(43);
        expect(pair.verifier, 'the verifier is base64url — no +, / or = to be re-encoded in a query').toMatch(/^[A-Za-z0-9_-]+$/);
        expect(pair.challenge, 'and so is the challenge').toMatch(/^[A-Za-z0-9_-]+$/);
        expect(pair.challenge, 'the pair is a real pair').toBe(pkceChallenge(pair.verifier));
        expect(pair.verifier, 'every authorize mints its own').not.toBe(generatePkcePair().verifier);
      },
    },

    {
      name: 'the-authorize-url-carries-the-challenge-only-for-a-pkce-provider',

      async run({ expect }) {
        const pkce = generatePkcePair();

        const withPkce = new URL(defaultAuthorize(stepContext(PKCE_PROVIDER, { pkce }).context));

        expect(withPkce.searchParams.get('code_challenge'), 'the challenge rides the URL').toBe(pkce.challenge);
        expect(withPkce.searchParams.get('code_challenge_method'), 'and names its method').toBe('S256');
        expect(withPkce.searchParams.get('code_verifier'), 'the VERIFIER never leaves the server on this leg').toBe(null);

        // The rest of the URL is what it always was
        expect(withPkce.searchParams.get('client_id'), 'the client id').toBe('client-id-771');
        expect(withPkce.searchParams.get('redirect_uri'), 'the redirect uri').toBe('https://brand.test/connections/callback');
        expect(withPkce.searchParams.get('response_type'), 'the response type').toBe('code');
        expect(withPkce.searchParams.get('state'), 'the encrypted state').toBe('encrypted-state-771');
        expect(withPkce.searchParams.get('scope'), 'the resolved scope, space-joined').toBe('identify');
        expect(withPkce.searchParams.get('prompt'), "the provider's own `params`").toBe('consent');

        const withoutPkce = new URL(defaultAuthorize(stepContext(PLAIN_PROVIDER).context));

        expect(withoutPkce.searchParams.get('code_challenge'), 'a provider that declares no PKCE sends none').toBe(null);
        expect(withoutPkce.searchParams.get('code_challenge_method'), 'and no method either').toBe(null);
      },
    },

    {
      name: 'the-exchange-body-carries-the-code-verifier-only-for-a-pkce-provider',

      async run({ expect }) {
        const pkce = generatePkcePair();
        const withPkce = stepContext(PKCE_PROVIDER, { pkce, code: 'auth-code-771' });

        const response = await defaultExchange.call(PKCE_PROVIDER, withPkce.context);

        expect(response.access_token, "the step answers the token endpoint's response").toBe('access-771');
        expect(withPkce.calls.length, 'one call to the token endpoint').toBe(1);
        expect(withPkce.calls[0].url, "the provider's ONE token url").toBe('https://provider.test/token');
        expect(withPkce.calls[0].options.timeout, 'the exchange keeps its 60s — it holds no lease').toBe(60000);

        const body = postedBody(withPkce.calls[0]);

        expect(body.code_verifier, 'the verifier proves the challenge').toBe(pkce.verifier);
        expect(body.grant_type, 'the grant type').toBe('authorization_code');
        expect(body.code, 'the code').toBe('auth-code-771');
        expect(body.client_id, 'the client id').toBe('client-id-771');
        expect(body.client_secret, 'the client secret').toBe('client-secret-771');
        expect(body.redirect_uri, 'the redirect uri').toBe('https://brand.test/connections/callback');

        const withoutPkce = stepContext(PLAIN_PROVIDER, { code: 'auth-code-771' });

        await defaultExchange.call(PLAIN_PROVIDER, withoutPkce.context);

        expect(postedBody(withoutPkce.calls[0]).code_verifier, 'a provider that declares no PKCE sends none').toBe(undefined);
      },
    },

    {
      name: 'the-default-refresh-posts-the-stored-refresh-token-to-the-same-url',

      async run({ expect }) {
        const { context, calls } = stepContext(PLAIN_PROVIDER, {
          token: { access_token: 'old-access', refresh_token: 'stored-refresh-771' },
        });

        await defaultRefresh.call(PLAIN_PROVIDER, context);

        const body = postedBody(calls[0]);

        expect(calls[0].url, 'the exchange and the refresh are ONE endpoint (#793)').toBe('https://provider.test/token');
        expect(calls[0].options.timeout, 'and 20s to answer in: a refresh runs while holding the 30s lease ([#783](https://github.com/Omega-JS-Stack/omega/issues/783)), so it may not outlive it').toBe(20000);
        expect(body.grant_type, 'the grant type').toBe('refresh_token');
        expect(body.refresh_token, 'the token the record holds').toBe('stored-refresh-771');
        expect(body.code_verifier, 'a refresh has no verifier to send').toBe(undefined);
      },
    },

    {
      // #793: revoking used to be a per-provider function with its own
      // signature; it is a step with a default now, and the default is the RFC
      name: 'the-default-revoke-is-the-rfc-7009-post',

      async run({ expect }) {
        const { context, calls } = stepContext(PLAIN_PROVIDER, {
          token: { access_token: 'access-793', refresh_token: 'refresh-793' },
        });

        const answer = await defaultRevoke.call(PLAIN_PROVIDER, context);

        expect(answer, 'a revoke that worked answers nothing').toBe(undefined);
        expect(calls[0].url, "the provider's revoke url").toBe('https://provider.test/revoke');
        expect(calls[0].options.method, 'as a POST').toBe('POST');

        const body = postedBody(calls[0]);

        expect(body.token, 'carrying the access token').toBe('access-793');
        expect(body.client_id, 'and the client the provider knows this app by').toBe('client-id-771');
        expect(body.client_secret, 'with its secret when there is one').toBe('client-secret-771');

        // A public client has none to send ([#785](https://github.com/Omega-JS-Stack/omega/issues/785))
        const publicClient = stepContext(PLAIN_PROVIDER, { clientSecret: '', token: { access_token: 'access-793' } });

        await defaultRevoke.call(PLAIN_PROVIDER, publicClient.context);

        expect('client_secret' in postedBody(publicClient.calls[0]), 'an empty secret is no secret here either').toBe(false);
      },
    },

    {
      name: 'a-provider-with-no-revoke-url-answers-unsupported-and-calls-nothing',

      async run({ expect }) {
        const noRevoke = { ...PLAIN_PROVIDER, urls: { authorize: 'https://provider.test/authorize', token: 'https://provider.test/token' } };
        const { context, calls } = stepContext(noRevoke, { token: { access_token: 'access-793' } });

        const answer = await defaultRevoke.call(noRevoke, context);

        expect(answer, 'the step says so rather than pretending it revoked').toBe(REVOKE_UNSUPPORTED);
        expect(calls.length, 'and no request went out').toBe(0);
        expect(spotify.urls.revoke, 'Spotify is the packaged provider in exactly this position').toBe(undefined);
      },
    },

    {
      // The record goes whatever the provider says: the user asked to be
      // disconnected, and a provider that cannot revoke does not get a veto
      name: 'the-delete-removes-the-record-even-when-the-revoke-cannot-run',

      async run({ expect }) {
        const omega = brandDir({
          'unrevokable-793': [
            'module.exports = {',
            "  provider: 'unrevokable-793',",
            "  name: 'Unrevokable',",
            "  urls: { authorize: 'https://brand.test/a', token: 'https://brand.test/t' },",
            "  async identity() { return { id: 'x' }; },",
            '};',
          ].join('\n'),
        });

        const { admin, writes } = recordingFirestore(null);

        Object.assign(omega, {
          firebase: { admin },
          project: { websiteUrl: 'https://brand.test' },
          config: { brand: { name: 'Test Brand' } },
        });

        const logged = [];
        const responses = [];
        const ctx = {
          omega,
          metadata: () => ({}),
          log: (...args) => logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
          respond: (message, options) => {
            responses.push({ message, options: options || {} });
            return { message, options: options || {} };
          },
        };

        await deleteRoute({
          ctx,
          user: {
            authenticated: true,
            auth: { uid: 'user-793' },
            roles: { admin: false },
            connections: { 'unrevokable-793': { x: { token: { access_token: 'access-793' }, identity: { id: 'x' } } } },
          },
          data: { provider: 'unrevokable-793' },
        });

        expect(responses[0].message.success, 'the disconnect succeeds').toBe(true);
        expect(logged.some((line) => line.includes('unsupported')), `and the log says the provider could not be told: ${logged.join(' | ')}`).toBeTruthy();

        const deleted = writes.find((write) => write.path === 'users/user-793');
        const removed = deleted && (deleted.payload.connections?.['unrevokable-793']?.x ?? deleted.payload['connections.unrevokable-793.x']);

        expect(deleted, 'the record is deleted').toBeTruthy();
        expect(removed?.methodName, `and it is the one account's record that went: ${JSON.stringify(deleted?.payload)}`).toBe('FieldValue.delete');
      },
    },

    {
      // A PUBLIC client ([#785](https://github.com/Omega-JS-Stack/omega/issues/785)):
      // Twitch registers one, the brand holds a client id and no secret, and the
      // body used to carry `client_secret=` empty — which a token endpoint reads
      // as a WRONG secret, not as no secret, and refuses the grant with it.
      name: 'a-public-client-sends-no-client_secret-key-at-all',

      async run({ expect }) {
        const omega = brandDir({
          'public-fixture-785': "module.exports = { provider: 'public-fixture-785', name: 'Public Fixture', urls: { authorize: 'https://brand.test/a', token: 'https://brand.test/t' }, async identity() { return { id: 'x' }; } };",
        });

        // The credentials as the LANE resolves them for a provider whose
        // CONNECTIONS_<PROVIDER>_CLIENT_SECRET is not in the brand's .env
        const resolved = loadProvider('public-fixture-785', omega);

        expect(resolved.clientSecret, 'an unset CONNECTIONS_<PROVIDER>_CLIENT_SECRET resolves to nothing').toBe(undefined);

        const exchange = stepContext(PLAIN_PROVIDER, { code: 'auth-code-785', clientSecret: resolved.clientSecret });

        await defaultExchange.call(PLAIN_PROVIDER, exchange.context);

        const exchangeBody = postedBody(exchange.calls[0]);

        expect('client_secret' in exchangeBody, 'the KEY is absent from the exchange, not present and empty').toBe(false);
        expect(exchangeBody.client_id, 'the client id still rides — that is what a public client identifies with').toBe('client-id-771');
        expect(exchangeBody.code, 'and the code').toBe('auth-code-785');

        const refresh = stepContext(PLAIN_PROVIDER, { clientSecret: resolved.clientSecret, token: { refresh_token: 'stored-refresh-785' } });

        await defaultRefresh.call(PLAIN_PROVIDER, refresh.context);

        expect('client_secret' in postedBody(refresh.calls[0]), 'and absent from the refresh too — the same client, the same registration').toBe(false);

        // A brand's `.env` writes an empty value as KEY="", which is the same
        // "no secret" as the key never being there
        const empty = stepContext(PLAIN_PROVIDER, { code: 'auth-code-785', clientSecret: '' });

        await defaultExchange.call(PLAIN_PROVIDER, empty.context);

        expect('client_secret' in postedBody(empty.calls[0]), 'an empty secret is no secret').toBe(false);
      },
    },

    {
      // The public-client flow in full: no secret to send, and the PKCE verifier
      // is what proves the exchange in its place
      // ([#771](https://github.com/Omega-JS-Stack/omega/issues/771) +
      // [#785](https://github.com/Omega-JS-Stack/omega/issues/785)).
      name: 'a-public-pkce-client-proves-the-exchange-with-the-verifier',

      async run({ expect }) {
        const pkce = generatePkcePair();
        const { context, calls } = stepContext(PKCE_PROVIDER, { pkce, code: 'auth-code-785', clientSecret: undefined });

        await defaultExchange.call(PKCE_PROVIDER, context);

        const body = postedBody(calls[0]);

        expect('client_secret' in body, 'no secret rides — the brand has none').toBe(false);
        expect(body.code_verifier, 'and the verifier does, which is what stands in for it').toBe(pkce.verifier);
        expect(body.client_id, 'beside the client id').toBe('client-id-771');
        expect(body.grant_type, 'on the same grant as any other client').toBe('authorization_code');
      },
    },

    {
      // The other half of #785: a CONFIDENTIAL client's request may not change
      // by a byte — every provider the lane already serves posts these exact
      // bodies today.
      name: 'a-confidential-clients-bodies-are-unchanged',

      async run({ expect }) {
        const exchange = stepContext(PLAIN_PROVIDER, { code: 'auth-code-785' });

        await defaultExchange.call(PLAIN_PROVIDER, exchange.context);

        expect(exchange.calls[0].options.body.toString(), 'the exchange body, field for field and in order').toBe('client_id=client-id-771&client_secret=client-secret-771&grant_type=authorization_code&redirect_uri=https%3A%2F%2Fbrand.test%2Fconnections%2Fcallback&code=auth-code-785');

        const refresh = stepContext(PLAIN_PROVIDER, { token: { refresh_token: 'stored-refresh-785' } });

        await defaultRefresh.call(PLAIN_PROVIDER, refresh.context);

        expect(refresh.calls[0].options.body.toString(), 'and the refresh body').toBe('client_id=client-id-771&client_secret=client-secret-771&grant_type=refresh_token&refresh_token=stored-refresh-785');
      },
    },

    {
      name: 'an-override-runs-as-a-method-and-its-answer-is-the-one-used',

      async run({ expect }) {
        const seen = {};

        const provider = {
          ...PLAIN_PROVIDER,
          provider: 'override-fixture',
          authorize(context) {
            seen.authorizeThis = this;
            seen.authorizeContext = context;
            // `this.urls.*` is the shape every shipped provider already uses
            return `${this.urls.authorize}?custom=1`;
          },
          async exchange() {
            seen.exchangeThis = this;
            return { access_token: 'from-the-override' };
          },
          async refresh() {
            seen.refreshThis = this;
            return { access_token: 'refreshed-by-the-override' };
          },
          async revoke() {
            seen.revokeThis = this;
          },
        };

        const { context, calls } = stepContext(provider, { code: 'auth-code-771', token: { access_token: 'a', refresh_token: 'r' } });

        const url = await runStep(provider, 'authorize', context);
        const exchanged = await runStep(provider, 'exchange', context);
        const refreshed = await runStep(provider, 'refresh', context);

        await runStep(provider, 'revoke', context);

        expect(url, "the override's URL is the one used").toBe('https://provider.test/authorize?custom=1');
        expect(exchanged.access_token, "the override's token response is the one used").toBe('from-the-override');
        expect(refreshed.access_token, "the override's refresh is the one used").toBe('refreshed-by-the-override');
        expect(calls.length, 'and no default ran behind it').toBe(0);

        expect(seen.authorizeThis, '`this` is the provider module, so this.urls.* works').toBe(provider);
        expect(seen.exchangeThis, 'the exchange too').toBe(provider);
        expect(seen.refreshThis, 'the refresh').toBe(provider);
        expect(seen.revokeThis, 'and the revoke').toBe(provider);
        expect(seen.authorizeContext.provider, 'the context carries the module, so an override never needs `this`').toBe(provider);
        expect(seen.authorizeContext.providerName, 'and the name it was loaded by').toBe('override-fixture');
        expect(seen.authorizeContext.uid, 'and the user the connect is for (#793)').toBe('user-793');

        // A provider that overrides nothing runs the defaults through the SAME call
        const url2 = await runStep(PLAIN_PROVIDER, 'authorize', stepContext(PLAIN_PROVIDER).context);

        expect(url2, 'no override means the default step').toMatch(/^https:\/\/provider\.test\/authorize\?/);
      },
    },

    {
      name: 'a-brand-provider-file-wins-over-the-package-one',

      async run({ expect }) {
        const shape = "urls: { authorize: 'https://brand.test/a', token: 'https://brand.test/t' }, async identity() { return { id: 'x' }; }";

        const omega = brandDir({
          google: `module.exports = { provider: 'google', name: 'Brand Google', ${shape} };`,
          'house-provider': `module.exports = { provider: 'house-provider', name: 'House', ${shape} };`,
        });

        const shadowed = loadProvider('google', omega);

        expect(shadowed.connectionProvider.name, "the brand's own file wins for a name the package also ships").toBe('Brand Google');

        const brandOnly = loadProvider('house-provider', omega);

        expect(brandOnly.connectionProvider.name, 'a provider only the brand has loads').toBe('House');

        const packaged = loadProvider('google', { cwd: jetpack.tmpDir({ prefix: 'omega-connections-771-empty' }).path() });

        expect(packaged.connectionProvider.name, 'with no brand file, the package provider still loads').toBe('Google');

        const noBrand = loadProvider('discord', null);

        expect(noBrand.connectionProvider.provider, 'and a caller with no omega reads the package dir alone').toBe('discord');
      },
    },

    {
      name: 'an-unknown-provider-is-still-the-same-400',

      async run({ expect }) {
        const omega = brandDir({});

        const unknown = loadProvider('not-a-provider', omega);

        expect(unknown.error.code, 'the code the route answers').toBe(400);
        expect(unknown.error.message, 'and the message it has always answered').toBe('Unknown connection provider: not-a-provider');

        const traversal = loadProvider('../../../../etc/passwd', omega);

        expect(traversal.error.code, 'a name that could escape the directory is just unknown').toBe(400);
      },
    },

    {
      name: 'a-provider-file-missing-its-shape-fails-loudly-at-load',

      async run({ expect }) {
        const identity = "async identity() { return { id: 'x' }; }";

        const omega = brandDir({
          'no-authorize': `module.exports = { provider: 'no-authorize', urls: { token: 'https://brand.test/t' }, ${identity} };`,
          'no-token': `module.exports = { provider: 'no-token', urls: { authorize: 'https://brand.test/a' }, ${identity} };`,
          'no-identity': "module.exports = { provider: 'no-identity', urls: { authorize: 'https://brand.test/a', token: 'https://brand.test/t' } };",
          'bad-pkce': `module.exports = { provider: 'bad-pkce', pkce: 'plain', urls: { authorize: 'https://brand.test/a', token: 'https://brand.test/t' }, ${identity} };`,
        });

        const expected = [
          ['no-authorize', 'urls.authorize'],
          ['no-token', 'urls.token'],
          ['no-identity', 'identity()'],
          ['bad-pkce', 'pkce'],
        ];

        for (const [name, missing] of expected) {
          let thrown = null;

          try {
            loadProvider(name, omega);
          } catch (e) {
            thrown = e;
          }

          expect(thrown, `${name} is a broken provider, not an unknown one — it throws`).toBeTruthy();
          expect(thrown.message.includes(`${name}.js`), `the message names the file: ${thrown.message}`).toBe(true);
          expect(thrown.message.includes(missing), `and the missing field: ${thrown.message}`).toBe(true);
          expect(thrown.message.includes(omega.cwd), `never the deployed path, which is not a caller's to see: ${thrown.message}`).toBe(false);
        }
      },
    },

    {
      // The verifier is a ONE-TIME secret. It used to be deleted only on the
      // success path, so an exchange that failed (or an identity check that
      // threw, or a provider that answered no refresh_token) left it in
      // `usage/<uid>` to be replayed with the same code.
      name: 'a-failing-exchange-still-clears-the-one-time-session',

      async run({ expect }) {
        const uid = 'user-771';
        const providerName = 'failing-exchange';
        const omega = brandDir({
          [providerName]: [
            'module.exports = {',
            `  provider: '${providerName}',`,
            "  name: 'Failing Exchange',",
            "  urls: { authorize: 'https://brand.test/a', token: 'https://brand.test/t' },",
            "  pkce: 'S256',",
            "  async exchange() { throw new Error('the provider said no'); },",
            "  async identity() { return { id: 'x' }; },",
            '};',
          ].join('\n'),
        });

        const { admin, writes } = recordingFirestore({
          connections: { [providerName]: { csrf: 'csrf-771', verifier: 'verifier-771', createdAt: Date.now() } },
        });

        Object.assign(omega, {
          firebase: { admin },
          project: { websiteUrl: 'https://brand.test' },
          config: { brand: { name: 'Test Brand' } },
        });

        const responses = [];
        const ctx = {
          omega,
          metadata: () => ({}),
          log() {},
          respond: (message, options) => {
            responses.push({ message, options });
            return { message, options };
          },
          meta: { startTime: { timestamp: 'now', timestampUNIX: 1 } },
        };

        const encryptedState = encryptState({ provider: providerName, uid, csrf: 'csrf-771', ts: Date.now() });

        await postRoute({ ctx, user: {}, data: { action: 'tokenize', code: 'auth-code-771', encryptedState } });

        expect(responses[0].options.code, 'the exchange failure is still reported').toBe(500);
        expect(responses[0].message.includes('Token exchange failed'), `with its own message: ${responses[0].message}`).toBe(true);

        const sessionDelete = writes.find((write) => write.path === `usage/${uid}` && write.verb === 'update');

        expect(sessionDelete, 'the one-time session was cleared even though the exchange failed').toBeTruthy();
        expect(`connections.${providerName}` in sessionDelete.payload, 'and it is the provider entry that was deleted').toBe(true);
        expect(writes.some((write) => write.path.startsWith('users/')), 'nothing was recorded on the user — there was no token to record').toBe(false);
      },
    },

    {
      name: 'twitch-identifies-against-helix-with-the-client-id-from-the-context',

      async run({ expect }) {
        identityCalls.length = 0;
        identityResponse = { data: [{ id: 'twitch-1', login: 'ianwieds', email: 'buyer@example.com' }] };

        expect(twitch.pkce, 'Twitch is a plain authorization-code provider').toBe(undefined);
        expect(typeof twitch.urls.authorize, 'it declares an authorize url').toBe('string');

        // The env read is GONE ([#793](https://github.com/Omega-JS-Stack/omega/issues/793)):
        // the credentials ride the context, resolved once by the lane. A stale
        // env value must not be able to reach the call.
        const originalClientId = process.env.CONNECTIONS_TWITCH_CLIENT_ID;
        process.env.CONNECTIONS_TWITCH_CLIENT_ID = 'never-read-793';

        let identity;

        try {
          identity = await twitch.identity({
            ctx: { log() {} },
            uid: 'user-771',
            clientId: 'twitch-client-771',
            token: { access_token: 'access-771', token_type: 'Bearer' },
            fetch: require('wonderful-fetch'),
          });
        } finally {
          if (originalClientId === undefined) {
            delete process.env.CONNECTIONS_TWITCH_CLIENT_ID;
          } else {
            process.env.CONNECTIONS_TWITCH_CLIENT_ID = originalClientId;
          }
        }

        expect(identity.id, "the helix payload's user is the identity, not the envelope").toBe('twitch-1');
        expect(identity.login, 'with its fields intact').toBe('ianwieds');
        expect(identityCalls[0].url, 'the users endpoint').toBe('https://api.twitch.tv/helix/users');
        expect(identityCalls[0].options.headers['Client-Id'], "Twitch requires the app id beside the token, and it is the CONTEXT's").toBe('twitch-client-771');
        expect(identityCalls[0].options.headers.authorization, 'and the bearer token').toBe('Bearer access-771');
      },
    },

    {
      name: 'kick-revokes-at-its-own-endpoint-and-stringifies-its-user-id',

      async run({ expect }) {
        identityCalls.length = 0;
        identityResponse = {};

        expect(kick.pkce, 'Kick is OAuth 2.1 — PKCE is not optional there').toBe('S256');

        await kick.revoke({
          ctx: { log() {} },
          clientId: 'kick-client-771',
          clientSecret: 'kick-secret-771',
          token: { access_token: 'access-771' },
          fetch: require('wonderful-fetch'),
        });

        expect(identityCalls[0].url, "the provider's own revoke url").toBe(kick.urls.revoke);
        expect(identityCalls[0].options.method, 'as a POST').toBe('POST');

        const body = Object.fromEntries(new URLSearchParams(identityCalls[0].options.body));

        expect(body.token, 'carrying the token').toBe('access-771');
        expect(body.token_hint_type, 'and the hint Kick wants beside it').toBe('access_token');

        // Kick's public API answers `user_id` as a NUMBER, and the route matches
        // on a string id
        identityCalls.length = 0;
        identityResponse = { data: [{ user_id: 8675309, name: 'ianwieds', email: 'buyer@example.com' }] };

        const identity = await kick.identity({
          ctx: { log() {} },
          uid: 'user-771',
          token: { access_token: 'access-771', token_type: 'Bearer' },
          fetch: require('wonderful-fetch'),
        });

        expect(identity.id, 'the id is the stringified user_id').toBe('8675309');
        expect(identity.user_id, "and Kick's own field is stored as it answered it").toBe(8675309);
        expect(identityCalls[0].url, 'the users endpoint').toBe('https://api.kick.com/public/v1/users');
        expect(identityCalls[0].options.headers.authorization, 'with the bearer token').toBe('Bearer access-771');
      },
    },
  ],
});
