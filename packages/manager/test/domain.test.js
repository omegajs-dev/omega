/**
 * Domain service tests — registrar nameserver reconciliation against
 * recording fakes for both APIs (Cloudflare zone lookup + Namecheap DNS).
 * Proves skip semantics, the converged zero-mutation no-op, drift updates,
 * the psl SLD/TLD split (multi-part TLDs), manual-registrar handling, the
 * IP-whitelist walkthrough (#698), and the dry-run guarantee.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

const { stripVTControlCharacters } = require('node:util');
const JSON5 = require('json5');
const { setBrowserOpener } = require('@omega.js/devkit/flows');
const { OPERATIONS, DEFAULTS } = require('../src/config.js');
const service = require('../src/services/domain/index.js');
const { NamecheapAPI, API_ACCESS_URL, isWhitelistError } = require('../src/services/domain/lib/namecheap-api.js');
const { openTtyPrompt } = require('./lib/interactive.js');
const { makeBrandRoot, readConfigSource } = require('./lib/config-fixture.js');

// Tests must never see real credentials from the shell environment
delete process.env.CLOUDFLARE_TOKEN;
delete process.env.NAMECHEAP_USERNAME;
delete process.env.NAMECHEAP_API_KEY;

const DOMAIN = 'fixture-brand.test';
// Cloudflare returns these unsorted — handlers must sort before comparing
const CF_NS = ['rita.ns.cloudflare.com', 'abe.ns.cloudflare.com'];
const CF_NS_SORTED = [...CF_NS].sort();
// The caller IP Namecheap refuses until it is whitelisted (TEST-NET-3)
const CLIENT_IP = '203.0.113.7';
const DOWN = '\x1B[B'; // arrow-down escape for select() answers

// ─── Fixtures ────────────────────────────────────────────────────────────────

function brandConfig({ url = `https://${DOMAIN}`, provider = 'namecheap' } = {}) {
  const config = {
    brand: { id: 'fixture-brand', name: 'Fixture Brand', url },
    domain: structuredClone(DEFAULTS.domain),
    targets: { web: { type: 'web' } },
  };
  config.domain.providers = provider ? { [provider]: {} } : {};
  return config;
}

/**
 * Fake CloudflareAPI — only the zone lookup the domain service uses. Pass an
 * ARRAY to answer a sequence of lookups (the last entry repeats), which is how
 * a zone that fills in its nameservers mid-wait is fixtured.
 */
function fakeCloudflare(zone) {
  const answers = Array.isArray(zone) ? zone : null;
  const api = {
    lookups: [],
    getZoneByName: async (name) => {
      api.lookups.push(name);
      const answer = answers ? answers[Math.min(api.lookups.length - 1, answers.length - 1)] : zone;
      return answer || null;
    },
  };
  return api;
}

/**
 * The rejection the client throws for a caller IP that is not on Namecheap's
 * API whitelist — shaped exactly as makeRequest builds it (code off the
 * <Error> element, plus the IP only the client knows).
 */
function whitelistRejection() {
  const error = new Error('Namecheap API error: API Key is invalid or API access has not been enabled');
  error.namecheapCode = '1011102';
  error.clientIp = CLIENT_IP;
  return error;
}

/**
 * Recording fake NamecheapAPI. Records every call; getDns can be made to
 * throw (domain not in the account), or to refuse the first `rejections`
 * reads with the IP-whitelist rejection (#698).
 */
function fakeNamecheap({ current = [], getDnsError = null, rejections = 0 } = {}) {
  const api = { calls: [] };
  let refused = 0;

  api.getDns = async (sld, tld) => {
    api.calls.push({ method: 'getDns', sld, tld });
    if (refused < rejections) {
      refused += 1;
      throw whitelistRejection();
    }
    if (getDnsError) {
      throw new Error(getDnsError);
    }
    return { usingCustom: current.length > 0, nameservers: current };
  };

  api.setCustomNameservers = async (sld, tld, nameservers) => {
    api.calls.push({ method: 'setCustomNameservers', sld, tld, nameservers });
  };

  api.mutations = () => api.calls.filter((c) => c.method === 'setCustomNameservers');
  return api;
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
  return stripVTControlCharacters(lines.join('\n'));
}

