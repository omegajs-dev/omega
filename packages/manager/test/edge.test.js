/**
 * Edge service tests — the read → diff → write reconciliation against a
 * recording fake API (the real client wraps fetch; these prove the diff
 * logic, skip semantics, subdomain filtering, the converged-zone zero-mutation
 * no-op, and the dry-run guarantee).
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

// The machine registry is per-machine state: this file's fixtures write into a
// temp home, never the developer's ~/.omega (#677).
require('@omega.js/devkit/test/temp-home');

const { DEFAULTS } = require('../src/config.js');
const { buildRequiredRecords } = require('../src/services/edge/lib/dns-records-helpers.js');
const { loadBrand } = require('../src/lib/brand.js');
const { makeBrandRoot, readConfigSource } = require('./lib/config-fixture.js');
const {
  DOMAIN, ZONE, brandConfig, fakeApi, handlerContext, runService, convergedResponses,
} = require('./lib/edge-fixture.js');

// Tests must never see a real token from the shell environment
delete process.env.CLOUDFLARE_TOKEN;
delete process.env.SENDGRID_API_KEY;

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * SendGrid's live answer for `GET /v3/whitelabel/domains`: the domain-auth
 * record set, whose `mail_cname` data is the `u<id>.<whitelabel>` host every
 * SendGrid record is built from (#692).
 */
const SENDGRID_DOMAINS = [{
  id: 7,
  domain: DOMAIN,
  valid: true,
  dns: {
    mail_cname: { host: `emailauth.${DOMAIN}`, data: 'u123.wl001.sendgrid.net', type: 'cname', valid: true },
    dkim1: { host: `s1._domainkey.${DOMAIN}`, data: 's1.domainkey.u123.wl001.sendgrid.net' },
    dkim2: { host: `s2._domainkey.${DOMAIN}`, data: 's2.domainkey.u123.wl001.sendgrid.net' },
  },
}];

/** Fake SendGrid client — the two reads dns-records makes. */
function fakeSendgrid({ domains = SENDGRID_DOMAINS, links = [] } = {}) {
  return {
    getAuthenticatedDomains: async () => (typeof domains === 'function' ? domains() : domains),
    getBrandedLinks: async () => (typeof links === 'function' ? links() : links),
  };
}

