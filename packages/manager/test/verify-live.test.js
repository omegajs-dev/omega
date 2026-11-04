/**
 * Live-verification tests — every check runs against INJECTED transports
 * (a fake fetch, a fake DNS resolver); no test ever touches the network.
 * The gating path proves a demo-only brand never even calls a transport.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

const { resolveVerifySurface, checkSite, checkDomain, checkCloudflare, runVerifyLegs, VERIFY_LEGS } = require('../src/lib/verify-live.js');

const HTML = `<!doctype html><html><head><title>OMEGA Playground</title></head><body>${'x'.repeat(600)}</body></html>`;

/** Fake fetch returning one canned response; records the URLs it saw. */
function fakeFetch({ status = 200, headers = { 'content-type': 'text/html; charset=utf-8' }, body = HTML, throws = null } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (throws) throw new Error(throws);
    return {
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: async () => body,
    };
  };
  impl.calls = calls;
  return impl;
}

/** Fake DNS resolver: resolves for every host except those in `fails`. */
function fakeResolve(fails = []) {
  const calls = [];
  const impl = async (host) => {
    calls.push(host);
    if (fails.includes(host)) throw new Error(`queryA ENOTFOUND ${host}`);
    return ['203.0.113.7'];
  };
  impl.calls = calls;
  return impl;
}

const LIVE_BRAND = { brand: { url: 'https://playground.omegajs.dev' }, cloud: { config: { projectId: 'omegajs-playground' } } };
const DEMO_BRAND = { brand: { url: 'https://sandbox-brand.example.com' }, cloud: { config: { projectId: 'demo-sandbox-brand' } } };

