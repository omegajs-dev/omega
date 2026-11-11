/**
 * Analytics service tests — GA4 streams/firebase-link against a method-level
 * recording fake of the Analytics Admin API, plus the meta/tiktok pixel
 * provisioning and token checks. Proves skip/filter semantics, the converged
 * zero-mutation no-op across all four operations, per-target stream creation,
 * diff-first rename + enhanced measurement, the clean-secret lifecycle, the
 * acknowledgement-gate warn, wrong-property link moves, the per-target
 * measurement-id writeback, find-by-name-before-create pixel provisioning
 * with its token gate, the near-zero-input Meta pass (gate → Enter-gated
 * token page → paste-in → ad-account discovery → create, all in one run) with
 * its `providers.meta: false` off switch, and the fully-drifted dry-run
 * guarantee.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

const { OPERATIONS, DEFAULTS } = require('../src/config.js');
const service = require('../src/services/analytics/index.js');
const { MetaMarketingAPI } = require('../src/services/analytics/lib/meta-api.js');
const { TikTokBusinessAPI } = require('../src/services/analytics/lib/tiktok-api.js');
const { resolveGoogleProperty } = require('../src/services/analytics/lib/property-flow.js');
const { join } = require('node:path');
const jetpack = require('fs-jetpack');

const { makeBrandRoot, readConfigSource } = require('./lib/config-fixture.js');
const { openTtyPrompt } = require('./lib/interactive.js');

/** The brand .env the analytics service writes each stream secret into (#434). */
const readEnv = (brandRoot) => jetpack.read(join(brandRoot, '.env')) || '';

// Tests must never see real credentials from the shell environment
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.META_ACCESS_TOKEN;
delete process.env.TIKTOK_ACCESS_TOKEN;

const DOMAIN = 'fixture-brand.test';
const ACCOUNT = '999888';
const PROPERTY = '123456';
const PROJECT = 'fixture-proj';
const PROJECT_NUMBER = '123456789';

// All enhanced-measurement keys enabled — matches the manager defaults
const ENHANCED_ALL = structuredClone(DEFAULTS.analytics.providers.google.enhancedMeasurement);

const WEB_STREAM = {
  name: `properties/${PROPERTY}/dataStreams/101`,
  type: 'WEB_DATA_STREAM',
  displayName: 'Fixture Brand - Website',
  webStreamData: { defaultUri: `https://${DOMAIN}`, measurementId: 'G-WEB1' },
};
const BACKEND_STREAM = {
  name: `properties/${PROPERTY}/dataStreams/102`,
  type: 'WEB_DATA_STREAM',
  displayName: 'Fixture Brand - Backend',
  webStreamData: { defaultUri: `https://api.${DOMAIN}`, measurementId: 'G-BACK1' },
};
// The stream Firebase auto-creates when linking, already normalized
const FIREBASE_STREAM = {
  name: `properties/${PROPERTY}/dataStreams/103`,
  type: 'WEB_DATA_STREAM',
  displayName: 'Fixture Brand - Firebase',
  webStreamData: { defaultUri: `https://${PROJECT}.firebaseapp.com`, measurementId: 'G-FIREBASE1' },
};
const CLEAN_SECRET = {
  name: `properties/${PROPERTY}/dataStreams/101/measurementProtocolSecrets/s1`,
  displayName: 'Secret',
  secretValue: 'cleansecret123',
};
const OUR_LINK = { name: `properties/${PROPERTY}/firebaseLinks/fl1`, project: `projects/${PROJECT_NUMBER}` };

// What the cloud service leaves in config (messagingSenderId IS the project
// number) — the google ops read both from there since #434
const FIREBASE_SDK_CONFIG = { measurementId: 'G-FIREBASE1', messagingSenderId: PROJECT_NUMBER };

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Every run gets a writeback-ready root: the stream reconcile lands each
// target's measurement id in omega.json5, and the pixel provisioning lands
// the pixel ids, so a fixture root without a real config file is not a
// runnable brand.
const FIXTURE_CONFIG = `{
  // Fixture Brand — analytics writeback target
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://fixture-brand.test' },
  cloud: { config: { projectId: 'fixture-proj' } },
  targets: { web: { type: 'web' }, backend: { type: 'backend' } },
}
`;

function brandConfig({
  url = `https://${DOMAIN}`, targets = { web: { type: 'web' }, backend: { type: 'backend' } }, google = true,
  metaId = null, tiktokId = null, metaAccount = null, tiktokAccount = null,
  metaDisabled = false, firebase = true,
} = {}) {
  const config = {
    brand: { id: 'fixture-brand', name: 'Fixture Brand', url },
    analytics: structuredClone(DEFAULTS.analytics),
    cloud: { config: { projectId: PROJECT, ...(firebase ? FIREBASE_SDK_CONFIG : {}) } },
    targets,
  };
  if (google) {
    config.analytics.providers.google.accountId = ACCOUNT;
    config.analytics.providers.google.propertyId = PROPERTY;
  }
  config.analytics.providers.meta.id = metaId;
  config.analytics.providers.meta.accountId = metaAccount;
  config.analytics.providers.tiktok.id = tiktokId;
  config.analytics.providers.tiktok.accountId = tiktokAccount;
  // The tri-state opt-out (#33): an unconfigured Meta half ASKS in a TTY, so
  // every interactive test that isn't about Meta turns it off the same way a
  // brand would
  if (metaDisabled) {
    config.analytics.providers.meta = false;
  }
  return config;
}

/**
 * Stub the real browser launch — pressEnterToOpen's seam (module.exports
 * .openInBrowser), the moment a human would see the page.
 */
function stubBrowser(onOpen) {
  const promptModule = require('@omega.js/devkit/prompt');
  const real = promptModule.openInBrowser;
  const opened = [];

  promptModule.openInBrowser = (url) => {
    opened.push(url);
    onOpen?.(url);
    return true;
  };

  return { opened, restore: () => { promptModule.openInBrowser = real; } };
}

const READ_METHODS = [
  'getProperty', 'listDataStreams', 'getEnhancedMeasurementSettings',
  'listMeasurementProtocolSecrets', 'listFirebaseLinks', 'listAccounts', 'listProperties',
];
const MUTATING_METHODS = [
  'createWebDataStream', 'updateDataStream', 'updateEnhancedMeasurementSettings',
  'createMeasurementProtocolSecret', 'deleteMeasurementProtocolSecret',
  'createFirebaseLink', 'deleteFirebaseLink',
];

/**
 * Recording fake GoogleAnalyticsAPI. Static values are cloned per call,
 * functions are called with the method args (throw inside one to simulate an
 * API error). A method with no configured response throws — so the converged
 * no-op test fails LOUDLY on any unexpected mutation.
 */
function fakeAnalytics(responses = {}) {
  const api = { calls: [] };

  for (const method of [...READ_METHODS, ...MUTATING_METHODS]) {
    api[method] = async (...args) => {
      api.calls.push({ method, args });
      if (!(method in responses)) {
        throw new Error(`fakeAnalytics: no response configured for ${method}(${JSON.stringify(args)})`);
      }
      const value = responses[method];
      return typeof value === 'function' ? await value(...args) : structuredClone(value);
    };
  }

  api.mutations = () => api.calls.filter((c) => MUTATING_METHODS.includes(c.method));
  api.callsTo = (method) => api.calls.filter((c) => c.method === method);
  return api;
}

/** Everything a fully converged two-target brand reads. */
function convergedResponses() {
  return {
    getProperty: { name: `properties/${PROPERTY}`, displayName: `Fixture Brand (${DOMAIN})` },
    listDataStreams: [WEB_STREAM, BACKEND_STREAM, FIREBASE_STREAM],
    getEnhancedMeasurementSettings: ENHANCED_ALL,
    listMeasurementProtocolSecrets: [CLEAN_SECRET],
    listFirebaseLinks: [OUR_LINK],
  };
}

