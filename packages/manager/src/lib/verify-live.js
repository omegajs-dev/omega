/**
 * Live-launch verification — the last mile of the one-command launch
 * (`omega pipeline --deploy=web`): after the deploy legs push, these checks
 * confirm the launch surface is actually LIVE from the outside.
 *
 *  - site:       HTTPS GET on the brand's canonical URL → 200 + text/html +
 *                a non-trivial body (a 200 empty shell is not a live site).
 *  - domain:     the apex (and www, when the brand owns the apex) resolve.
 *  - cloudflare: the response arrives THROUGH Cloudflare (cf-ray, or
 *                server: cloudflare).
 *
 * Both transports are seams: `{ fetch, resolve }` default to the real
 * globals and tests pass fakes, so no test ever touches the network.
 *
 * Gating mirrors the cloud service: a demo-* (emulator-only) brand has no
 * live surface to check, so every leg records a gated skip with its reason
 * and NO transport is called.
 */
const dns = require('node:dns').promises;

const { isDemoProject, defaultAddressReason } = require('@omega.js/config');
const { getApexDomain } = require('./domain-utils.js');

// deploy target → the checks that prove THAT target's surface is live. Only
// the web target has an outside-observable launch surface; backend/desktop/
// extension prove themselves through their own deploy legs.
const VERIFY_LEGS = { web: ['site', 'domain', 'cloudflare'] };

// A live page is bigger than this; a 200 carrying less is an empty shell
// (a hosting placeholder, a stub 404 page served with the wrong status).
const MIN_BODY_BYTES = 500;

// Live checks talk to the internet — never let one hang the pipeline.
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Resolve what a brand's live surface IS, and whether it may be checked.
 *
 * @param {object} brandConfig - Merged brand config (omega.json5).
 * @returns {{ url: string|null, hostnames: string[], gated: string|null }} - `gated` is the skip reason when live checks must not run.
 */
function resolveVerifySurface(brandConfig) {
  const projectId = brandConfig?.cloud?.config?.projectId;
  if (!projectId) {
    return { url: null, hostnames: [], gated: 'no cloud project configured — no live surface to verify' };
  }
  if (isDemoProject(projectId)) {
    return { url: null, hostnames: [], gated: `${projectId} is a demo-* (emulator-only) project — no live surface to verify` };
  }

  const url = (brandConfig?.brand?.url || '').replace(/\/$/, '');
  if (!url) {
    return { url: null, hostnames: [], gated: 'no brand.url configured' };
  }

  const pagesReason = defaultAddressReason(url);
  if (pagesReason) return { url: null, hostnames: [], gated: pagesReason };

  const hostname = new URL(url).hostname;
  // www is a platform DNS record on the apex only — a subdomain brand's www
  // belongs to the parent brand, so it is not this brand's to verify.
  const hostnames = getApexDomain(hostname) === hostname ? [hostname, `www.${hostname}`] : [hostname];

  return { url, hostnames, gated: null };
}

/** Real-fetch wrapper carrying the timeout; fakes ignore the options. */
function request(surface, transports) {
  const fetchImpl = transports.fetch || globalThis.fetch;
  return fetchImpl(surface.url, { redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/**
 * The canonical URL serves a real page.
 *
 * @param {object} surface - From resolveVerifySurface().
 * @param {object} transports - { fetch }.
 * @returns {Promise<{ status: string, error: string|null }>}
 */
async function checkSite(surface, transports) {
  let response;
  try {
    response = await request(surface, transports);
  } catch (error) {
    return { status: 'error', error: `${surface.url} unreachable — ${error.message}` };
  }

  if (response.status !== 200) {
    return { status: 'error', error: `${surface.url} returned ${response.status} (expected 200)` };
  }

  const contentType = response.headers.get('content-type') || '(none)';
  if (!contentType.includes('text/html')) {
    return { status: 'error', error: `${surface.url} served content-type ${contentType} (expected text/html)` };
  }

  const body = await response.text();
  if (body.length < MIN_BODY_BYTES) {
    return { status: 'error', error: `${surface.url} served a ${body.length}-byte body (expected ≥ ${MIN_BODY_BYTES} — a 200 empty shell is not a live site)` };
  }

  return { status: 'success', error: null };
}

/**
 * Every hostname the brand owns resolves in DNS.
 *
 * @param {object} surface - From resolveVerifySurface().
 * @param {object} transports - { resolve }.
 * @returns {Promise<{ status: string, error: string|null }>}
 */
async function checkDomain(surface, transports) {
  const resolve = transports.resolve || dns.resolve4;

  for (const hostname of surface.hostnames) {
    try {
      await resolve(hostname);
    } catch (error) {
      return { status: 'error', error: `${hostname} does not resolve — ${error.message}` };
    }
  }

  return { status: 'success', error: null };
}

/**
 * The response arrives through Cloudflare (proxied, not origin-direct).
 *
 * @param {object} surface - From resolveVerifySurface().
 * @param {object} transports - { fetch }.
 * @returns {Promise<{ status: string, error: string|null }>}
 */
async function checkCloudflare(surface, transports) {
  let response;
  try {
    response = await request(surface, transports);
  } catch (error) {
    return { status: 'error', error: `${surface.url} unreachable — ${error.message}` };
  }

  const ray = response.headers.get('cf-ray');
  const server = response.headers.get('server') || '(none)';
  if (!ray && !/cloudflare/i.test(server)) {
    return { status: 'error', error: `${surface.url} did not arrive through Cloudflare (no cf-ray, server: ${server})` };
  }

  return { status: 'success', error: null };
}

const CHECKS = { site: checkSite, domain: checkDomain, cloudflare: checkCloudflare };

/**
 * Run the verify sweep for a set of deploy targets.
 *
 * @param {string[]} targets - Deploy targets to verify (web, backend, …).
 * @param {object} brandConfig - Merged brand config.
 * @param {object} [transports] - { fetch, resolve } seams; real globals by default.
 * @param {object} [options] - { dryRun }: a plan-only pass records the legs it WOULD run and touches nothing.
 * @returns {Promise<Array<object>>} - Run-record rows (`verify:<name>`), judged exactly like deploy legs.
 */
async function runVerifyLegs(targets, brandConfig, transports = {}, options = {}) {
  const names = [];
  for (const target of targets) {
    for (const name of VERIFY_LEGS[target] || []) {
      if (!names.includes(name)) names.push(name);
    }
  }

  if (names.length === 0) {
    return [];
  }

  const surface = resolveVerifySurface(brandConfig);

  // A dry run is plan-only everywhere else in the manager — the live sweep is
  // no exception: it reports the legs it would run and sends no traffic.
  const gated = options.dryRun ? 'dry-run — the live sweep is plan-only here' : surface.gated;
  if (gated) {
    return names.map((name) => ({ service: `verify:${name}`, status: 'skipped', output: null, error: null, reason: gated }));
  }

  const rows = [];
  for (const name of names) {
    const result = await CHECKS[name](surface, transports);
    rows.push({ service: `verify:${name}`, status: result.status, output: null, error: result.error });
  }

  return rows;
}

module.exports = { VERIFY_LEGS, resolveVerifySurface, checkSite, checkDomain, checkCloudflare, runVerifyLegs };