module.exports = defineCases({
  type: 'group',
  description: 'verify-live',
  tests: [
    {
      name: 'verify: surface resolves the canonical URL and the apex + www hostnames',
      run: (ctx) => {
        const surface = resolveVerifySurface({ brand: { url: 'https://omegajs.dev' }, cloud: { config: { projectId: 'omegajs' } } });
        ctx.expect(surface.gated).toBe(null);
        ctx.expect(surface.url).toBe('https://omegajs.dev');
        ctx.expect(surface.hostnames).toEqual(['omegajs.dev', 'www.omegajs.dev']);
      },
    },

    {
      name: 'verify: a subdomain brand verifies only its own host (www belongs to the apex brand)',
      run: (ctx) => {
        const surface = resolveVerifySurface(LIVE_BRAND);
        ctx.expect(surface.hostnames).toEqual(['playground.omegajs.dev']);
      },
    },

    {
      name: 'verify: a demo-* brand is gated with a reason; a brand without brand.url too',
      run: (ctx) => {
        ctx.expect(resolveVerifySurface(DEMO_BRAND).gated).toMatch(/demo-sandbox-brand.*emulator-only/);
        ctx.expect(resolveVerifySurface({ cloud: { config: { projectId: 'omegajs' } } }).gated).toMatch(/no brand\.url configured/);
      },
    },

    {
      name: 'verify: a brand with a URL but NO cloud project is gated, not checked live',
      run: (ctx) => {
        const surface = resolveVerifySurface({ brand: { url: 'https://omegajs.dev' } });
        ctx.expect(surface.gated).toMatch(/no cloud project configured/);
      },
    },

    {
      name: 'verify: a default Pages brand.url is gated with the one reason, naming no hostname to check',
      run: (ctx) => {
        const surface = resolveVerifySurface({ brand: { url: 'https://dreamr-design.github.io/dreamr-web' }, cloud: { config: { projectId: 'dreamr' } } });
        ctx.expect(surface.gated).toBe('brand.url is the hosting provider\'s default address (dreamr-design.github.io): no domain to manage');
        ctx.expect(surface.hostnames).toEqual([]);
      },
    },

    {
      name: 'verify site: 200 + text/html + a non-trivial body passes',
      run: async (ctx) => {
        const fetchImpl = fakeFetch();
        const result = await checkSite(resolveVerifySurface(LIVE_BRAND), { fetch: fetchImpl });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.error).toBe(null);
        ctx.expect(fetchImpl.calls).toEqual(['https://playground.omegajs.dev']);
      },
    },

    {
      name: 'verify site: a non-200 fails, naming the status',
      run: async (ctx) => {
        const result = await checkSite(resolveVerifySurface(LIVE_BRAND), { fetch: fakeFetch({ status: 404 }) });
        ctx.expect(result.status).toBe('error');
        ctx.expect(result.error).toMatch(/404/);
      },
    },

    {
      name: 'verify site: the wrong content-type fails, naming what came back',
      run: async (ctx) => {
        const result = await checkSite(resolveVerifySurface(LIVE_BRAND), { fetch: fakeFetch({ headers: { 'content-type': 'application/json' } }) });
        ctx.expect(result.status).toBe('error');
        ctx.expect(result.error).toMatch(/application\/json/);
      },
    },

    {
      name: 'verify site: a trivial body fails (a 200 empty shell is not a live site)',
      run: async (ctx) => {
        const result = await checkSite(resolveVerifySurface(LIVE_BRAND), { fetch: fakeFetch({ body: '<html></html>' }) });
        ctx.expect(result.status).toBe('error');
        ctx.expect(result.error).toMatch(/body/);
      },
    },

    {
      name: 'verify site: a transport throw fails the check, carrying the message',
      run: async (ctx) => {
        const result = await checkSite(resolveVerifySurface(LIVE_BRAND), { fetch: fakeFetch({ throws: 'ECONNREFUSED' }) });
        ctx.expect(result.status).toBe('error');
        ctx.expect(result.error).toMatch(/ECONNREFUSED/);
      },
    },

    {
      name: 'verify domain: every hostname resolving passes; a failure names the host',
      run: async (ctx) => {
        const surface = resolveVerifySurface({ brand: { url: 'https://omegajs.dev' }, cloud: { config: { projectId: 'omegajs' } } });

        const resolve = fakeResolve();
        const ok = await checkDomain(surface, { resolve });
        ctx.expect(ok.status).toBe('success');
        ctx.expect(resolve.calls).toEqual(['omegajs.dev', 'www.omegajs.dev']);

        const bad = await checkDomain(surface, { resolve: fakeResolve(['www.omegajs.dev']) });
        ctx.expect(bad.status).toBe('error');
        ctx.expect(bad.error).toMatch(/www\.omegajs\.dev/);
      },
    },

    {
      name: 'verify cloudflare: cf-ray or server: cloudflare passes, neither fails',
      run: async (ctx) => {
        const surface = resolveVerifySurface(LIVE_BRAND);

        const ray = await checkCloudflare(surface, { fetch: fakeFetch({ headers: { 'content-type': 'text/html', 'cf-ray': '8f3a1b2c3d4e5f60-IAD' } }) });
        ctx.expect(ray.status).toBe('success');

        const server = await checkCloudflare(surface, { fetch: fakeFetch({ headers: { 'content-type': 'text/html', server: 'cloudflare' } }) });
        ctx.expect(server.status).toBe('success');

        const bare = await checkCloudflare(surface, { fetch: fakeFetch({ headers: { 'content-type': 'text/html', server: 'GitHub.com' } }) });
        ctx.expect(bare.status).toBe('error');
        ctx.expect(bare.error).toMatch(/cloudflare/i);
      },
    },

    {
      name: 'verify legs: a deployed web target runs site + domain + cloudflare as verify:<name> rows',
      run: async (ctx) => {
        const fetchImpl = fakeFetch({ headers: { 'content-type': 'text/html', 'cf-ray': '8f3a-IAD' } });
        const rows = await runVerifyLegs(['web'], LIVE_BRAND, { fetch: fetchImpl, resolve: fakeResolve() });

        ctx.expect(rows.map((row) => row.service)).toEqual(['verify:site', 'verify:domain', 'verify:cloudflare']);
        ctx.expect(rows.every((row) => row.status === 'success')).toBeTruthy();
      },
    },

    {
      name: 'verify legs: a target with no live surface contributes no rows',
      run: async (ctx) => {
        ctx.expect(Object.keys(VERIFY_LEGS)).toEqual(['web']);
        const rows = await runVerifyLegs(['backend'], LIVE_BRAND, { fetch: fakeFetch(), resolve: fakeResolve() });
        ctx.expect(rows).toEqual([]);
      },
    },

    {
      name: 'verify legs: a demo-only brand records gated skips and touches NO transport',
      run: async (ctx) => {
        const fetchImpl = fakeFetch();
        const resolve = fakeResolve();
        const rows = await runVerifyLegs(['web'], DEMO_BRAND, { fetch: fetchImpl, resolve });

        ctx.expect(rows.map((row) => row.service)).toEqual(['verify:site', 'verify:domain', 'verify:cloudflare']);
        ctx.expect(rows.every((row) => row.status === 'skipped')).toBeTruthy();
        ctx.expect(rows[0].reason).toMatch(/demo-sandbox-brand.*emulator-only/);
        ctx.expect(fetchImpl.calls, 'no network for a demo brand').toEqual([]);
        ctx.expect(resolve.calls, 'no DNS for a demo brand').toEqual([]);
      },
    },

    {
      name: 'verify legs: a brand with no cloud project records gated skips, never a live check',
      run: async (ctx) => {
        const fetchImpl = fakeFetch();
        const rows = await runVerifyLegs(['web'], { brand: { url: 'https://omegajs.dev' } }, { fetch: fetchImpl, resolve: fakeResolve() });

        ctx.expect(rows.every((row) => row.status === 'skipped')).toBeTruthy();
        ctx.expect(rows[0].reason).toMatch(/no cloud project configured/);
        ctx.expect(fetchImpl.calls).toEqual([]);
      },
    },

    {
      name: 'verify legs: a dry run plans the sweep — skip rows, zero transport calls',
      run: async (ctx) => {
        const exploding = () => { throw new Error('a dry run must never touch the network'); };
        const rows = await runVerifyLegs(['web'], LIVE_BRAND, { fetch: exploding, resolve: exploding }, { dryRun: true });

        ctx.expect(rows.map((row) => row.service)).toEqual(['verify:site', 'verify:domain', 'verify:cloudflare']);
        ctx.expect(rows.every((row) => row.status === 'skipped')).toBeTruthy();
        ctx.expect(rows[0].reason).toMatch(/dry-run/);
      },
    },

    {
      name: 'verify legs: a failed check comes back as an error row (the pipeline fails it like a deploy leg)',
      run: async (ctx) => {
        const rows = await runVerifyLegs(['web'], LIVE_BRAND, { fetch: fakeFetch({ status: 503 }), resolve: fakeResolve() });
        const site = rows.find((row) => row.service === 'verify:site');

        ctx.expect(site.status).toBe('error');
        ctx.expect(site.error).toMatch(/503/);
      },
    },
  ],
});
