/**
 * Account service tests — the users operation against method-level
 * recording fakes of the auth admin, Firestore, and backend clients, with
 * the password derivation and custom-token signing real. Proves skip
 * semantics, the owner password channels (OMEGA_ACCOUNT_PASSWORD__* env
 * pin → config/hooks/account/password.js hook, brand + company, with real
 * hook files → lazy ACCOUNT_PASSWORD_SEED derivation), the seed .env
 * writeback (and that dry runs and env/hook-covered brands never write
 * it), the converged zero-mutation no-op, account creation with signup,
 * password convergence, the leaf-path admin/plan merge (and the
 * no-products no-op omega-manager got wrong), the {domain} template,
 * marketing-only entries, the unauthorized-admin audit error, and the
 * dry-run zero-mutation guarantee.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const { generateKeyPairSync, createVerify } = require('node:crypto');
const jetpack = require('fs-jetpack');

const { SERVICE_ORDER, OPERATIONS, DEFAULTS } = require('../src/config.js');
const { derivePassword } = require('../src/services/account/lib/password.js');
const { passwordEnvVar } = require('../src/services/account/lib/resolve-password.js');
const { createAuthAdmin, CUSTOM_TOKEN_AUD } = require('../src/lib/auth-admin.js');
const { writeEnvValue } = require('../src/lib/env-secret.js');
const service = require('../src/services/account/index.js');

delete process.env.ACCOUNT_PASSWORD_SEED;

const SEED = 'fixture-seed';
const DOMAIN = 'fixture-brand.test';
const EMAIL = `support@${DOMAIN}`;
const PASSWORD = derivePassword(SEED, EMAIL, DOMAIN);

const USER = { uid: 'uid-support', email: EMAIL, providerData: [{ providerId: 'google.com' }] };
const ADMIN_DOC = { roles: { admin: true }, subscription: { product: { id: 'pro', name: 'Pro' } } };
const ADMIN_QUERY = {
  from: [{ collectionId: 'users' }],
  where: {
    fieldFilter: {
      field: { fieldPath: 'roles.admin' },
      op: 'EQUAL',
      value: { booleanValue: true },
    },
  },
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

function stageBrand() {
  return mkdtempSync(join(tmpdir(), 'omega-account-'));
}

function brandConfig({ account, admins, products, cloud, url } = {}) {
  const config = {
    brand: { id: 'fixture-brand', name: 'Fixture Brand', url: url !== undefined ? url : `https://${DOMAIN}` },
    targets: { web: { type: 'web' }, backend: { type: 'backend' } },
    // The Firebase web API key comes from config now (#434) — the cloud
    // service's sdk-config writeback is what puts it there
    cloud: cloud || { shared: false, config: { apiKey: 'fixture-api-key' } },
    payment: {
      products: products !== undefined ? products : [
        { id: 'basic', name: 'Basic' },
        { id: 'pro', name: 'Pro' },
      ],
    },
  };
  if (account !== undefined) {
    config.account = account;
  } else {
    config.account = {
      enabled: true,
      admins: admins || [{ email: 'support@{domain}', account: true, marketing: true }],
    };
  }
  return config;
}

/** Method-level recording fake — a call with no configured response throws LOUDLY. */
function makeFake(name, methods, mutating, responses) {
  const api = { calls: [] };

  for (const method of methods) {
    api[method] = async (...args) => {
      api.calls.push({ method, args });
      if (!(method in responses)) {
        throw new Error(`${name}: unexpected call ${method}(${JSON.stringify(args[0])})`);
      }
      const responder = responses[method];
      return typeof responder === 'function' ? responder(...args) : structuredClone(responder);
    };
  }

  api.mutations = () => api.calls.filter((c) => mutating.has(c.method));
  api.of = (method) => api.calls.filter((c) => c.method === method);
  return api;
}

function fakeAuth(responses = {}) {
  return makeFake('fakeAuth', ['getUserByEmail', 'getUser', 'createUser', 'updateUser', 'createCustomToken'],
    new Set(['createUser', 'updateUser']), responses);
}

