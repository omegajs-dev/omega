/**
 * Cloudflare cache purge — talks to the Cloudflare API directly with the
 * BRAND's own CLOUDFLARE_TOKEN from the .env cascade.
 *
 * Zone resolution: config `edge.providers.cloudflare.zone` wins;
 * otherwise the zone is looked up by the brand URL's apex domain. No token
 * → a clean skip (machine-readable), never a failure — purging is a
 * post-deploy nicety, not a gate.
 */
const fetch = require('wonderful-fetch');
const { defaultAddressReason } = require('@omega.js/config');

const API = 'https://api.cloudflare.com/client/v4';

/**
 * The apex domain of a site URL: playground.omegajs.dev → omegajs.dev.
 * Multi-label TLDs aren't handled (none of ours) — config `edge.providers.cloudflare.zone`
 * is the override for exotic zones.
 * @param {string} url
 * @returns {string|null}
 */
function apexOf(url) {
  const host = String(url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) {
    return null;
  }
  return labels.slice(-2).join('.');
}

/**
 * Purge the site's Cloudflare zone cache (purge_everything).
 *
 * @param {object} options
 * @param {object} options.config - resolved web config (edge.providers.cloudflare.zone, brand.url)
 * @param {string} [options.token] - Cloudflare API token (default: env CLOUDFLARE_TOKEN)
 * @param {boolean} [options.dryRun] - resolve + plan, send nothing
 * @param {function} [options.fetcher] - injection point for tests (default: wonderful-fetch)
 * @returns {Promise<{ status: 'purged'|'planned'|'skipped', reason?: string, zone?: string, zoneName?: string }>}
 */
async function purgeZoneCache(options) {
  const { config, dryRun = false, fetcher = fetch } = options;
  const token = options.token !== undefined ? options.token : process.env.CLOUDFLARE_TOKEN;

  if (!token) {
    return { status: 'skipped', reason: 'no CLOUDFLARE_TOKEN in the env cascade' };
  }

  const headers = { Authorization: `Bearer ${token}` };

  // Zone id: explicit config wins; otherwise look it up by apex domain
  let zone = config.edge && config.edge.providers && config.edge.providers.cloudflare && config.edge.providers.cloudflare.zone;
  let zoneName = null;
  if (!zone) {
    const pagesReason = defaultAddressReason(config.brand && config.brand.url);
    if (pagesReason) {
      return { status: 'skipped', reason: pagesReason };
    }
    const apex = apexOf(config.brand && config.brand.url);
    if (!apex) {
      return { status: 'skipped', reason: 'no edge.providers.cloudflare.zone in config and no brand.url to derive the zone from' };
    }
    const lookup = await fetcher(`${API}/zones?name=${apex}`, { method: 'get', response: 'json', headers });
    const match = lookup && lookup.result && lookup.result[0];
    if (!match) {
      return { status: 'skipped', reason: `no Cloudflare zone named ${apex} visible to this token` };
    }
    zone = match.id;
    zoneName = match.name;
  }

  if (dryRun) {
    return { status: 'planned', zone, zoneName };
  }

  const result = await fetcher(`${API}/zones/${zone}/purge_cache`, {
    method: 'post',
    response: 'json',
    headers,
    body: { purge_everything: true },
  });

  if (!result || result.success !== true) {
    const errors = (result && result.errors) || [];
    const detail = errors.length ? JSON.stringify(errors) : 'unknown error';
    // Code 10000 on purge_cache with a token that could READ the zone =
    // missing permission (DNS-scoped tokens hit this — the exact live
    // rehearsal failure): purging needs Zone → Cache Purge → Purge.
    const hint = errors.some((error) => error.code === 10000)
      ? ' — the token lacks the Cache Purge permission: edit it at https://dash.cloudflare.com/profile/api-tokens and add Zone → Cache Purge → Purge'
      : '';
    throw new Error(`Cloudflare purge failed: ${detail}${hint}`);
  }

  return { status: 'purged', zone, zoneName };
}

module.exports = { purgeZoneCache, apexOf };