function runService(config, { cloudflare, namecheap, options = {}, brandRoot } = {}) {
  return service.run({
    brandId: 'fixture-brand',
    brandRoot: brandRoot || '/tmp/omega-manager-domain-unused', // the registrar ask writes config/omega.json5 when given a real root
    brandConfig: config,
    brand: { id: 'fixture-brand', config, enabledTargets: Object.keys(config.targets || {}), targets: [] },
    targets: [],
    operations: OPERATIONS.domain,
    options,
    serviceData: {},
    cloudflareApi: cloudflare,
    registrarApi: namecheap,
  });
}

// ─── The registrar ask ───────────────────────────────────────────────────────

const REGISTRAR_ASK_CONFIG = `{
  // Fixture Brand: the registrar pick lands here
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://${DOMAIN}' },
}
`;

/** Run fn with the registrar's credentials in the env, so the ask is the only gate. */
async function withRegistrarCredentials(fn) {
  process.env.CLOUDFLARE_TOKEN = 'fixture-cf-token';
  process.env.NAMECHEAP_USERNAME = 'fixture-user';
  process.env.NAMECHEAP_API_KEY = 'fixture-key';
  try {
    return await fn();
  } finally {
    delete process.env.CLOUDFLARE_TOKEN;
    delete process.env.NAMECHEAP_USERNAME;
    delete process.env.NAMECHEAP_API_KEY;
  }
}