function fakeFirestore(responses = {}) {
  return makeFake('fakeFirestore', ['getDoc', 'patchDoc', 'runQuery'],
    new Set(['patchDoc']), responses);
}

function fakeBackend(responses = {}) {
  return makeFake('fakeBackend', ['verifyPassword', 'signup', 'syncMarketingContact'],
    new Set(['signup', 'syncMarketingContact']), responses);
}

/** Fakes for a fully converged brand (nothing to change). */
function convergedClients() {
  return {
    auth: fakeAuth({ getUserByEmail: USER, getUser: USER }),
    firestore: fakeFirestore({ getDoc: ADMIN_DOC, runQuery: [{ id: USER.uid, data: {} }] }),
    backend: fakeBackend({ verifyPassword: true, syncMarketingContact: undefined }),
  };
}

async function runService(config, { root, auth, firestore, backend, options = {}, seed = SEED } = {}) {
  const previousSeed = process.env.ACCOUNT_PASSWORD_SEED;
  if (seed === null) {
    delete process.env.ACCOUNT_PASSWORD_SEED;
  } else {
    process.env.ACCOUNT_PASSWORD_SEED = seed;
  }

  try {
    return await service.run({
      brandId: 'fixture-brand',
      brandRoot: root || stageBrand(),
      brandConfig: config,
      operations: OPERATIONS.account,
      options,
      serviceData: {},
      authAdmin: auth,
      firestore,
      accountBackend: backend,
    });
  } finally {
    if (previousSeed === undefined) {
      delete process.env.ACCOUNT_PASSWORD_SEED;
    } else {
      process.env.ACCOUNT_PASSWORD_SEED = previousSeed;
    }
  }
}

// ─── Owner password channels (env → hook → seed) ─────────────────────────────

/** Write a hook file under a root's config/hooks/ tree. */
function writeHook(root, hookPath, source) {
  const file = join(root, 'config', 'hooks', ...hookPath.split('/')) + '.js';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return file;
}

