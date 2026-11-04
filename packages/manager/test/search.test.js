/**
 * Search service tests — the Search Console domain property + DNS verification +
 * sitemaps against recording fakes for both APIs. Proves skip semantics,
 * the converged zero-mutation no-op, the one-pass verify flow (TXT via
 * Cloudflare, verify once, pending → warned + rerun converges), stale-token
 * replacement, the no-API ga-link warn, missing-only sitemap submission
 * (omega-manager resubmitted every run), and the dry-run guarantee.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

const { OPERATIONS, DEFAULTS } = require('../src/config.js');
const service = require('../src/services/search/index.js');
const { makeBrandRoot, readConfigSource } = require('./lib/config-fixture.js');
const { openTtyPrompt } = require('./lib/interactive.js');

// Tests must never see real credentials from the shell environment
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.CLOUDFLARE_TOKEN;

const DOMAIN = 'fixture-brand.test';
const PROPERTY_URL = `sc-domain:${DOMAIN}`;
const GA_PROPERTY = '123456';
const TOKEN = 'google-site-verification=fixtureTokenValue123';
const SITEMAP_URL = `https://${DOMAIN}/sitemap.xml`;

// ─── Fixtures ────────────────────────────────────────────────────────────────

// `gaLinked` = the brand has already confirmed the Search Console ↔ GA
// association. It has no read API on either side, so config is its home (#434).
function brandConfig({ url = `https://${DOMAIN}`, targets = { web: { type: 'web' } }, gaProperty = GA_PROPERTY, gaLinked = false } = {}) {
  const config = {
    brand: { id: 'fixture-brand', name: 'Fixture Brand', url },
    search: { providers: { searchConsole: { ...structuredClone(DEFAULTS.search.providers.searchConsole), ...(gaLinked ? { gaLinked: true } : {}) } } },
    analytics: structuredClone(DEFAULTS.analytics),
    targets,
  };
  config.analytics.providers.google.propertyId = gaProperty;
  return config;
}

// The ga-link confirm writes into omega.json5, so every run gets a real one
const FIXTURE_CONFIG = `{
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://${DOMAIN}' },
}
`;

const GSC_READS = ['listSites', 'listSitemaps'];
// getVerificationToken/verifySite change verification state — strict no-op
// tests count them as mutations
const GSC_MUTATIONS = ['addSite', 'submitSitemap', 'getVerificationToken', 'verifySite'];

/** Recording fake GoogleSearchConsoleAPI (method-level, like the others). */
function fakeGsc(responses = {}) {
  const api = { calls: [] };

  for (const method of [...GSC_READS, ...GSC_MUTATIONS]) {
    api[method] = async (...args) => {
      api.calls.push({ method, args });
      if (!(method in responses)) {
        throw new Error(`fakeGsc: no response configured for ${method}(${JSON.stringify(args)})`);
      }
      const value = responses[method];
      return typeof value === 'function' ? await value(...args) : structuredClone(value);
    };
  }

  api.mutations = () => api.calls.filter((c) => GSC_MUTATIONS.includes(c.method));
  api.callsTo = (method) => api.calls.filter((c) => c.method === method);
  return api;
}

