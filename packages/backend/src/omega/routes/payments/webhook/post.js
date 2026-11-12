import path from 'path';
import loadProvider from '../../../libraries/load-provider.js';
import powertools from 'node-powertools';
import safeCompare from '../../../helpers/safe-compare.js';
import env from '../../../libraries/env.js';

/**
 * POST /payments/webhook?provider=stripe&key=XXX
 * Receives payment provider webhooks, validates them, and saves to Firestore
 * The Firestore onWrite trigger handles async processing
 *
 * This handler is provider-agnostic. Each provider module defines:
 *   - parseWebhook(req) — extracts { eventId, eventType, category, resourceType, resourceId, chargeId, refundId, raw, uid }
 *   - isSupported(eventType) — returns true for events we should process
 */
export default async ({ ctx, omega }) => {
  const admin = omega.firebase.admin;
  const data = ctx.request.data;
  const query = ctx.request.query;

  // Get provider and key from query params
  const provider = query.provider;
  const key = query.key;

  // Validate provider
  if (!provider) {
    return ctx.respond('Missing provider parameter', { code: 400 });
  }

  // Validate key
  if (!safeCompare(key, env.get('OMEGA_WEBHOOK_KEY'))) {
    return ctx.respond('Invalid key', { code: 401 });
  }

  // Guard: test provider is not available in production
  // (mirrors the intent side's guard — the webhook providers receive only the raw
  // req, so the dispatch layer is where this side has a ctx to ask)
  if (provider === 'test' && ctx.isProduction()) {
    return ctx.respond('Test provider is not available in production', { code: 403 });
  }

  // Validate brand — quit if a brand is specified and doesn't match ours
  const brand = query.brand;
  const ourBrand = omega.config.brand?.id;
  if (brand && ourBrand && brand !== ourBrand) {
    ctx.log(`Ignoring webhook: explicit brand mismatch (received=${brand}, expected=${ourBrand})`);
    return ctx.respond({ received: true, ignored: true });
  }

  // Load the provider module
  let providerModule;
  try {
    providerModule = loadProvider(path.join(import.meta.dirname, 'providers'), provider);
  } catch (e) {
    return ctx.respond(`Unknown provider: ${provider}`, { code: 400 });
  }

  // Parse the webhook using the provider
  let parsed;
  try {
    parsed = providerModule.parseWebhook(ctx.req);
  } catch (e) {
    return ctx.respond(`Failed to parse webhook: ${e.message}`, { code: 400 });
  }

  const { eventId, eventType, category, resourceType, resourceId, chargeId, refundId, raw, uid } = parsed;

  ctx.log(`Parsed webhook: eventId=${eventId}, eventType=${eventType}, category=${category || 'null'}, resourceType=${resourceType || 'null'}, uid=${uid || 'null'}, api_version=${raw?.api_version || 'unknown'}`);

  // Let the provider decide if this event type is relevant
  if (providerModule.isSupported && !providerModule.isSupported(eventType)) {
    ctx.log(`Ignoring unsupported event type: ${eventType}`);
    return ctx.respond({ received: true, ignored: true });
  }

  // Skip events with no category (e.g., checkout.session.completed for subscription mode)
  if (!category) {
    ctx.log(`Ignoring event with no category: ${eventType}`);
    return ctx.respond({ received: true, ignored: true });
  }

  // Build timestamps
  const now = powertools.timestamp(new Date(), { output: 'string' });
  const nowUNIX = powertools.timestamp(now, { output: 'unix' });

  // Claim the event, then save — in ONE transaction. Providers retry, and a
  // retry can arrive while the first delivery is still in flight: a read
  // followed by a separate write leaves a window where both deliveries see no
  // doc and both write, so the pipeline runs the same event twice. The
  // transaction's read locks the document, so exactly one delivery claims it
  // and the other is told it is a duplicate ([#212]).
  const docRef = admin.firestore().doc(`payments-webhooks/${eventId}`);
  const claimed = await admin.firestore().runTransaction(async (transaction) => {
    const existingDoc = await transaction.get(docRef);

    if (existingDoc.exists) {
      const existingStatus = existingDoc.data()?.status;

      // A failed webhook is the one state that may be reclaimed — that IS the retry path
      if (existingStatus !== 'failed') {
        return { claimed: false, status: existingStatus };
      }
    }

    // Save with status=pending (trigger handles the rest)
    transaction.set(docRef, {
      id: eventId,
      provider: provider,
      status: 'pending',
      raw: raw,
      owner: uid,
      event: {
        type: eventType,
        category: category,
        resourceType: resourceType,
        resourceId: resourceId,
        // THIS charge's own id (Stripe/Chargebee invoice, PayPal sale), where a
        // subscription event names one. The resourceId is the subscription, which
        // never changes, so only this can key a single charge — and GA4
        // deduplicates `purchase` on the id it is sent
        // ([#656](https://github.com/Omega-JS-Stack/omega/issues/656))
        chargeId: chargeId || null,
        // The refund's own id, where the parser separates it from the resource the
        // refund reversed — the key the trigger looks its amounts up by
        // ([#510](https://github.com/Omega-JS-Stack/omega/issues/510))
        refundId: refundId || null,
      },
      error: null,
      metadata: {
        created: {
          timestamp: now,
          timestampUNIX: nowUNIX,
        },
        completed: {
          timestamp: null,
          timestampUNIX: null,
        },
      },
    });

    return { claimed: true, retried: existingDoc.exists };
  });

  if (!claimed.claimed) {
    ctx.log(`Duplicate webhook ${eventId}, existing status=${claimed.status}, skipping`);
    return ctx.respond({ received: true, duplicate: true });
  }

  if (claimed.retried) {
    ctx.log(`Retrying previously failed webhook ${eventId}`);
  }

  ctx.log(`Saved payments-webhooks/${eventId}: eventType=${eventType}, category=${category}, provider=${provider}, uid=${uid}`);

  // Return 200 immediately
  return ctx.respond({ received: true });
};