module.exports = defineCases({
  type: 'group',
  description: 'account',
  tests: [
    // ─── Registry / defaults / password pins ─────────────────────────────────────

    {
      name: 'account: registered after update, before testing, with the users operation',
      run: (ctx) => {
        ctx.expect(SERVICE_ORDER[SERVICE_ORDER.indexOf('update') + 1]).toBe('account');
        ctx.expect(SERVICE_ORDER[SERVICE_ORDER.indexOf('account') + 1]).toBe('migrations');
        ctx.expect(OPERATIONS.account.map((o) => o.name)).toEqual(['users']);
        ctx.expect(DEFAULTS.account).toEqual({
          enabled: true,
          admins: [{ email: 'support@{domain}', account: true, marketing: true }],
        });
      },
    },

    {
      name: 'account: derivePassword is deterministic with guaranteed complexity classes',
      run: (ctx) => {
        ctx.expect(derivePassword(SEED, EMAIL, DOMAIN)).toBe(PASSWORD);
        ctx.expect(PASSWORD).toMatch(/^A1![A-Za-z0-9_-]{20}$/);
      },
    },

    {
      name: 'account: derivePassword varies per email, domain, and seed',
      run: (ctx) => {
        ctx.expect(derivePassword(SEED, 'other@x.com', DOMAIN)).not.toBe(PASSWORD);
        ctx.expect(derivePassword(SEED, EMAIL, 'other-brand.test')).not.toBe(PASSWORD);
        ctx.expect(derivePassword('other-seed', EMAIL, DOMAIN)).not.toBe(PASSWORD);
      },
    },

    {
      name: 'account: derivePassword uses the apex domain so subdomains do not rotate passwords',
      run: (ctx) => {
        const base = derivePassword(SEED, EMAIL, 'mybrand.com');
        ctx.expect(derivePassword(SEED, EMAIL, 'www.mybrand.com')).toBe(base);
        ctx.expect(derivePassword(SEED, EMAIL, 'api.mybrand.com')).toBe(base);
      },
    },

    {
      name: 'account: custom tokens carry the Firebase audience and uid, signed by the service account',
      run: (ctx) => {
        const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const client = createAuthAdmin({
          project_id: 'fixture-project',
          client_email: 'sa@fixture-project.iam.gserviceaccount.com',
          private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        });

        const token = client.createCustomToken('uid-42');
        const [header, payload, signature] = token.split('.');

        ctx.expect(JSON.parse(Buffer.from(header, 'base64url'))).toEqual({ alg: 'RS256', typ: 'JWT' });
        const claims = JSON.parse(Buffer.from(payload, 'base64url'));
        ctx.expect(claims.aud).toBe(CUSTOM_TOKEN_AUD);
        ctx.expect(claims.uid).toBe('uid-42');
        ctx.expect(claims.iss).toBe('sa@fixture-project.iam.gserviceaccount.com');
        ctx.expect(claims.sub).toBe(claims.iss);

        const verifier = createVerify('SHA256');
        verifier.update(`${header}.${payload}`);
        ctx.expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
      },
    },

    // ─── env-secret shared lib ───────────────────────────────────────────────────

    {
      name: 'env-secret: writeEnvValue appends to a fresh .env and replaces in place on rerun',
      run: (ctx) => {
        const root = stageBrand();

        // Writes converge onto the marker sections (env-order.test.js owns the
        // layout contract): this test pins the value semantics only
        writeEnvValue(root, 'FIXTURE_SECRET', 'first');
        ctx.expect(jetpack.read(join(root, '.env'))).toMatch(/^FIXTURE_SECRET="first"$/m);

        jetpack.write(join(root, '.env'), 'OTHER_VAR="keep"\nFIXTURE_SECRET="first"\nTRAILING_VAR="keep"\n');
        writeEnvValue(root, 'FIXTURE_SECRET', 'second');
        const env = jetpack.read(join(root, '.env'));
        ctx.expect(env).toMatch(/^FIXTURE_SECRET="second"$/m);
        ctx.expect(env).not.toMatch(/"first"/);
        ctx.expect(env).toMatch(/^OTHER_VAR="keep"$/m);
        ctx.expect(env).toMatch(/^TRAILING_VAR="keep"$/m);
      },
    },

    // ─── Setup / skip semantics ──────────────────────────────────────────────────

    {
      name: 'account: account.enabled = false skips the service',
      run: async (ctx) => {
        const result = await runService(brandConfig({ account: { enabled: false } }));
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/account\.enabled/);
      },
    },

    {
      name: 'account: scalar account: false skips the service',
      run: async (ctx) => {
        const result = await runService(brandConfig({ account: false }));
        ctx.expect(result.status).toBe('skipped');
      },
    },

    {
      name: 'account: no backend target skips the service',
      run: async (ctx) => {
        const config = brandConfig();
        delete config.targets.backend;
        const result = await runService(config);
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/no backend target/);
      },
    },

    {
      name: 'account: shared Firebase project skips the service',
      run: async (ctx) => {
        const result = await runService(brandConfig({ cloud: { shared: true } }));
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/shared Firebase project/);
      },
    },

    {
      name: 'account: missing brand.url skips the service',
      run: async (ctx) => {
        const result = await runService(brandConfig({ url: '' }));
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/no brand\.url/);
      },
    },

    {
      name: 'account: a default Pages brand.url is no domain, so setup skips with the one reason before any client call',
      run: async (ctx) => {
        const auth = fakeAuth();
        const firestore = fakeFirestore();
        const backend = fakeBackend();

        const result = await runService(brandConfig({ url: 'https://dreamr-design.github.io/dreamr-web' }), { auth, firestore, backend });

        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toBe('brand.url is the hosting provider\'s default address (dreamr-design.github.io): no domain to manage');
        ctx.expect(auth.calls).toEqual([]);
        ctx.expect(firestore.calls).toEqual([]);
        ctx.expect(backend.calls).toEqual([]);
      },
    },

    {
      name: 'account: empty admins list skips the service',
      run: async (ctx) => {
        const result = await runService(brandConfig({ account: { enabled: true, admins: [] } }));
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/no account\.admins/);
      },
    },

    {
      name: 'account: missing service account skips with firebase-service guidance',
      run: async (ctx) => {
        const root = stageBrand();
        const result = await runService(brandConfig(), { root });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/\.omega\/secrets\/service-account\.json.*cloud service/);
        // The skip happened before seed resolution — nothing written
        ctx.expect(jetpack.exists(join(root, '.env'))).toBe(false);
      },
    },

    // ─── Seed writeback ──────────────────────────────────────────────────────────

    {
      name: 'account: generates ACCOUNT_PASSWORD_SEED, persists it to .env, and derives from it',
      run: async (ctx) => {
        const root = stageBrand();
        const auth = fakeAuth({ getUserByEmail: USER, getUser: USER, updateUser: undefined });
        const firestore = fakeFirestore({ getDoc: ADMIN_DOC, runQuery: [{ id: USER.uid, data: {} }] });
        const backend = fakeBackend({ verifyPassword: false, syncMarketingContact: undefined });

        const result = await runService(brandConfig(), { root, auth, firestore, backend, seed: null });
        ctx.expect(result.status).toBe('success');

        const envContent = jetpack.read(join(root, '.env'));
        const seedMatch = envContent.match(/^ACCOUNT_PASSWORD_SEED="([A-Za-z0-9_-]{32})"$/m);
        ctx.expect(seedMatch, `.env should carry the generated seed, got: ${envContent}`).toBeTruthy();

        // The password pushed to Firebase Auth derives from the seed just persisted
        ctx.expect(auth.of('updateUser')[0].args).toEqual([USER.uid, { password: derivePassword(seedMatch[1], EMAIL, DOMAIN) }]);
      },
    },

    {
      name: 'account: passwordEnvVar maps an email to its OMEGA_ACCOUNT_PASSWORD__* pin',
      run: (ctx) => {
        ctx.expect(passwordEnvVar('support@acme.com')).toBe('OMEGA_ACCOUNT_PASSWORD__SUPPORT_ACME_COM');
        ctx.expect(passwordEnvVar('ian.wiedenman@gmail.com')).toBe('OMEGA_ACCOUNT_PASSWORD__IAN_WIEDENMAN_GMAIL_COM');
      },
    },

    {
      name: 'account: an env-pinned password wins and no seed is ever generated',
      run: async (ctx) => {
        const root = stageBrand();
        const envVar = passwordEnvVar(EMAIL);
        process.env[envVar] = 'EnvPinned1!';
        ctx.after(() => delete process.env[envVar]);

        const { auth, firestore, backend } = convergedClients();
        const result = await runService(brandConfig(), { root, auth, firestore, backend, seed: null });

        ctx.expect(result.status).toBe('success');
        ctx.expect(backend.of('verifyPassword')[0].args).toEqual([EMAIL, 'EnvPinned1!']);
        // Fully env-covered → the lazy seed channel never materializes
        ctx.expect(jetpack.exists(join(root, '.env'))).toBe(false);
      },
    },

    {
      name: 'account: a real brand hook supplies the password (formula over email/domain/apex/brand)',
      run: async (ctx) => {
        const root = stageBrand();
        writeHook(root, 'account/password', `
    module.exports = ({ email, domain, apex, brand }) =>
      \`Hk1!\${brand.id}:\${email.split('@')[0]}:\${apex}:\${domain === apex}\`;
  `);

        const auth = fakeAuth({ getUserByEmail: USER, getUser: USER, updateUser: undefined });
        const firestore = fakeFirestore({ getDoc: ADMIN_DOC, runQuery: [{ id: USER.uid, data: {} }] });
        const backend = fakeBackend({ verifyPassword: false, syncMarketingContact: undefined });

        const result = await runService(brandConfig(), { root, auth, firestore, backend, seed: null });

        ctx.expect(result.status).toBe('success');
        ctx.expect(auth.of('updateUser')[0].args).toEqual([USER.uid, { password: `Hk1!fixture-brand:support:${DOMAIN}:true` }]);
        // Fully hook-covered → no seed written
        ctx.expect(jetpack.exists(join(root, '.env'))).toBe(false);
      },
    },

    {
      name: 'account: the env pin beats the hook',
      run: async (ctx) => {
        const root = stageBrand();
        writeHook(root, 'account/password', 'module.exports = () => "HookLoses1!";\n');
        const envVar = passwordEnvVar(EMAIL);
        process.env[envVar] = 'EnvWins1!';
        ctx.after(() => delete process.env[envVar]);

        const { auth, firestore, backend } = convergedClients();
        await runService(brandConfig(), { root, auth, firestore, backend, seed: null });

        ctx.expect(backend.of('verifyPassword')[0].args).toEqual([EMAIL, 'EnvWins1!']);
      },
    },

    {
      name: 'account: a company hook covers a brand that names one (Ian\'s formula lives in HIS tree)',
      run: async (ctx) => {
        // The company tree lives inside the PARENT brand's repo (#677), and the
        // machine registry line is what says where the parent is.
        const parentRoot = stageBrand();
        mkdirSync(join(parentRoot, 'config'), { recursive: true });
        writeFileSync(join(parentRoot, 'config', 'omega.json5'), "{ brand: { id: 'fixture-co' }, company: { id: 'self' } }");
        writeHook(join(parentRoot, 'company'), 'account/password', 'module.exports = ({ email, brand }) => `Co1!${brand.id}/${email}`;\n');

        const root = stageBrand();
        mkdirSync(join(root, 'config'), { recursive: true });
        writeFileSync(join(root, 'config', 'omega.json5'), "{ brand: { id: 'fixture-brand' }, company: { id: 'fixture-co' } }");

        const home = stageBrand();
        writeFileSync(join(home, 'brands.json'), JSON.stringify({ 'fixture-co': { root: parentRoot } }));
        const previousHome = process.env.OMEGA_HOME;
        process.env.OMEGA_HOME = home;
        ctx.after(() => {
          if (previousHome === undefined) delete process.env.OMEGA_HOME;
          else process.env.OMEGA_HOME = previousHome;
        });

        const { auth, firestore, backend } = convergedClients();
        const result = await runService(brandConfig(), { root, auth, firestore, backend, seed: null });

        ctx.expect(result.status).toBe('success');
        ctx.expect(backend.of('verifyPassword')[0].args).toEqual([EMAIL, `Co1!fixture-brand/${EMAIL}`]);
        ctx.expect(jetpack.exists(join(root, '.env'))).toBe(false);
      },
    },

    {
      name: 'account: a hook returning an invalid password fails the service naming the hook file',
      run: async (ctx) => {
        const root = stageBrand();
        writeHook(root, 'account/password', 'module.exports = () => "x";\n');

        const { auth, firestore, backend } = convergedClients();
        const result = await runService(brandConfig(), { root, auth, firestore, backend, seed: null });

        ctx.expect(result.status).toBe('error');
        ctx.expect(result.error).toMatch(/account\/password.*invalid password for support@fixture-brand\.test/);
      },
    },

    {
      name: 'account: a marketing-only list never touches the password channels — no seed written',
      run: async (ctx) => {
        const root = stageBrand();
        const auth = fakeAuth({ getUserByEmail: USER });
        const firestore = fakeFirestore({ runQuery: [] });
        const backend = fakeBackend({ syncMarketingContact: undefined });

        const result = await runService(
          brandConfig({ admins: [{ email: EMAIL, marketing: true }] }),
          { root, auth, firestore, backend, seed: null },
        );

        ctx.expect(result.status).toBe('success');
        ctx.expect(jetpack.exists(join(root, '.env'))).toBe(false);
      },
    },

    // ─── Convergence / mutations ─────────────────────────────────────────────────

    {
      name: 'account: a converged brand is a zero-mutation no-op with only the marketing push',
      run: async (ctx) => {
        const { auth, firestore, backend } = convergedClients();
        const result = await runService(brandConfig(), { auth, firestore, backend });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.state).toBe(null);
        ctx.expect(auth.mutations().length).toBe(0);
        ctx.expect(firestore.mutations().length).toBe(0);
        ctx.expect(backend.of('verifyPassword')[0].args).toEqual([EMAIL, PASSWORD]);
        ctx.expect(backend.of('syncMarketingContact')[0].args).toEqual([USER.uid]);
        ctx.expect(backend.of('signup').length).toBe(0);
        ctx.expect(result.output.users).toEqual({
          ok: 1, created: 0, updated: 0, adminUpdated: 0, planned: 0, marketingSynced: 1,
        });
      },
    },

    {
      name: 'account: the admin audit runs the pinned roles.admin structured query',
      run: async (ctx) => {
        const { auth, firestore, backend } = convergedClients();
        await runService(brandConfig(), { auth, firestore, backend });

        ctx.expect(firestore.of('runQuery')[0].args).toEqual([ADMIN_QUERY]);
        ctx.expect(auth.of('getUser')[0].args).toEqual([USER.uid]);
      },
    },

    {
      name: 'account: a drifted password is updated to the derived value',
      run: async (ctx) => {
        const auth = fakeAuth({ getUserByEmail: USER, getUser: USER, updateUser: undefined });
        const firestore = fakeFirestore({ getDoc: ADMIN_DOC, runQuery: [{ id: USER.uid, data: {} }] });
        const backend = fakeBackend({ verifyPassword: false, syncMarketingContact: undefined });

        const result = await runService(brandConfig(), { auth, firestore, backend });

        ctx.expect(result.status).toBe('success');
        ctx.expect(auth.of('updateUser')[0].args).toEqual([USER.uid, { password: PASSWORD }]);
        ctx.expect(result.output.users.updated).toBe(1);
      },
    },

    {
      name: 'account: a missing account is created, gets admin + plan, and completes signup',
      run: async (ctx) => {
        const auth = fakeAuth({
          getUserByEmail: null,
          getUser: { uid: 'uid-new', email: EMAIL, providerData: [] },
          createUser: ({ email }) => ({ uid: 'uid-new', email }),
        });
        const firestore = fakeFirestore({ getDoc: null, patchDoc: undefined, runQuery: [{ id: 'uid-new', data: {} }] });
        const backend = fakeBackend({ signup: undefined });

        const result = await runService(brandConfig(), { auth, firestore, backend });

        ctx.expect(result.status).toBe('success');
        ctx.expect(auth.of('createUser')[0].args).toEqual([{ email: EMAIL, password: PASSWORD }]);
        ctx.expect(firestore.of('patchDoc')[0].args).toEqual([
          'users/uid-new',
          {
            roles: { admin: true },
            subscription: { product: { id: 'pro', name: 'Pro' }, status: 'active' },
          },
          ['roles.admin', 'subscription.product.id', 'subscription.product.name', 'subscription.status'],
        ]);
        ctx.expect(backend.of('signup')[0].args).toEqual(['uid-new']);
        // Fresh creates rely on signup for marketing inference — no direct sync
        ctx.expect(backend.of('syncMarketingContact').length).toBe(0);
        ctx.expect(result.output.users).toEqual({
          ok: 0, created: 1, updated: 0, adminUpdated: 1, planned: 0, marketingSynced: 0,
        });
      },
    },

    {
      name: 'account: creation without a Firebase API key warns and skips the signup call',
      run: async (ctx) => {
        const auth = fakeAuth({
          getUserByEmail: null,
          getUser: { uid: 'uid-new', email: EMAIL, providerData: [] },
          createUser: ({ email }) => ({ uid: 'uid-new', email }),
        });
        const firestore = fakeFirestore({ getDoc: null, patchDoc: undefined, runQuery: [{ id: 'uid-new', data: {} }] });
        const backend = fakeBackend({});

        // No cloud.config.apiKey → password verification and backend calls degrade
        const result = await runService(brandConfig({ cloud: { shared: false } }), { auth, firestore, backend });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(backend.of('signup').length).toBe(0);
        ctx.expect(result.output.users.created).toBe(1);
      },
    },

    {
      name: 'account: a failed signup call downgrades to warned and the run continues',
      run: async (ctx) => {
        const auth = fakeAuth({
          getUserByEmail: null,
          getUser: { uid: 'uid-new', email: EMAIL, providerData: [] },
          createUser: ({ email }) => ({ uid: 'uid-new', email }),
        });
        const firestore = fakeFirestore({ getDoc: null, patchDoc: undefined, runQuery: [{ id: 'uid-new', data: {} }] });
        const backend = fakeBackend({
          signup: () => { throw new Error('POST /omega/user/signup failed (503)'); },
        });

        const result = await runService(brandConfig(), { auth, firestore, backend });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.users.created).toBe(1);
        ctx.expect(firestore.of('runQuery').length).toBe(1); // audit still ran
      },
    },

    {
      name: 'account: {domain} templates resolve in admin emails, tolerant of spaces',
      run: async (ctx) => {
        const { auth, firestore, backend } = convergedClients();
        const config = brandConfig({
          admins: [{ email: 'support@{ domain }', account: true, marketing: true }],
        });
        await runService(config, { auth, firestore, backend });

        ctx.expect(auth.of('getUserByEmail')[0].args).toEqual([EMAIL]);
      },
    },

    {
      name: 'account: admin set but wrong plan patches only the subscription leaf paths',
      run: async (ctx) => {
        const auth = fakeAuth({ getUserByEmail: USER, getUser: USER });
        const firestore = fakeFirestore({
          getDoc: { roles: { admin: true }, subscription: { product: { id: 'basic', name: 'Basic' } } },
          patchDoc: undefined,
          runQuery: [{ id: USER.uid, data: {} }],
        });
        const backend = fakeBackend({ verifyPassword: true, syncMarketingContact: undefined });

        const result = await runService(brandConfig(), { auth, firestore, backend });

        ctx.expect(result.status).toBe('success');
        ctx.expect(firestore.of('patchDoc')[0].args).toEqual([
          `users/${USER.uid}`,
          { subscription: { product: { id: 'pro', name: 'Pro' }, status: 'active' } },
          ['subscription.product.id', 'subscription.product.name', 'subscription.status'],
        ]);
        ctx.expect(result.output.users.adminUpdated).toBe(1);
      },
    },

    {
      name: 'account: no payment products manages only the role — no write when converged',
      run: async (ctx) => {
        // omega-manager issued an empty merge write on every run in this case
        const auth = fakeAuth({ getUserByEmail: USER, getUser: USER });
        const firestore = fakeFirestore({ getDoc: { roles: { admin: true } }, runQuery: [{ id: USER.uid, data: {} }] });
        const backend = fakeBackend({ verifyPassword: true, syncMarketingContact: undefined });

        const result = await runService(brandConfig({ products: [] }), { auth, firestore, backend });

        ctx.expect(result.status).toBe('success');
        ctx.expect(firestore.mutations().length).toBe(0);
      },
    },

    // ─── Marketing-only entries ──────────────────────────────────────────────────

    {
      name: 'account: a marketing-only entry syncs when the auth user exists',
      run: async (ctx) => {
        const auth = fakeAuth({ getUserByEmail: USER });
        const firestore = fakeFirestore({ runQuery: [] });
        const backend = fakeBackend({ syncMarketingContact: undefined });

        const result = await runService(
          brandConfig({ admins: [{ email: EMAIL, marketing: true }] }),
          { auth, firestore, backend },
        );

        ctx.expect(result.status).toBe('success');
        ctx.expect(backend.of('syncMarketingContact')[0].args).toEqual([USER.uid]);
        ctx.expect(auth.mutations().length).toBe(0);
      },
    },

    {
      name: 'account: a marketing-only entry with no auth user is skipped quietly',
      run: async (ctx) => {
        const auth = fakeAuth({ getUserByEmail: null });
        const firestore = fakeFirestore({ runQuery: [] });
        const backend = fakeBackend({});

        const result = await runService(
          brandConfig({ admins: [{ email: EMAIL, marketing: true }] }),
          { auth, firestore, backend },
        );

        ctx.expect(result.status).toBe('success');
        ctx.expect(backend.of('syncMarketingContact').length).toBe(0);
        ctx.expect(result.output.users.marketingSynced).toEqual(0);
      },
    },

    // ─── Admin audit ─────────────────────────────────────────────────────────────

    {
      name: 'account: an unauthorized admin fails the service with its email and uid',
      run: async (ctx) => {
        const { backend } = convergedClients();
        const auth = fakeAuth({
          getUserByEmail: USER,
          getUser: (uid) => (uid === USER.uid ? structuredClone(USER) : { uid, email: 'evil@example.com', providerData: [] }),
        });
        const firestore = fakeFirestore({
          getDoc: ADMIN_DOC,
          runQuery: [{ id: USER.uid, data: {} }, { id: 'uid-evil', data: {} }],
        });

        const result = await runService(brandConfig(), { auth, firestore, backend });

        ctx.expect(result.status).toBe('error');
        ctx.expect(result.error).toMatch(/Unauthorized admin accounts found: evil@example\.com \(uid-evil\)/);
      },
    },

    {
      name: 'account: an admin doc with no auth record is unauthorized',
      run: async (ctx) => {
        const { backend } = convergedClients();
        const auth = fakeAuth({
          getUserByEmail: USER,
          getUser: (uid) => (uid === USER.uid ? structuredClone(USER) : null),
        });
        const firestore = fakeFirestore({
          getDoc: ADMIN_DOC,
          runQuery: [{ id: USER.uid, data: {} }, { id: 'uid-ghost', data: {} }],
        });

        const result = await runService(brandConfig(), { auth, firestore, backend });

        ctx.expect(result.status).toBe('error');
        ctx.expect(result.error).toMatch(/uid-ghost/);
      },
    },

    // ─── Dry run ─────────────────────────────────────────────────────────────────

    {
      name: 'account: dry run plans a missing account without touching anything',
      run: async (ctx) => {
        const auth = fakeAuth({ getUserByEmail: null });
        const firestore = fakeFirestore({ runQuery: [] });
        const backend = fakeBackend({});

        const result = await runService(brandConfig(), {
          auth, firestore, backend, options: { dryRun: true },
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(auth.mutations().length).toBe(0);
        ctx.expect(firestore.mutations().length).toBe(0);
        ctx.expect(backend.of('signup').length).toBe(0);
        ctx.expect(result.output.users.planned).toBe(1);
        ctx.expect(firestore.of('runQuery').length).toBe(1); // the audit is read-only and still runs
      },
    },

    {
      name: 'account: dry run plans password + admin + marketing on a drifted account, zero mutations',
      run: async (ctx) => {
        const auth = fakeAuth({ getUserByEmail: USER, getUser: USER });
        const firestore = fakeFirestore({ getDoc: {}, runQuery: [{ id: USER.uid, data: {} }] });
        const backend = fakeBackend({ verifyPassword: false });

        const result = await runService(brandConfig(), {
          auth, firestore, backend, options: { dryRun: true },
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(auth.mutations().length).toBe(0);
        ctx.expect(firestore.mutations().length).toBe(0);
        ctx.expect(result.output.users.planned).toBe(3);
      },
    },

    {
      name: 'account: dry run without a seed plans passwords and never writes .env',
      run: async (ctx) => {
        const root = stageBrand();
        const auth = fakeAuth({ getUserByEmail: USER, getUser: USER });
        const firestore = fakeFirestore({ getDoc: ADMIN_DOC, runQuery: [{ id: USER.uid, data: {} }] });
        const backend = fakeBackend({});

        const result = await runService(brandConfig(), {
          root, auth, firestore, backend, seed: null, options: { dryRun: true },
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(jetpack.exists(join(root, '.env'))).toBe(false);
        ctx.expect(backend.of('verifyPassword').length).toBe(0); // no seed → nothing to verify against
        ctx.expect(result.output.users.planned).toBe(2); // password pending + marketing sync
      },
    },
  ],
});