/** Recording fake CloudflareAPI — zone lookup + raw dns_records requests. */
function fakeCf({ zone = { id: 'zone-1', name: DOMAIN }, txtRecords = [] } = {}) {
  const api = { calls: [] };

  api.getZoneByName = async (name) => {
    api.calls.push({ method: 'getZoneByName', name });
    return zone;
  };

  api.makeRequest = async (endpoint, options = {}) => {
    const method = options.method || 'GET';
    api.calls.push({ method: 'makeRequest', httpMethod: method, endpoint, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'GET') {
      return { result: txtRecords };
    }
    return { result: {} };
  };

  api.mutations = () => api.calls.filter((c) => c.method === 'makeRequest' && c.httpMethod !== 'GET');
  return api;
}

function runService(config, { gsc, cloudflare = null, options = {}, brandRoot } = {}) {
  return service.run({
    brandId: 'fixture-brand',
    brandRoot: brandRoot || makeBrandRoot(FIXTURE_CONFIG), // the ga-link confirm writes here
    brandConfig: config,
    brand: { id: 'fixture-brand', config, enabledTargets: Object.keys(config.targets || {}), targets: [] },
    targets: [],
    operations: OPERATIONS.search,
    options,
    searchConsoleApi: gsc,
    cloudflareApi: cloudflare,
  });
}

module.exports = defineCases({
  type: 'group',
  description: 'search',
  tests: [
    // ─── Setup / skip semantics ──────────────────────────────────────────────────

    {
      name: 'search: skips without Google credentials',
      run: async (ctx) => {
        const result = await runService(brandConfig());
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/GOOGLE_CLIENT_ID/);
      },
    },

    {
      name: 'search: search.providers.searchConsole.enabled = false skips the service',
      run: async (ctx) => {
        const config = brandConfig();
        config.search.providers.searchConsole.enabled = false;

        const result = await runService(config, { gsc: fakeGsc() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/search\.providers\.searchConsole\.enabled/);
      },
    },

    {
      name: 'search: skips without brand.url',
      run: async (ctx) => {
        const result = await runService(brandConfig({ url: '' }), { gsc: fakeGsc() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/brand\.url/);
      },
    },

    {
      name: 'search: a default Pages brand.url is no domain, so setup skips with the one reason before any property call',
      run: async (ctx) => {
        const gsc = fakeGsc();
        const result = await runService(brandConfig({ url: 'https://dreamr-design.github.io/dreamr-web' }), { gsc });

        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toBe('brand.url is the hosting provider\'s default address (dreamr-design.github.io): no domain to manage');
        ctx.expect(gsc.calls).toEqual([]);
      },
    },

    // ─── Converged no-op ─────────────────────────────────────────────────────────

    {
      name: 'search: a fully converged brand is a zero-mutation no-op across all 3 operations',
      run: async (ctx) => {
        const gsc = fakeGsc({
          listSites: [{ siteUrl: PROPERTY_URL, permissionLevel: 'siteOwner' }],
          listSitemaps: [{ path: SITEMAP_URL }],
        });

        const result = await runService(brandConfig({ gaLinked: true }), { gsc });

        ctx.expect(result.status).toBe('success');
        ctx.expect(gsc.mutations().length).toBe(0);
        ctx.expect(result.state.propertyUrl).toBe(PROPERTY_URL);
        ctx.expect(result.state.permissionLevel).toBe('siteOwner');
        ctx.expect(result.output.sitemaps.existing).toBe(1);
      },
    },

    // ─── Property creation / verification ────────────────────────────────────────

    {
      name: 'search: missing property is verified via TXT and added in one pass',
      run: async (ctx) => {
        const gsc = fakeGsc({
          listSites: [],
          getVerificationToken: { token: TOKEN, method: 'DNS_TXT' },
          verifySite: { site: { identifier: DOMAIN } },
          addSite: { added: true },
          listSitemaps: [{ path: SITEMAP_URL }],
        });
        const cf = fakeCf();

        const result = await runService(brandConfig({ gaLinked: true }), {
          gsc,
          cloudflare: cf,
        });

        ctx.expect(result.status).toBe('success');

        // TXT record posted at the apex with the quoted token
        const posts = cf.mutations().filter((c) => c.httpMethod === 'POST');
        ctx.expect(posts.length).toBe(1);
        ctx.expect(posts[0].body.type).toBe('TXT');
        ctx.expect(posts[0].body.name).toBe('@');
        ctx.expect(posts[0].body.content).toBe(`"${TOKEN}"`);

        ctx.expect(gsc.callsTo('verifySite')[0].args).toEqual([DOMAIN, 'DNS_TXT', 'INET_DOMAIN']);
        ctx.expect(gsc.callsTo('addSite')[0].args).toEqual([PROPERTY_URL]);
        ctx.expect(result.state.propertyUrl).toBe(PROPERTY_URL);
        ctx.expect(result.state.verificationMethod).toBe('DNS_TXT');
      },
    },

    {
      name: 'search: stale verification records are replaced, not accumulated',
      run: async (ctx) => {
        const gsc = fakeGsc({
          listSites: [],
          getVerificationToken: { token: TOKEN },
          verifySite: {},
          addSite: {},
          listSitemaps: [{ path: SITEMAP_URL }],
        });
        const cf = fakeCf({
          txtRecords: [
            { id: 'rec-old', type: 'TXT', name: DOMAIN, content: '"google-site-verification=oldStaleToken"' },
            { id: 'rec-spf', type: 'TXT', name: DOMAIN, content: 'v=spf1 include:_spf.google.com -all' },
          ],
        });

        await runService(brandConfig({ gaLinked: true }), {
          gsc,
          cloudflare: cf,
        });

        const deletes = cf.mutations().filter((c) => c.httpMethod === 'DELETE');
        ctx.expect(deletes.length).toBe(1); // the stale google token — the SPF record is untouched
        ctx.expect(deletes[0].endpoint).toMatch(/rec-old/);
        ctx.expect(cf.mutations().filter((c) => c.httpMethod === 'POST').length).toBe(1);
      },
    },

    {
      name: 'search: verification still propagating warns and defers the add',
      run: async (ctx) => {
        const gsc = fakeGsc({
          listSites: [],
          getVerificationToken: { token: TOKEN },
          verifySite: () => {
            throw new Error('HTTP 400: The necessary verification token could not be found on your site.');
          },
        });
        const cf = fakeCf();

        const result = await runService(brandConfig(), { gsc, cloudflare: cf });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(gsc.callsTo('addSite').length).toBe(0);
        // TXT was written — the rerun only needs to verify + add
        ctx.expect(cf.mutations().filter((c) => c.httpMethod === 'POST').length).toBe(1);
        // Downstream operations wait for the property (no listSitemaps either)
        ctx.expect(gsc.callsTo('listSitemaps').length).toBe(0);
      },
    },

    {
      name: 'search: an already-verified domain still gets the property added',
      run: async (ctx) => {
        const gsc = fakeGsc({
          listSites: [],
          getVerificationToken: { token: TOKEN },
          verifySite: () => {
            throw new Error('HTTP 400: Site has already been verified by this user.');
          },
          addSite: {},
          listSitemaps: [{ path: SITEMAP_URL }],
        });

        const result = await runService(brandConfig({ gaLinked: true }), {
          gsc,
          cloudflare: fakeCf({ txtRecords: [{ id: 'r1', type: 'TXT', name: DOMAIN, content: `"${TOKEN}"` }] }),
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(gsc.callsTo('addSite').length).toBe(1);
      },
    },

    {
      name: 'search: no Cloudflare token → manual TXT record + warned',
      run: async (ctx) => {
        const gsc = fakeGsc({
          listSites: [],
          getVerificationToken: { token: TOKEN },
        });

        const result = await runService(brandConfig(), { gsc, cloudflare: null });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.property.manualRecord).toEqual({ name: DOMAIN, type: 'TXT', content: TOKEN });
        ctx.expect(gsc.callsTo('addSite').length).toBe(0);
      },
    },

    {
      name: 'search: subdomain brands verify at the subdomain label in the apex zone',
      run: async (ctx) => {
        const gsc = fakeGsc({
          listSites: [],
          getVerificationToken: { token: TOKEN },
          verifySite: {},
          addSite: {},
          listSitemaps: [{ path: `https://app.${DOMAIN}/sitemap.xml` }],
        });
        const cf = fakeCf({ zone: { id: 'zone-1', name: DOMAIN } });

        const result = await runService(brandConfig({ url: `https://app.${DOMAIN}`, gaLinked: true }), {
          gsc,
          cloudflare: cf,
        });

        ctx.expect(cf.calls[0].name).toBe(DOMAIN); // zone lookup at the APEX
        const post = cf.mutations().find((c) => c.httpMethod === 'POST');
        ctx.expect(post.body.name).toBe('app');
        ctx.expect(result.state.propertyUrl).toBe(`sc-domain:app.${DOMAIN}`);
      },
    },

    // ─── GA association ──────────────────────────────────────────────────────────

    {
      name: 'search: unconfirmed GA association warns with the associations URL (no API exists)',
      run: async (ctx) => {
        const gsc = fakeGsc({
          listSites: [{ siteUrl: PROPERTY_URL, permissionLevel: 'siteOwner' }],
          listSitemaps: [{ path: SITEMAP_URL }],
        });

        const result = await runService(brandConfig(), { gsc });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.gaLink.associationsUrl).toMatch(/resource_id=sc-domain%3A/);
        ctx.expect(gsc.mutations().length).toBe(0);
      },
    },

    {
      name: 'search: interactive GA-association is Enter-gated, confirm stamps gaLinked, service passes',
      run: async (ctx) => {
        const gsc = fakeGsc({
          listSites: [{ siteUrl: PROPERTY_URL, permissionLevel: 'siteOwner' }],
          listSitemaps: [{ path: SITEMAP_URL }],
        });

        // pressEnterToOpen launches via prompt's openInBrowser — stub it
        const promptModule = require('@omega.js/devkit/prompt');
        const opened = [];
        const realOpen = promptModule.openInBrowser;
        promptModule.openInBrowser = (url) => { opened.push(url); return true; };
        const tty = openTtyPrompt();
        const brandRoot = makeBrandRoot(FIXTURE_CONFIG);

        try {
          const run = runService(brandConfig(), { gsc, brandRoot });
          await tty.answer('Press Enter to open the Search Console associations page', '\r');
          await tty.answer(`Search Console associated with GA property ${GA_PROPERTY}?`, 'y\r');
          const result = await run;

          ctx.expect(result.status).toBe('success');
          // The confirm's ONE home is omega.json5 (#434) — nothing can re-check it
          ctx.expect(readConfigSource(brandRoot)).toMatch(/gaLinked: true/);
          ctx.expect(opened[0]).toMatch(/search\.google\.com\/search-console\/settings\/associations/);
          ctx.expect(gsc.mutations().length).toBe(0);
        } finally {
          promptModule.openInBrowser = realOpen;
          tty.close();
        }
      },
    },

    {
      name: 'search: no GA property configured → nothing to associate, no warn',
      run: async (ctx) => {
        const gsc = fakeGsc({
          listSites: [{ siteUrl: PROPERTY_URL, permissionLevel: 'siteOwner' }],
          listSitemaps: [{ path: SITEMAP_URL }],
        });

        const result = await runService(brandConfig({ gaProperty: null }), { gsc });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output?.gaLink).toBe(undefined);
      },
    },

    // ─── Sitemaps ────────────────────────────────────────────────────────────────

    {
      name: 'search: missing sitemaps are submitted; existing ones are left alone',
      run: async (ctx) => {
        const gsc = fakeGsc({
          listSites: [{ siteUrl: PROPERTY_URL, permissionLevel: 'siteOwner' }],
          listSitemaps: [],
          submitSitemap: { submitted: true },
        });

        const result = await runService(brandConfig({ gaLinked: true }), { gsc });

        const submits = gsc.callsTo('submitSitemap');
        ctx.expect(submits.length).toBe(1);
        ctx.expect(submits[0].args).toEqual([PROPERTY_URL, SITEMAP_URL]);
        ctx.expect(result.output.sitemaps.submitted).toBe(1);
      },
    },

    {
      name: 'search: submitSitemap = false skips submission without reading',
      run: async (ctx) => {
        const config = brandConfig({ gaLinked: true });
        config.search.providers.searchConsole.submitSitemap = false;

        const gsc = fakeGsc({
          listSites: [{ siteUrl: PROPERTY_URL, permissionLevel: 'siteOwner' }],
        });

        const result = await runService(config, {
          gsc,
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(gsc.callsTo('listSitemaps').length).toBe(0);
      },
    },

    {
      name: 'search: brands without a web target have no sitemap to submit',
      run: async (ctx) => {
        const gsc = fakeGsc({
          listSites: [{ siteUrl: PROPERTY_URL, permissionLevel: 'siteOwner' }],
        });

        const result = await runService(brandConfig({ targets: { backend: { type: 'backend' } }, gaLinked: true }), {
          gsc,
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(gsc.callsTo('listSitemaps').length).toBe(0);
        ctx.expect(gsc.callsTo('submitSitemap').length).toBe(0);
      },
    },

    // ─── Dry-run ─────────────────────────────────────────────────────────────────

    {
      name: 'search: dry-run on a fully drifted brand performs zero mutations',
      run: async (ctx) => {
        const gsc = fakeGsc({ listSites: [] });
        const cf = fakeCf();

        const result = await runService(brandConfig(), {
          gsc,
          cloudflare: cf,
          options: { dryRun: true },
        });

        ctx.expect(gsc.mutations().length).toBe(0); // not even a verification token is minted
        ctx.expect(cf.calls.length).toBe(0);
        ctx.expect(result.output.property.planned).toBe('verify-and-add');
      },
    },

    {
      name: 'search: interactive run polls verification until DNS propagates, then adds the property',
      run: async (ctx) => {
        let verifies = 0;
        const gsc = fakeGsc({
          listSites: [],
          getVerificationToken: { token: TOKEN },
          verifySite: () => {
            verifies++;
            if (verifies === 1) {
              throw new Error('HTTP 400: The necessary verification token could not be found on your site.');
            }
            return { site: { identifier: DOMAIN } };
          },
          addSite: { added: true },
          listSitemaps: [{ path: SITEMAP_URL }],
        });
        const cf = fakeCf();
        const tty = openTtyPrompt();

        try {
          const result = await runService(brandConfig({ gaLinked: true }), {
            gsc,
            cloudflare: cf,
            });

          ctx.expect(result.status).toBe('success');
          ctx.expect(verifies).toBe(2); // initial attempt + the poll's first re-check
          ctx.expect(gsc.callsTo('addSite')[0].args).toEqual([PROPERTY_URL]);
          ctx.expect(result.state.propertyUrl).toBe(PROPERTY_URL);
        } finally {
          tty.close();
        }
      },
    },
  ],
});
