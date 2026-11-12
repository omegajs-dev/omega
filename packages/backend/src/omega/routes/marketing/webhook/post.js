/**
 * POST /marketing/webhook?provider=sendgrid|beehiiv&key=<OMEGA_WEBHOOK_KEY>
 *
 * Receives cross-provider unsubscribe webhooks (SendGrid + Beehiiv) and:
 *   1. Authenticates via ?key= query param (OMEGA_WEBHOOK_KEY env)
 *   2. Optionally rejects mismatched brand via ?brand= filter
 *   3. Loads the matching provider module from ./providers/{provider}.js
 *   4. Parses the webhook payload into one or more normalized events
 *   5. For each supported event: dispatch to the provider's handler
 *   6. Returns 200 immediately so the provider doesn't retry
 *
 * Each provider module defines:
 *   - parseWebhook(req)   — returns Array<{ eventId, eventType, email, timestamp, raw, ... }>
 *   - isSupported(parsed) — returns true if this parsed event should be processed
 *   - handleEvent(ctx)    — does the work for one event (user doc + cross-provider sync)
 *
 * No idempotency ledger: every supported handler (revoke consent + cross-provider
 * remove) is naturally idempotent — re-processing a provider retry produces the same
 * end state with no extra side effects, so duplicate suppression buys nothing.
 */
import path from 'path';
import loadProvider from '../../../libraries/load-provider.js';
import safeCompare from '../../../helpers/safe-compare.js';
import env from '../../../libraries/env.js';

export default async ({ ctx, omega }) => {
  const query = ctx.request.query;

  const provider = query.provider;
  const key = query.key;

  // Validate provider
  if (!provider) {
    return ctx.respond('Missing provider parameter', { code: 400 });
  }

  // Validate key against OMEGA_WEBHOOK_KEY (separate from OMEGA_ADMIN_KEY
  // so it can be rotated independently and scoped narrowly)
  if (!safeCompare(key, env.get('OMEGA_WEBHOOK_KEY'))) {
    return ctx.respond('Invalid key', { code: 401 });
  }

  // Brand filter (defensive — mirror payments webhook pattern). If a brand is
  // specified and doesn't match ours, silently ignore. This lets one webhook
  // URL be shared across brands while each brand only processes its own events.
  const brand = query.brand;
  const ourBrand = omega.config.brand?.id;
  if (brand && ourBrand && brand !== ourBrand) {
    ctx.log(`marketing webhook: brand mismatch (received=${brand}, expected=${ourBrand}), ignoring`);
    return ctx.respond({ received: true, ignored: true });
  }

  // Load the provider module
  let providerModule;
  try {
    providerModule = loadProvider(path.join(import.meta.dirname, 'providers'), provider);
  } catch (e) {
    ctx.error(`marketing webhook: failed to load provider "${provider}":`, e);
    return ctx.respond(`Unknown provider: ${provider}`, { code: 400 });
  }

  // Parse the webhook body into events
  let events;
  try {
    events = providerModule.parseWebhook(ctx.req);
  } catch (e) {
    ctx.error(`marketing webhook: parse failed for ${provider}:`, e);
    return ctx.respond(`Failed to parse webhook: ${e.message}`, { code: 400 });
  }

  if (!Array.isArray(events) || events.length === 0) {
    ctx.log(`marketing webhook: ${provider} returned no events`);
    return ctx.respond({ received: true, processed: 0 });
  }

  ctx.log(`marketing webhook: ${provider} delivered ${events.length} event(s)`);

  // Process each event independently — one failure shouldn't block the others.
  // Use Promise.allSettled so we return success only after all events have been
  // attempted.
  const results = await Promise.allSettled(
    events.map((event) => processOneEvent({ omega, ctx, provider, event, providerModule }))
  );

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value?.processed) processed++;
      else skipped++;
    } else {
      failed++;
      ctx.error('marketing webhook: event processing rejected:', r.reason);
    }
  }

  ctx.log(`marketing webhook: ${provider} complete — processed=${processed}, skipped=${skipped}, failed=${failed}`);

  return ctx.respond({ received: true, processed, skipped, failed });
};

/**
 * Process a single event: support check, then dispatch to the provider's handler.
 * Handlers are idempotent, so provider retries re-run safely with no dedup ledger.
 * Returns { processed: bool, skipped?: string, error?: any }.
 */
async function processOneEvent({ omega, ctx, provider, event, providerModule }) {
  const { eventType } = event;

  // Filter by supported event types
  if (providerModule.isSupported && !providerModule.isSupported(event)) {
    return { processed: false, skipped: 'unsupported-event-type' };
  }

  try {
    await providerModule.handleEvent({ omega, ctx, parsed: event });
    return { processed: true };
  } catch (e) {
    ctx.error(`marketing webhook: handler failed for ${provider} event ${event.eventId} (${eventType}):`, e);
    return { processed: false, error: e };
  }
}
