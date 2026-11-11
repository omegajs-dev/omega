/**
 * POST /marketing/webhook/forward?provider=sendgrid|beehiiv&key=<OMEGA_WEBHOOK_KEY>
 *
 * Parent-only forwarder. SendGrid and Beehiiv send webhooks to this single URL
 * on the parent @omega.js/backend. The parent reads its `brands` collection and re-POSTs the
 * raw body to every child's /marketing/webhook?provider=X. Each child then
 * processes the event against its own Firestore and providers.
 *
 * Gating:
 *   - Only enabled on the webhook ROOT: a brand that names no company, or names
 *     itself as one (`company: { id: 'self' }`, #677). A brand belonging to a
 *     company (the typical setup for child backends) returns 404.
 *   - Same OMEGA_WEBHOOK_KEY is shared across all brands, so the
 *     parent forwards the key it received (already validated) when calling
 *     each child.
 *
 * Self-inclusion:
 *   - The parent's own brand IS included in the fan-out. The parent @omega.js/backend has
 *     its own user base (e.g. itwcreativeworks.com users) and needs the same
 *     consent updates as any other brand. Self-fan-out goes via HTTP like
 *     every other child — no special inline path.
 *
 * Failure isolation:
 *   - Each child POST is awaited via Promise.allSettled so one slow/down child
 *     doesn't block the others. Failures are logged but the overall request
 *     still returns 200 so the provider doesn't retry the parent indefinitely.
 *     Children themselves track idempotency, so provider retries are safe.
 */
const fetch = require('wonderful-fetch');
const safeCompare = require('../../../../helpers/safe-compare.js');
const env = require('../../../../libraries/env.js');
const { apiAddress } = require('@omega.js/config/api-address');

const CHILD_TIMEOUT_MS = 10000;

module.exports = async ({ ctx, omega }) => {
  const admin = omega.firebase.admin;
  const query = ctx.request.query;

  // Gate: only the parent @omega.js/backend exposes this route. Any brand that
  // belongs to a company (the normal case) returns 404: pretend the route
  // doesn't exist.
  if (!omega.isParent()) {
    return ctx.respond('Not found', { code: 404 });
  }

  const provider = query.provider;
  const key = query.key;

  if (!provider) {
    return ctx.respond('Missing provider parameter', { code: 400 });
  }

  // Same key used for the receiver — parent validates incoming, then re-uses
  // it for outbound calls to children (all brands share this env value).
  if (!safeCompare(key, env.get('OMEGA_WEBHOOK_KEY'))) {
    return ctx.respond('Invalid key', { code: 401 });
  }

  // Read the brands collection. This lives in the PARENT's Firestore.
  const snapshot = await admin.firestore().collection('brands').get()
    .catch((e) => {
      ctx.error('marketing webhook forward: failed to read brands collection:', e);
      return null;
    });

  if (!snapshot) {
    return ctx.respond('Failed to load brands', { code: 500 });
  }

  // Collect brand URLs from the docs
  const brands = [];
  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    const brandUrl = data.brand?.url || null;
    const brandId = data.brand?.id || doc.id;

    if (!brandUrl) {
      ctx.log(`marketing webhook forward: brand ${brandId} has no brand.url, skipping`);
      return;
    }

    brands.push({ brandId, brandUrl });
  });

  if (brands.length === 0) {
    ctx.log('marketing webhook forward: no brands to forward to');
    return ctx.respond({ received: true, forwarded: 0 });
  }

  ctx.log(`marketing webhook forward: fanning out ${provider} event to ${brands.length} brand(s)`);

  // Forward the raw body to every child. ctx.req.body holds the body
  // as we received it from the provider. We re-POST it without modification.
  const rawBody = ctx.req?.body;

  const results = await Promise.allSettled(
    brands.map(({ brandId, brandUrl }) => forwardToChild({
      ctx,
      brandId,
      brandUrl,
      provider,
      key,
      body: rawBody,
    }))
  );

  let succeeded = 0;
  let failed = 0;
  const failures = [];
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    const brand = brands[i];
    if (r.status === 'fulfilled' && r.value?.ok) {
      succeeded += 1;
    } else {
      failed += 1;
      const reason = r.status === 'rejected' ? r.reason?.message : (r.value?.error || 'unknown');
      failures.push({ brandId: brand.brandId, reason });
      ctx.error(`marketing webhook forward: ${brand.brandId} failed:`, reason);
    }
  }

  ctx.log(`marketing webhook forward: ${provider} complete — succeeded=${succeeded}, failed=${failed}`);

  // Always return 200 — child failures shouldn't make the provider retry the
  // parent. Each child tracks its own idempotency so safe to re-fan on retry.
  return ctx.respond({
    received: true,
    forwarded: brands.length,
    succeeded,
    failed,
    failures: failures.length > 0 ? failures : undefined,
  });
};

/**
 * POST the raw body to one child @omega.js/backend's /marketing/webhook receiver.
 * Returns { ok: true } on success, { ok: false, error } on failure.
 */
async function forwardToChild({ ctx, brandId, brandUrl, provider, key, body }) {
  // The child receiver is `/omega/marketing/webhook` on the apiAddress of its
  // registry doc's brand.url ('https://somiibo.com' → 'https://api.somiibo.com').
  // A default Pages host needs a project id, which no registry doc carries.
  const base = apiAddress(brandUrl);
  if (!base) {
    return { ok: false, error: `brand URL "${brandUrl}" derives no API address (invalid, or a default Pages host with no project id)` };
  }

  const apiUrl = `${base}/omega/marketing/webhook?provider=${encodeURIComponent(provider)}&key=${encodeURIComponent(key)}`;

  try {
    const result = await fetch(apiUrl, {
      method: 'POST',
      response: 'json',
      timeout: CHILD_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    ctx.log(`marketing webhook forward: ${brandId} OK — ${JSON.stringify(result)}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