function runService(config, { analytics, meta, tiktok, options = {}, metaToken, tiktokToken, brandRoot } = {}) {
  if (metaToken) {
    process.env.META_ACCESS_TOKEN = metaToken;
  } else {
    delete process.env.META_ACCESS_TOKEN;
  }
  if (tiktokToken) {
    process.env.TIKTOK_ACCESS_TOKEN = tiktokToken;
  } else {
    delete process.env.TIKTOK_ACCESS_TOKEN;
  }
  // Each run starts from a brand .env with no stream secrets in it — the
  // handler seeds its fallback from process.env (#434)
  for (const target of ['web', 'backend', 'desktop', 'extension', 'mobile']) {
    delete process.env[`GOOGLE_ANALYTICS_SECRET_${target.toUpperCase()}`];
  }

  return service.run({
    brandId: 'fixture-brand',
    brandRoot: brandRoot || makeBrandRoot(FIXTURE_CONFIG), // every run may write config/omega.json5
    brandConfig: config,
    brand: { id: 'fixture-brand', config, enabledTargets: Object.keys(config.targets || {}), targets: [] },
    targets: [],
    operations: OPERATIONS.analytics,
    options,
    analyticsApi: analytics,
    metaApi: meta,
    tiktokApi: tiktok,
  });
}

// ─── Pixel provisioning (#417) ───────────────────────────────────────────────
// Meta is LIVE; TikTok rides the SAME flow but no brand carries its token
// yet, so every real run of the TikTok half ends at the warned guidance.

const PIXEL_METHODS = ['listAdAccounts', 'listPixels', 'createPixel'];

/**
 * Recording fake pixel client — meta and tiktok share the normalized
 * { id, name } surface, so one fake serves both. An unconfigured method
 * throws, which is how the converged tests prove nothing was called.
 */
function fakePixelApi(responses = {}) {
  const api = { calls: [] };

  for (const method of PIXEL_METHODS) {
    api[method] = async (...args) => {
      api.calls.push({ method, args });
      if (!(method in responses)) {
        throw new Error(`fakePixelApi: no response configured for ${method}(${JSON.stringify(args)})`);
      }
      const value = responses[method];
      return typeof value === 'function' ? await value(...args) : structuredClone(value);
    };
  }

  api.callsTo = (method) => api.calls.filter((c) => c.method === method);
  return api;
}

// ─── Near-zero-input Meta pass (#417, Ian 2026-08-21) ────────────────────────
// The GA4 half's standard applied to the pixel: the run acquires what it
// needs instead of demanding it in config first — the token via the
// Enter-gated walk to the page that mints it, the ad account from the token
// itself. `providers.meta: false` is the off switch for all of it.

const AD_ACCOUNT = { id: '1234567890', name: 'Fixture Brand Ads' };
const SYSTEM_USERS_URL = 'https://business.facebook.com/settings/system-users';
const DOWN = '\x1B[B'; // arrow-down escape for select() answers

// ─── Company-default GA account (cp257) ──────────────────────────────────────
// A company-managed brand inherits `analytics.providers.google.accountId`
// through the merge chain (company layer under the brand file). The flow says
// so with a dim note instead of prompting; an explicit brand value wins in
// the merge and gets no note; the picker stays the fallback.

/** Capture console.log lines around a flow run (prompt I/O bypasses console). */
function captureLog() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  return { lines, restore: () => { console.log = original; } };
}

const COMPANY_NOTE = 'defaulting to company account';

// ─── Pixel API clients (#417) ────────────────────────────────────────────────
// The clients are the ONLY place the platform request shapes live. Meta's is
// proven against the live Marketing API; TikTok's is the SCAFFOLD half —
// pinning it here is what makes the flip a token, not a rewrite.

/** Record every fetch and answer with a canned response. */
function stubFetch(response) {
  const original = global.fetch;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: response.ok !== false,
      status: response.status || 200,
      text: async () => JSON.stringify(response.body),
    };
  };

  return { calls, restore: () => { global.fetch = original; } };
}

