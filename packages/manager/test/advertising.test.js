/**
 * Advertising service tests — domain presence + approval state against a
 * recording fake of the read-only Management API v2. Proves skip semantics
 * (including the de-ITW'd accountId — no company pub- default), the READY
 * converged read, the per-state warn ladder, the missing-site console
 * deep-link, and dry-run parity (the API has no writes at all).
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

const { setBrowserOpener } = require('@omega.js/devkit/flows');
const { OPERATIONS, DEFAULTS } = require('../src/config.js');
const service = require('../src/services/advertising/index.js');
const { makeBrandRoot, readConfigSource } = require('./lib/config-fixture.js');
const { openTtyPrompt } = require('./lib/interactive.js');

// Tests must never see real credentials from the shell environment
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const DOMAIN = 'fixture-brand.test';
const ACCOUNT_ID = 'pub-0000000000000000';
const CLIENT = `ca-${ACCOUNT_ID}`; // config carries the embed-ready ca-pub-… form
const SITES_URL = `https://adsense.google.com/adsense/u/0/${ACCOUNT_ID}/sites/list?url=${DOMAIN}`;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function brandConfig({ url = `https://${DOMAIN}`, client = CLIENT } = {}) {
  return {
    brand: { id: 'fixture-brand', name: 'Fixture Brand', url },
    advertising: { providers: { adsense: { client } } },
    targets: { web: { type: 'web' } },
  };
}

/** Recording fake GoogleAdsenseAPI — the v2 API is read-only, so every call is a read. */
function fakeAdsense({ sites = [] } = {}) {
  const api = { calls: [] };

  api.listSites = async (accountId) => {
    api.calls.push({ method: 'listSites', accountId });
    return structuredClone(sites);
  };

  return api;
}

/** Capture console.log lines around a run (the reported line is console output). */
function captureLog() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  return { lines, restore: () => { console.log = original; } };
}

function runService(config, { adsense, options = {}, brandRoot } = {}) {
  return service.run({
    brandId: 'fixture-brand',
    brandRoot: brandRoot || '/tmp/omega-manager-adsense-unused', // the selection flow writes config/omega.json5 when given a real root
    brandConfig: config,
    brand: { id: 'fixture-brand', config, enabledTargets: Object.keys(config.targets || {}), targets: [] },
    targets: [],
    operations: OPERATIONS.advertising,
    options,
    serviceData: {},
    adsenseApi: adsense,
  });
}

