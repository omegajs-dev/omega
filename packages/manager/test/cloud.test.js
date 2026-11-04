/**
 * Firebase service tests — the 13 operations against a method-level recording
 * fake of the FirebaseAPI surface (plus a Cloudflare fake for hosting's DNS
 * writes). Proves skip/shared semantics, the converged-project zero-mutation
 * no-op, per-operation drift writes, the de-ITW'd billing guidance, warned
 * manual flows (Google sign-in, VAPID), the omega.json5 cloud.config drift
 * check, and the dry-run guarantee.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const path = require('node:path');
const jetpack = require('fs-jetpack');

const { setBrowserOpener } = require('@omega.js/devkit/flows');
const { openTtyPrompt } = require('./lib/interactive.js');
const {
  DOMAIN, PROJECT, PROJECT_NUMBER, SA_EMAIL, ACT_AS_ROLE, ALL_SERVICES, EXPECTED_SDK,
  tmpRoot, stagedRoot, brandConfig, fakeFirebase, fakeCf, runService, convergedResponses,
} = require('./lib/cloud-fixture.js');

// Tests must never see real credentials from the shell environment
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.CLOUDFLARE_TOKEN;

// The two runtime accounts a functions deploy acts as
const APPSPOT_SA = `${PROJECT}@appspot.gserviceaccount.com`;
const COMPUTE_SA = `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`;
const SCHEDULER_ROLE = 'roles/cloudscheduler.admin';
const DOWN = '\x1B[B'; // arrow-down escape for select() answers

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Direct-handler context (bypasses setup — for focused per-operation tests)
const { makeBrandRoot, readConfigSource } = require('./lib/config-fixture.js');

// Writeback target for the sdk-config drift tests.
const FIREBASE_WRITEBACK_CONFIG = `// Fixture Brand — hand-edited writeback target
{
  brand: { id: 'fixture-brand' },
}
`;

function handlerContext(config, firebase, extra = {}) {
  return {
    firebaseApi: firebase,
    cloudflareApi: null,
    brandId: 'fixture-brand',
    brandRoot: tmpRoot(),
    brandConfig: config,
    projectId: PROJECT,
    domain: DOMAIN,
    apexDomain: DOMAIN,
    isSubdomainProject: false,
    targets: [],
    serviceData: {},
    options: {},
    ...extra,
  };
}

// ─── Hosting: TLS coverage → proxy eligibility (cp114b/cp115) ────────────────

/** Direct-handler context for a subdomain project (api.play.{DOMAIN}). */
function deepProjectContext(firebase, cloudflare) {
  return {
    firebaseApi: firebase,
    cloudflareApi: cloudflare,
    brandConfig: {},
    projectId: PROJECT,
    domain: `play.${DOMAIN}`,
    apexDomain: DOMAIN,
    isSubdomainProject: true,
    options: {},
    serviceData: {},
  };
}

/** Firebase fake for a project whose api domain is already verified. */
function verifiedDomainFirebase() {
  return fakeFirebase({
    listHostingSites: [{ name: `projects/${PROJECT}/sites/${PROJECT}` }],
    checkDomainStatus: { exists: true, verified: true },
  });
}

// ─── The deploy grant: actAs on the two default runtime accounts (#878) ──────

/** The act-as binding as the live policy carries it. */
function actAsPolicy(members) {
  return { bindings: [{ role: ACT_AS_ROLE, members }] };
}

// ─── OAuth consent: supportEmail must be OWNABLE by the caller (#29) ─────────

const ensureOAuthConsent = require('../src/services/cloud/ensure/oauth-consent.js');

// ─── OAuth consent: an Internal audience is a manage-time STOPPER (#667) ─────

const INTERNAL_BRAND = { name: `projects/${PROJECT_NUMBER}/brands/b1`, applicationTitle: 'Fixture Brand', supportEmail: 'owner@example.com', orgInternalOnly: true };
const AUDIENCE_URL = `https://console.cloud.google.com/auth/audience?project=${PROJECT}`;

// Writeback target for the Disable outcome (the tri-state opt-out lands here)
const AUDIENCE_CONFIG = `// Fixture Brand — consent audience opt-out target
{
  brand: { id: 'fixture-brand' },
  cloud: { config: { projectId: "fixture-proj" } }, // consentAudience lands beside it
}
`;

// ─── OAuth consent: the branding page is a NAMED manual step (#696) ─────────

const BRANDING_URL = `https://console.cloud.google.com/auth/branding?project=${PROJECT}`;

// ─── Interactive project selection/creation (config-landing flow) ────────────

const { resolveFirebaseProject } = require('../src/services/cloud/lib/project-flow.js');

const PROJECT_FLOW_CONFIG = `{
  // Fixture Brand — firebase writeback target
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://fixture-brand.test' },
  cloud: { organizationId: "123456789" }, // projectId lands under cloud.config
}
`;

function projectFlowContext(brandRoot) {
  return {
    brandId: 'fixture-brand',
    brandRoot,
    options: {},
    brandConfig: {
      brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://fixture-brand.test' },
      cloud: { organizationId: '123456789' },
    },
  };
}