module.exports = defineCases({
  type: 'group',
  description: 'analytics',
  tests: [
    // ─── Setup / skip semantics ──────────────────────────────────────────────────

    {
      name: 'analytics: skips when no provider is configured',
      run: async (ctx) => {
        const result = await runService(brandConfig({ google: false }));
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/no analytics providers configured/);
      },
    },

    {
      name: 'analytics: analytics.enabled = false skips the service',
      run: async (ctx) => {
        const config = brandConfig();
        config.analytics.enabled = false;

        const result = await runService(config, { analytics: fakeAnalytics() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/analytics\.enabled/);
      },
    },

    {
      name: 'analytics: google-only config without credentials skips the service',
      run: async (ctx) => {
        const result = await runService(brandConfig());
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/GOOGLE_CLIENT_ID/);
      },
    },

    {
      name: 'analytics: no propertyId filters the google operations; pixel checks still run',
      run: async (ctx) => {
        // No fake API injected — if the filter failed, google-streams would crash
        const result = await runService(brandConfig({ google: false, metaId: 'PIXEL123' }));

        ctx.expect(result.status).toBe('warned'); // meta id configured but no token
        ctx.expect(result.output.meta.pixelId).toBe('PIXEL123');
        ctx.expect(result.output.meta.tokenConfigured).toBe(false);
        ctx.expect(result.output?.streams).toBe(undefined); // google-streams never ran
      },
    },

    // ─── Converged no-op ─────────────────────────────────────────────────────────

    {
      name: 'analytics: a fully converged brand is a zero-mutation no-op across all 4 operations',
      run: async (ctx) => {
        const api = fakeAnalytics(convergedResponses());

        const result = await runService(brandConfig({ metaId: 'PIXEL123', tiktokId: 'TT123' }), {
          analytics: api,
          metaToken: 'meta-token',
          tiktokToken: 'tiktok-token',
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.mutations().length).toBe(0);

        ctx.expect(result.output.streams.resolved.web.measurementId).toBe('G-WEB1');
        ctx.expect(result.output.streams.resolved.backend.streamId).toBe('102');
        ctx.expect(result.output.firebaseLink.linked).toBe(true);
        ctx.expect(result.output.meta.tokenConfigured).toBe(true);
        ctx.expect(result.output.tiktok.tokenConfigured).toBe(true);
      },
    },

    // ─── Stream reconciliation ───────────────────────────────────────────────────

    {
      name: 'analytics: missing streams are created with the per-target URI and display name',
      run: async (ctx) => {
        let nextId = 200;
        const api = fakeAnalytics({
          ...convergedResponses(),
          listDataStreams: [], // property has no streams at all
          // No firebase state in this test → the link must match by project ID
          listFirebaseLinks: [{ name: `properties/${PROPERTY}/firebaseLinks/fl1`, project: `projects/${PROJECT}` }],
          createWebDataStream: (propertyId, { defaultUri, displayName }) => ({
            name: `properties/${PROPERTY}/dataStreams/${++nextId}`,
            type: 'WEB_DATA_STREAM',
            displayName,
            webStreamData: { defaultUri, measurementId: `G-NEW${nextId}` },
          }),
        });

        const result = await runService(brandConfig(), { analytics: api });

        const creates = api.callsTo('createWebDataStream');
        ctx.expect(creates.length).toBe(2);
        ctx.expect(creates[0].args[1]).toEqual({ defaultUri: `https://${DOMAIN}`, displayName: 'Fixture Brand - Website' });
        ctx.expect(creates[1].args[1]).toEqual({ defaultUri: `https://api.${DOMAIN}`, displayName: 'Fixture Brand - Backend' });

        ctx.expect(result.output.streams.resolved.web.measurementId).toBe('G-NEW201');
        ctx.expect(result.output.streams.resolved.backend.measurementId).toBe('G-NEW202');
        // Correctly-named creations need no rename
        ctx.expect(api.callsTo('updateDataStream').length).toBe(0);
      },
    },

    {
      name: 'analytics: streams follow the NAMES a brand declares, typed by their own type (#886)',
      run: async (ctx) => {
        let nextId = 300;
        const api = fakeAnalytics({
          ...convergedResponses(),
          listDataStreams: [],
          listFirebaseLinks: [{ name: `properties/${PROPERTY}/firebaseLinks/fl1`, project: `projects/${PROJECT}` }],
          createWebDataStream: (propertyId, { defaultUri, displayName }) => ({
            name: `properties/${PROPERTY}/dataStreams/${++nextId}`,
            type: 'WEB_DATA_STREAM',
            displayName,
            webStreamData: { defaultUri, measurementId: `G-NEW${nextId}` },
          }),
        });

        const config = brandConfig({
          targets: {
            web: { type: 'web' },
            community: { type: 'web' },
            api: { type: 'backend' },
          },
        });
        const result = await runService(config, { analytics: api });

        const creates = api.callsTo('createWebDataStream').map((call) => call.args[1]);
        ctx.expect(creates).toEqual([
          // The type-named web target is the brand url; the second web target is its
          // own subdomain, resolved by targetUrl, never a second root-domain stream
          { defaultUri: `https://${DOMAIN}`, displayName: 'Fixture Brand - Website' },
          { defaultUri: `https://community.${DOMAIN}`, displayName: 'Fixture Brand - Website' },
          // A backend NAMED api keeps the backend's virtual subdomain + display name
          { defaultUri: `https://api.${DOMAIN}`, displayName: 'Fixture Brand - Backend' },
        ]);

        // Everything downstream is keyed by the NAME the brand declared
        ctx.expect(Object.keys(result.output.streams.resolved)).toEqual(['web', 'community', 'api']);
      },
    },

    {
      name: 'analytics: a brand on a default Pages host streams its website and its Cloud Functions API, and no other target',
      run: async (ctx) => {
        let nextId = 400;
        const api = fakeAnalytics({
          ...convergedResponses(),
          listDataStreams: [],
          listFirebaseLinks: [{ name: `properties/${PROPERTY}/firebaseLinks/fl1`, project: `projects/${PROJECT}` }],
          createWebDataStream: (propertyId, { defaultUri, displayName }) => ({
            name: `properties/${PROPERTY}/dataStreams/${++nextId}`,
            type: 'WEB_DATA_STREAM',
            displayName,
            webStreamData: { defaultUri, measurementId: `G-NEW${nextId}` },
          }),
        });

        const config = brandConfig({
          url: 'https://dreamr-design.github.io/dreamr-web',
          targets: { web: { type: 'web' }, backend: { type: 'backend' }, desktop: { type: 'desktop' } },
        });
        const result = await runService(config, { analytics: api });

        ctx.expect(api.callsTo('createWebDataStream').map((call) => call.args[1])).toEqual([
          { defaultUri: 'https://dreamr-design.github.io/dreamr-web', displayName: 'Fixture Brand - Website' },
          { defaultUri: `https://us-central1-${PROJECT}.cloudfunctions.net/omega_api`, displayName: 'Fixture Brand - Backend' },
        ]);
        ctx.expect(Object.keys(result.output.streams.resolved), 'a desktop has no address on a Pages host').toEqual(['web', 'backend']);
      },
    },

    // ─── Measurement id → config (#417) ──────────────────────────────────────────
    // Before this, stream ids only ever reached .omega/state.json, so a brand's
    // configured `analytics.providers.google.id` stayed null (the playground's
    // still was, months after its property was created) and each target's
    // Measurement Protocol secret had no stream id of its own to pair with.

    {
      name: 'analytics: each target measurement id lands in targets.<name>.analytics.providers.google.id',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const api = fakeAnalytics(convergedResponses());

        await runService(brandConfig(), { analytics: api, brandRoot });

        const written = readConfigSource(brandRoot);
        ctx.expect(written).toMatch(/targets:[\s\S]*web:[\s\S]*analytics:[\s\S]*google:[\s\S]*id: "G-WEB1"/);
        ctx.expect(written).toMatch(/backend:[\s\S]*analytics:[\s\S]*google:[\s\S]*id: "G-BACK1"/);
        // The per-surface override never touches the shared block: nothing lands at
        // the config's TOP level, only inside each target's entry
        ctx.expect(written, 'shared analytics block untouched').not.toMatch(/^ {2}analytics:/m);
        ctx.expect(written.includes('// Fixture Brand — analytics writeback target'), 'comments survive').toBeTruthy();
      },
    },

    {
      name: 'analytics: a config already carrying the measurement ids is left byte-identical',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const first = fakeAnalytics(convergedResponses());
        await runService(brandConfig(), { analytics: first, brandRoot });

        const landed = readConfigSource(brandRoot);
        const config = brandConfig();
        config.targets = {
          web: { type: 'web', analytics: { providers: { google: { id: 'G-WEB1' } } } },
          backend: { type: 'backend', analytics: { providers: { google: { id: 'G-BACK1' } } } },
        };

        const second = fakeAnalytics(convergedResponses());
        await runService(config, { analytics: second, brandRoot });

        ctx.expect(readConfigSource(brandRoot), 'converged rerun writes nothing').toBe(landed);
      },
    },

    {
      name: 'analytics: displayName drift renames the stream without creating',
      run: async (ctx) => {
        const drifted = structuredClone(WEB_STREAM);
        drifted.displayName = 'Old Stream Name';

        const api = fakeAnalytics({
          ...convergedResponses(),
          listDataStreams: [drifted, FIREBASE_STREAM],
          updateDataStream: {},
        });

        const result = await runService(brandConfig({ targets: { web: { type: 'web' } } }), {
          analytics: api,
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('createWebDataStream').length).toBe(0);
        const renames = api.callsTo('updateDataStream');
        ctx.expect(renames.length).toBe(1);
        ctx.expect(renames[0].args[2]).toEqual({ displayName: 'Fixture Brand - Website' });
      },
    },

    {
      name: 'analytics: enhanced measurement is patched only on drift (omega-manager patched every run)',
      run: async (ctx) => {
        const driftedSettings = { ...ENHANCED_ALL, scrollsEnabled: false };

        const api = fakeAnalytics({
          ...convergedResponses(),
          listDataStreams: [WEB_STREAM, FIREBASE_STREAM],
          getEnhancedMeasurementSettings: driftedSettings,
          updateEnhancedMeasurementSettings: {},
        });

        await runService(brandConfig({ targets: { web: { type: 'web' } } }), {
          analytics: api,
        });

        const patches = api.callsTo('updateEnhancedMeasurementSettings');
        ctx.expect(patches.length).toBe(1);
        ctx.expect(patches[0].args[2]).toEqual(ENHANCED_ALL);
      },
    },

    {
      name: 'analytics: an unclean secret is regenerated until clean',
      run: async (ctx) => {
        const uncleanSecret = { ...CLEAN_SECRET, secretValue: 'dirty-secret_1' };
        const created = ['still_dirty', 'finallyclean'];
        let createCount = 0;

        const api = fakeAnalytics({
          ...convergedResponses(),
          listDataStreams: [WEB_STREAM, FIREBASE_STREAM],
          listMeasurementProtocolSecrets: [uncleanSecret],
          createMeasurementProtocolSecret: () => ({
            name: `properties/${PROPERTY}/dataStreams/101/measurementProtocolSecrets/new${createCount}`,
            displayName: 'Secret',
            secretValue: created[createCount++],
          }),
          deleteMeasurementProtocolSecret: { deleted: true },
        });

        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        await runService(brandConfig({ targets: { web: { type: 'web' } } }), { analytics: api, brandRoot });

        // Original unclean + first regeneration deleted; two creates until clean
        ctx.expect(api.callsTo('deleteMeasurementProtocolSecret').length).toBe(2);
        ctx.expect(api.callsTo('createMeasurementProtocolSecret').length).toBe(2);
        // The clean secret's home is the brand .env, never omega.json5 (#434)
        ctx.expect(readEnv(brandRoot)).toMatch(/GOOGLE_ANALYTICS_SECRET_WEB="finallyclean"/);
        ctx.expect(!readConfigSource(brandRoot).includes('finallyclean')).toBeTruthy();
      },
    },

    {
      name: 'analytics: the data-collection acknowledgement gate warns instead of failing',
      run: async (ctx) => {
        const api = fakeAnalytics({
          ...convergedResponses(),
          listDataStreams: [WEB_STREAM, FIREBASE_STREAM],
          listMeasurementProtocolSecrets: () => {
            throw new Error('HTTP 403: User Data Collection Acknowledgement required.');
          },
        });

        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const result = await runService(brandConfig({ targets: { web: { type: 'web' } } }), { analytics: api, brandRoot });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(readEnv(brandRoot)).toBe(''); // no secret resolved, nothing written
        ctx.expect(api.mutations().length).toBe(0);
      },
    },

    {
      name: 'analytics: interactive acknowledgement — Enter-gated open, retry poll lands the secret in ONE run',
      run: async (ctx) => {
        // openInBrowser is the moment the human sees the page — the stub "acks"
        let acked = false;
        const api = fakeAnalytics({
          ...convergedResponses(),
          listDataStreams: [WEB_STREAM, FIREBASE_STREAM],
          listMeasurementProtocolSecrets: () => {
            throw new Error('HTTP 403: User Data Collection Acknowledgement required.');
          },
          createMeasurementProtocolSecret: () => {
            if (!acked) {
              throw new Error('HTTP 403: User Data Collection Acknowledgement required.');
            }
            return { name: `properties/${PROPERTY}/dataStreams/101/measurementProtocolSecrets/s9`, displayName: 'Secret', secretValue: 'freshcleansecret' };
          },
        });

        const browser = stubBrowser(() => { acked = true; });
        const tty = openTtyPrompt();
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        try {
          const run = runService(brandConfig({ targets: { web: { type: 'web' } }, metaDisabled: true }), {
            analytics: api, brandRoot,
            });

          await tty.answer('Press Enter to open the data-collection acknowledgement page', '\r');
          await tty.answer('(enter)=check now, (s)=skip', '\r');
          const result = await run;

          ctx.expect(readEnv(brandRoot)).toMatch(/GOOGLE_ANALYTICS_SECRET_WEB="freshcleansecret"/);
          ctx.expect(result.status, 'the acknowledged run finishes green — no rerun needed').toBe('success');
          ctx.expect(browser.opened[0]).toMatch(/analytics\.google\.com/);
        } finally {
          browser.restore();
          tty.close();
        }
      },
    },

    {
      name: 'analytics: firebase-link derives the project from cloud.config — its ONE home (#23)',
      run: async (ctx) => {
        const config = brandConfig({ targets: { web: { type: 'web' } } });
        // BOTH halves come from cloud.config now: the id, and the project NUMBER
        // the link may reference instead (#434 moved it off state)
        config.cloud = { provider: 'firebase', config: { projectId: PROJECT, ...FIREBASE_SDK_CONFIG } };

        const api = fakeAnalytics(convergedResponses());
        const result = await runService(config, { analytics: api });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('listFirebaseLinks').length > 0, 'the link op ran instead of skipping on a missing cloud.config.projectId').toBeTruthy();
        ctx.expect(api.mutations().length, 'converged link stays a no-op').toBe(0);
      },
    },

    {
      name: 'analytics: a configured propertyId that does not exist warns',
      run: async (ctx) => {
        const api = fakeAnalytics({
          ...convergedResponses(),
          getProperty: null,
          listDataStreams: [FIREBASE_STREAM],
        });

        const result = await runService(brandConfig({ targets: { web: { type: 'web' } } }), {
          analytics: api,
        });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.streams.error).toMatch(/not found/);
      },
    },

    {
      name: 'analytics: firebase measurementId missing from the property warns of a cross-link',
      run: async (ctx) => {
        // Property carries only the web stream — Firebase's G-FIREBASE1 lives elsewhere
        const api = fakeAnalytics({
          ...convergedResponses(),
          listDataStreams: [WEB_STREAM],
        });

        const result = await runService(brandConfig({ targets: { web: { type: 'web' } } }), {
          analytics: api,
        });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(api.mutations().length).toBe(0);
      },
    },

    // ─── Firebase link ───────────────────────────────────────────────────────────

    {
      name: 'analytics: a link on the wrong property is moved to the configured one',
      run: async (ctx) => {
        const api = fakeAnalytics({
          ...convergedResponses(),
          listDataStreams: [WEB_STREAM, FIREBASE_STREAM],
          listFirebaseLinks: (propertyId) => (propertyId === '777'
            ? [{ name: 'properties/777/firebaseLinks/fl9', project: `projects/${PROJECT_NUMBER}` }]
            : []),
          listAccounts: [{ name: `accounts/${ACCOUNT}`, displayName: 'Fixture Account' }],
          listProperties: [{ name: 'properties/777', displayName: 'Wrong Property' }],
          deleteFirebaseLink: { deleted: true },
          createFirebaseLink: { name: `properties/${PROPERTY}/firebaseLinks/fl2` },
        });

        const result = await runService(brandConfig({ targets: { web: { type: 'web' } } }), {
          analytics: api,
        });

        const deletes = api.callsTo('deleteFirebaseLink');
        ctx.expect(deletes.length).toBe(1);
        ctx.expect(deletes[0].args).toEqual(['777', 'fl9']);
        const creates = api.callsTo('createFirebaseLink');
        ctx.expect(creates.length).toBe(1);
        ctx.expect(creates[0].args).toEqual([PROPERTY, PROJECT]);
        ctx.expect(result.output.firebaseLink.linked).toBe(true);
      },
    },

    // #662: the delete and the create are ONE walk's work. GA holds a
    // just-deleted link for a moment and answers the create with a precondition
    // failure — the run waits that out (skip allowed) instead of owing a rerun.
    {
      name: 'analytics: the create waits out GA\'s hold on the just-deleted link and links in the SAME walk (#662)',
      run: async (ctx) => {
        let attempts = 0;
        const api = fakeAnalytics({
          ...convergedResponses(),
          listDataStreams: [WEB_STREAM, FIREBASE_STREAM],
          listFirebaseLinks: (propertyId) => (propertyId === '777'
            ? [{ name: 'properties/777/firebaseLinks/fl9', project: `projects/${PROJECT_NUMBER}` }]
            : []),
          listAccounts: [{ name: `accounts/${ACCOUNT}`, displayName: 'Fixture Account' }],
          listProperties: [{ name: 'properties/777', displayName: 'Wrong Property' }],
          deleteFirebaseLink: { deleted: true },
          createFirebaseLink: () => {
            attempts += 1;
            if (attempts < 3) {
              throw new Error('HTTP 400: Precondition check failed.');
            }
            return { name: `properties/${PROPERTY}/firebaseLinks/fl2` };
          },
        });

        const tty = openTtyPrompt();
        try {
          const run = runService(brandConfig({ targets: { web: { type: 'web' } }, metaDisabled: true }), { analytics: api });

          await tty.answer('(enter)=check now, (s)=skip', '\r');
          const result = await run;

          ctx.expect(result.status, 'the link landed in this walk — nothing owed to a rerun').toBe('success');
          ctx.expect(result.output.firebaseLink.linked).toBe(true);
          ctx.expect(api.callsTo('createFirebaseLink').length, 'the create was retried on a later tick, not abandoned').toBe(3);
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'analytics: skipping the link wait warns with the reason the summary prints (#662)',
      run: async (ctx) => {
        const api = fakeAnalytics({
          ...convergedResponses(),
          listDataStreams: [WEB_STREAM, FIREBASE_STREAM],
          listFirebaseLinks: (propertyId) => (propertyId === '777'
            ? [{ name: 'properties/777/firebaseLinks/fl9', project: `projects/${PROJECT_NUMBER}` }]
            : []),
          listAccounts: [{ name: `accounts/${ACCOUNT}`, displayName: 'Fixture Account' }],
          listProperties: [{ name: 'properties/777', displayName: 'Wrong Property' }],
          deleteFirebaseLink: { deleted: true },
          createFirebaseLink: () => {
            throw new Error('HTTP 400: Precondition check failed.');
          },
        });

        const tty = openTtyPrompt();
        try {
          const run = runService(brandConfig({ targets: { web: { type: 'web' } }, metaDisabled: true }), { analytics: api });

          await tty.answer('(enter)=check now, (s)=skip', 's');
          const result = await run;

          ctx.expect(result.status).toBe('warned');
          ctx.expect(result.warned).toEqual([{ operation: 'google-firebase-link', reason: 'the Firebase link is not ready yet — rerun in a minute' }]);
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'analytics: a property linked to a DIFFERENT firebase project warns (not ours to break)',
      run: async (ctx) => {
        const api = fakeAnalytics({
          ...convergedResponses(),
          listDataStreams: [WEB_STREAM, FIREBASE_STREAM],
          listFirebaseLinks: [{ name: `properties/${PROPERTY}/firebaseLinks/fl3`, project: 'projects/someone-elses-project' }],
        });

        const result = await runService(brandConfig({ targets: { web: { type: 'web' } } }), {
          analytics: api,
        });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.firebaseLink.error).toMatch(/different project/);
        ctx.expect(api.callsTo('deleteFirebaseLink').length).toBe(0);
      },
    },

    {
      name: 'analytics: the Firebase auto-stream ("Web App", no URI) is normalized after link check',
      run: async (ctx) => {
        const autoStream = {
          name: `properties/${PROPERTY}/dataStreams/103`,
          type: 'WEB_DATA_STREAM',
          displayName: 'Web App',
          webStreamData: { measurementId: 'G-FIREBASE1' },
        };

        const api = fakeAnalytics({
          ...convergedResponses(),
          listDataStreams: [WEB_STREAM, autoStream],
          updateDataStream: {},
        });

        const result = await runService(brandConfig({ targets: { web: { type: 'web' } } }), {
          analytics: api,
        });

        const updates = api.callsTo('updateDataStream');
        ctx.expect(updates.length).toBe(1);
        ctx.expect(updates[0].args[2]).toEqual({
          displayName: 'Fixture Brand - Firebase',
          webStreamData: { defaultUri: `https://${PROJECT}.firebaseapp.com` },
        });
        ctx.expect(updates[0].args[3]).toEqual(['displayName', 'webStreamData.defaultUri']);
        ctx.expect(result.output.firebaseLink.streamUpdated.updated).toBe(true);
      },
    },

    // ─── Pixel tokens ────────────────────────────────────────────────────────────

    {
      name: 'analytics: pixel token present succeeds, missing token warns with the env var name',
      run: async (ctx) => {
        const result = await runService(
          brandConfig({ google: false, metaId: 'PIXEL123', tiktokId: 'TT456' }),
          { metaToken: 'meta-token' }, // tiktok token deliberately missing
        );

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.meta.tokenConfigured).toBe(true);
        ctx.expect(result.output.tiktok.tokenConfigured).toBe(false);
      },
    },

    {
      name: 'analytics: interactive paste-in walks to the token page (Enter-gated) and saves it to the brand .env',
      run: async (ctx) => {
        const jetpack = require('fs-jetpack');
        const brandRoot = makeBrandRoot('{}');
        const browser = stubBrowser();
        const tty = openTtyPrompt();

        try {
          const run = runService(brandConfig({ google: false, metaId: 'PIXEL123' }), { brandRoot });
          // The check path opens the same three-outcome gate as everything else (#608)
          await tty.answer('Set up now?', '\r');
          await tty.answer('Press Enter to open the Meta Pixel access token page', '\r');
          await tty.answer('Paste META_ACCESS_TOKEN:', 'pasted-meta-token\r');
          const result = await run;

          ctx.expect(result.status).toBe('success');
          ctx.expect(result.output.meta.tokenConfigured).toBe(true);
          ctx.expect(browser.opened, 'Enter opened the page — never auto-opened').toEqual(['https://business.facebook.com/settings/system-users']);
          ctx.expect(jetpack.read(`${brandRoot}/.env`)).toMatch(/^META_ACCESS_TOKEN="pasted-meta-token"$/m);
          ctx.expect(process.env.META_ACCESS_TOKEN).toBe('pasted-meta-token');
        } finally {
          browser.restore();
          tty.close();
          delete process.env.META_ACCESS_TOKEN;
        }
      },
    },

    {
      name: 'analytics: an empty paste-in keeps the warned guidance and writes nothing',
      run: async (ctx) => {
        const jetpack = require('fs-jetpack');
        const brandRoot = makeBrandRoot('{}');
        const browser = stubBrowser();
        const tty = openTtyPrompt();

        try {
          const run = runService(brandConfig({ google: false, metaId: 'PIXEL123' }), { brandRoot });
          await tty.answer('Set up now?', '\r');
          await tty.answer('Press Enter to open the Meta Pixel access token page', '\r');
          await tty.answer('Paste META_ACCESS_TOKEN:', '\r');
          const result = await run;

          ctx.expect(result.status).toBe('warned');
          ctx.expect(result.output.meta.tokenConfigured).toBe(false);
          ctx.expect(jetpack.exists(`${brandRoot}/.env`)).toBe(false);
          ctx.expect(process.env.META_ACCESS_TOKEN).toBe(undefined);
        } finally {
          browser.restore();
          tty.close();
        }
      },
    },

    {
      name: 'analytics: a configured pixel id is converged proof — the platform API is never called',
      run: async (ctx) => {
        const meta = fakePixelApi(); // any call throws

        const result = await runService(
          brandConfig({ google: false, metaId: 'PIXEL123', metaAccount: '1234567890' }),
          { meta, metaToken: 'meta-token' },
        );

        ctx.expect(result.status).toBe('success');
        ctx.expect(meta.calls.length).toBe(0);
        ctx.expect(result.output.meta.pixelId).toBe('PIXEL123');
      },
    },

    {
      name: 'analytics: the brand pixel is matched BY NAME before any create, and the id lands in omega.json5',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const meta = fakePixelApi({
          listPixels: [{ id: 'PX-SOMEONE-ELSE', name: 'Another Brand' }, { id: 'PX-EXISTING', name: 'Fixture Brand' }],
        });

        const result = await runService(
          brandConfig({ google: false, metaAccount: '1234567890' }),
          { meta, metaToken: 'meta-token', brandRoot },
        );

        ctx.expect(meta.callsTo('listPixels')[0].args).toEqual(['1234567890']);
        ctx.expect(meta.callsTo('createPixel').length, 'a matching pixel is never re-created').toBe(0);
        ctx.expect(readConfigSource(brandRoot).includes('id: "PX-EXISTING"')).toBeTruthy();
        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.meta.pixelId, 'the token check sees the id landed this pass').toBe('PX-EXISTING');
        ctx.expect(result.output.meta.tokenConfigured).toBe(true);
      },
    },

    {
      name: 'analytics: a missing Meta Pixel is created on the ad account and written back',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const meta = fakePixelApi({
          listPixels: [],
          createPixel: (accountId, name) => ({ id: 'PX-NEW', name }),
        });

        const result = await runService(
          brandConfig({ google: false, metaAccount: '1234567890' }),
          { meta, metaToken: 'meta-token', brandRoot },
        );

        ctx.expect(meta.callsTo('createPixel')[0].args).toEqual(['1234567890', 'Fixture Brand']);
        ctx.expect(readConfigSource(brandRoot).includes('id: "PX-NEW"')).toBeTruthy();
        ctx.expect(result.output.meta.pixelId).toBe('PX-NEW');
        ctx.expect(result.status).toBe('success');
      },
    },

    {
      name: 'analytics: no META_ACCESS_TOKEN — the create is skipped with guidance, never attempted',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const before = readConfigSource(brandRoot);
        const meta = fakePixelApi(); // any call throws

        const result = await runService(
          brandConfig({ google: false, metaAccount: '1234567890' }),
          { meta, brandRoot }, // token deliberately missing — the state every brand is in today
        );

        ctx.expect(result.status).toBe('warned');
        ctx.expect(meta.calls.length, 'no token, no call').toBe(0);
        ctx.expect(result.output.meta.pixelId).toBe(null);
        ctx.expect(result.output.meta.tokenConfigured).toBe(false);
        ctx.expect(readConfigSource(brandRoot), 'nothing lands in config').toBe(before);
      },
    },

    {
      name: 'analytics: dry-run plans the pixel create and writes nothing',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const before = readConfigSource(brandRoot);
        const meta = fakePixelApi({ listPixels: [] }); // createPixel would throw

        const result = await runService(
          brandConfig({ google: false, metaAccount: '1234567890' }),
          { meta, metaToken: 'meta-token', brandRoot, options: { dryRun: true } },
        );

        ctx.expect(meta.callsTo('createPixel').length).toBe(0);
        ctx.expect(result.output.meta).toEqual({ planned: 'create', name: 'Fixture Brand' });
        ctx.expect(readConfigSource(brandRoot)).toBe(before);
      },
    },

    {
      name: 'analytics: the TikTok half rides the same flow — advertiser id + token creates and lands the code',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const tiktok = fakePixelApi({
          listPixels: [],
          createPixel: (advertiserId, name) => ({ id: 'TT-NEW', name }),
        });

        const result = await runService(
          brandConfig({ google: false, tiktokAccount: '7000000000000000001' }),
          { tiktok, tiktokToken: 'tiktok-token', brandRoot },
        );

        ctx.expect(tiktok.callsTo('createPixel')[0].args).toEqual(['7000000000000000001', 'Fixture Brand']);
        ctx.expect(readConfigSource(brandRoot).includes('id: "TT-NEW"')).toBeTruthy();
        ctx.expect(result.output.tiktok.pixelId).toBe('TT-NEW');
      },
    },

    {
      name: 'analytics: without TIKTOK_ACCESS_TOKEN the TikTok half stays inert — warned, zero calls',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const before = readConfigSource(brandRoot);
        const tiktok = fakePixelApi(); // any call throws — the scaffold must not reach the API

        const result = await runService(
          brandConfig({ google: false, tiktokAccount: '7000000000000000001' }),
          { tiktok, brandRoot },
        );

        ctx.expect(result.status).toBe('warned');
        ctx.expect(tiktok.calls.length).toBe(0);
        ctx.expect(result.output.tiktok.tokenConfigured).toBe(false);
        ctx.expect(readConfigSource(brandRoot)).toBe(before);
      },
    },

    {
      name: 'analytics: an accountId with no id is enough to run the service (the provisioning gate)',
      run: async (ctx) => {
        const skipped = await runService(brandConfig({ google: false }));
        ctx.expect(skipped.status).toBe('skipped');

        const meta = fakePixelApi({ listPixels: [], createPixel: { id: 'PX-NEW', name: 'Fixture Brand' } });
        const result = await runService(brandConfig({ google: false, metaAccount: '1234567890' }), {
          meta,
          metaToken: 'meta-token',
        });

        ctx.expect(result.status, 'a configurable-but-uncreated pixel is work').not.toBe('skipped');
      },
    },

    {
      name: 'analytics: ONE interactive pass — gate, token paste-in, account discovery, pixel create',
      run: async (ctx) => {
        const jetpack = require('fs-jetpack');
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const meta = fakePixelApi({
          listAdAccounts: [AD_ACCOUNT],
          listPixels: [],
          createPixel: (accountId, name) => ({ id: 'PX-NEW', name }),
        });
        const browser = stubBrowser();
        const tty = openTtyPrompt();

        try {
          // Nothing configured and no token — the state every brand starts in
          const run = runService(brandConfig({ google: false }), { meta, brandRoot });
          await tty.answer('Set up now?', '\r');
          await tty.answer('Press Enter to open the Meta Pixel access token page', '\r');
          await tty.answer('Paste META_ACCESS_TOKEN:', 'pasted-meta-token\r');
          const result = await run;

          ctx.expect(browser.opened).toEqual([SYSTEM_USERS_URL]);
          ctx.expect(meta.callsTo('listAdAccounts').length, 'the token pasted this pass is what discovery runs on').toBe(1);
          ctx.expect(meta.callsTo('createPixel')[0].args).toEqual([AD_ACCOUNT.id, 'Fixture Brand']);

          const written = readConfigSource(brandRoot);
          ctx.expect(written.includes(`accountId: "${AD_ACCOUNT.id}"`), 'the discovered ad account lands in config').toBeTruthy();
          ctx.expect(written.includes('id: "PX-NEW"')).toBeTruthy();
          ctx.expect(written.includes('// Fixture Brand — analytics writeback target'), 'comments survive').toBeTruthy();
          ctx.expect(jetpack.read(`${brandRoot}/.env`)).toMatch(/^META_ACCESS_TOKEN="pasted-meta-token"$/m);
          ctx.expect(result.status).toBe('success');
          ctx.expect(result.output.meta.pixelId, 'the token check reports the pixel this pass made').toBe('PX-NEW');
          ctx.expect(result.output.meta.tokenConfigured).toBe(true);
        } finally {
          browser.restore();
          tty.close();
          delete process.env.META_ACCESS_TOKEN;
        }
      },
    },

    {
      name: 'analytics: the setup gate\'s Disable writes providers.meta: false instead of asking again',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const meta = fakePixelApi(); // any call throws
        const tty = openTtyPrompt();

        try {
          const run = runService(brandConfig({ google: false }), { meta, brandRoot });
          await tty.answer('Set up now?', `${DOWN}${DOWN}\r`); // Disable (stop prompting)
          const result = await run;

          ctx.expect(meta.calls.length).toBe(0);
          ctx.expect(readConfigSource(brandRoot)).toMatch(/meta: false/);
          ctx.expect(result.status, 'opting out is not a warning').toBe('success');
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'analytics: providers.meta = false disables the provider — no calls, no prompts, no warn',
      timeout: 10000,
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const before = readConfigSource(brandRoot);
        const meta = fakePixelApi(); // any call throws
        const tty = openTtyPrompt(); // interactive: an ignored opt-out would prompt (and time this test out)
        const log = captureLog();

        let result;
        try {
          result = await runService(
            brandConfig({ google: false, metaDisabled: true, tiktokId: 'TT456' }),
            { meta, tiktokToken: 'tiktok-token', brandRoot },
          );
        } finally {
          log.restore();
          tty.close();
        }

        ctx.expect(meta.calls.length).toBe(0);
        ctx.expect(result.output.meta, 'a disabled provider reports nothing').toBe(undefined);
        ctx.expect(result.status).toBe('success');
        ctx.expect(readConfigSource(brandRoot)).toBe(before);
        ctx.expect(log.lines.some((line) => line.includes('Meta Pixel disabled (analytics.providers.meta: false)')), 'the opt-out is reported as disabled, not as unconfigured').toBeTruthy();
      },
    },

    {
      name: 'analytics: a token seeing exactly one ad account auto-selects it — and the rerun is a byte-identical no-op',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const meta = fakePixelApi({
          listAdAccounts: [AD_ACCOUNT],
          listPixels: [],
          createPixel: (accountId, name) => ({ id: 'PX-NEW', name }),
        });

        // No TTY: the token alone is enough — nothing to ask when there's one answer
        const first = await runService(brandConfig({ google: false }), { meta, metaToken: 'meta-token', brandRoot });
        const landed = readConfigSource(brandRoot);

        ctx.expect(first.status).toBe('success');
        ctx.expect(landed.includes(`accountId: "${AD_ACCOUNT.id}"`)).toBeTruthy();
        ctx.expect(landed.includes('id: "PX-NEW"')).toBeTruthy();

        // The rerun reads the landed config back — converged means zero calls
        const rerun = fakePixelApi(); // any call throws
        const second = await runService(
          brandConfig({ google: false, metaId: 'PX-NEW', metaAccount: AD_ACCOUNT.id }),
          { meta: rerun, metaToken: 'meta-token', brandRoot },
        );

        ctx.expect(rerun.calls.length).toBe(0);
        ctx.expect(readConfigSource(brandRoot), 'converged rerun writes nothing').toBe(landed);
        ctx.expect(second.status).toBe('success');
      },
    },

    {
      name: 'analytics: several visible ad accounts without a TTY list the candidates and create nothing',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const before = readConfigSource(brandRoot);
        const meta = fakePixelApi({
          listAdAccounts: [AD_ACCOUNT, { id: '9999999999', name: 'Second Account' }],
        }); // listPixels/createPixel would throw

        const log = captureLog();
        let result;
        try {
          result = await runService(brandConfig({ google: false }), { meta, metaToken: 'meta-token', brandRoot });
        } finally {
          log.restore();
        }

        ctx.expect(result.status).toBe('warned');
        ctx.expect(meta.callsTo('listPixels').length, 'no account, no create').toBe(0);
        ctx.expect(log.lines.some((line) => line.includes('2 ad accounts visible'))).toBeTruthy();
        ctx.expect(log.lines.some((line) => line.includes('Second Account'))).toBeTruthy();
        ctx.expect(readConfigSource(brandRoot)).toBe(before);
      },
    },

    {
      name: 'analytics: several visible ad accounts in a TTY are a pick — the choice lands in config',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const meta = fakePixelApi({
          listAdAccounts: [{ id: '9999999999', name: 'Second Account' }, AD_ACCOUNT],
          listPixels: [{ id: 'PX-EXISTING', name: 'Fixture Brand' }],
        });
        const tty = openTtyPrompt();

        try {
          const run = runService(brandConfig({ google: false }), { meta, metaToken: 'meta-token', brandRoot });
          await tty.answer('Set up now?', '\r'); // the token is already in hand — the gate still asks permission
          // The brand match ("Fixture Brand Ads") sorts to the cursor
          await tty.answer('Select the ad account for Meta Pixel:', '\r');
          const result = await run;

          ctx.expect(meta.callsTo('listPixels')[0].args).toEqual([AD_ACCOUNT.id]);
          const written = readConfigSource(brandRoot);
          ctx.expect(written.includes(`accountId: "${AD_ACCOUNT.id}"`)).toBeTruthy();
          ctx.expect(written.includes('id: "PX-EXISTING"')).toBeTruthy();
          ctx.expect(result.status).toBe('success');
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'analytics: a token that sees no ad accounts warns with the fix, and creates nothing',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const before = readConfigSource(brandRoot);
        const meta = fakePixelApi({ listAdAccounts: [] });

        const log = captureLog();
        let result;
        try {
          result = await runService(brandConfig({ google: false }), { meta, metaToken: 'meta-token', brandRoot });
        } finally {
          log.restore();
        }

        ctx.expect(result.status).toBe('warned');
        ctx.expect(meta.callsTo('listPixels').length).toBe(0);
        ctx.expect(log.lines.some((line) => line.includes('No ad accounts are visible to META_ACCESS_TOKEN'))).toBeTruthy();
        ctx.expect(log.lines.some((line) => line.includes('Add assets'))).toBeTruthy();
        ctx.expect(readConfigSource(brandRoot)).toBe(before);
      },
    },

    {
      name: 'analytics: without a token and without a TTY, an unconfigured Meta half is silent (the service skips)',
      run: async (ctx) => {
        const result = await runService(brandConfig({ google: false }), { meta: fakePixelApi() });

        ctx.expect(result.status, 'nothing configured, nothing to ask with — no nagging in CI').toBe('skipped');
      },
    },

    // ─── Dry-run ─────────────────────────────────────────────────────────────────

    {
      name: 'analytics: dry-run on a fully drifted brand performs zero mutations',
      run: async (ctx) => {
        const api = fakeAnalytics({
          getProperty: { name: `properties/${PROPERTY}` },
          listDataStreams: [], // no streams → both would be created
          listFirebaseLinks: (propertyId) => (propertyId === '777'
            ? [{ name: 'properties/777/firebaseLinks/fl9', project: `projects/${PROJECT_NUMBER}` }]
            : []),
          listAccounts: [{ name: `accounts/${ACCOUNT}` }],
          listProperties: [{ name: 'properties/777', displayName: 'Wrong Property' }],
        });

        const result = await runService(brandConfig(), {
          analytics: api,
          options: { dryRun: true },
        });

        ctx.expect(api.mutations().length).toBe(0);
        ctx.expect(result.output.streams.planned.length).toBe(2);
        ctx.expect(result.output.firebaseLink.planned).toEqual([
          'unlink from property 777',
          `link to property ${PROPERTY}`,
        ]);
      },
    },

    // ─── Interactive account + property flow (config-landing) ────────────────────

    {
      name: 'setup: interactive run lands account + property in omega.json5 and the google ops run in the same pass',
      run: async (ctx) => {
        const api = fakeAnalytics({
          ...convergedResponses(),
          listAccounts: [{ name: `accounts/${ACCOUNT}`, displayName: 'Fixture Account' }],
          listProperties: [{ name: `properties/${PROPERTY}`, displayName: 'Fixture Brand' }],
        });
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const tty = openTtyPrompt();

        try {
          const run = runService(brandConfig({ google: false, metaDisabled: true }), { analytics: api, brandRoot });
          await tty.answer('Set up now?', '\r'); // one gate covers the account + property pair
          await tty.answer('Select Google Analytics account:', '\r');
          await tty.answer('Select GA4 property:', '\r'); // no second "Set up now?" gate
          const result = await run;

          ctx.expect(result.status).toBe('success');
          ctx.expect(api.callsTo('listDataStreams').length >= 1).toBeTruthy(); // google ops ran with the landed property
          const written = readConfigSource(brandRoot);
          ctx.expect(written.includes(`accountId: "${ACCOUNT}"`)).toBeTruthy();
          ctx.expect(written.includes(`propertyId: "${PROPERTY}"`)).toBeTruthy();
          ctx.expect(written.includes('// Fixture Brand — analytics writeback target')).toBeTruthy();
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'property-flow: create-new property calls the Admin API with config time zone + currency',
      run: async (ctx) => {
        const created = [];
        const api = {
          listProperties: async () => [],
          createProperty: async (accountId, body) => {
            created.push({ accountId, body });
            return { name: 'properties/424242' };
          },
        };
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const context = {
          brandId: 'fixture-brand',
          brandRoot,
          options: {},
          brandConfig: {
            brand: { id: 'fixture-brand', name: 'Fixture Brand', url: `https://${DOMAIN}` },
            analytics: { providers: { google: { accountId: ACCOUNT, propertyId: null, timeZone: 'America/Los_Angeles', currency: 'USD' } } },
          },
        };
        const tty = openTtyPrompt();

        try {
          const run = resolveGoogleProperty(context, api);
          // account is pre-configured → the property step carries the gate
          await tty.answer('Set up now?', '\r');
          await tty.answer('Select GA4 property:', '\r'); // "+ Create new property" is the only choice
          const propertyId = await run;

          ctx.expect(propertyId).toBe('424242');
          ctx.expect(created).toEqual([{
            accountId: ACCOUNT,
            body: { displayName: `Fixture Brand (${DOMAIN})`, timeZone: 'America/Los_Angeles', currencyCode: 'USD' },
          }]);
          ctx.expect(readConfigSource(brandRoot).includes('propertyId: "424242"')).toBeTruthy();
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'property-flow: company-inherited account resolves with the company-default note, no prompt',
      run: async (ctx) => {
        const api = { listAccounts: async () => { throw new Error('must not list accounts — the company default resolves it'); } };
        const context = {
          brandId: 'fixture-brand',
          brandRoot: '/tmp/omega-manager-analytics-unused', // nothing lands — both values exist
          options: {}, // non-interactive on purpose: the company default needs no prompt
          brandConfig: {
            brand: { id: 'fixture-brand', name: 'Fixture Brand', url: `https://${DOMAIN}` },
            // The merged view a company-managed brand sees: the company accountId
            // arrived through the merge chain
            analytics: { providers: { google: { accountId: ACCOUNT, propertyId: PROPERTY } } },
          },
          companyConfig: { analytics: { providers: { google: { accountId: ACCOUNT } } } },
        };

        const log = captureLog();
        let propertyId;
        try {
          propertyId = await resolveGoogleProperty(context, api);
        } finally {
          log.restore();
        }

        ctx.expect(propertyId).toBe(PROPERTY);
        ctx.expect(log.lines.some((line) => line.includes(`Google Analytics account ${ACCOUNT}`) && line.includes(COMPANY_NOTE))).toBeTruthy();
      },
    },

    {
      name: 'property-flow: explicit brand accountId beats the company default — no company note',
      run: async (ctx) => {
        const api = { listAccounts: async () => { throw new Error('must not list accounts'); } };
        const context = {
          brandId: 'fixture-brand',
          brandRoot: '/tmp/omega-manager-analytics-unused',
          options: {},
          brandConfig: {
            brand: { id: 'fixture-brand', name: 'Fixture Brand', url: `https://${DOMAIN}` },
            // Brand file set its own account — the merge already made it win
            analytics: { providers: { google: { accountId: '424242', propertyId: PROPERTY } } },
          },
          companyConfig: { analytics: { providers: { google: { accountId: ACCOUNT } } } },
        };

        const log = captureLog();
        let propertyId;
        try {
          propertyId = await resolveGoogleProperty(context, api);
        } finally {
          log.restore();
        }

        ctx.expect(propertyId).toBe(PROPERTY);
        ctx.expect(!log.lines.some((line) => line.includes(COMPANY_NOTE))).toBeTruthy();
      },
    },

    {
      name: 'property-flow: company layer without an accountId → interactive picker fallback',
      run: async (ctx) => {
        const api = {
          listAccounts: async () => [{ name: `accounts/${ACCOUNT}`, displayName: 'Fixture Account' }],
          listProperties: async () => [{ name: `properties/${PROPERTY}`, displayName: 'Fixture Brand' }],
        };
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);
        const context = {
          brandId: 'fixture-brand',
          brandRoot,
          options: {},
          brandConfig: {
            brand: { id: 'fixture-brand', name: 'Fixture Brand', url: `https://${DOMAIN}` },
            analytics: { providers: { google: {} } },
          },
          companyConfig: { brand: { name: 'Fixture Co' } }, // company exists, no GA default
        };
        const tty = openTtyPrompt();

        try {
          const run = resolveGoogleProperty(context, api);
          await tty.answer('Set up now?', '\r');
          await tty.answer('Select Google Analytics account:', '\r');
          await tty.answer('Select GA4 property:', '\r'); // account flow's Yes gates the pair
          const propertyId = await run;

          ctx.expect(propertyId).toBe(PROPERTY);
          const written = readConfigSource(brandRoot);
          ctx.expect(written.includes(`accountId: "${ACCOUNT}"`)).toBeTruthy();
          ctx.expect(written.includes(`propertyId: "${PROPERTY}"`)).toBeTruthy();
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'meta-api: pixels are listed and created on the ad account edge with the system-user token',
      run: async (ctx) => {
        const list = stubFetch({ body: { data: [{ id: 'PX1', name: 'Fixture Brand' }] } });
        let created;
        try {
          const api = new MetaMarketingAPI({ accessToken: 'sys-user-token' });
          ctx.expect(await api.listPixels('1234567890')).toEqual([{ id: 'PX1', name: 'Fixture Brand' }]);

          ctx.expect(list.calls[0].url).toMatch(/^https:\/\/graph\.facebook\.com\/v21\.0\/act_1234567890\/adspixels\?fields=id,name/);
          ctx.expect(list.calls[0].options.headers.Authorization).toBe('Bearer sys-user-token');

          created = stubFetch({ body: { id: 'PX-NEW' } });
          ctx.expect(await api.createPixel('act_1234567890', 'Fixture Brand')).toEqual({ id: 'PX-NEW', name: 'Fixture Brand' });
          ctx.expect(created.calls[0].url, 'an act_-prefixed id is not double-prefixed').toBe('https://graph.facebook.com/v21.0/act_1234567890/adspixels');
          ctx.expect(created.calls[0].options.method).toBe('POST');
          ctx.expect(JSON.parse(created.calls[0].options.body)).toEqual({ name: 'Fixture Brand' });
        } finally {
          created?.restore(); // restores the list stub…
          list.restore();     // …which restores the real fetch
        }
      },
    },

    {
      name: 'meta-api: ad accounts come back with the BARE id config carries, not the act_ ref',
      run: async (ctx) => {
        const stub = stubFetch({
          body: { data: [{ id: 'act_1234567890', account_id: '1234567890', name: 'Fixture Brand Ads' }] },
        });
        try {
          const api = new MetaMarketingAPI({ accessToken: 'sys-user-token' });
          ctx.expect(await api.listAdAccounts()).toEqual([{ id: '1234567890', name: 'Fixture Brand Ads' }]);
          ctx.expect(stub.calls[0].url).toBe('https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name,account_id&limit=100');
          ctx.expect(stub.calls[0].options.headers.Authorization).toBe('Bearer sys-user-token');
        } finally {
          stub.restore();
        }
      },
    },

    {
      name: 'meta-api: a client built BEFORE the paste-in still authenticates (the env is read per request)',
      run: async (ctx) => {
        const api = new MetaMarketingAPI(); // built while META_ACCESS_TOKEN is unset
        const stub = stubFetch({ body: { data: [] } });
        process.env.META_ACCESS_TOKEN = 'pasted-this-run';
        try {
          await api.listAdAccounts();
          ctx.expect(stub.calls[0].options.headers.Authorization).toBe('Bearer pasted-this-run');
        } finally {
          stub.restore();
          delete process.env.META_ACCESS_TOKEN;
        }
      },
    },

    {
      name: 'meta-api: a Graph error surfaces its own message',
      run: async (ctx) => {
        const stub = stubFetch({ ok: false, status: 400, body: { error: { message: '(#200) Requires ads_management permission' } } });
        try {
          await ctx.expect(new MetaMarketingAPI({ accessToken: 't' }).listPixels('1')).rejects.toThrow(/Meta API error \(400\): \(#200\) Requires ads_management permission/);
        } finally {
          stub.restore();
        }
      },
    },

    {
      name: 'tiktok-api: the v1.3 pixel endpoints speak advertiser_id + the Access-Token header',
      run: async (ctx) => {
        const list = stubFetch({ body: { code: 0, data: { pixels: [{ pixel_code: 'TT1', pixel_name: 'Fixture Brand' }] } } });
        let created;
        try {
          const api = new TikTokBusinessAPI({ accessToken: 'tt-token' });
          ctx.expect(await api.listPixels('7000000000000000001')).toEqual([{ id: 'TT1', name: 'Fixture Brand' }]);
          ctx.expect(list.calls[0].url).toBe('https://business-api.tiktok.com/open_api/v1.3/pixel/list/?advertiser_id=7000000000000000001');
          ctx.expect(list.calls[0].options.headers['Access-Token']).toBe('tt-token');

          created = stubFetch({ body: { code: 0, data: { pixel_code: 'TT-NEW', pixel_name: 'Fixture Brand' } } });
          ctx.expect(await api.createPixel('7000000000000000001', 'Fixture Brand')).toEqual({ id: 'TT-NEW', name: 'Fixture Brand' });
          ctx.expect(created.calls[0].url).toBe('https://business-api.tiktok.com/open_api/v1.3/pixel/create/');
          ctx.expect(JSON.parse(created.calls[0].options.body)).toEqual({
            advertiser_id: '7000000000000000001',
            pixel_name: 'Fixture Brand',
            pixel_mode: 'STANDARD_MODE',
          });
        } finally {
          created?.restore(); // restores the list stub…
          list.restore();     // …which restores the real fetch
        }
      },
    },

    {
      name: 'tiktok-api: a 200 carrying a non-zero code is an error, not a success',
      run: async (ctx) => {
        const stub = stubFetch({ body: { code: 40002, message: 'Advertiser not authorized' } });
        try {
          await ctx.expect(new TikTokBusinessAPI({ accessToken: 't' }).listPixels('1')).rejects.toThrow(/TikTok API error \(40002\): Advertiser not authorized/);
        } finally {
          stub.restore();
        }
      },
    },
  ],
});