module.exports = defineCases({
  type: 'group',
  description: 'advertising',
  tests: [
    // ─── Setup / skip semantics ──────────────────────────────────────────────────

    {
      name: 'advertising: skips without Google credentials in .env',
      run: async (ctx) => {
        const result = await runService(brandConfig()); // no injected api → the creds check applies
        ctx.expect(result.status).toBe('skipped');
        // The shared setup contract's loud headless skip (#608): names both keys and the fix
        ctx.expect(result.reason).toMatch(/GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET/);
        ctx.expect(result.missingEnv).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
      },
    },

    // #527 — the adsense block has ONE switch, and it is the client id: `enabled`
    // was a SECOND polarity that stopped the manager managing the account while
    // the site kept serving ads off the same id. It is deleted; a config still
    // carrying it is an undeclared key the service never reads.
    {
      name: 'advertising: a stray enabled = false does not skip — client presence is the only switch (#527)',
      run: async (ctx) => {
        const config = brandConfig();
        config.advertising.providers.adsense.enabled = false;

        const api = fakeAdsense({ sites: [{ domain: DOMAIN, state: 'READY', autoAdsEnabled: true }] });
        const result = await runService(config, { adsense: api });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.calls[0]).toEqual({ method: 'listSites', accountId: ACCOUNT_ID });
      },
    },

    {
      name: 'advertising: skips without brand.url',
      run: async (ctx) => {
        const result = await runService(brandConfig({ url: '' }), { adsense: fakeAdsense() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/brand\.url/);
      },
    },

    {
      name: 'advertising: a default Pages brand.url is no domain, so the service skips with the one reason before any API call',
      run: async (ctx) => {
        const api = fakeAdsense();

        const result = await runService(brandConfig({ url: 'https://dreamr-design.github.io/dreamr-web' }), { adsense: api });

        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toBe('brand.url is the hosting provider\'s default address (dreamr-design.github.io): no domain to manage');
        ctx.expect(api.calls).toEqual([]);
      },
    },

    {
      name: 'advertising: skips without a client id — and the default carries no company account',
      run: async (ctx) => {
        const result = await runService(brandConfig({ client: null }), { adsense: fakeAdsense() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/advertising\.providers\.adsense\.client/);

        // omega-manager defaulted this to the company's shared pub- account — the
        // manager defaults layer must not seed the provider entry AT ALL (wave-5
        // F10: defaults merge under every brand, so a seeded section would defeat
        // the presence gate below)
        ctx.expect(DEFAULTS.advertising?.providers?.adsense).toBe(undefined);
      },
    },

    {
      name: 'advertising: NO provider entry = deliberate absence — skips before any account resolution (wave-5 F10)',
      run: async (ctx) => {
        // Build the config the way the real pipeline does: the manager DEFAULTS
        // merge under the brand file. The gate must survive that merge — a seeded
        // provider entry in DEFAULTS would resurrect it for every brand.
        const { deepMerge } = require('@omega.js/config');
        const authored = brandConfig();
        delete authored.advertising; // the brand never opted in
        const config = deepMerge(structuredClone(DEFAULTS), authored);
        ctx.expect(config.advertising?.providers?.adsense).toBe(undefined);

        const api = fakeAdsense();
        const result = await runService(config, { adsense: api });

        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/no advertising\.providers\.adsense/);
        // The account-selection flow must never run — it lands a shared account
        // into the brand config, which is exactly the writeback this gate prevents.
        ctx.expect(api.calls.length).toBe(0);
      },
    },

    // ─── Site present ────────────────────────────────────────────────────────────

    {
      name: 'advertising: READY site is a success with exactly one read',
      run: async (ctx) => {
        const api = fakeAdsense({ sites: [{ domain: DOMAIN, state: 'READY', autoAdsEnabled: true }] });

        const result = await runService(brandConfig(), { adsense: api });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.sites).toEqual({ domain: DOMAIN, state: 'READY', autoAdsEnabled: true });
        ctx.expect(api.calls.length).toBe(1);
        ctx.expect(api.calls[0]).toEqual({ method: 'listSites', accountId: ACCOUNT_ID });
      },
    },

    {
      name: 'advertising: a www-prefixed AdSense entry matches the bare domain',
      run: async (ctx) => {
        const api = fakeAdsense({ sites: [{ domain: `www.${DOMAIN}`, state: 'READY', autoAdsEnabled: false }] });

        const result = await runService(brandConfig(), { adsense: api });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.sites.domain).toBe(`www.${DOMAIN}`);
      },
    },

    // #631 — AdSense lists sites at the apex only, so the apex entry covers every
    // subdomain of it: a subdomain brand must read its parent's state, not warn
    // that it is missing.
    {
      name: 'advertising: an apex AdSense entry covers a subdomain brand (#631)',
      run: async (ctx) => {
        const sub = `playground.${DOMAIN}`;
        const api = fakeAdsense({ sites: [{ domain: DOMAIN, state: 'GETTING_READY', autoAdsEnabled: true }] });

        const log = captureLog();
        let result;
        try {
          result = await runService(brandConfig({ url: `https://${sub}` }), { adsense: api });
        } finally {
          log.restore();
        }

        ctx.expect(result.status).toBe('warned'); // the matched entry's state is reported as-is
        ctx.expect(result.output.sites.domain).toBe(DOMAIN); // the matched entry's domain
        ctx.expect(result.output.sites.state).toBe('GETTING_READY');
        ctx.expect(result.output.sites.coveredBy).toBe(DOMAIN);
        // The reported line says the match is a parent, not the brand's own domain
        ctx.expect(log.lines.some((line) => new RegExp(`${sub}.*is covered by.*${DOMAIN}`).test(line)), `expected a covered-by line, got:\n${log.lines.join('\n')}`).toBeTruthy();
      },
    },

    {
      name: 'advertising: a suffix that is not a parent domain does not cover the brand (#631)',
      run: async (ctx) => {
        const sub = `playground.${DOMAIN}`;
        const api = fakeAdsense({
          sites: [
            { domain: `not${DOMAIN}`, state: 'READY' }, // unrelated apex
            { domain: 'brand.test', state: 'READY' }, // a string suffix of fixture-brand.test, but not a parent
          ],
        });

        const result = await runService(brandConfig({ url: `https://${sub}` }), { adsense: api });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.sites.domain).toBe(sub);
        ctx.expect(result.output.sites.state).toBe(null);
      },
    },

    {
      name: 'advertising: non-READY approval states are warned, not failed',
      run: async (ctx) => {
        for (const state of ['GETTING_READY', 'REQUIRES_REVIEW', 'NEEDS_ATTENTION']) {
          const api = fakeAdsense({ sites: [{ domain: DOMAIN, state, autoAdsEnabled: false }] });

          const result = await runService(brandConfig(), { adsense: api });

          ctx.expect(result.status, `state ${state} should warn`).toBe('warned');
          ctx.expect(result.output.sites.state).toBe(state);
          ctx.expect(api.calls.length).toBe(1);
        }
      },
    },

    {
      name: 'advertising: an unknown state is surfaced verbatim as a warning',
      run: async (ctx) => {
        const api = fakeAdsense({ sites: [{ domain: DOMAIN, state: 'SOME_FUTURE_STATE' }] });

        const result = await runService(brandConfig(), { adsense: api });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.sites.state).toBe('SOME_FUTURE_STATE');
      },
    },

    // ─── Site missing ────────────────────────────────────────────────────────────

    {
      name: 'advertising: missing site warns with the exact add-site console deep-link',
      run: async (ctx) => {
        const api = fakeAdsense({ sites: [{ domain: 'some-other-brand.test', state: 'READY' }] });

        const result = await runService(brandConfig(), { adsense: api });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.sites).toEqual({ domain: DOMAIN, state: null, addUrl: SITES_URL });
        ctx.expect(api.calls.length).toBe(1);
      },
    },

    // ─── Dry-run ─────────────────────────────────────────────────────────────────

    {
      name: 'advertising: dry-run behaves identically — the API has no writes at all',
      run: async (ctx) => {
        const ready = fakeAdsense({ sites: [{ domain: DOMAIN, state: 'READY', autoAdsEnabled: true }] });
        const readyResult = await runService(brandConfig(), { adsense: ready, options: { dryRun: true } });
        ctx.expect(readyResult.status).toBe('success');
        ctx.expect(ready.calls.length).toBe(1);

        const missing = fakeAdsense();
        const missingResult = await runService(brandConfig(), { adsense: missing, options: { dryRun: true } });
        ctx.expect(missingResult.status).toBe('warned');
        ctx.expect(missingResult.output.sites.addUrl).toBe(SITES_URL);
        ctx.expect(missing.calls.length).toBe(1);
      },
    },

    // ─── Interactive account selection (config-landing flow) ─────────────────────

    {
      name: 'setup: interactive run offers account selection and lands the client id in omega.json5',
      run: async (ctx) => {
        const api = fakeAdsense({ sites: [{ domain: DOMAIN, state: 'READY', autoAdsEnabled: true }] });
        api.listAccounts = async () => {
          api.calls.push({ method: 'listAccounts' });
          return [
            { name: 'accounts/pub-1111111111111111', displayName: 'Other Org' },
            { name: `accounts/${ACCOUNT_ID}`, displayName: 'Fixture Brand' },
          ];
        };
        const brandRoot = makeBrandRoot(`{
  // Fixture Brand — adsense writeback target
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://fixture-brand.test' },
  advertising: { providers: { adsense: {} } }, // client lands here
  targets: { web: { type: 'web' } },
}
`);
        setBrowserOpener(async () => true); // create-new is never picked, but a test must never launch a real browser
        const tty = openTtyPrompt();

        try {
          const run = runService(brandConfig({ client: null }), { adsense: api, brandRoot });
          await tty.answer('Set up now?', '\r'); // Yes
          // Cursor lands on the brand match "Fixture Brand (pub-…)" — ENTER picks it
          await tty.answer('Select AdSense account:', '\r');
          const result = await run;

          ctx.expect(result.status).toBe('success'); // READY site via the landed account
          ctx.expect(api.calls.at(-1)).toEqual({ method: 'listSites', accountId: ACCOUNT_ID });
          const written = readConfigSource(brandRoot);
          ctx.expect(written.includes(`client: "${CLIENT}"`)).toBeTruthy(); // ca-pub-… form, the schema's embed-ready value
          ctx.expect(written.includes('// client lands here')).toBeTruthy();
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    {
      name: 'setup: Disable opts the provider out — never a false where the schema wants a string (cp268, #527)',
      run: async (ctx) => {
        const api = fakeAdsense();
        api.listAccounts = async () => [];
        const brandRoot = makeBrandRoot(`{
  // Fixture Brand — adsense disable target
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://fixture-brand.test' },
  advertising: { providers: { adsense: {} } }, // opted in, no client yet
  targets: { web: { type: 'web' } },
}
`);
        const tty = openTtyPrompt();

        try {
          const run = runService(brandConfig({ client: null }), { adsense: api, brandRoot });
          // Arrow down twice: Yes → Skip → Disable (stop prompting)
          await tty.answer('Set up now?', '\x1B[B\x1B[B\r');
          const result = await run;

          ctx.expect(result.status).toBe('skipped');
          const written = readConfigSource(brandRoot);
          // Since #527 there is no `enabled` gate to land it on: Disable opts the
          // PROVIDER out (the chatsy/slapform shape), which the deliberate-absence
          // skip already honors on the next run.
          ctx.expect(written.includes('adsense: false'), 'Disable opts the provider entry out').toBeTruthy();
          ctx.expect(!written.includes('enabled: false'), 'the deleted gate is never resurrected by a writeback').toBeTruthy();
          ctx.expect(!written.includes('client: false'), 'client (schema string) never receives a boolean').toBeTruthy();
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'sites: interactive run opens the add-site page and polls until the site appears',
      run: async (ctx) => {
        let listCalls = 0;
        const api = fakeAdsense();
        api.listSites = async (accountId) => {
          api.calls.push({ method: 'listSites', accountId });
          listCalls++;
          return listCalls === 1 ? [] : [{ domain: DOMAIN, state: 'READY' }];
        };
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });
        const tty = openTtyPrompt();

        try {
          const run = runService(brandConfig(), { adsense: api });
          await tty.answer('Press Enter to open the AdSense sites page', '\r');
          const result = await run;

          ctx.expect(result.status).toBe('success');
          ctx.expect(result.output.sites.state).toBe('READY');
          ctx.expect(opened).toEqual([SITES_URL]);
          ctx.expect(listCalls).toBe(2); // initial read + the poll's first re-check
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },
  ],
});