module.exports = defineCases({
  type: 'group',
  description: 'cloud',
  tests: [
    // ─── Setup / skip semantics ──────────────────────────────────────────────────

    {
      name: 'cloud: skips without cloud.config.projectId',
      run: async (ctx) => {
        const config = brandConfig();
        config.cloud.config.projectId = null;

        const result = await runService(config, { firebase: fakeFirebase() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/cloud\.config\.projectId/);
      },
    },

    {
      name: 'cloud: derives projectId from cloud.config — the ONE home (#23)',
      run: async (ctx) => {
        const config = brandConfig();
        config.cloud.config.projectId = null;
        config.cloud = { provider: 'firebase', config: { projectId: PROJECT } };

        const result = await runService(config, { firebase: fakeFirebase() });
        ctx.expect(result.status, 'cloud.config.projectId names the project — no skip').not.toBe('skipped');
      },
    },

    {
      name: 'cloud: cloud.enabled = false skips the service',
      run: async (ctx) => {
        const config = brandConfig({ cloud: { enabled: false } });
        const result = await runService(config, { firebase: fakeFirebase() });
        ctx.expect(result.status).toBe('skipped');
      },
    },

    {
      name: 'cloud: demo-* project skips (emulator-only — no real cloud to reconcile)',
      run: async (ctx) => {
        const config = brandConfig({ cloud: { config: { projectId: 'demo-omega' } } });
        const result = await runService(config, { firebase: fakeFirebase() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/demo-\*/);
      },
    },

    {
      name: 'cloud: skips without GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET',
      run: async (ctx) => {
        const result = await runService(brandConfig());
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/GOOGLE_CLIENT_ID/);
      },
    },

    {
      name: 'cloud: a default Pages brand.url is no domain, so setup skips with the one reason before any client call',
      run: async (ctx) => {
        const config = brandConfig();
        config.brand.url = 'https://dreamr-design.github.io/dreamr-web';
        const firebase = fakeFirebase();
        const cloudflare = fakeCf();

        const result = await runService(config, { firebase, cloudflare });

        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toBe('brand.url is the hosting provider\'s default address (dreamr-design.github.io): no domain to manage');
        ctx.expect(firebase.calls).toEqual([]);
        ctx.expect(cloudflare.calls).toEqual([]);
      },
    },

    {
      name: 'cloud: shared project only runs service-account + sdk-config',
      run: async (ctx) => {
        const config = brandConfig({
          cloud: { shared: true },
          sdkConfig: { ...EXPECTED_SDK },
        });
        const api = fakeFirebase(convergedResponses());

        const result = await runService(config, {
          firebase: api,
          brandRoot: stagedRoot(),
        });

        ctx.expect(result.status).toBe('success');
        // No project-level reads happened — billing/identity/hosting stayed untouched
        ctx.expect(api.callsTo('getProjectBillingInfo').length).toBe(0);
        ctx.expect(api.callsTo('getIdentityConfig').length).toBe(0);
        ctx.expect(api.callsTo('listHostingSites').length).toBe(0);
        ctx.expect(api.callsTo('listWebApps').length > 0).toBeTruthy();
        ctx.expect(api.mutations().length).toBe(0);
      },
    },

    {
      name: 'cloud: brand.url with a path/port derives a hostname-only domain — authDomain never carries them (cp268)',
      run: async (ctx) => {
        const config = brandConfig({
          cloud: { shared: true },
          sdkConfig: { ...EXPECTED_SDK },
        });
        config.brand.url = `https://${DOMAIN}:8443/app`; // schema allows any http(s) URL
        const api = fakeFirebase(convergedResponses());

        const result = await runService(config, {
          firebase: api,
          brandRoot: stagedRoot(),
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.state.sdkConfig.authDomain).toBe(DOMAIN); // hostname only — no :8443, no /app
      },
    },

    // ─── The flagship: converged project = zero-mutation no-op ───────────────────

    {
      name: 'cloud: fully converged project is a zero-mutation no-op across all 13 operations',
      run: async (ctx) => {
        const config = brandConfig({ sdkConfig: { ...EXPECTED_SDK } });
        const api = fakeFirebase(convergedResponses());
        const cf = fakeCf({
          records: [{ id: 'c1', type: 'CNAME', name: `api.${DOMAIN}`, content: `${PROJECT}.web.app`, proxied: true }],
        });

        config.cloud.oauthRedirectsConfigured = true;
        config.cloud.messaging = { vapidKey: 'B'.repeat(87) };
        process.env.VAPID_PRIVATE_KEY = 'p'.repeat(43);

        const result = await runService(config, {
          firebase: api,
          cloudflare: cf,
          brandRoot: stagedRoot(),
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.mutations()).toEqual([]);
        ctx.expect(cf.mutations()).toEqual([]);

        // Values the later operations in this run carry forward
        ctx.expect(result.state.serviceAccount.email).toBe(SA_EMAIL);
        ctx.expect(result.state.sdkConfig.authDomain).toBe(DOMAIN);
        ctx.expect(result.state.hosting.domains[0].status).toBe('verified');
      },
    },

    {
      name: 'hosting: deep subdomain-project api domain comes back to DNS-only (Universal SSL limit)',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/hosting.js');

        // Universal SSL: apex + one label ride the proxy, deeper never does
        ctx.expect(handler.universalSslCovers(DOMAIN, DOMAIN)).toBe(true);
        ctx.expect(handler.universalSslCovers(`api.${DOMAIN}`, DOMAIN)).toBe(true);
        ctx.expect(handler.universalSslCovers(`api.play.${DOMAIN}`, DOMAIN)).toBe(false);

        // Certificate-host matching: a TLS wildcard spans exactly ONE label
        ctx.expect(handler.certHostMatches(`api.play.${DOMAIN}`, `api.play.${DOMAIN}`)).toBe(true);
        ctx.expect(handler.certHostMatches(`*.play.${DOMAIN}`, `api.play.${DOMAIN}`)).toBe(true);
        ctx.expect(handler.certHostMatches(`*.${DOMAIN}`, `api.play.${DOMAIN}`)).toBe(false);
        ctx.expect(handler.certHostMatches(DOMAIN, `api.${DOMAIN}`)).toBe(false);

        // Live-found shape (api.playground.omegajs.dev on a free zone): verified
        // domain, CNAME proxied:true from the pre-fix run → must be PATCHed down
        // to DNS-only so Firebase can serve the certificate.
        const cf = fakeCf({
          records: [{ id: 'c9', type: 'CNAME', name: `api.play.${DOMAIN}`, content: `${PROJECT}.web.app`, proxied: true }],
        });

        const result = await handler(deepProjectContext(verifiedDomainFirebase(), cf));

        ctx.expect(result.state.hosting.domains[0].status).toBe('verified');
        const patch = cf.mutations().find((c) => c.method === 'PATCH');
        ctx.expect(patch, 'expected the proxied CNAME to be PATCHed').toBeTruthy();
        ctx.expect(patch.body.proxied).toBe(false);
      },
    },

    {
      name: 'hosting: deep api domain rides the proxy when the zone has Total TLS',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/hosting.js');

        // Converged DNS-only from a free-era run; the zone since gained Total TLS,
        // which mints a certificate for every proxied hostname → PATCH up.
        const cf = fakeCf({
          totalTls: { enabled: true, certificate_authority: 'lets_encrypt' },
          records: [{ id: 'c9', type: 'CNAME', name: `api.play.${DOMAIN}`, content: `${PROJECT}.web.app`, proxied: false }],
        });

        const result = await handler(deepProjectContext(verifiedDomainFirebase(), cf));

        ctx.expect(result.state.hosting.domains[0].status).toBe('verified');
        const patch = cf.mutations().find((c) => c.method === 'PATCH');
        ctx.expect(patch, 'expected the DNS-only CNAME to be PATCHed up to proxied').toBeTruthy();
        ctx.expect(patch.body.proxied).toBe(true);
      },
    },

    {
      name: 'hosting: deep api domain rides the proxy only once a covering cert pack is ACTIVE',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/hosting.js');
        const universalPack = { type: 'universal', status: 'active', hosts: [DOMAIN, `*.${DOMAIN}`] };
        const deepPack = (status) => ({ type: 'advanced', status, hosts: [`*.play.${DOMAIN}`] });

        // Pending validation → not covered yet → CNAME created DNS-only
        const pendingCf = fakeCf({ certPacks: [universalPack, deepPack('pending_validation')] });
        await handler(deepProjectContext(verifiedDomainFirebase(), pendingCf));
        const pendingPost = pendingCf.mutations().find((c) => c.method === 'POST');
        ctx.expect(pendingPost.body.proxied).toBe(false);

        // Active → covered → CNAME created proxied
        const activeCf = fakeCf({ certPacks: [universalPack, deepPack('active')] });
        await handler(deepProjectContext(verifiedDomainFirebase(), activeCf));
        const activePost = activeCf.mutations().find((c) => c.method === 'POST');
        ctx.expect(activePost.body.proxied).toBe(true);
      },
    },

    {
      name: 'hosting: TLS-coverage lookups failing falls back to DNS-only',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/hosting.js');
        const cf = fakeCf({ totalTls: new Error('boom'), certPacks: new Error('boom') });

        const result = await handler(deepProjectContext(verifiedDomainFirebase(), cf));

        ctx.expect(result.state.hosting.domains[0].status).toBe('verified');
        const post = cf.mutations().find((c) => c.method === 'POST');
        ctx.expect(post.body.proxied).toBe(false);
      },
    },

    {
      name: 'hosting: no Cloudflare client — verified domain reports without DNS writes',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/hosting.js');

        const result = await handler(deepProjectContext(verifiedDomainFirebase(), null));

        ctx.expect(result.state.hosting.domains[0].status).toBe('verified');
      },
    },

    // ─── Billing (de-ITW'd) ──────────────────────────────────────────────────────

    {
      name: 'billing: Spark plan with no cloud.billingAccount warns instead of linking',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/billing.js');
        const api = fakeFirebase({ getProjectBillingInfo: { billingEnabled: false } });

        const result = await handler(handlerContext(brandConfig(), api));

        ctx.expect(result.status).toBe('warned');
        ctx.expect(api.mutations().length).toBe(0);
        // #32: the skip announces itself to the run-summary aggregate
        ctx.expect(result.output.billing.needsInteractive.includes('billing account')).toBeTruthy();
      },
    },

    {
      name: 'billing: an unreadable billing API says "could not check", never announces Spark (#56)',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/billing.js');
        // getProjectBillingInfo() swallows every read failure into null (the live
        // run's auth attempt timed out), so the step knows nothing about the plan.
        const api = fakeFirebase({ getProjectBillingInfo: null });
        const lines = [];
        const originalLog = console.log;
        console.log = (...args) => lines.push(args.join(' '));

        let result;
        try {
          result = await handler(handlerContext(brandConfig(), api));
        } finally {
          console.log = originalLog;
        }

        ctx.expect(result.status).toBe('warned');
        ctx.expect(api.mutations().length).toBe(0);
        ctx.expect(result.output.billing.error).toMatch(/could not check/i);
        const printed = lines.join('\n');
        ctx.expect(printed).toMatch(/Could not check the billing plan/);
        ctx.expect(!printed.includes('Spark plan (free tier)'), 'never states a plan it did not read').toBeTruthy();
      },
    },

    {
      name: 'billing: cloud.billingAccount: false = the user chose Spark — clean success, no nagging, no link',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/billing.js');
        const api = fakeFirebase({ getProjectBillingInfo: { billingEnabled: false } });
        const config = brandConfig({ cloud: { billingAccount: false } });

        const result = await handler(handlerContext(config, api));

        ctx.expect(result.status).toBe(undefined); // success — an opt-out is a clean state
        ctx.expect(api.mutations().length).toBe(0);
        ctx.expect(result.output.billing.note.includes('opted out')).toBeTruthy();
      },
    },

    {
      name: 'billing: interactive flow lists accounts, lands the pick in omega.json5, links it',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/billing.js');
        const api = fakeFirebase({
          getProjectBillingInfo: { billingEnabled: false },
          listBillingAccounts: [
            { name: 'billingAccounts/OTHER-111', displayName: 'Other Org', open: true },
            { name: 'billingAccounts/FIXTURE-222', displayName: 'Fixture Brand', open: true },
          ],
          linkBillingAccount: {},
        });
        const brandRoot = makeBrandRoot(FIREBASE_WRITEBACK_CONFIG);
        const config = brandConfig();
        const tty = openTtyPrompt();

        try {
          const run = handler(handlerContext(config, api, { brandRoot }));
          await tty.answer('Set up now?', '\r'); // Yes
          // "+ Create new" lists first but the cursor lands on the brand match
          await tty.answer('Select Billing account:', '\r');
          const result = await run;

          ctx.expect(result.state.billing.enabled).toBe(true);
          ctx.expect(api.callsTo('linkBillingAccount')[0].args).toEqual([PROJECT, 'billingAccounts/FIXTURE-222']);
          ctx.expect(config.cloud.billingAccount).toBe('billingAccounts/FIXTURE-222');
          ctx.expect(readConfigSource(brandRoot).includes('billingAccount: "billingAccounts/FIXTURE-222"')).toBeTruthy();
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'billing: interactive opt-out lands cloud.billingAccount: false and stays on Spark',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/billing.js');
        const api = fakeFirebase({
          getProjectBillingInfo: { billingEnabled: false },
          listBillingAccounts: [
            { name: 'billingAccounts/FIXTURE-222', displayName: 'Fixture Brand', open: true },
          ],
          // no linkBillingAccount response — any link attempt fails loudly
        });
        const brandRoot = makeBrandRoot(FIREBASE_WRITEBACK_CONFIG);
        const config = brandConfig();
        const tty = openTtyPrompt();

        try {
          const run = handler(handlerContext(config, api, { brandRoot }));
          await tty.answer('Set up now?', '\r'); // Yes
          // Choices: + Create new, Fixture Brand, Stay on the Spark plan — cursor on the brand match
          await tty.answer('Select Billing account:', `${DOWN}\r`);
          const result = await run;

          ctx.expect(result.status).toBe(undefined); // success — an opt-out is a clean state
          ctx.expect(result.output.billing.note.includes('opted out')).toBeTruthy();
          ctx.expect(config.cloud.billingAccount).toBe(false);
          ctx.expect(readConfigSource(brandRoot).includes('billingAccount: false')).toBeTruthy();
          ctx.expect(api.mutations().length).toBe(0);
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'billing: Spark plan with a configured account links it',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/billing.js');
        const api = fakeFirebase({
          getProjectBillingInfo: { billingEnabled: false },
          linkBillingAccount: {},
        });
        const config = brandConfig({ cloud: { billingAccount: 'billingAccounts/MY-OWN' } });

        const result = await handler(handlerContext(config, api));

        ctx.expect(result.state.billing.enabled).toBe(true);
        ctx.expect(api.callsTo('linkBillingAccount')[0].args).toEqual([PROJECT, 'billingAccounts/MY-OWN']);
      },
    },

    // ─── Services (diff-first — omega-manager batch-enabled every run) ───────────

    {
      name: 'services: only the missing APIs are enabled',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/services.js');
        const converged = convergedResponses();
        const api = fakeFirebase({
          ...converged,
          listEnabledServices: ALL_SERVICES.filter((s) => s !== 'fcm.googleapis.com' && s !== 'iap.googleapis.com'),
          enableServices: {},
        });

        await handler(handlerContext(brandConfig(), api));

        const batch = api.callsTo('enableServices');
        ctx.expect(batch.length).toBe(1);
        ctx.expect(batch[0].args[1]).toEqual(['iap.googleapis.com', 'fcm.googleapis.com']);
        ctx.expect(api.callsTo('setIamPolicy').length).toBe(0); // compute roles already present
      },
    },

    {
      name: 'project-settings: drifted name is patched, matching web app untouched',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/project-settings.js');
        const api = fakeFirebase({
          ...convergedResponses(),
          getGcpProject: { displayName: 'Old Name' },
          updateProjectName: {},
        });

        const result = await handler(handlerContext(brandConfig(), api));

        ctx.expect(api.callsTo('updateProjectName').length).toBe(1);
        ctx.expect(api.callsTo('updateWebAppDisplayName').length).toBe(0);
        ctx.expect(result.state.settings.projectName).toBe('Fixture Brand');
      },
    },

    // ─── Service account key lifecycle ───────────────────────────────────────────

    {
      name: 'service-account: missing key is created and saved to .omega/secrets (the ONE home — the backend stage reads it from there)',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/service-account.js');
        const api = fakeFirebase({
          ...convergedResponses(),
          createServiceAccountKey: { type: 'service_account', client_email: SA_EMAIL, private_key: 'FAKE' },
        });

        const brandRoot = tmpRoot(); // no key staged
        const backendPath = path.join(brandRoot, 'targets', 'backend');

        const result = await handler(handlerContext(brandConfig(), api, {
          brandRoot,
          targetDirs: [{ name: 'backend', dir: 'targets/backend', path: backendPath, target: 'backend' }],
        }));

        ctx.expect(result.state.serviceAccount.email).toBe(SA_EMAIL);
        ctx.expect(api.callsTo('createServiceAccountKey').length).toBe(1);
        ctx.expect(api.callsTo('createServiceAccount').length).toBe(0); // account existed
        ctx.expect(jetpack.read(path.join(brandRoot, '.omega', 'secrets', 'service-account.json'), 'json').client_email).toBe(SA_EMAIL);
        // No per-target copy: dist/ staging pulls from .omega/secrets at build time
        ctx.expect(jetpack.exists(path.join(backendPath, 'functions', 'service-account.json'))).toBe(false);
        ctx.expect(jetpack.exists(path.join(backendPath, 'service-account.json'))).toBe(false);
      },
    },

    {
      name: 'service-account: a missing cloudscheduler.admin is granted on the PROJECT policy (#878)',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/service-account.js');
        const converged = convergedResponses();
        const api = fakeFirebase({
          ...converged,
          getIamPolicy: () => ({
            bindings: converged.getIamPolicy().bindings.filter((b) => b.role !== SCHEDULER_ROLE),
          }),
          setIamPolicy: {},
        });

        const result = await handler(handlerContext(brandConfig(), api, { brandRoot: stagedRoot() }));

        const writes = api.callsTo('setIamPolicy');
        ctx.expect(writes.length, 'the one missing role is granted in a single policy write').toBe(1);
        const binding = writes[0].args[1].bindings.find((b) => b.role === SCHEDULER_ROLE);
        ctx.expect(binding.members.includes(`serviceAccount:${SA_EMAIL}`), 'the deploy account carries the scheduler role').toBeTruthy();
        ctx.expect(result.status).not.toBe('warned');
      },
    },

    {
      name: 'service-account: a missing actAs binding is granted on BOTH default runtime accounts (#878)',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/service-account.js');
        const api = fakeFirebase({
          ...convergedResponses(),
          getServiceAccountIamPolicy: () => ({ bindings: [] }),
          setServiceAccountIamPolicy: {},
        });

        const result = await handler(handlerContext(brandConfig(), api, { brandRoot: stagedRoot() }));

        const writes = api.callsTo('setServiceAccountIamPolicy');
        ctx.expect(writes.map((call) => call.args[1]), 'one write per runtime account, and no more').toEqual([APPSPOT_SA, COMPUTE_SA]);
        for (const write of writes) {
          const binding = write.args[2].bindings.find((b) => b.role === ACT_AS_ROLE);
          ctx.expect(binding.members.includes(`serviceAccount:${SA_EMAIL}`), `${write.args[1]} carries the deploy account under ${ACT_AS_ROLE}`).toBeTruthy();
        }
        ctx.expect(result.status).not.toBe('warned');
        ctx.expect(result.state.serviceAccount.email).toBe(SA_EMAIL);
      },
    },

    {
      name: 'service-account: an account that already carries actAs is not written again (#878)',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/service-account.js');
        const api = fakeFirebase({
          ...convergedResponses(),
          getServiceAccountIamPolicy: (projectId, email) => (
            email === APPSPOT_SA ? actAsPolicy([`serviceAccount:${SA_EMAIL}`]) : { bindings: [] }
          ),
          setServiceAccountIamPolicy: {},
        });

        const result = await handler(handlerContext(brandConfig(), api, { brandRoot: stagedRoot() }));

        const writes = api.callsTo('setServiceAccountIamPolicy');
        ctx.expect(writes.length, 'only the account that was missing it is written').toBe(1);
        ctx.expect(writes[0].args[1]).toBe(COMPUTE_SA);
        ctx.expect(result.status).not.toBe('warned');
      },
    },

    {
      name: 'service-account: a dry run PLANS the actAs grant and writes nothing (#878)',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/service-account.js');
        const api = fakeFirebase({
          ...convergedResponses(),
          getServiceAccountIamPolicy: () => ({ bindings: [] }),
        });
        const lines = [];
        const originalLog = console.log;
        console.log = (...args) => lines.push(args.join(' '));

        try {
          await handler(handlerContext(brandConfig(), api, { brandRoot: stagedRoot(), options: { dryRun: true } }));
        } finally {
          console.log = originalLog;
        }

        ctx.expect(api.mutations(), 'a dry run grants nothing').toEqual([]);
        ctx.expect(lines.join('\n')).toMatch(/Dry run .{0,3} would grant roles\/iam\.serviceAccountUser on the default service accounts/);
      },
    },

    {
      name: 'service-account: a refused actAs grant warns LOUDLY with the by-hand command (#878)',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/service-account.js');
        const api = fakeFirebase({
          ...convergedResponses(),
          getServiceAccountIamPolicy: () => ({ bindings: [] }),
          setServiceAccountIamPolicy: () => { throw new Error('Permission denied (403)'); },
        });
        const lines = [];
        const originalLog = console.log;
        console.log = (...args) => lines.push(args.join(' '));

        let result;
        try {
          result = await handler(handlerContext(brandConfig(), api, { brandRoot: stagedRoot() }));
        } finally {
          console.log = originalLog;
        }

        // The run summary names the operation by this reason (#643)
        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.reason).toMatch(/roles\/iam\.serviceAccountUser/);
        ctx.expect(result.reason).toMatch(new RegExp(APPSPOT_SA.replace(/\./g, '\\.')));
        ctx.expect(result.state.serviceAccount.email, 'the key the rest of the run needs still travels').toBe(SA_EMAIL);
        ctx.expect(lines.join('\n')).toMatch(new RegExp(`gcloud iam service-accounts add-iam-policy-binding ${APPSPOT_SA} --project ${PROJECT} --member="serviceAccount:${SA_EMAIL}" --role="${ACT_AS_ROLE}"`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      },
    },

    {
      name: 'service-account: a failed project number lookup is blamed on the LOOKUP, not on an account (#878)',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/service-account.js');
        const api = fakeFirebase({
          ...convergedResponses(),
          getProjectNumber: () => { throw new Error('caller lacks resourcemanager.projects.get'); },
        });
        const lines = [];
        const originalLog = console.log;
        console.log = (...args) => lines.push(args.join(' '));

        let result;
        try {
          result = await handler(handlerContext(brandConfig(), api, { brandRoot: stagedRoot() }));
        } finally {
          console.log = originalLog;
        }

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.reason).toMatch(/the project number lookup failed/);
        ctx.expect(result.reason, 'no account is named for a failure that happened before any account was read').not.toMatch(new RegExp(APPSPOT_SA.replace(/\./g, '\\.')));
        ctx.expect(api.callsTo('setServiceAccountIamPolicy').length, 'nothing was granted').toBe(0);
        ctx.expect(result.state.serviceAccount.email, 'the key the rest of the run needs still travels').toBe(SA_EMAIL);
        ctx.expect(lines.join('\n')).toMatch(/Could not resolve the project number for the deploy role grant/);
        ctx.expect(lines.join('\n'), 'no by-hand command, because there is no account to paste into one').not.toMatch(/add-iam-policy-binding/);
      },
    },

    // ─── Authentication (manual flows → warned, config diffs → PATCH) ────────────

    {
      name: 'authentication: disabled email sign-in is enabled; missing Google sign-in warns',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/authentication.js');
        const converged = convergedResponses();
        const identityConfig = structuredClone(converged.getIdentityConfig);
        identityConfig.signIn.email.enabled = false;

        const api = fakeFirebase({
          ...converged,
          getIdentityConfig: identityConfig,
          getIdpConfig: null, // Google sign-in not set up
          updateIdentityConfig: {},
        });

        const result = await handler(handlerContext(brandConfig(), api));

        ctx.expect(result.status).toBe('warned'); // Google sign-in needs the console
        const patches = api.callsTo('updateIdentityConfig');
        ctx.expect(patches.length).toBe(1);
        ctx.expect(patches[0].args[1].signIn.email.enabled).toBe(true);
        ctx.expect(api.callsTo('initializeIdentityPlatform').length).toBe(0); // config existed
      },
    },

    {
      name: 'authentication: wrong-project OAuth client is flagged, credentials not saved',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/authentication.js');
        const api = fakeFirebase({
          ...convergedResponses(),
          getIdpConfig: { enabled: true, clientId: '999999-other.apps.googleusercontent.com', clientSecret: 's' },
        });

        const context = handlerContext(brandConfig(), api);
        const result = await handler(context);

        ctx.expect(result.status).toBe('warned');
        ctx.expect(jetpack.exists(path.join(context.brandRoot, '.omega', 'secrets', 'google-oauth.json'))).toBe(false);
      },
    },

    {
      name: 'authentication: an unchanged google-oauth.json is NOT rewritten on the next run (#623)',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/authentication.js');
        const api = fakeFirebase(convergedResponses());
        // Redirect URIs already confirmed, so the run reaches the secret write
        // without the interactive flow
        const context = handlerContext(brandConfig({ cloud: { oauthRedirectsConfigured: true } }), api);
        const secretsPath = path.join(context.brandRoot, '.omega', 'secrets', 'google-oauth.json');

        await handler(context);
        ctx.expect(jetpack.read(secretsPath, 'json').clientSecret).toBe('fixture-secret');

        // Backdate so a rewrite is unmistakable (same-ms writes hide behind mtime)
        const backdated = new Date(Date.now() - 60_000);
        fs.utimesSync(secretsPath, backdated, backdated);

        await handler(context);

        ctx.expect(fs.statSync(secretsPath).mtimeMs < Date.now() - 30_000, 'a converged secret is read-compared, never re-written (the #590 idiom)').toBeTruthy();
      },
    },

    {
      name: 'authentication: a DRIFTED google-oauth.json is rewritten (#623)',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/authentication.js');
        const api = fakeFirebase(convergedResponses());
        const context = handlerContext(brandConfig({ cloud: { oauthRedirectsConfigured: true } }), api);
        const secretsPath = path.join(context.brandRoot, '.omega', 'secrets', 'google-oauth.json');

        jetpack.write(secretsPath, { clientId: `${PROJECT_NUMBER}-abc.apps.googleusercontent.com`, clientSecret: 'rotated-away' });

        await handler(context);

        ctx.expect(jetpack.read(secretsPath, 'json').clientSecret, 'the console is the source of truth — a stale secret is replaced').toBe('fixture-secret');
      },
    },

    {
      name: 'authentication: interactive redirect-URI confirm records completion in config (#434)',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/authentication.js');
        const prompt = require('@omega.js/devkit/prompt');
        const api = fakeFirebase(convergedResponses());
        const tty = openTtyPrompt();

        // Stub the real browser launch behind the press-Enter-to-open step
        const opened = [];
        const realOpen = prompt.openInBrowser;
        prompt.openInBrowser = (url) => { opened.push(url); return true; };

        try {
          const context = handlerContext(brandConfig(), api);
          const run = handler(context);
          await tty.answer('Press Enter to open the OAuth client settings', '\r');
          await tty.answer('Origins + redirect URIs configured in the OAuth client?', 'y\r');
          const result = await run;

          ctx.expect(result.status).toBe('success');
          ctx.expect(result.output.authentication.oauthRedirectsConfigured).toBe(true);
          ctx.expect(readConfigSource(context.brandRoot)).toMatch(/oauthRedirectsConfigured: true/);
          ctx.expect(opened.length, 'Enter opened the OAuth client settings').toBe(1);
        } finally {
          prompt.openInBrowser = realOpen;
          tty.close();
        }
      },
    },

    // ─── Cloud messaging ─────────────────────────────────────────────────────────

    {
      name: 'cloud-messaging: missing VAPID key pair warns with console guidance',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/cloud-messaging.js');
        const api = fakeFirebase({ isServiceEnabled: () => true });

        const result = await handler(handlerContext(brandConfig(), api));

        ctx.expect(result.status).toBe('warned');
        ctx.expect(api.mutations().length).toBe(0);
      },
    },

    {
      name: 'cloud-messaging: interactive paste-back validates lengths and splits the pair across its two homes (#434)',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/cloud-messaging.js');
        const prompt = require('@omega.js/devkit/prompt');
        const api = fakeFirebase({ isServiceEnabled: () => true });
        const tty = openTtyPrompt();

        const realOpen = prompt.openInBrowser;
        prompt.openInBrowser = () => true;

        try {
          const context = handlerContext(brandConfig(), api);
          const run = handler(context);
          await tty.answer('Press Enter to open the Cloud Messaging settings', '\r');
          await tty.answer('VAPID public key:', 'too-short\r');
          // \x15 (ctrl-U) clears the rejected line before retyping
          await tty.answer('must be exactly 87 characters', `\x15${'B'.repeat(87)}\r`);
          await tty.answer('VAPID private key:', `${'p'.repeat(43)}\r`);
          const result = await run;

          // Public half → omega.json5 (it ships to every browser); private half →
          // the gitignored brand .env
          ctx.expect(readConfigSource(context.brandRoot)).toMatch(new RegExp(`vapidKey: "${'B'.repeat(87)}"`));
          ctx.expect(jetpack.read(path.join(context.brandRoot, '.env'))).toMatch(new RegExp(`VAPID_PRIVATE_KEY="${'p'.repeat(43)}"`));
          ctx.expect(!readConfigSource(context.brandRoot).includes('p'.repeat(43))).toBeTruthy();
          ctx.expect(result.status).not.toBe('warned');
          ctx.expect(api.mutations().length).toBe(0);
        } finally {
          prompt.openInBrowser = realOpen;
          tty.close();
        }
      },
    },

    // ─── SDK config drift check ──────────────────────────────────────────────────

    {
      name: 'sdk-config: the missing omega.json5 cloud.config keys are written back, comments intact',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/sdk-config.js');
        const api = fakeFirebase(convergedResponses());
        const brandRoot = makeBrandRoot(FIREBASE_WRITEBACK_CONFIG);

        // The fixture's cloud.config carries only projectId (its ONE home, #23) —
        // every other SDK key is missing and must land.
        const result = await handler(handlerContext(brandConfig(), api, { brandRoot }));

        ctx.expect(result.status).toBe(undefined); // drift healed — success, not warned
        ctx.expect(result.state.sdkConfig).toEqual(EXPECTED_SDK);
        ctx.expect(result.output.sdkConfig.updated.slice().sort()).toEqual(Object.keys(EXPECTED_SDK).filter((k) => EXPECTED_SDK[k] && k !== 'projectId').sort());
        ctx.expect(api.callsTo('createWebApp').length).toBe(0);

        const written = readConfigSource(brandRoot);
        ctx.expect(written.includes(`apiKey: "${EXPECTED_SDK.apiKey}"`)).toBeTruthy();
        ctx.expect(written.includes(`authDomain: "${DOMAIN}"`)).toBeTruthy(); // brand host — the build self-hosts /__/auth/* (cp268)
        ctx.expect(written.includes('// Fixture Brand — hand-edited writeback target')).toBeTruthy();
      },
    },

    {
      name: 'sdk-config: dry run warns with the paste block and leaves omega.json5 untouched',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/sdk-config.js');
        const api = fakeFirebase(convergedResponses());
        const brandRoot = makeBrandRoot(FIREBASE_WRITEBACK_CONFIG);
        const before = readConfigSource(brandRoot);

        const result = await handler(handlerContext(brandConfig(), api, { brandRoot, options: { dryRun: true } }));

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.state.sdkConfig).toEqual(EXPECTED_SDK);
        ctx.expect(readConfigSource(brandRoot)).toBe(before);
      },
    },

    // ─── Hosting (one-pass converge) ─────────────────────────────────────────────

    {
      name: 'hosting: missing domain is created, ownership TXT + unproxied CNAME written, warned pending',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/hosting.js');
        let created = false;
        const api = fakeFirebase({
          ...convergedResponses(),
          checkDomainStatus: () => (created
            ? {
              exists: true,
              verified: false,
              ownershipState: 'OWNERSHIP_PENDING',
              hostState: 'HOST_UNHOSTED',
              requiredDnsUpdates: [{
                domainName: `api.${DOMAIN}`,
                desired: { records: [
                  { type: 'TXT', rdata: `hosting-site=${PROJECT}` },
                  { type: 'A', rdata: '199.36.158.100' }, // must be skipped
                ] },
              }],
            }
            : { verified: false, exists: false }),
          createCustomDomain: () => { created = true; return {}; },
        });
        const cf = fakeCf();

        const result = await handler(handlerContext(brandConfig(), api, { cloudflareApi: cf }));

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.state.hosting.domains[0].status).toBe('pending');
        ctx.expect(api.callsTo('createCustomDomain').length).toBe(1);

        const writes = cf.mutations();
        const txt = writes.find((w) => w.body?.type === 'TXT');
        const cname = writes.find((w) => w.body?.type === 'CNAME');
        ctx.expect(txt.body.content).toBe(`hosting-site=${PROJECT}`);
        ctx.expect(cname.body.content).toBe(`${PROJECT}.web.app`);
        ctx.expect(cname.body.proxied).toBe(false); // unproxied until verified
        ctx.expect(!writes.some((w) => w.body?.type === 'A')).toBeTruthy(); // A records skipped
      },
    },

    // #588: the op used to ensure an api.{sub}.{domain} per `brand.subdomains`
    // entry, a key nothing else declared or read. Ian's 2026-09-01 call: the web
    // INSTANCE is the subdomain and every instance shares ONE backend, so the
    // default site ensures api.<domain> and nothing per instance.
    {
      name: 'hosting: a multi-instance brand still ensures api.<domain> alone (#588)',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/hosting.js');
        const api = fakeFirebase(convergedResponses());
        const config = brandConfig();
        config.targets.web = [{ id: 'main' }, { id: 'admin' }, { id: 'cdn' }];

        const result = await handler(handlerContext(config, api));

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.state.hosting.domains).toEqual([{ domain: `api.${DOMAIN}`, status: 'verified' }]);

        // The retired key is inert: its reader is gone, not merely unused
        const stale = brandConfig();
        stale.brand.subdomains = ['admin', 'cdn'];
        const staleResult = await handler(handlerContext(stale, fakeFirebase(convergedResponses())));
        ctx.expect(staleResult.state.hosting.domains).toEqual([{ domain: `api.${DOMAIN}`, status: 'verified' }]);
      },
    },

    {
      name: 'hosting: cloud.apiSubdomain = false skips without touching anything',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/hosting.js');
        const api = fakeFirebase({});
        const config = brandConfig({ cloud: { apiSubdomain: false } });

        const result = await handler(handlerContext(config, api));

        ctx.expect(result).toEqual({});
        ctx.expect(api.calls.length).toBe(0);
      },
    },

    // ─── Dry run: drifted everywhere, zero mutations ─────────────────────────────

    {
      name: 'cloud: dry-run on a fully drifted project performs zero mutations',
      run: async (ctx) => {
        const config = brandConfig({ cloud: { billingAccount: 'billingAccounts/MY-OWN' } });
        const api = fakeFirebase({
          getProjectBillingInfo: { billingEnabled: false },
          listEnabledServices: [],
          getProjectNumber: PROJECT_NUMBER,
          getIamPolicy: () => ({ bindings: [] }),
          getGcpProject: { displayName: 'Old Name' },
          listWebApps: [],
          listBrands: [],
          listServiceAccounts: [],
          listHostingSites: [],
          getFirestoreDatabase: null,
          listRealtimeDatabases: [],
          getIdentityConfig: null,
          getStorageBucket: null,
          isServiceEnabled: () => false,
        });
        const cf = fakeCf();
        const brandRoot = tmpRoot();

        const result = await runService(config, {
          firebase: api,
          cloudflare: cf,
          brandRoot,
          options: { dryRun: true },
        });

        ctx.expect(result.status).not.toBe('error');
        ctx.expect(api.mutations()).toEqual([]);
        ctx.expect(cf.mutations()).toEqual([]);
        // No key file or secrets materialized either
        ctx.expect(jetpack.exists(path.join(brandRoot, '.omega', 'secrets'))).toBe(false);
      },
    },

    {
      name: 'oauth-consent: defaults supportEmail to the AUTHORIZING user, never support@domain (#29)',
      run: async (ctx) => {
        const api = fakeFirebase({
          listBrands: [],
          getAuthenticatedEmail: 'owner@example.com',
          createBrand: (projectId, title, email) => ({ name: 'projects/123/brands/b9', applicationTitle: title, supportEmail: email }),
        });

        const result = await ensureOAuthConsent({ firebaseApi: api, brandConfig: brandConfig(), projectId: PROJECT, domain: DOMAIN });

        ctx.expect(api.callsTo('createBrand')[0].args).toEqual([PROJECT, 'Fixture Brand', 'owner@example.com']);
        ctx.expect(result.state.oauthConsent.supportEmail).toBe('owner@example.com');
      },
    },

    {
      name: 'oauth-consent: config supportEmail (owned Google Group) wins; no email at all warns without mutating',
      run: async (ctx) => {
        const grp = fakeFirebase({
          listBrands: [],
          createBrand: (projectId, title, email) => ({ name: 'b', applicationTitle: title, supportEmail: email }),
        });
        await ensureOAuthConsent({
          firebaseApi: grp,
          brandConfig: brandConfig({ cloud: { supportEmail: 'team@groups.example.com' } }),
          projectId: PROJECT,
          domain: DOMAIN,
        });
        ctx.expect(grp.callsTo('createBrand')[0].args).toEqual([PROJECT, 'Fixture Brand', 'team@groups.example.com']);
        ctx.expect(grp.callsTo('getAuthenticatedEmail').length, 'config wins — no lookup').toBe(0);

        const none = fakeFirebase({ listBrands: [], getAuthenticatedEmail: null });
        const result = await ensureOAuthConsent({ firebaseApi: none, brandConfig: brandConfig(), projectId: PROJECT, domain: DOMAIN });
        ctx.expect(result.status).toBe('warned');
        ctx.expect(none.callsTo('createBrand').length, 'never sends a doomed value').toBe(0);
      },
    },

    {
      name: 'oauth-consent: an External audience is a ✓ — nothing asks, nothing polls (#667)',
      run: async (ctx) => {
        const api = fakeFirebase({ listBrands: [{ ...INTERNAL_BRAND, orgInternalOnly: false }] });
        const tty = openTtyPrompt(); // interactive: a gate or a poll here would hang

        try {
          const result = await ensureOAuthConsent(handlerContext(brandConfig(), api));

          ctx.expect(result.state.oauthConsent.audience).toBe('External');
          ctx.expect(result.status, 'already External — a clean run').toBe(undefined);
          ctx.expect(api.callsTo('listBrands').length, 'one read, no poll').toBe(1);
          ctx.expect(api.mutations()).toEqual([]);
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'oauth-consent: Internal + interactive STOPS — ENTER opens the console page and polls until it flips (#667)',
      run: async (ctx) => {
        // Google gives no API write for the audience: the human flips it in the
        // console and the ensure watches the brand read for it
        let reads = 0;
        const api = fakeFirebase({
          listBrands: () => (++reads === 1 ? [INTERNAL_BRAND] : [{ ...INTERNAL_BRAND, orgInternalOnly: false }]),
        });
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });
        const tty = openTtyPrompt();

        try {
          const run = ensureOAuthConsent(handlerContext(brandConfig(), api));
          await tty.answer('Set up now?', '\r'); // Yes
          await tty.answer('Press Enter to open the consent audience page', '\r');
          const result = await run;

          ctx.expect(opened).toEqual([AUDIENCE_URL]);
          ctx.expect(result.state.oauthConsent.audience).toBe('External');
          ctx.expect(result.status, 'the flip landed — nothing to warn about').toBe(undefined);
          ctx.expect(reads, 'the initial read plus the poll re-read').toBe(2);
          ctx.expect(api.mutations(), 'no write exists to attempt').toEqual([]);
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    {
      name: 'oauth-consent: (s) at the audience poll = later — Internal, warned with the reason (#667)',
      run: async (ctx) => {
        const api = fakeFirebase({ listBrands: [INTERNAL_BRAND] }); // never flips
        setBrowserOpener(async () => true);
        const tty = openTtyPrompt();

        try {
          const run = ensureOAuthConsent(handlerContext(brandConfig(), api));
          await tty.answer('Set up now?', '\r'); // Yes
          await tty.answer('Press Enter to open the consent audience page', '\r');
          await tty.answer('(enter)=check now, (s)=skip', 's');
          const result = await run;

          ctx.expect(result.status).toBe('warned');
          ctx.expect(result.reason).toMatch(/consent audience is Internal/);
          ctx.expect(result.state.oauthConsent.audience).toBe('Internal');
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    {
      name: 'oauth-consent: Disable lands cloud.consentAudience: false and the next run never asks (#667)',
      run: async (ctx) => {
        const api = fakeFirebase({ listBrands: [INTERNAL_BRAND] });
        const brandRoot = makeBrandRoot(AUDIENCE_CONFIG);
        const config = brandConfig();
        const tty = openTtyPrompt();

        try {
          const run = ensureOAuthConsent(handlerContext(config, api, { brandRoot }));
          await tty.answer('Set up now?', `${DOWN}${DOWN}\r`); // Disable (stop prompting)
          const result = await run;

          ctx.expect(result.status, 'a deliberate opt-out is not a warning').toBe(undefined);
          ctx.expect(result.state.oauthConsent.audience).toBe('Internal');
          const written = readConfigSource(brandRoot);
          ctx.expect(written.includes('consentAudience: false'), 'the opt-out lands in omega.json5').toBeTruthy();
          ctx.expect(!written.includes('enabled: false'), 'the whole cloud service never dies with the audience step').toBeTruthy();
          ctx.expect(written.includes('// consentAudience lands beside it'), 'the comment-preserving writeback').toBeTruthy();

          // The next run reads the recorded `false`: no gate, no poll — either
          // would hang on this still-open TTY
          const second = await ensureOAuthConsent(handlerContext(config, api, { brandRoot }));
          ctx.expect(second.status, 'a recorded opt-out is silent forever').toBe(undefined);
          ctx.expect(second.state.oauthConsent.audience).toBe('Internal');
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'oauth-consent: a non-interactive run warns with the console URL and never asks (#667)',
      run: async (ctx) => {
        const api = fakeFirebase({ listBrands: [INTERNAL_BRAND] });
        const lines = [];
        const originalLog = console.log;
        console.log = (...args) => lines.push(args.join(' '));

        let result;
        try {
          result = await ensureOAuthConsent(handlerContext(brandConfig(), api));
        } finally {
          console.log = originalLog;
        }

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.reason).toMatch(/consent audience is Internal/);
        ctx.expect(result.state.oauthConsent.audience).toBe('Internal');
        ctx.expect(lines.join('\n').includes(AUDIENCE_URL), 'the console URL is printed').toBeTruthy();
        ctx.expect(api.callsTo('listBrands').length, 'no poll without a TTY').toBe(1);
      },
    },

    {
      name: 'oauth-consent: a dry run plans the stopper without asking or writing',
      run: async (ctx) => {
        const api = fakeFirebase({ listBrands: [INTERNAL_BRAND] });

        const result = await ensureOAuthConsent(handlerContext(brandConfig(), api, { options: { dryRun: true } }));

        ctx.expect(api.mutations()).toEqual([]);
        ctx.expect(result.status, 'a dry run plans, it never warns').toBe(undefined);
        ctx.expect(result.state.oauthConsent.audience).toBe('Internal');
      },
    },

    {
      name: 'oauth-consent: a CREATED screen is born Internal — the audience goes through the same stopper (#667)',
      run: async (ctx) => {
        // Google creates API-made brands Internal, always: the create path reads
        // the returned brand and stops on it like any other
        const api = fakeFirebase({
          listBrands: [],
          getAuthenticatedEmail: 'owner@example.com',
          createBrand: (projectId, title, email) => ({ name: 'projects/123/brands/b9', applicationTitle: title, supportEmail: email, orgInternalOnly: true }),
        });

        const result = await ensureOAuthConsent(handlerContext(brandConfig(), api));

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.reason).toMatch(/consent audience is Internal/);
        ctx.expect(result.state.oauthConsent.audience).toBe('Internal');
      },
    },

    {
      name: "oauth-consent: an 'already exists' create re-reads the screen and reports it",
      run: async (ctx) => {
        // The list lagged (or a concurrent run won): the screen still gets its
        // audience read and reported, instead of a run that says nothing
        let listed = 0;
        const api = fakeFirebase({
          listBrands: () => (listed++ === 0 ? [] : [{ ...INTERNAL_BRAND, orgInternalOnly: false }]),
          getAuthenticatedEmail: 'owner@example.com',
          createBrand: () => { throw new Error('Requested entity already exists'); },
        });

        const result = await ensureOAuthConsent(handlerContext(brandConfig(), api));

        ctx.expect(result.state.oauthConsent.audience).toBe('External');
        ctx.expect(result.state.oauthConsent.supportEmail).toBe(INTERNAL_BRAND.supportEmail);
      },
    },

    {
      name: 'oauth-consent: an org-less project names the cause, never the generic could-not-create line (#667)',
      run: async (ctx) => {
        // Brand creation is org-only: an org-less project answers 400 "Project
        // must belong to an organization"
        const api = fakeFirebase({
          listBrands: [],
          getAuthenticatedEmail: 'owner@example.com',
          createBrand: () => { throw new Error('Google API Error: Project must belong to an organization.'); },
        });
        const lines = [];
        const originalLog = console.log;
        console.log = (...args) => lines.push(args.join(' '));

        let result;
        try {
          result = await ensureOAuthConsent(handlerContext(brandConfig(), api));
        } finally {
          console.log = originalLog;
        }

        const printed = lines.join('\n');
        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.reason).toMatch(/belongs to no organization/);
        ctx.expect(printed).toMatch(/belongs to no organization/);
        ctx.expect(!printed.includes('Could not create OAuth consent screen'), 'a known cause never gets the generic line').toBeTruthy();
      },
    },

    {
      name: 'oauth-consent: the walk NAMES the console branding page — Google gives no API for it (#696)',
      run: async (ctx) => {
        // The logo, the home/privacy/terms links and the authorized domains live on
        // a page with no API, so the run cannot reconcile them: it names the page
        // and says what is safe to change right now (#693's ruling).
        const capture = () => {
          const lines = [];
          const originalLog = console.log;
          console.log = (...args) => lines.push(args.join(' '));
          return { lines, restore: () => { console.log = originalLog; } };
        };

        const existing = fakeFirebase({ listBrands: [{ ...INTERNAL_BRAND, orgInternalOnly: false }] });
        const read = capture();
        let result;
        try {
          result = await ensureOAuthConsent(handlerContext(brandConfig(), existing));
        } finally {
          read.restore();
        }

        const printed = read.lines.join('\n');
        ctx.expect(result.status, 'naming a manual step never warns or fails the run').toBe(undefined);
        ctx.expect(printed.includes(BRANDING_URL), `the branding page URL is named, got:\n${printed}`).toBeTruthy();
        ctx.expect(printed, 'the one-line checklist says links + authorized domains are safe anytime').toMatch(/safe anytime/);
        ctx.expect(printed, 'and that a logo upload starts the verification review').toMatch(/verification review/i);
        ctx.expect(existing.mutations(), 'naming a page mutates nothing').toEqual([]);

        // The freshly CREATED screen gets the same naming — a new project is
        // exactly where the branding page has never been touched
        const created = fakeFirebase({
          listBrands: [],
          getAuthenticatedEmail: 'owner@example.com',
          createBrand: (projectId, title, email) => ({ name: 'projects/123/brands/b9', applicationTitle: title, supportEmail: email }),
        });
        const write = capture();
        try {
          await ensureOAuthConsent(handlerContext(brandConfig(), created));
        } finally {
          write.restore();
        }

        ctx.expect(write.lines.join('\n').includes(BRANDING_URL), 'the created screen names the branding page too').toBeTruthy();
      },
    },

    {
      name: 'project-flow: selecting an existing project lands cloud.config.projectId in omega.json5',
      run: async (ctx) => {
        const api = {
          listProjects: async () => [
            { projectId: 'other-proj', displayName: 'Other' },
            { projectId: 'fixture-brand', displayName: 'Fixture Brand' },
          ],
        };
        const brandRoot = makeBrandRoot(PROJECT_FLOW_CONFIG);
        const context = projectFlowContext(brandRoot);
        const tty = openTtyPrompt();

        try {
          const run = resolveFirebaseProject(context, api);
          await tty.answer('Set up now?', '\r'); // Yes
          // Cursor lands on the brand match "Fixture Brand (fixture-brand)"
          await tty.answer('Select Firebase project:', '\r');
          const projectId = await run;

          ctx.expect(projectId).toBe('fixture-brand');
          ctx.expect(context.brandConfig.cloud.config.projectId).toBe('fixture-brand');
          const written = readConfigSource(brandRoot);
          ctx.expect(written.includes('projectId: "fixture-brand"')).toBeTruthy();
          ctx.expect(written.includes('// projectId lands under cloud.config')).toBeTruthy();
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'project-flow: create-new prompts id + name and creates inside the configured organization',
      run: async (ctx) => {
        const created = [];
        const api = {
          listProjects: async () => [], // also drives the quota print (0/30)
          createProject: async (projectId, displayName, organizationId) => {
            created.push({ projectId, displayName, organizationId });
            return { projectId, displayName };
          },
        };
        const brandRoot = makeBrandRoot(PROJECT_FLOW_CONFIG);
        const context = projectFlowContext(brandRoot);
        const tty = openTtyPrompt();

        try {
          const run = resolveFirebaseProject(context, api);
          await tty.answer('Set up now?', '\r');
          await tty.answer('Select Firebase project:', '\r'); // "+ Create new" is the only choice
          await tty.answer('Enter project ID', '\r');   // accept the default (brand id)
          await tty.answer('Enter display name', '\r'); // accept the default (brand name)
          const projectId = await run;

          ctx.expect(projectId).toBe('fixture-brand');
          ctx.expect(created).toEqual([{ projectId: 'fixture-brand', displayName: 'Fixture Brand', organizationId: '123456789' }]);
          ctx.expect(readConfigSource(brandRoot).includes('projectId: "fixture-brand"')).toBeTruthy();
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'project-flow: create-new with no org configured asks — the picked org lands in omega.json5 and createProject (#33)',
      run: async (ctx) => {
        const created = [];
        const api = {
          listProjects: async () => [],
          listOrganizations: async () => [
            { name: 'organizations/999888777', displayName: 'fixture-brand.test' },
          ],
          createProject: async (projectId, displayName, organizationId) => {
            created.push({ projectId, displayName, organizationId });
            return { projectId, displayName };
          },
        };
        const brandRoot = makeBrandRoot(PROJECT_FLOW_CONFIG);
        const context = projectFlowContext(brandRoot);
        delete context.brandConfig.cloud.organizationId; // unset → tri-state asks
        const tty = openTtyPrompt();

        try {
          const run = resolveFirebaseProject(context, api);
          await tty.answer('Set up now?', '\r');
          await tty.answer('Select Firebase project:', '\r'); // "+ Create new" is the only choice
          await tty.answer('Enter project ID', '\r');
          await tty.answer('Enter display name', '\r');
          // Org question — cursor on the only real org, ENTER picks it
          await tty.answer('Create the project inside a Google Cloud organization?', '\r');
          const projectId = await run;

          ctx.expect(projectId).toBe('fixture-brand');
          ctx.expect(created).toEqual([{ projectId: 'fixture-brand', displayName: 'Fixture Brand', organizationId: '999888777' }]);
          ctx.expect(readConfigSource(brandRoot).includes('organizationId: "999888777"')).toBeTruthy();
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'project-flow: org opt-out creates the project standalone and lands cloud.organizationId: false (#33)',
      run: async (ctx) => {
        const created = [];
        const api = {
          listProjects: async () => [],
          listOrganizations: async () => [
            { name: 'organizations/999888777', displayName: 'fixture-brand.test' },
          ],
          createProject: async (projectId, displayName, organizationId) => {
            created.push({ projectId, displayName, organizationId });
            return { projectId, displayName };
          },
        };
        const brandRoot = makeBrandRoot(PROJECT_FLOW_CONFIG);
        const context = projectFlowContext(brandRoot);
        delete context.brandConfig.cloud.organizationId;
        const tty = openTtyPrompt();

        try {
          const run = resolveFirebaseProject(context, api);
          await tty.answer('Set up now?', '\r');
          await tty.answer('Select Firebase project:', '\r');
          await tty.answer('Enter project ID', '\r');
          await tty.answer('Enter display name', '\r');
          // DOWN past the org to "No organization — create it standalone"
          await tty.answer('Create the project inside a Google Cloud organization?', `${DOWN}\r`);
          const projectId = await run;

          ctx.expect(projectId).toBe('fixture-brand');
          // Opt-out → createProject standalone; the config-flow suite pins that the
          // landed false short-circuits every later ask (tri-state round-trip)
          ctx.expect(created).toEqual([{ projectId: 'fixture-brand', displayName: 'Fixture Brand', organizationId: null }]);
          const written = readConfigSource(brandRoot);
          ctx.expect(written.includes('organizationId: false')).toBeTruthy();
          ctx.expect(context.brandConfig.cloud.organizationId).toBe(false);
        } finally {
          tty.close();
        }
      },
    },

    // ─── Hosting: interactive verification poll ──────────────────────────────────

    {
      name: 'hosting: interactive run polls until verified, writing the mid-poll ACME record and proxying the CNAME',
      run: async (ctx) => {
        const handler = require('../src/services/cloud/ensure/hosting.js');
        const OWNERSHIP = { type: 'TXT', rdata: `hosting-site=${PROJECT}` };
        const ACME = { type: 'TXT', rdata: 'acme-validation-token' };
        const updates = (records, domainName = `api.${DOMAIN}`) => [{ domainName, desired: { records } }];

        // missing → created-pending (1 required record) → still-pending with the
        // ACME challenge added (2 records — must be written mid-poll) → verified
        let checks = 0;
        const api = fakeFirebase({
          ...convergedResponses(),
          createCustomDomain: {},
          checkDomainStatus: () => {
            checks++;
            if (checks === 1) return { verified: false, exists: false };
            if (checks === 2) return { verified: false, exists: true, ownershipState: 'OWNERSHIP_PENDING', hostState: 'HOST_UNHOSTED', requiredDnsUpdates: updates([OWNERSHIP]) };
            if (checks === 3) return { verified: false, exists: true, ownershipState: 'OWNERSHIP_ACTIVE', hostState: 'HOST_UNHOSTED', requiredDnsUpdates: [...updates([OWNERSHIP]), ...updates([ACME], `_acme-challenge.api.${DOMAIN}`)] };
            return { verified: true };
          },
        });
        const cf = fakeCf();
        const tty = openTtyPrompt();

        try {
          const run = handler(handlerContext(brandConfig(), api, { cloudflareApi: cf }));
          // ENTER = "check now" — keep nudging so the poll never waits an interval
          await tty.answer('check now', '\r');
          const nudge = setInterval(() => { tty.answer('check now', '\r').catch(() => {}); }, 80);
          let result;
          try {
            result = await run;
          } finally {
            clearInterval(nudge);
          }

          ctx.expect(result.status).toBe('success');
          ctx.expect(result.state.hosting.domains[0].status).toBe('verified');
          ctx.expect(checks >= 4).toBeTruthy();

          const writes = cf.mutations();
          ctx.expect(writes.some((w) => w.body?.content === ACME.rdata)).toBeTruthy(); // ACME TXT written mid-poll
          ctx.expect(writes.some((w) => w.body?.type === 'CNAME' && w.body?.proxied === true)).toBeTruthy(); // proxied after verify
        } finally {
          tty.close();
        }
      },
    },
  ],
});