module.exports = defineCases({
  type: 'group',
  description: 'domain',
  tests: [
    // ─── Setup / skip semantics ──────────────────────────────────────────────────

    {
      name: 'domain: headless with no registrar picked skips, printing the line that names domain.providers',
      run: async (ctx) => {
        let result;
        const printed = await captureLogAsync(async () => {
          result = await runService(brandConfig({ provider: null }));
        });

        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/domain\.providers/);
        ctx.expect(printed.includes('→ Set domain.providers in config/omega.json5, or run manage in a terminal to answer'), `headless line missing from: ${printed}`).toBeTruthy();
      },
    },

    {
      name: 'domain: no registrar picked, in a terminal, the owner picks namecheap: it lands and the service goes on with it',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'pending', name_servers: CF_NS };
        const namecheap = fakeNamecheap({ current: ['dns1.registrar-servers.com'] });
        const brandRoot = makeBrandRoot(REGISTRAR_ASK_CONFIG);
        const tty = openTtyPrompt();

        try {
          const result = await withRegistrarCredentials(async () => {
            const run = runService(brandConfig({ provider: null }), { cloudflare: fakeCloudflare(zone), namecheap, brandRoot });
            await tty.answer('Set up now?', '\r'); // Yes
            // The select lists the registry's registrars; typing jumps to the match
            await tty.answer('namecheap', 'namecheap\r');
            return run;
          });

          ctx.expect(JSON5.parse(readConfigSource(brandRoot)).domain.providers).toEqual({ namecheap: {} });
          ctx.expect(result.status, 'the walk went on with the registrar it just landed').toBe('success');
          ctx.expect(namecheap.mutations()[0].nameservers).toEqual(CF_NS_SORTED);
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'domain: Disable at the registrar ask lands domain.enabled: false and skips',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(REGISTRAR_ASK_CONFIG);
        const tty = openTtyPrompt();

        try {
          const run = runService(brandConfig({ provider: null }), { brandRoot });
          await tty.answer('Set up now?', `${DOWN}${DOWN}\r`); // Disable (stop prompting)
          const result = await run;

          ctx.expect(JSON5.parse(readConfigSource(brandRoot)).domain.enabled).toBe(false);
          ctx.expect(result.status).toBe('skipped');
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'domain: domain.enabled = false skips the service',
      run: async (ctx) => {
        const config = brandConfig();
        config.domain.enabled = false;

        const result = await runService(config);
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/domain\.enabled/);
      },
    },

    {
      name: 'domain: a default Pages brand.url is no domain, so setup skips with the one reason',
      run: async (ctx) => {
        const cloudflare = fakeCloudflare(null);
        const namecheap = fakeNamecheap();

        const result = await runService(brandConfig({ url: 'https://dreamr-design.github.io/dreamr-web' }), { cloudflare, namecheap });

        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toBe('brand.url is the hosting provider\'s default address (dreamr-design.github.io): no domain to manage');
        ctx.expect(cloudflare.lookups).toEqual([]);
        ctx.expect(namecheap.calls).toEqual([]);
      },
    },

    {
      name: 'domain: skips without CLOUDFLARE_TOKEN (zone nameservers are unreadable)',
      run: async (ctx) => {
        const result = await runService(brandConfig(), { namecheap: fakeNamecheap() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/CLOUDFLARE_TOKEN/);
      },
    },

    {
      name: 'domain: namecheap provider skips without NAMECHEAP credentials',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'active', name_servers: CF_NS };
        const result = await runService(brandConfig(), { cloudflare: fakeCloudflare(zone) });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/NAMECHEAP_USERNAME/);
      },
    },

    {
      name: 'domain: manual provider needs no Namecheap credentials',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'active', name_servers: CF_NS };
        const result = await runService(brandConfig({ provider: 'squarespace' }), {
          cloudflare: fakeCloudflare(zone),
        });
        ctx.expect(result.status).toBe('success');
      },
    },

    // ─── Namecheap reconciliation ────────────────────────────────────────────────

    {
      name: 'domain: converged nameservers are a zero-mutation no-op',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'active', name_servers: CF_NS };
        // Namecheap returns them in a different order — comparison must sort
        const namecheap = fakeNamecheap({ current: [...CF_NS].reverse() });

        const result = await runService(brandConfig(), {
          cloudflare: fakeCloudflare(zone),
          namecheap,
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.nameservers.alreadySet).toBe(true);
        ctx.expect(namecheap.mutations().length).toBe(0);
      },
    },

    {
      name: 'domain: subdomain project manages the PARENT domain\'s nameservers (cp113)',
      run: async (ctx) => {
        // playground.omegajs.dev-style brand: the zone AND the registrar entry are
        // the registrable parent — never the subdomain.
        const zone = { id: 'zone-1', name: DOMAIN, status: 'pending', name_servers: CF_NS };
        const cloudflare = fakeCloudflare(zone);
        const namecheap = fakeNamecheap({ current: ['dns1.registrar-servers.com'] });

        const result = await runService(brandConfig({ url: `https://app.${DOMAIN}` }), {
          cloudflare,
          namecheap,
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(cloudflare.lookups).toEqual([DOMAIN]); // parent zone queried, not app.DOMAIN
        const set = namecheap.mutations();
        ctx.expect(set.length).toBe(1);
        ctx.expect(`${set[0].sld}.${set[0].tld}`).toBe(DOMAIN); // registrar write hits the parent
        ctx.expect(set[0].nameservers).toEqual(CF_NS_SORTED);
      },
    },

    {
      name: 'domain: drifted nameservers are set at Namecheap (sorted)',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'pending', name_servers: CF_NS };
        const namecheap = fakeNamecheap({ current: ['dns1.registrar-servers.com', 'dns2.registrar-servers.com'] });

        const result = await runService(brandConfig(), {
          cloudflare: fakeCloudflare(zone),
          namecheap,
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.nameservers.updated).toBe(true);
        ctx.expect(result.output.nameservers.previous).toEqual(['dns1.registrar-servers.com', 'dns2.registrar-servers.com']);

        const set = namecheap.mutations();
        ctx.expect(set.length).toBe(1);
        ctx.expect(set[0]).toEqual({ method: 'setCustomNameservers', sld: 'fixture-brand', tld: 'test', nameservers: CF_NS_SORTED });
      },
    },

    {
      name: 'domain: multi-part TLDs split correctly via psl (omega-manager popped one label)',
      run: async (ctx) => {
        const zone = { id: 'zone-uk', name: 'mybrand.co.uk', status: 'pending', name_servers: CF_NS };
        const namecheap = fakeNamecheap({ current: [] });

        const result = await runService(brandConfig({ url: 'https://mybrand.co.uk' }), {
          cloudflare: fakeCloudflare(zone),
          namecheap,
        });

        ctx.expect(result.status).toBe('success');
        // Namecheap wants SLD "mybrand" + TLD "co.uk" — NOT "mybrand.co" + "uk"
        ctx.expect(namecheap.calls[0]).toEqual({ method: 'getDns', sld: 'mybrand', tld: 'co.uk' });
        ctx.expect(namecheap.mutations()[0].sld).toEqual('mybrand');
        ctx.expect(namecheap.mutations()[0].tld).toEqual('co.uk');
      },
    },

    {
      name: 'domain: domain not in the Namecheap account warns instead of failing',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'pending', name_servers: CF_NS };
        const namecheap = fakeNamecheap({ getDnsError: 'Domain not found in this account' });

        const result = await runService(brandConfig(), {
          cloudflare: fakeCloudflare(zone),
          namecheap,
        });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.nameservers.error).toMatch(/not found/);
        ctx.expect(namecheap.mutations().length).toBe(0);
      },
    },

    // ─── The IP-whitelist walkthrough (#698) ─────────────────────────────────────

    {
      name: 'domain: the client tags a whitelist rejection with its code and the caller IP (#698)',
      run: async (ctx) => {
        const realFetch = global.fetch;
        global.fetch = async (url) => (String(url).includes('ipify')
          ? { json: async () => ({ ip: CLIENT_IP }) }
          : { text: async () => '<?xml version="1.0" encoding="utf-8"?><ApiResponse Status="ERROR"><Errors><Error Number="1011102">API Key is invalid or API access has not been enabled</Error></Errors></ApiResponse>' });

        try {
          const api = new NamecheapAPI({ username: 'fixture-user', apiKey: 'fixture-key' });
          const error = await api.getDns('fixture-brand', 'test').then(() => null, (e) => e);

          ctx.expect(error, 'a Status="ERROR" response throws').toBeTruthy();
          ctx.expect(error.namecheapCode).toBe('1011102');
          ctx.expect(error.clientIp, 'the walkthrough gets the IP to whitelist off the error').toBe(CLIENT_IP);
          ctx.expect(isWhitelistError(error)).toBe(true);
          // Every other API failure stays on the plain warn path
          ctx.expect(isWhitelistError(new Error('Namecheap API error: Domain not found'))).toBe(false);
        } finally {
          global.fetch = realFetch;
        }
      },
    },

    {
      name: 'domain: a whitelist rejection opens the API access page with the IP and rechecks until it passes (#698)',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'pending', name_servers: CF_NS };
        // Refused twice: the first read AND the walkthrough's first recheck, so the
        // loop has to run a second recheck before it passes
        const namecheap = fakeNamecheap({ current: ['dns1.registrar-servers.com'], rejections: 2 });
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });
        const tty = openTtyPrompt();

        try {
          const run = runService(brandConfig(), { cloudflare: fakeCloudflare(zone), namecheap });

          await tty.waitFor(`Add ${CLIENT_IP} under "Whitelisted IPs"`);
          await tty.answer('Press Enter to open the Namecheap API access page', '\r');
          await tty.answer('(enter)=check now, (s)=skip', '\r');
          const result = await run;

          ctx.expect(result.status, 'the recheck passed, so the walk finished the registrar write').toBe('success');
          ctx.expect(opened, 'the apiaccess ROOT page, never a deep link').toEqual([API_ACCESS_URL]);
          ctx.expect(namecheap.calls.filter((c) => c.method === 'getDns').length >= 3, 'the refused read was rechecked in a loop').toBeTruthy();
          ctx.expect(namecheap.mutations()[0].nameservers).toEqual(CF_NS_SORTED);
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    {
      name: 'domain: a recheck that fails for a NEW reason reports THAT error, not the stale whitelist one (#698)',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'pending', name_servers: CF_NS };
        // The whitelist stops the first read; by the recheck the IP is on the list
        // and Namecheap answers with the real problem — the domain isn't in the account
        const namecheap = fakeNamecheap({ rejections: 1, getDnsError: 'Namecheap API error: Domain not found' });
        setBrowserOpener(async () => true);
        const tty = openTtyPrompt();
        let result;

        try {
          const printed = await captureLogAsync(async () => {
            const run = runService(brandConfig(), { cloudflare: fakeCloudflare(zone), namecheap });

            await tty.answer('Press Enter to open the Namecheap API access page', '\r');
            result = await run;
          });

          ctx.expect(printed, 'the recheck error is printed, never swallowed').toMatch(/Domain not found/);
          ctx.expect(printed, 'the non-whitelist hint is reachable on this branch').toMatch(/not purchased\?/);
          ctx.expect(result.status).toBe('warned');
          ctx.expect(result.output.nameservers.error).toMatch(/Domain not found/);
          ctx.expect(result.output.nameservers.error, 'the pre-walk whitelist message is stale here').not.toMatch(/API access has not been enabled/);
          ctx.expect(namecheap.mutations().length).toBe(0);
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    {
      name: 'domain: declining the whitelist walkthrough warns and continues (#698)',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'pending', name_servers: CF_NS };
        const namecheap = fakeNamecheap({ rejections: Infinity });
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });
        const tty = openTtyPrompt();

        try {
          const run = runService(brandConfig(), { cloudflare: fakeCloudflare(zone), namecheap });

          await tty.answer('Press Enter to open the Namecheap API access page', '\r');
          await tty.answer('(enter)=check now, (s)=skip', 's');
          const result = await run;

          ctx.expect(result.status).toBe('warned');
          ctx.expect(result.output.nameservers.error).toMatch(/API access has not been enabled/);
          ctx.expect(namecheap.mutations().length).toBe(0);
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    {
      name: 'domain: a whitelist rejection on a non-interactive run warns and continues, never prompting (#698)',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'pending', name_servers: CF_NS };
        const namecheap = fakeNamecheap({ rejections: Infinity });
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });

        try {
          const result = await runService(brandConfig(), { cloudflare: fakeCloudflare(zone), namecheap });

          ctx.expect(result.status).toBe('warned');
          ctx.expect(result.warned).toEqual([{ operation: 'nameservers', reason: 'could not read the nameservers at Namecheap' }]);
          ctx.expect(result.output.nameservers.error).toMatch(/API access has not been enabled/);
          ctx.expect(opened, 'no browser, no poll — today\'s warn-and-continue').toEqual([]);
          ctx.expect(namecheap.calls.length, 'the refused read is never retried without a TTY').toBe(1);
        } finally {
          setBrowserOpener(null);
        }
      },
    },

    {
      name: 'domain: an accepted API call never opens the whitelist walkthrough (#698)',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'active', name_servers: CF_NS };
        const namecheap = fakeNamecheap({ current: [...CF_NS] });
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });
        const tty = openTtyPrompt();

        try {
          const result = await runService(brandConfig(), { cloudflare: fakeCloudflare(zone), namecheap });

          ctx.expect(result.status).toBe('success');
          ctx.expect(opened).toEqual([]);
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    {
      name: 'domain: dry-run reports the planned update with zero mutations',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'pending', name_servers: CF_NS };
        const namecheap = fakeNamecheap({ current: ['dns1.registrar-servers.com'] });

        const result = await runService(brandConfig(), {
          cloudflare: fakeCloudflare(zone),
          namecheap,
          options: { dryRun: true },
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.nameservers.planned).toBe('update');
        ctx.expect(result.output.nameservers.required).toEqual(CF_NS_SORTED);
        ctx.expect(namecheap.mutations().length).toBe(0);
      },
    },

    // ─── Manual registrars ───────────────────────────────────────────────────────

    {
      name: 'domain: manual provider with an active zone is already converged',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'active', name_servers: CF_NS };

        const result = await runService(brandConfig({ provider: 'squarespace' }), {
          cloudflare: fakeCloudflare(zone),
        });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.nameservers.alreadySet).toBe(true);
      },
    },

    {
      name: 'domain: manual provider with a pending zone warns with the values to set',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'pending', name_servers: CF_NS };

        const result = await runService(brandConfig({ provider: 'squarespace' }), {
          cloudflare: fakeCloudflare(zone),
        });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.nameservers.manual).toBe(true);
        ctx.expect(result.output.nameservers.provider).toBe('squarespace');
        ctx.expect(result.output.nameservers.required).toEqual(CF_NS_SORTED);
      },
    },

    // ─── Zone edge cases ─────────────────────────────────────────────────────────

    {
      name: 'domain: no Cloudflare zone yet warns and touches nothing',
      run: async (ctx) => {
        const namecheap = fakeNamecheap();

        const result = await runService(brandConfig(), {
          cloudflare: fakeCloudflare(null),
          namecheap,
        });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.nameservers.note).toMatch(/no Cloudflare zone/);
        ctx.expect(namecheap.calls.length).toBe(0);
      },
    },

    // #662: the edge service creates the zone earlier in the SAME walk, so a bare
    // zone here is seconds-old — the registrar write waits for Cloudflare to
    // assign the nameservers instead of leaving it to a second run.
    {
      name: 'domain: a zone still assigning nameservers is waited out and set in the SAME walk (#662)',
      run: async (ctx) => {
        const bare = { id: 'zone-1', name: DOMAIN, status: 'initializing', name_servers: [] };
        const assigned = { id: 'zone-1', name: DOMAIN, status: 'pending', name_servers: CF_NS };
        const cloudflare = fakeCloudflare([bare, bare, assigned]);
        const namecheap = fakeNamecheap({ current: ['dns1.registrar-servers.com'] });

        const tty = openTtyPrompt();
        try {
          const run = runService(brandConfig(), { cloudflare, namecheap });

          await tty.answer('(enter)=check now, (s)=skip', '\r');
          const result = await run;

          ctx.expect(result.status, 'the walk finished the registrar write — no rerun owed').toBe('success');
          ctx.expect(cloudflare.lookups.length >= 3, 'the zone was re-read on a later tick').toBeTruthy();
          ctx.expect(namecheap.mutations()[0].nameservers).toEqual(CF_NS_SORTED);
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'domain: skipping the nameserver wait warns with the reason the summary prints (#662)',
      run: async (ctx) => {
        const bare = { id: 'zone-1', name: DOMAIN, status: 'initializing', name_servers: [] };
        const cloudflare = fakeCloudflare(bare);
        const namecheap = fakeNamecheap();

        const tty = openTtyPrompt();
        try {
          const run = runService(brandConfig(), { cloudflare, namecheap });

          await tty.answer('(enter)=check now, (s)=skip', 's');
          const result = await run;

          ctx.expect(result.status).toBe('warned');
          ctx.expect(result.warned).toEqual([{ operation: 'nameservers', reason: 'the zone has no assigned nameservers yet' }]);
          ctx.expect(namecheap.calls.length).toBe(0);
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'domain: zone without assigned nameservers warns and touches nothing',
      run: async (ctx) => {
        const zone = { id: 'zone-1', name: DOMAIN, status: 'initializing', name_servers: [] };
        const namecheap = fakeNamecheap();

        const result = await runService(brandConfig(), {
          cloudflare: fakeCloudflare(zone),
          namecheap,
        });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.nameservers.note).toMatch(/no assigned nameservers/);
        ctx.expect(namecheap.calls.length).toBe(0);
      },
    },
  ],
});
