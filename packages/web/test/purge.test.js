/**
 * cp140 — Cloudflare cache purge (the UJM cloudflare-purge successor,
 * de-ITW'd): direct API with the brand's own token, zone from config
 * `edge.providers.cloudflare.zone` or looked up by the brand URL's apex, clean skips
 * without a token, dry-run plans without purging. All over an injected
 * fetch recorder — no live Cloudflare in the suite.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const { purgeZoneCache, apexOf } = require('../src/purge.js');

/** Recording fetcher: scripted responses in call order. */
function recorder(responses) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return responses[calls.length - 1];
  };
  return { calls, fetcher };
}

module.exports = defineCases({
  type: 'group',
  description: 'purge',
  tests: [
    {
      name: 'apexOf: derives the zone apex from a site url',
      run: (ctx) => {
        ctx.expect(apexOf('https://playground.omegajs.dev')).toBe('omegajs.dev');
        ctx.expect(apexOf('https://www.somiibo.com/path')).toBe('somiibo.com');
        ctx.expect(apexOf('somiibo.com')).toBe('somiibo.com');
        ctx.expect(apexOf('localhost')).toBe(null);
        ctx.expect(apexOf('')).toBe(null);
      },
    },

    {
      name: 'purge: explicit edge.providers.cloudflare.zone purges directly — one POST, bearer token, purge_everything',
      run: async (ctx) => {
        const { calls, fetcher } = recorder([{ success: true }]);
        const result = await purgeZoneCache({
          config: { edge: { providers: { cloudflare: { zone: 'zone-123' } } }, brand: { url: 'https://x.dev' } },
          token: 'tok-1',
          fetcher,
        });

        ctx.expect(result).toEqual({ status: 'purged', zone: 'zone-123', zoneName: null });
        ctx.expect(calls.length, 'no lookup when the zone is configured').toBe(1);
        ctx.expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/zones/zone-123/purge_cache');
        ctx.expect(calls[0].options.headers.Authorization).toBe('Bearer tok-1');
        ctx.expect(calls[0].options.body).toEqual({ purge_everything: true });
      },
    },

    {
      name: 'purge: no configured zone → looked up by the brand apex, then purged',
      run: async (ctx) => {
        const { calls, fetcher } = recorder([
          { result: [{ id: 'zone-abc', name: 'omegajs.dev' }] },
          { success: true },
        ]);
        const result = await purgeZoneCache({
          config: { brand: { url: 'https://playground.omegajs.dev' } },
          token: 'tok-2',
          fetcher,
        });

        ctx.expect(result).toEqual({ status: 'purged', zone: 'zone-abc', zoneName: 'omegajs.dev' });
        ctx.expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/zones?name=omegajs.dev');
        ctx.expect(calls[1].url).toBe('https://api.cloudflare.com/client/v4/zones/zone-abc/purge_cache');
      },
    },

    {
      name: 'purge: skips cleanly — no token, invisible zone, underivable apex; zero writes',
      run: async (ctx) => {
        const none = await purgeZoneCache({ config: { brand: { url: 'https://x.dev' } }, token: '', fetcher: () => { throw new Error('must not fetch'); } });
        ctx.expect(none.status).toBe('skipped');
        ctx.expect(none.reason).toMatch(/CLOUDFLARE_TOKEN/);

        const { calls, fetcher } = recorder([{ result: [] }]);
        const invisible = await purgeZoneCache({ config: { brand: { url: 'https://ghost.example.com' } }, token: 't', fetcher });
        ctx.expect(invisible.status).toBe('skipped');
        ctx.expect(invisible.reason).toMatch(/no Cloudflare zone named example.com/);
        ctx.expect(calls.length, 'lookup only, never a purge').toBe(1);

        const noApex = await purgeZoneCache({ config: { brand: {} }, token: 't', fetcher: () => { throw new Error('must not fetch'); } });
        ctx.expect(noApex.status).toBe('skipped');
      },
    },

    {
      name: 'purge: a default Pages brand.url with no zone id skips with the one reason and sends no request',
      run: async (ctx) => {
        const { calls, fetcher } = recorder([]);
        const result = await purgeZoneCache({ config: { brand: { url: 'https://dreamr-design.github.io/dreamr-web' } }, token: 't', fetcher });

        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toBe('brand.url is the hosting provider\'s default address (dreamr-design.github.io): no domain to manage');
        ctx.expect(calls).toEqual([]);
      },
    },

    {
      name: 'purge: dry run resolves the zone and plans, sends no purge',
      run: async (ctx) => {
        const { calls, fetcher } = recorder([{ result: [{ id: 'zone-dry', name: 'omegajs.dev' }] }]);
        const result = await purgeZoneCache({
          config: { brand: { url: 'https://playground.omegajs.dev' } },
          token: 't',
          dryRun: true,
          fetcher,
        });

        ctx.expect(result).toEqual({ status: 'planned', zone: 'zone-dry', zoneName: 'omegajs.dev' });
        ctx.expect(calls.length, 'lookup only').toBe(1);
      },
    },

    {
      name: 'purge: a Cloudflare error surfaces with the API detail',
      run: async (ctx) => {
        const { fetcher } = recorder([{ success: false, errors: [{ code: 9109, message: 'Invalid access token' }] }]);
        await ctx.expect(purgeZoneCache({ config: { edge: { providers: { cloudflare: { zone: 'z' } } } }, token: 'bad', fetcher })).rejects.toThrow(/Invalid access token/);
      },
    },

    {
      name: 'purge: the DNS-scoped-token failure (code 10000) names the missing Cache Purge permission',
      run: async (ctx) => {
        const { fetcher } = recorder([{ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }]);
        await ctx.expect(purgeZoneCache({ config: { edge: { providers: { cloudflare: { zone: 'z' } } } }, token: 'dns-only', fetcher })).rejects.toThrow(/Cache Purge permission.*dash\.cloudflare\.com/);
      },
    },
  ],
});