/** Run fn with console.log captured; returns the joined lines. */
async function captureLogAsync(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

// A brand served from its GitHub Pages address owns no domain for the edge to manage.
const PAGES_URL = 'https://dreamr-design.github.io/dreamr-web';
const PAGES_REASON = 'brand.url is the hosting provider\'s default address (dreamr-design.github.io): no domain to manage';

// The DashQR case (#466): printed QR codes point at /c/<id> forever, so the
// destination is COMPUTED from the request path. That is the whole reason
// templated redirects live at the edge rather than in web config — a static
// host has nothing that can answer a path it never built.
const QR_RULE = {
  name: 'Redirect: QR short code',
  expression: '(starts_with(http.request.uri.path, "/c/"))',
  statusCode: 301,
  preserveQueryString: false,
  targetUrl: { expression: 'concat("https://", http.host, "/code?id=", substring(http.request.uri.path, 3))' },
  enabled: true,
};

// ─── Interactive verification polls (fake TTY + stubbed browser) ─────────────

const { setBrowserOpener } = require('@omega.js/devkit/flows');
const { openTtyPrompt } = require('./lib/interactive.js');

module.exports = defineCases({
  type: 'group',
  description: 'edge',
  tests: [
    // ─── Setup / skip semantics ──────────────────────────────────────────────────

    {
      name: 'edge: skips without CLOUDFLARE_TOKEN',
      run: async (ctx) => {
        const result = await runService(brandConfig(), undefined);
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/CLOUDFLARE_TOKEN/);
      },
    },

    {
      name: 'edge: edge.providers.cloudflare.enabled = false skips the service',
      run: async (ctx) => {
        const config = brandConfig();
        config.edge.providers.cloudflare.enabled = false;

        const result = await runService(config, fakeApi());
        ctx.expect(result.status).toBe('skipped');
      },
    },

    {
      name: 'edge: a default Pages brand.url is no domain, so setup skips with the one reason before any zone lookup',
      run: async (ctx) => {
        const api = fakeApi();
        const lookups = [];
        api.getZoneByName = async (name) => { lookups.push(name); return null; };
        api.getAllZones = async () => { lookups.push('*'); return []; };

        const result = await runService(brandConfig(PAGES_URL), api);

        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toBe(PAGES_REASON);
        ctx.expect(lookups).toEqual([]);
        ctx.expect(api.calls).toEqual([]);
      },
    },

    {
      name: 'edge: a default Pages brand.url skips with the one reason even with no token and no client, and asks nothing',
      run: async (ctx) => {
        const tty = openTtyPrompt();
        try {
          const run = runService(brandConfig(PAGES_URL), undefined);
          // A prompt renders before the run could settle, so whichever comes first says whether it asked
          const asked = await Promise.race([run.then(() => false), tty.waitFor('?').then(() => true)]);

          ctx.expect(asked, 'no token ask, no setup ask: there is no domain to set up').toBe(false);
          const result = await run;
          ctx.expect(result.status).toBe('skipped');
          ctx.expect(result.reason).toBe(PAGES_REASON);
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'edge: subdomain project uses the parent zone and only runs zone + dns-records',
      run: async (ctx) => {
        const sub = `app.${DOMAIN}`;
        const config = brandConfig(`https://${sub}`);
        const api = fakeApi({
          zones: [ZONE],
          responses: {
            'GET /accounts': [{ id: 'acct-1' }],
            'GET /zones/zone-1/dns_records': [
              { id: 's1', type: 'A', name: sub, content: '185.199.108.153', proxied: true, comment: 'GitHub Pages IP' },
              { id: 's2', type: 'AAAA', name: sub, content: '2606:50c0:8000::153', proxied: true, comment: 'GitHub Pages IP' },
            ],
          },
        });

        const result = await runService(config, api);

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.state.zoneId).toBe('zone-1');
        ctx.expect(api.mutations()).toEqual([]);
        // Zone-level operations never ran
        for (const c of api.calls) {
          ctx.expect(!/settings|rulesets|managed_headers|speed_api|email/.test(c.endpoint), `unexpected zone-level call: ${c.endpoint}`).toBeTruthy();
        }
      },
    },

    // ─── Idempotency: the converged zone ─────────────────────────────────────────

    {
      name: 'edge: fully converged zone is a zero-mutation no-op across all 12 operations',
      run: async (ctx) => {
        const config = brandConfig();
        const api = fakeApi({ zones: [ZONE], responses: convergedResponses(config) });

        const result = await runService(config, api);

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.mutations()).toEqual([]);
        ctx.expect(result.state.zoneId).toBe('zone-1');
      },
    },

    // ─── Zone ────────────────────────────────────────────────────────────────────

    {
      name: 'zone: missing zone is created; pending reports nameservers without any interactive wait',
      run: async (ctx) => {
        const ensureZone = require('../src/services/edge/ensure/zone.js');
        const api = fakeApi({
          zones: [],
          responses: {
            'GET /accounts': [{ id: 'acct-1' }],
            'POST /zones': { id: 'zone-new', status: 'pending', name_servers: ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'] },
          },
        });

        const result = await ensureZone(handlerContext(brandConfig(), api));

        ctx.expect(result.state.zoneId).toBe('zone-new');
        ctx.expect(result.output.zone.status).toBe('pending');
        ctx.expect(result.output.zone.nameservers).toEqual(['a.ns.cloudflare.com', 'b.ns.cloudflare.com']);
        ctx.expect(api.call('POST', '/zones')).toBeTruthy();
      },
    },

    {
      name: 'zone: the resolved id lands in edge.providers.cloudflare.zone (#434)',
      run: async (ctx) => {
        const ensureZone = require('../src/services/edge/ensure/zone.js');
        const api = fakeApi({
          zones: [{ id: 'zone-1', name: DOMAIN, status: 'active' }],
          responses: { 'GET /accounts': [{ id: 'acct-1' }] },
        });
        const context = handlerContext(brandConfig(), api);

        const result = await ensureZone(context);

        // `omega purge` reads the id from config, where no Cloudflare token is in play
        ctx.expect(result.state.zoneId).toBe('zone-1');
        ctx.expect(readConfigSource(context.brandRoot)).toMatch(/zone: "zone-1"/);
      },
    },

    {
      name: 'zone: dry-run never creates',
      run: async (ctx) => {
        const ensureZone = require('../src/services/edge/ensure/zone.js');
        const api = fakeApi({ zones: [], responses: { 'GET /accounts': [{ id: 'acct-1' }] } });

        const result = await ensureZone(handlerContext(brandConfig(), api, { options: { dryRun: true } }));

        ctx.expect(result.output.zone.planned).toBe('create');
        ctx.expect(api.mutations()).toEqual([]);
      },
    },

    {
      name: 'zone: subdomain project with a missing parent zone CREATES the parent (cp113)',
      run: async (ctx) => {
        const ensureZone = require('../src/services/edge/ensure/zone.js');
        const sub = `app.${DOMAIN}`;
        const api = fakeApi({
          zones: [],
          responses: {
            'GET /accounts': [{ id: 'acct-1' }],
            'POST /zones': { id: 'zone-parent', status: 'pending', name_servers: ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'] },
          },
        });

        const result = await ensureZone(handlerContext(brandConfig(`https://${sub}`), api, {
          domain: sub,
          zoneDomain: DOMAIN,
          isSubdomainProject: true,
        }));

        // The zone POSTed is the PARENT, not the subdomain
        const create = api.call('POST', '/zones');
        ctx.expect(create.body.name).toBe(DOMAIN);
        ctx.expect(result.state.zoneId).toBe('zone-parent');
        ctx.expect(result.output.zone.created).toBe(true);
        ctx.expect(result.output.zone.status).toBe('pending');
        ctx.expect(result.output.zone.nameservers).toEqual(['a.ns.cloudflare.com', 'b.ns.cloudflare.com']);
      },
    },

    {
      name: 'edge: dry-run with NO existing zone plans every op — zero API writes, no zones/null calls (cp113)',
      run: async (ctx) => {
        // The latent bug: ops after `zone` used to call /zones/null/… when the
        // zone didn't exist yet. fakeApi throws on any un-stubbed call, so this
        // passing means only /accounts was ever read.
        const api = fakeApi({ zones: [], responses: { 'GET /accounts': [{ id: 'acct-1' }] } });

        const result = await runService(brandConfig(), api, { dryRun: true });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.mutations()).toEqual([]);

        const sub = fakeApi({ zones: [], responses: { 'GET /accounts': [{ id: 'acct-1' }] } });
        const subResult = await runService(brandConfig(`https://app.${DOMAIN}`), sub, { dryRun: true });
        ctx.expect(subResult.status).toBe('success');
        ctx.expect(sub.mutations()).toEqual([]);
      },
    },

    {
      name: 'zone: subdomain missing-parent dry-run plans the parent create, zero mutations',
      run: async (ctx) => {
        const ensureZone = require('../src/services/edge/ensure/zone.js');
        const api = fakeApi({ zones: [], responses: { 'GET /accounts': [{ id: 'acct-1' }] } });

        const result = await ensureZone(handlerContext(brandConfig(`https://app.${DOMAIN}`), api, {
          domain: `app.${DOMAIN}`,
          zoneDomain: DOMAIN,
          isSubdomainProject: true,
          options: { dryRun: true },
        }));

        ctx.expect(result.output.zone.planned).toBe('create');
        ctx.expect(api.mutations()).toEqual([]);
      },
    },

    {
      name: 'zone: a zone created this run is visible to later operations via serviceData',
      run: async (ctx) => {
        const ensureDns = require('../src/services/edge/ensure/dns-records.js');
        const api = fakeApi({
          responses: { 'GET /zones/zone-fresh/dns_records': [] },
        });

        // zoneId null at setup time (zone didn't exist), zone op returned state
        const config = brandConfig();
        config.edge.providers.cloudflare.dns = null; // diff returns null — read is the point here
        await ensureDns(handlerContext(config, api, { zoneId: null, serviceData: { zoneId: 'zone-fresh' } }));

        ctx.expect(api.call('GET', '/zones/zone-fresh/dns_records')).toBeTruthy();
      },
    },

    // ─── DNS records ─────────────────────────────────────────────────────────────

    {
      name: 'dns helpers: platform records only — company extras (BIMI/DMARC reports) are config-gated',
      run: (ctx) => {
        // Default config: no BIMI, no SendGrid block, DMARC without report addresses
        const defaults = buildRequiredRecords(DOMAIN, brandConfig().edge.providers.cloudflare.dns, false, null);
        const names = defaults.map((r) => r.name);
        ctx.expect(!names.some((n) => n.includes('_bimi'))).toBeTruthy();
        ctx.expect(!names.some((n) => n.includes('emailauth'))).toBeTruthy();
        const dmarc = defaults.find((r) => r.name === `_dmarc.${DOMAIN}`);
        ctx.expect(dmarc.content).toBe('"v=DMARC1; p=quarantine; pct=100"');

        // Everything configured: records appear with the configured values
        const full = buildRequiredRecords(DOMAIN, {
          spf: 'strict',
          dmarcPolicy: 'reject',
          spfIncludes: ['_spf.google.com'],
          dmarcReports: { rua: ['dmarc@corp.test'], ruf: ['forensics@corp.test'] },
          bimiLogo: 'https://cdn.corp.test/logo.svg',
          // NOT config (#692): diffRecords folds this block in from the live
          // `GET /v3/whitelabel/domains` read before calling the builder
          sendgrid: { id: '123', whitelabel: 'wl001' },
          records: [{ type: 'TXT', name: '@', content: '"ahrefs-x"', comment: 'Ahrefs domain verification' }],
        }, false, 'privateemail');

        const byName = (n, t) => full.find((r) => r.name === n && (!t || r.type === t));
        ctx.expect(byName(DOMAIN, 'TXT').content).toBe('"ahrefs-x"'); // custom record, @ resolved to the domain
        ctx.expect(byName(`_dmarc.${DOMAIN}`).content).toBe('"v=DMARC1; p=reject; rua=mailto:dmarc@corp.test; ruf=mailto:forensics@corp.test; pct=100"');
        ctx.expect(byName(`default._bimi.${DOMAIN}`).content).toBe('"v=BIMI1; l=https://cdn.corp.test/logo.svg"');
        ctx.expect(byName(`emailauth.${DOMAIN}`).content).toBe('u123.wl001.sendgrid.net');
        ctx.expect(byName(`s1._domainkey.${DOMAIN}`).content).toBe('s1.domainkey.u123.wl001.sendgrid.net');
        ctx.expect(byName(`123.${DOMAIN}`).content).toBe('sendgrid.net');

        // #646: the branded LINK host is the one SendGrid record that rides the proxy
        // — and only once SendGrid says the branding is VALID (the flip's own test
        // below). Unvalidated, it stays grey-clouded like every other SendGrid record.
        ctx.expect(byName(`emailurl.${DOMAIN}`).proxied, 'no validity in the block, no proxy').toBe(false);
        ctx.expect(byName(`emailauth.${DOMAIN}`).proxied).toBe(false);
        ctx.expect(byName(`123.${DOMAIN}`).proxied).toBe(false);
        ctx.expect(byName(`s1._domainkey.${DOMAIN}`).proxied).toBe(false);
        const spf = full.find((r) => r.type === 'TXT' && r.content.includes('v=spf1'));
        ctx.expect(spf.content.includes('include:spf.privateemail.com')).toBeTruthy();
        ctx.expect(spf.content.endsWith('-all"')).toBeTruthy();
        ctx.expect(full.filter((r) => r.type === 'MX').length).toBe(2);
        // TXT customs are ADDITIVE: the apex verification token coexists with the
        // SPF default (a custom apex TXT must never suppress SPF)
        ctx.expect(full.filter((r) => r.type === 'TXT' && r.name === DOMAIN).length).toBe(2);
      },
    },

    // #646: SendGrid rewrites every transactional link through `emailurl.<domain>`
    // and serves NO certificate for it, so the record has to ride Cloudflare's
    // proxy for the click to land on HTTPS. But SendGrid VALIDATES the branding by
    // resolving that name as a CNAME to sendgrid.net, and a proxied record answers
    // with the edge's addresses instead — so flipping the proxy on first locks the
    // branding out of ever validating. The live answer decides, per run.
    {
      name: 'dns helpers: the branded link host is proxied only once SendGrid validates it (#646)',
      run: (ctx) => {
        const dnsConfig = (linkBrandingValid) => ({
          sendgrid: { id: '123', whitelabel: 'wl001', ...(linkBrandingValid === undefined ? {} : { linkBrandingValid }) },
        });
        const emailurl = (config) => buildRequiredRecords(DOMAIN, config, false, null)
          .find((r) => r.name === `emailurl.${DOMAIN}`);

        ctx.expect(emailurl(dnsConfig(true)).proxied, 'validated: the click lands on HTTPS at the edge').toBe(true);
        ctx.expect(emailurl(dnsConfig(false)).proxied, 'not validated: grey-cloud, or the CNAME lookup never resolves').toBe(false);
        ctx.expect(emailurl(dnsConfig()).proxied, 'and an unanswered read is a NO — a wrong proxy needs a hand edit to undo').toBe(false);
      },
    },

    {
      name: 'dns-records: the emailurl record follows SendGrid\'s link-branding validity (#646)',
      run: async (ctx) => {
        const ensureDns = require('../src/services/edge/ensure/dns-records.js');

        const run = async (links) => {
          const api = fakeApi({
            responses: {
              'GET /zones/zone-1/dns_records': [],
              'POST /zones/zone-1/dns_records': { id: 'new' },
            },
          });
          await ensureDns(handlerContext(brandConfig(), api, { sendgridApi: fakeSendgrid({ links }) }));

          return api.calls.find((c) => c.method === 'POST' && c.body.name === `emailurl.${DOMAIN}`);
        };

        const validated = await run([{ domain: DOMAIN, subdomain: 'emailurl', valid: true }]);
        ctx.expect(validated.body.proxied, 'SendGrid resolved the CNAME — the proxy is safe to turn on').toBe(true);

        const pending = await run([{ domain: DOMAIN, subdomain: 'emailurl', valid: false }]);
        ctx.expect(pending.body.proxied, 'still validating — a proxied record would answer with Cloudflare IPs').toBe(false);

        const absent = await run([{ domain: 'other-brand.test', subdomain: 'emailurl', valid: true }]);
        ctx.expect(absent.body.proxied, 'another brand\'s branding says nothing about this one').toBe(false);
      },
    },

    // #692: the SendGrid record set is SendGrid's own observed fact about the
    // domain — read live per run, never a config copy. omega-brand proved the copy
    // wrong on 2026-08-30: domain auth passed, no `dns.sendgrid` existed, and the
    // walk silently desired NO SendGrid records at all.
    {
      name: 'dns-records: the SendGrid records are built from the live domain-auth read (#692)',
      run: async (ctx) => {
        const ensureDns = require('../src/services/edge/ensure/dns-records.js');

        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/dns_records': [],
            'POST /zones/zone-1/dns_records': { id: 'new' },
          },
        });
        await ensureDns(handlerContext(brandConfig(), api, {
          sendgridApi: fakeSendgrid({ links: [{ domain: DOMAIN, subdomain: 'emailurl', valid: true }] }),
        }));

        const created = (name) => api.calls.find((c) => c.method === 'POST' && c.body.name === name);
        // Every record derives from mail_cname's u<id>.<whitelabel> host
        ctx.expect(created(`emailauth.${DOMAIN}`).body.content).toBe('u123.wl001.sendgrid.net');
        ctx.expect(created(`123.${DOMAIN}`).body.content, 'the owner CNAME is named for the id').toBe('sendgrid.net');
        ctx.expect(created(`s1._domainkey.${DOMAIN}`).body.content).toBe('s1.domainkey.u123.wl001.sendgrid.net');
        ctx.expect(created(`s2._domainkey.${DOMAIN}`).body.content).toBe('s2.domainkey.u123.wl001.sendgrid.net');
        ctx.expect(created(`emailurl.${DOMAIN}`).body.proxied, 'links reported valid — the branded link rides the proxy').toBe(true);
      },
    },

    // #692: no answer is a LOUD skip. Silence was the bug — `emailurl.<domain>`
    // never existed, so the #646 proxy-once-valid flip could never engage.
    {
      name: 'dns-records: an unanswered SendGrid read skips the SendGrid records and says why (#692)',
      run: async (ctx) => {
        const ensureDns = require('../src/services/edge/ensure/dns-records.js');

        const run = async (extra) => {
          const api = fakeApi({
            responses: {
              'GET /zones/zone-1/dns_records': [],
              'POST /zones/zone-1/dns_records': { id: 'new' },
            },
          });
          const logs = await captureLogAsync(() => ensureDns(handlerContext(brandConfig(), api, extra)));
          const sendgridRecords = api.calls.filter((c) =>
            c.method === 'POST' && /^(emailauth|emailurl|123|s[12]\._domainkey)\./.test(c.body.name),
          );
          return { logs, sendgridRecords, api };
        };

        // No SENDGRID_API_KEY (deleted for this file) and no injected client
        const noKey = await run({});
        ctx.expect(noKey.sendgridRecords.length, 'nothing to build the host from').toBe(0);
        ctx.expect(noKey.logs).toMatch(/SendGrid records skipped — no /);
        ctx.expect(noKey.logs).toMatch(/SENDGRID_API_KEY/);
        ctx.expect(noKey.api.calls.some((c) => c.method === 'POST' && c.body.name === DOMAIN), 'the platform records still land').toBeTruthy();

        // The account authenticates other domains, but not this brand's
        const noDomain = await run({
          sendgridApi: fakeSendgrid({ domains: [{ domain: 'other-brand.test', dns: { mail_cname: { data: 'u9.wl9.sendgrid.net' } } }] }),
        });
        ctx.expect(noDomain.sendgridRecords.length).toBe(0);
        ctx.expect(noDomain.logs).toMatch(/no authenticated domain for /);
        ctx.expect(noDomain.logs).toMatch(new RegExp(DOMAIN.replace('.', '\\.')));

        // A mail_cname that is not the u<id>.<whitelabel> shape — the warning names it
        const malformed = await run({
          sendgridApi: fakeSendgrid({ domains: [{ domain: DOMAIN, dns: { mail_cname: { data: 'em1234.fixture-brand.test' } } }] }),
        });
        ctx.expect(malformed.sendgridRecords.length, 'a guessed host would poison every SendGrid record').toBe(0);
        ctx.expect(malformed.logs).toMatch(/domain-auth host /);
        ctx.expect(malformed.logs).toMatch(/em1234\.fixture-brand\.test/);

        // An unreachable SendGrid is survivable — the zone still reconciles
        const unreachable = await run({
          sendgridApi: { getAuthenticatedDomains: async () => { throw new Error('SendGrid API error (503): Service Unavailable'); } },
        });
        ctx.expect(unreachable.sendgridRecords.length).toBe(0);
        ctx.expect(unreachable.logs).toMatch(/could not read the domain authentication/);
        ctx.expect(unreachable.logs).toMatch(/503/);
      },
    },

    // #692: config is not a fallback for the live read. A brand that still carries
    // the deleted `dns.sendgrid` block must build NOTHING from it — the stale copy
    // is exactly what pointed omega-brand's records at the wrong host.
    {
      name: 'dns-records: a leftover dns.sendgrid config block never builds records (#692)',
      run: async (ctx) => {
        const ensureDns = require('../src/services/edge/ensure/dns-records.js');
        const config = brandConfig();
        config.edge.providers.cloudflare.dns.sendgrid = { id: '999', whitelabel: 'stale' };

        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/dns_records': [],
            'POST /zones/zone-1/dns_records': { id: 'new' },
          },
        });

        // Live read answers NOTHING (no key, no client injected)
        await ensureDns(handlerContext(config, api, {}));

        const created = api.calls.filter((c) => c.method === 'POST').map((c) => c.body.name);
        ctx.expect(!created.some((n) => /^(emailauth|emailurl|999|s[12]\._domainkey)\./.test(n)), 'the stale copy desired nothing').toBeTruthy();
        ctx.expect(created.includes(DOMAIN), 'the platform records still land').toBeTruthy();
      },
    },

    // #662 + #692: the wait is for a branding that EXISTS and has not validated
    // yet. A host with no branding at all gets one from the campaigns service
    // later in the same walk (#693), so waiting on it HERE would never end.
    {
      name: 'dns-records: no link branding at all skips the wait and points at the campaigns service (#693)',
      run: async (ctx) => {
        const ensureDns = require('../src/services/edge/ensure/dns-records.js');

        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/dns_records': [],
            'POST /zones/zone-1/dns_records': { id: 'new' },
          },
        });

        // A TTY is available: an entry that EXISTS holds the walk here (#662), so a
        // handler that finishes inside the beat is one that never started waiting.
        const tty = openTtyPrompt();
        let result;
        const logs = await captureLogAsync(async () => {
          try {
            const run = ensureDns(handlerContext(brandConfig(), api, {
              sendgridApi: fakeSendgrid({ links: [{ domain: 'other-brand.test', subdomain: 'emailurl', valid: true }] }),
            }));
            const raced = await Promise.race([run, new Promise((resolve) => setTimeout(() => resolve('WAITED'), 750))]);
            if (raced === 'WAITED') {
              await tty.answer('(enter)=check now, (s)=skip', 's'); // release it, then fail
              await run;
            }
            result = raced;
          } finally {
            tty.close();
          }
        });

        ctx.expect(result, 'the branding arrives from the campaigns service — a wait on it here would never end').not.toBe('WAITED');
        const created = api.calls.find((c) => c.method === 'POST' && c.body.name === `emailurl.${DOMAIN}`);
        ctx.expect(created.body.proxied, 'branding that does not exist never rides the proxy').toBe(false);
        ctx.expect(result.status, 'nothing is PENDING — there is no branding to validate').toBe('success');
        ctx.expect(logs).toMatch(/SendGrid has no link branding for that host yet/);
        ctx.expect(logs, 'the line names who creates it').toMatch(/campaigns service creates and validates it later in this run/);
      },
    },

    {
      name: 'dns-records: drift creates missing, updates SPF enforcement, deletes obsolete MX + wrong A',
      run: async (ctx) => {
        const ensureDns = require('../src/services/edge/ensure/dns-records.js');
        const config = brandConfig();
        config.domain.email.providers = { cloudflare: {} };

        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/dns_records': [
              // Wrong A content → replaced (delete + create of the right one)
              { id: 'a1', type: 'A', name: DOMAIN, content: '1.2.3.4', proxied: true, comment: 'GitHub Pages IP' },
              // SPF with soft enforcement while config says strict → content update
              { id: 't1', type: 'TXT', name: DOMAIN, content: '"v=spf1 include:_spf.google.com include:sendgrid.net include:_spf.mx.cloudflare.net ~all"', comment: 'SPF policy' },
              // Mailgun MX while provider is cloudflare → obsolete
              { id: 'm1', type: 'MX', name: DOMAIN, content: 'mxa.mailgun.org', priority: 10, comment: 'Squarespace email forwarding' },
            ],
            'POST /zones/zone-1/dns_records': {},
            'PATCH /zones/zone-1/dns_records/t1': {},
            'DELETE /zones/zone-1/dns_records/m1': {},
            'DELETE /zones/zone-1/dns_records/a1': {},
          },
        });

        const result = await ensureDns(handlerContext(config, api));

        ctx.expect(result.status).toBe('success');
        // Creates: AAAA, www CNAME, DMARC = 3. The wrong-content A and the route MX
        // records converge on the NEXT run — existing records matching by name+type
        // block creation this run while the deletes clear them (faithful omega-
        // manager two-run convergence).
        ctx.expect(result.output.dns.created.length).toBe(3);
        ctx.expect(result.output.dns.updated.length).toBe(1);
        ctx.expect(result.output.dns.deleted.length).toBe(2);
        ctx.expect(result.output.dns.errors.length).toBe(0);

        const patched = api.call('PATCH', '/zones/zone-1/dns_records/t1');
        ctx.expect(patched.body.content.endsWith('-all"')).toBeTruthy();
        // No SendGrid/BIMI records invented (not configured)
        const created = api.calls.filter((c) => c.method === 'POST').map((c) => c.body.name);
        ctx.expect(!created.some((n) => n.includes('emailauth') || n.includes('_bimi'))).toBeTruthy();
      },
    },

    {
      name: 'dns-records: dry-run reports planned counts with zero mutations',
      run: async (ctx) => {
        const ensureDns = require('../src/services/edge/ensure/dns-records.js');
        const api = fakeApi({
          responses: { 'GET /zones/zone-1/dns_records': [] },
        });

        const result = await ensureDns(handlerContext(brandConfig(), api, { options: { dryRun: true } }));

        ctx.expect(api.mutations()).toEqual([]);
        // A, AAAA, www, SPF, DMARC (no email provider → no MX)
        ctx.expect(result.output.dns.planned.create).toBe(5);
      },
    },

    // #692: the domain-auth read is a READ, so a dry run does it too and plans the
    // records it found — the old config-gated path planned nothing at all here.
    {
      name: 'dns-records: dry-run reads SendGrid live and names the host in the plan (#692)',
      run: async (ctx) => {
        const ensureDns = require('../src/services/edge/ensure/dns-records.js');
        const api = fakeApi({
          responses: { 'GET /zones/zone-1/dns_records': [] },
        });

        let result;
        const logs = await captureLogAsync(async () => {
          result = await ensureDns(handlerContext(brandConfig(), api, {
            options: { dryRun: true },
            sendgridApi: fakeSendgrid({ links: [{ domain: DOMAIN, subdomain: 'emailurl', valid: true }] }),
          }));
        });

        ctx.expect(api.mutations()).toEqual([]);
        // The 5 platform records + emailauth, the owner CNAME, emailurl, 2 DKIM keys
        ctx.expect(result.output.dns.planned.create).toBe(10);
        ctx.expect(logs).toMatch(/SendGrid domain auth read live: u123\.wl001\.sendgrid\.net/);
      },
    },

    // ─── Zone settings ───────────────────────────────────────────────────────────

    {
      name: 'zone-settings: patches exactly the drifted editable settings; read-only drift is skipped',
      run: async (ctx) => {
        const ensureSettings = require('../src/services/edge/ensure/zone-settings.js');
        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/settings': [
              { id: 'ssl', value: 'off', editable: true },          // drifted → PATCH
              { id: 'waf', value: 'on', editable: false },          // drifted but read-only → skipped
              { id: 'brotli', value: 'on', editable: true },        // converged
              { id: 'speed_brain', value: 'on', editable: true },   // addons present in bulk → no extra GET
              { id: 'fonts', value: 'on', editable: true },
            ],
            'PATCH /zones/zone-1/settings/ssl': {},
          },
        });

        const result = await ensureSettings(handlerContext(brandConfig(), api));

        ctx.expect(result.output.settings.success).toEqual(['ssl']);
        ctx.expect(api.mutations().length).toBe(1);
        ctx.expect(api.call('PATCH', '/zones/zone-1/settings/ssl').body).toEqual({ value: 'full' });
      },
    },

    {
      name: 'zone-settings: dry-run lists the plan, patches nothing',
      run: async (ctx) => {
        const ensureSettings = require('../src/services/edge/ensure/zone-settings.js');
        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/settings': [
              { id: 'ssl', value: 'off', editable: true },
              { id: 'speed_brain', value: 'on', editable: true },
              { id: 'fonts', value: 'on', editable: true },
            ],
          },
        });

        const result = await ensureSettings(handlerContext(brandConfig(), api, { options: { dryRun: true } }));

        ctx.expect(result.output.settings.planned).toEqual(['ssl']);
        ctx.expect(api.mutations()).toEqual([]);
      },
    },

    // ─── Rulesets ────────────────────────────────────────────────────────────────

    {
      name: 'cache-rules: updates stale TTLs and removes unconfigured rules in one PUT',
      run: async (ctx) => {
        const ensureCacheRules = require('../src/services/edge/ensure/cache-rules.js');
        const config = brandConfig();
        const cache = config.edge.providers.cloudflare.cacheRules[0];

        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/rulesets/phases/http_request_cache_settings/entrypoint': {
              id: 'rs-cache', kind: 'zone', phase: 'http_request_cache_settings', name: 'Cache Rules', description: 'managed',
              rules: [
                {
                  id: 'cr1', description: cache.name, expression: cache.expression, enabled: true,
                  action: 'set_cache_settings',
                  action_parameters: { cache: true, edge_ttl: { mode: 'override_origin', default: 100 }, browser_ttl: { mode: 'override_origin', default: 100 } },
                },
                { id: 'cr2', description: 'Old Rule Nobody Configured', expression: 'true', enabled: true, action: 'set_cache_settings', action_parameters: {} },
              ],
            },
            'PUT /zones/zone-1/rulesets/rs-cache': {},
          },
        });

        const result = await ensureCacheRules(handlerContext(config, api));

        ctx.expect(result.output.cacheRules.updated).toBe(true);
        const put = api.call('PUT', '/zones/zone-1/rulesets/rs-cache');
        ctx.expect(put.body.rules.length).toBe(config.edge.providers.cloudflare.cacheRules.length);
        ctx.expect(put.body.rules[0].action_parameters.edge_ttl.default).toBe(cache.edgeTtl);
        ctx.expect(!put.body.rules.some((rule) => rule.description === 'Old Rule Nobody Configured')).toBeTruthy();
      },
    },

    {
      name: 'cache-rules: missing entrypoint ruleset is created via POST',
      run: async (ctx) => {
        const ensureCacheRules = require('../src/services/edge/ensure/cache-rules.js');
        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/rulesets/phases/http_request_cache_settings/entrypoint': () => {
              throw new Error('Cloudflare API Error: could not find entrypoint ruleset (10003)');
            },
            'POST /zones/zone-1/rulesets': {},
          },
        });

        const result = await ensureCacheRules(handlerContext(brandConfig(), api));

        ctx.expect(result.output.cacheRules.updated).toBe(true);
        const post = api.call('POST', '/zones/zone-1/rulesets');
        ctx.expect(post.body.phase).toBe('http_request_cache_settings');
        ctx.expect(post.body.rules.length).toBe(DEFAULTS.edge.providers.cloudflare.cacheRules.length);
      },
    },

    // #751: the built site's every asset is content-hashed under /assets, so it is
    // cacheable forever — HTML is the one thing that must not be, or a deploy stays
    // invisible to a returning visitor for as long as the browser holds it.
    {
      name: 'cache-rules: the framework defaults cache built assets for a year and keep HTML short (#751)',
      run: (ctx) => {
        const rules = DEFAULTS.edge.providers.cloudflare.cacheRules;
        const assets = rules.find((rule) => rule.name === 'Assets: Cache for 1 Year');
        const html = rules.find((rule) => rule.name === 'HTML: Short Browser Cache');

        ctx.expect(assets.edgeTtl).toBe(31536000);
        ctx.expect(assets.browserTtl).toBe(31536000);
        ctx.expect(assets.expression.includes('wildcard r"/assets/*"')).toBeTruthy();

        ctx.expect(html, 'the defaults carry an HTML rule').toBeTruthy();
        ctx.expect(html.browserTtl).toBe(60);
        ctx.expect(html.edgeTtl).toBe(7200);
        // Never the asset rule's paths — one path, one cache lifetime
        ctx.expect(html.expression.includes('not starts_with(http.request.uri.path, "/assets/")')).toBeTruthy();
      },
    },

    // Every loader of /build.js carries the build stamp, so the file caches like a
    // hashed asset: an exact-path clause on the year rule, beside the two it had.
    {
      name: 'cache-rules: the year-long assets rule also matches /build.js',
      run: (ctx) => {
        const assets = DEFAULTS.edge.providers.cloudflare.cacheRules.find((rule) => rule.name === 'Assets: Cache for 1 Year');

        ctx.expect(assets.expression.includes('(http.request.uri.path eq "/build.js")')).toBeTruthy();
        ctx.expect(assets.expression.includes('(http.request.uri.path wildcard r"/assets/*")')).toBeTruthy();
        ctx.expect(assets.expression.includes('(http.request.uri.path eq "/__/auth/iframe.js")')).toBeTruthy();
      },
    },

    {
      name: 'cache-rules: a zone holding the old assets expression is updated to the new one in one PUT',
      run: async (ctx) => {
        const ensureCacheRules = require('../src/services/edge/ensure/cache-rules.js');
        const OLD_ASSETS_EXPRESSION = '(http.request.uri.path wildcard r"/assets/*") or (http.request.uri.path eq "/__/auth/iframe.js")';
        const config = brandConfig();
        const rules = config.edge.providers.cloudflare.cacheRules;
        const assets = rules.find((rule) => rule.name === 'Assets: Cache for 1 Year');

        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/rulesets/phases/http_request_cache_settings/entrypoint': {
              id: 'rs-cache', kind: 'zone', phase: 'http_request_cache_settings', name: 'Cache Rules', description: 'managed',
              rules: rules.map((rule, i) => ({
                id: `cr${i + 1}`,
                description: rule.name,
                expression: rule === assets ? OLD_ASSETS_EXPRESSION : rule.expression,
                enabled: rule.enabled,
                action: 'set_cache_settings',
                action_parameters: {
                  cache: true,
                  edge_ttl: { mode: 'override_origin', default: rule.edgeTtl },
                  browser_ttl: { mode: 'override_origin', default: rule.browserTtl },
                },
              })),
            },
            'PUT /zones/zone-1/rulesets/rs-cache': {},
          },
        });

        const result = await ensureCacheRules(handlerContext(config, api));

        ctx.expect(result, 'the reconcile saw a stale rule and wrote').toBeTruthy();
        ctx.expect(result.output.cacheRules.updated).toBe(true);
        ctx.expect(api.mutations().map((call) => `${call.method} ${call.endpoint}`)).toEqual(['PUT /zones/zone-1/rulesets/rs-cache']);
        const written = api.mutations()[0].body.rules.find((rule) => rule.description === 'Assets: Cache for 1 Year');
        ctx.expect(written.expression).not.toBe(OLD_ASSETS_EXPRESSION);
        ctx.expect(written.expression).toBe(assets.expression);
        ctx.expect(written.expression.includes('(http.request.uri.path eq "/build.js")')).toBeTruthy();
      },
    },

    {
      name: 'cache-rules: a brand declaring no rules still reconciles the framework defaults (#751)',
      run: async (ctx) => {
        const ensureCacheRules = require('../src/services/edge/ensure/cache-rules.js');
        const { config } = loadBrand(makeBrandRoot(`{
  brand: { id: 'fixture-brand', url: 'https://${DOMAIN}' },
}
`));
        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/rulesets/phases/http_request_cache_settings/entrypoint': () => {
              throw new Error('Cloudflare API Error: could not find entrypoint ruleset (10003)');
            },
            'POST /zones/zone-1/rulesets': {},
          },
        });

        await ensureCacheRules(handlerContext(config, api));

        const post = api.call('POST', '/zones/zone-1/rulesets');
        ctx.expect(post.body.rules.map((rule) => rule.description)).toEqual(['Assets: Cache for 1 Year', 'HTML: Short Browser Cache']);
        ctx.expect(post.body.rules[0].action_parameters.browser_ttl.default).toBe(31536000);
        ctx.expect(post.body.rules[1].action_parameters.browser_ttl.default).toBe(60);
      },
    },

    // Cache rules are ZONE-scoped, and the zone serves the api host too
    // (api.<domain>, whose Firebase rewrites answer extensionless user-scoped GETs
    // like /authorize and /omega/user/connections). An unguarded HTML rule would make
    // those edge-cacheable, so the rule names the hosts it is FOR.
    {
      name: 'cache-rules: the HTML rule never matches the api or emailurl hosts (#751)',
      run: (ctx) => {
        const rules = DEFAULTS.edge.providers.cloudflare.cacheRules;
        const html = rules.find((rule) => rule.name === 'HTML: Short Browser Cache');
        const assets = rules.find((rule) => rule.name === 'Assets: Cache for 1 Year');

        ctx.expect(html.expression.includes('not starts_with(http.host, "api.")')).toBeTruthy();
        // The other proxied non-site host: the SendGrid link-tracking CNAME, whose
        // extensionless click/open URLs must reach SendGrid every time.
        ctx.expect(html.expression.includes('not starts_with(http.host, "emailurl.")')).toBeTruthy();
        // Every site host on the zone still matches: apex, www, and a subdomain
        // project served under the parent zone — so the guard is the api PREFIX,
        // never an equality on one host.
        ctx.expect(!html.expression.includes('http.host eq')).toBeTruthy();
        // The assets rule stays host-agnostic: both its paths are static files
        ctx.expect(!assets.expression.includes('http.host')).toBeTruthy();
      },
    },

    {
      name: "cache-rules: a brand's own cacheRules replace the defaults entirely (#751)",
      run: (ctx) => {
        const { config } = loadBrand(makeBrandRoot(`{
  brand: { id: 'fixture-brand', url: 'https://${DOMAIN}' },
  edge: { providers: { cloudflare: { cacheRules: [{ name: 'Only Mine', expression: 'true', edgeTtl: 60, browserTtl: 60 }] } } },
}
`));

        ctx.expect(config.edge.providers.cloudflare.cacheRules.map((rule) => rule.name)).toEqual(['Only Mine']);
      },
    },

    // #754: 0 is a real TTL, not "unset". `browserTtl: 0` is a brand saying "hold
    // nothing in the browser" (Cloudflare writes `max-age=0`), and a `||` default
    // silently turned that into 14400. The manager sends the TTLs the brand
    // declared and lets Cloudflare judge them — an edge bypass is its own MODE in
    // Cloudflare's grammar, never a value this module substitutes.
    {
      name: 'cache-rules: a declared TTL of 0 is honored, never replaced by the default (#754)',
      run: async (ctx) => {
        const ensureCacheRules = require('../src/services/edge/ensure/cache-rules.js');
        const { config } = loadBrand(makeBrandRoot(`{
  brand: { id: 'fixture-brand', url: 'https://${DOMAIN}' },
  edge: { providers: { cloudflare: { cacheRules: [
    { name: 'HTML: No Browser Cache', expression: 'true', edgeTtl: 7200, browserTtl: 0 },
    { name: 'API: No Cache At All', expression: 'starts_with(http.host, "api.")', edgeTtl: 0, browserTtl: 0 },
  ] } } },
}
`));
        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/rulesets/phases/http_request_cache_settings/entrypoint': () => {
              throw new Error('Cloudflare API Error: could not find entrypoint ruleset (10003)');
            },
            'POST /zones/zone-1/rulesets': {},
          },
        });

        await ensureCacheRules(handlerContext(config, api));

        const post = api.call('POST', '/zones/zone-1/rulesets');
        ctx.expect(post.body.rules[0].action_parameters.browser_ttl.default).toBe(0);
        ctx.expect(post.body.rules[0].action_parameters.edge_ttl.default).toBe(7200);
        ctx.expect(post.body.rules[1].action_parameters.browser_ttl.default).toBe(0);
        ctx.expect(post.body.rules[1].action_parameters.edge_ttl.default).toBe(0);
      },
    },

    // A rule already at 0 on the zone is converged: the diff must not see a
    // difference the `||` default invented and PUT a needless update every run.
    {
      name: 'cache-rules: a zone already at a 0 TTL needs no update (#754)',
      run: async (ctx) => {
        const ensureCacheRules = require('../src/services/edge/ensure/cache-rules.js');
        const { config } = loadBrand(makeBrandRoot(`{
  brand: { id: 'fixture-brand', url: 'https://${DOMAIN}' },
  edge: { providers: { cloudflare: { cacheRules: [
    { name: 'HTML: No Browser Cache', expression: 'true', edgeTtl: 7200, browserTtl: 0 },
  ] } } },
}
`));
        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/rulesets/phases/http_request_cache_settings/entrypoint': {
              id: 'rs-cache', kind: 'zone', phase: 'http_request_cache_settings', name: 'Cache Rules', description: 'managed',
              rules: [{
                id: 'cr1', description: 'HTML: No Browser Cache', expression: 'true', enabled: true,
                action: 'set_cache_settings',
                action_parameters: {
                  cache: true,
                  edge_ttl: { mode: 'override_origin', default: 7200 },
                  browser_ttl: { mode: 'override_origin', default: 0 },
                },
              }],
            },
          },
        });

        const result = await ensureCacheRules(handlerContext(config, api));

        ctx.expect(result).toBe(undefined);
        ctx.expect(api.mutations()).toEqual([]);
      },
    },

    {
      name: 'rules-redirect: a templated redirect is created with its computed target intact (#466)',
      run: async (ctx) => {
        const ensureRedirect = require('../src/services/edge/ensure/rules-redirect.js');
        const config = brandConfig();
        const trailing = config.edge.providers.cloudflare.rules.redirect[0];
        config.edge.providers.cloudflare.rules.redirect.push(QR_RULE);

        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/rulesets/phases/http_request_dynamic_redirect/entrypoint': {
              id: 'rs-redirect', kind: 'zone', phase: 'http_request_dynamic_redirect', name: 'Redirect Rules',
              rules: [{
                id: 'rr1', description: trailing.name, expression: trailing.expression, enabled: trailing.enabled,
                action: 'redirect',
                action_parameters: {
                  from_value: {
                    status_code: trailing.statusCode,
                    preserve_query_string: trailing.preserveQueryString,
                    target_url: trailing.targetUrl,
                  },
                },
              }],
            },
            'PUT /zones/zone-1/rulesets/rs-redirect': {},
          },
        });

        const result = await ensureRedirect(handlerContext(config, api));

        ctx.expect(result.output.redirect.updated).toBe(true);
        const put = api.call('PUT', '/zones/zone-1/rulesets/rs-redirect');
        ctx.expect(put.body.rules.length, 'the converged rule survives beside the new one').toBe(2);

        const qr = put.body.rules.find((rule) => rule.description === QR_RULE.name);
        ctx.expect(qr.action).toBe('redirect');
        ctx.expect(qr.expression, 'the match is the edge filter expression, verbatim').toBe(QR_RULE.expression);
        ctx.expect(qr.action_parameters.from_value).toEqual({
          status_code: 301,
          // The target carries its own `?id=`, so an inbound querystring must NOT be
          // appended — that is what the key is for.
          preserve_query_string: false,
          target_url: QR_RULE.targetUrl,
        });
      },
    },

    {
      name: 'rules-redirect: a converged templated rule mutates nothing, and a dry run plans instead of writing',
      run: async (ctx) => {
        const ensureRedirect = require('../src/services/edge/ensure/rules-redirect.js');
        const config = brandConfig();
        config.edge.providers.cloudflare.rules.redirect.push(QR_RULE);

        const responses = {
          'GET /zones/zone-1/rulesets/phases/http_request_dynamic_redirect/entrypoint': {
            id: 'rs-redirect', kind: 'zone', phase: 'http_request_dynamic_redirect', name: 'Redirect Rules',
            rules: config.edge.providers.cloudflare.rules.redirect.map((rule, index) => ({
              id: `rr${index + 1}`, description: rule.name, expression: rule.expression, enabled: rule.enabled,
              action: 'redirect',
              action_parameters: {
                from_value: {
                  status_code: rule.statusCode,
                  preserve_query_string: rule.preserveQueryString,
                  target_url: rule.targetUrl,
                },
              },
            })),
          },
        };

        const converged = fakeApi({ responses });
        await ensureRedirect(handlerContext(config, converged));
        ctx.expect(converged.mutations(), 'a converged ruleset is a zero-mutation read').toEqual([]);

        // Drift the live status code so the dry run has something to plan.
        const drifted = fakeApi({ responses: structuredClone(responses) });
        drifted.responses['GET /zones/zone-1/rulesets/phases/http_request_dynamic_redirect/entrypoint']
          .rules[1].action_parameters.from_value.status_code = 302;

        const result = await ensureRedirect(handlerContext(config, drifted, { options: { dryRun: true } }));

        ctx.expect(result.output.redirect.planned).toBe('update');
        ctx.expect(drifted.mutations(), 'a dry run writes nothing').toEqual([]);
      },
    },

    {
      name: 'managed-transforms: enables only the drifted transform',
      run: async (ctx) => {
        const ensureTransforms = require('../src/services/edge/ensure/rules-managed-transforms.js');
        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/managed_headers': {
              managed_request_headers: [{ id: 'add_visitor_location_headers', enabled: false }],
              managed_response_headers: [{ id: 'remove_x-powered-by_header', enabled: true }],
            },
            'PATCH /zones/zone-1/managed_headers': {},
          },
        });

        const result = await ensureTransforms(handlerContext(brandConfig(), api));

        ctx.expect(result.output.managedTransforms.updated).toBe(true);
        const patch = api.call('PATCH', '/zones/zone-1/managed_headers');
        const visitor = patch.body.managed_request_headers.find((h) => h.id === 'add_visitor_location_headers');
        ctx.expect(visitor.enabled).toBe(true);
      },
    },

    // ─── Email routing ───────────────────────────────────────────────────────────

    {
      name: 'email-routing: provider other than cloudflare makes no API calls',
      run: async (ctx) => {
        const ensureEmailRouting = require('../src/services/edge/ensure/email-routing.js');
        const config = brandConfig();
        config.domain.email.providers = { squarespace: {} };

        const api = fakeApi();
        await ensureEmailRouting(handlerContext(config, api));

        ctx.expect(api.calls.length).toBe(0);
      },
    },

    {
      name: 'email-routing: converged catch-all + rules are a no-op',
      run: async (ctx) => {
        const ensureEmailRouting = require('../src/services/edge/ensure/email-routing.js');
        const config = brandConfig();
        config.domain.email.providers = { cloudflare: {} };
        config.domain.email.forwarding = [
          { from: '*', to: 'inbox@corp.test' },
          { from: 'support', to: 'help@corp.test' },
        ];

        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/email/routing': { enabled: true },
            'GET /zones/zone-1/email/routing/rules': [{
              tag: 't1', enabled: true,
              matchers: [{ type: 'literal', field: 'to', value: `support@${DOMAIN}` }],
              actions: [{ type: 'forward', value: ['help@corp.test'] }],
            }],
            'GET /zones/zone-1/email/routing/rules/catch_all': {
              enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'forward', value: ['inbox@corp.test'] }],
            },
          },
        });

        const result = await ensureEmailRouting(handlerContext(config, api));

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.emailRouting.skipped).toBe(2);
        ctx.expect(api.mutations()).toEqual([]);
      },
    },

    {
      name: 'email-routing: unverified destination sends a verification email and returns warned (no interactive poll)',
      run: async (ctx) => {
        const ensureEmailRouting = require('../src/services/edge/ensure/email-routing.js');
        const config = brandConfig();
        config.domain.email.providers = { cloudflare: {} };
        config.domain.email.forwarding = [{ from: 'support', to: 'new@corp.test' }];

        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/email/routing': { enabled: true },
            'GET /zones/zone-1/email/routing/rules': [],
            'POST /zones/zone-1/email/routing/rules': () => {
              throw new Error('Cloudflare API Error: [{"code":2054,"message":"destination address not verified"}]');
            },
            'GET /zones/zone-1': { account: { id: 'acct-1' } },
            'POST /accounts/acct-1/email/routing/addresses': {},
            'GET /zones/zone-1/email/routing/rules/catch_all': { enabled: false },
          },
        });

        const result = await ensureEmailRouting(handlerContext(config, api));

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.emailRouting.unverified).toBe(1);
        ctx.expect(api.call('POST', '/accounts/acct-1/email/routing/addresses')).toBeTruthy();
      },
    },

    // ─── Speed + workers ─────────────────────────────────────────────────────────

    {
      name: 'speed-scheduled-tests: inactive zone (nameservers pending) is skipped, not failed',
      run: async (ctx) => {
        const ensureSpeed = require('../src/services/edge/ensure/speed-scheduled-tests.js');
        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/speed_api/pages': () => {
              throw new Error('Cloudflare API Error: [{"code":401,"message":"speed.errors.zone_not_active"}]');
            },
          },
        });

        const result = await ensureSpeed(handlerContext(brandConfig(), api));
        ctx.expect(result.status).toBe('skipped');
      },
    },

    {
      name: 'workers: no workers configured → no API traffic',
      run: async (ctx) => {
        const ensureWorkers = require('../src/services/edge/ensure/workers.js');
        const api = fakeApi();

        const result = await ensureWorkers(handlerContext(brandConfig(), api));

        ctx.expect(result).toBe(undefined);
        ctx.expect(api.calls.length).toBe(0);
      },
    },

    {
      name: 'zone: pending zone with a manual registrar opens its nameserver page and polls until active',
      run: async (ctx) => {
        const ensureZone = require('../src/services/edge/ensure/zone.js');
        const api = fakeApi({
          zones: [{ id: 'zone-p', name: DOMAIN, status: 'pending', name_servers: ['a.ns.cloudflare.com'] }],
          responses: {
            'GET /accounts': [{ id: 'acct-1' }],
            // The poll's first re-read already sees the activated zone
            'GET /zones/zone-p': { id: 'zone-p', name: DOMAIN, status: 'active' },
          },
        });
        const config = brandConfig();
        config.domain.providers = { squarespace: {} };
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });
        const tty = openTtyPrompt();

        try {
          const run = ensureZone(handlerContext(config, api));
          await tty.answer('Press Enter to open the squarespace nameserver settings', '\r');
          const result = await run;

          ctx.expect(result.state.zoneId).toBe('zone-p');
          ctx.expect(result.output.zone.status).toBe('active');
          ctx.expect(opened).toEqual([`https://account.squarespace.com/domains/managed/${DOMAIN}/dns/domain-nameservers`]);
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    {
      name: 'zone: pending zone with an API registrar defers to the domain service even interactively',
      run: async (ctx) => {
        const ensureZone = require('../src/services/edge/ensure/zone.js');
        // No GET /zones/zone-p responder — a poll attempt would fail loudly
        const api = fakeApi({
          zones: [{ id: 'zone-p', name: DOMAIN, status: 'pending', name_servers: ['a.ns.cloudflare.com'] }],
          responses: { 'GET /accounts': [{ id: 'acct-1' }] },
        });
        const config = brandConfig();
        config.domain.providers = { namecheap: {} };
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });
        const tty = openTtyPrompt();

        try {
          const result = await ensureZone(handlerContext(config, api));

          ctx.expect(result.output.zone.status).toBe('pending');
          ctx.expect(opened).toEqual([]);
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    {
      name: 'email-routing: interactive run opens the dashboard and retries the write once verified',
      run: async (ctx) => {
        const ensureEmailRouting = require('../src/services/edge/ensure/email-routing.js');
        const config = brandConfig();
        config.domain.email.providers = { cloudflare: {} };
        config.domain.email.forwarding = [{ from: 'support', to: 'new@corp.test' }];

        let attempts = 0;
        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/email/routing': { enabled: true },
            'GET /zones/zone-1/email/routing/rules': [],
            'POST /zones/zone-1/email/routing/rules': () => {
              attempts++;
              if (attempts === 1) {
                throw new Error('Cloudflare API Error: [{"code":2054,"message":"destination address not verified"}]');
              }
              return {};
            },
            'GET /zones/zone-1': { account: { id: 'acct-1' } },
            'POST /accounts/acct-1/email/routing/addresses': {},
            'GET /zones/zone-1/email/routing/rules/catch_all': { enabled: false },
          },
        });
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });
        const tty = openTtyPrompt();

        try {
          const run = ensureEmailRouting(handlerContext(config, api));
          await tty.answer('Press Enter to open the Cloudflare destination-addresses page', '\r');
          const result = await run;

          ctx.expect(result.status).toBe('success');
          ctx.expect(result.output.emailRouting.created).toBe(1);
          ctx.expect(result.output.emailRouting.unverified).toBe(0);
          ctx.expect(opened).toEqual(['https://dash.cloudflare.com/acct-1/email-routing/destination-addresses']);
          ctx.expect(attempts).toBe(2); // initial write + the poll's retry after verification
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    // #662: the flip belongs to THIS walk. SendGrid validates the branded link a
    // few minutes after the CNAME lands, so an interactive run waits for that
    // answer and proxies the record in the same pass; skipping keeps it grey.
    {
      name: 'dns-records: the run waits for SendGrid\'s validation and proxies emailurl in the SAME walk (#662)',
      run: async (ctx) => {
        const ensureDns = require('../src/services/edge/ensure/dns-records.js');
        const config = brandConfig();

        let reads = 0;
        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/dns_records': [],
            'POST /zones/zone-1/dns_records': { id: 'new' },
          },
        });

        const tty = openTtyPrompt();
        try {
          const run = ensureDns(handlerContext(config, api, {
            sendgridApi: fakeSendgrid({
              links: () => {
                reads += 1;
                return [{ domain: DOMAIN, subdomain: 'emailurl', valid: reads >= 3 }];
              },
            }),
          }));

          await tty.answer('(enter)=check now, (s)=skip', '\r');
          const result = await run;

          const created = api.calls.find((c) => c.method === 'POST' && c.body.name === `emailurl.${DOMAIN}`);
          ctx.expect(created.body.proxied, 'validation landed mid-run — the record is written proxied, not on a rerun').toBe(true);
          ctx.expect(result.status, 'nothing is owed to a second run').toBe('success');
          ctx.expect(reads >= 3, 'SendGrid was re-asked on a later tick').toBeTruthy();
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'dns-records: skipping the branded-link wait warns with the reason the summary prints (#662)',
      run: async (ctx) => {
        const ensureDns = require('../src/services/edge/ensure/dns-records.js');
        const config = brandConfig();

        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/dns_records': [],
            'POST /zones/zone-1/dns_records': { id: 'new' },
          },
        });

        const tty = openTtyPrompt();
        try {
          const run = ensureDns(handlerContext(config, api, {
            sendgridApi: fakeSendgrid({ links: [{ domain: DOMAIN, subdomain: 'emailurl', valid: false }] }),
          }));

          await tty.answer('(enter)=check now, (s)=skip', 's');
          const result = await run;

          const created = api.calls.find((c) => c.method === 'POST' && c.body.name === `emailurl.${DOMAIN}`);
          ctx.expect(created.body.proxied, 'still unvalidated — a proxied record would answer with Cloudflare IPs').toBe(false);
          ctx.expect(result.status).toBe('warned');
          ctx.expect(result.reason).toMatch(/has not validated the branded link/);
        } finally {
          tty.close();
        }
      },
    },

    // ─── The api proxy worker ────────────────────────────────────────────────────

    // The worker proxies /omega to the brand's functions and nothing else: the
    // retired /backend-manager alias is no prefix, so it reaches the origin like
    // any other path (#945). `fetch` is the one global the worker calls, so the
    // test records what it was handed instead of reaching the network.
    {
      name: 'api proxy worker: /omega proxies to the functions, the retired /backend-manager alias passes through',
      run: async (ctx) => {
        const { default: worker } = await import('../src/services/edge/workers/omega-api-proxy.js');
        const originalFetch = globalThis.fetch;
        const seen = [];
        globalThis.fetch = async (target) => {
          seen.push(typeof target === 'string' ? target : target.url);
          return 'response';
        };

        try {
          const env = { FIREBASE_PROJECT_ID: 'fixture-project' };
          await worker.fetch(new Request('https://api.fixture-brand.test/omega/user/signup?x=1'), env);
          await worker.fetch(new Request('https://api.fixture-brand.test/backend-manager/user/signup'), env);
        } finally {
          globalThis.fetch = originalFetch;
        }

        ctx.expect(seen).toEqual([
          'https://us-central1-fixture-project.cloudfunctions.net/omega_api/user/signup?x=1',
          'https://api.fixture-brand.test/backend-manager/user/signup',
        ]);
      },
    },
  ],
});
