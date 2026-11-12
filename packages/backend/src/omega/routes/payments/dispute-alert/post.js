import path from 'path';
import loadProvider from '../../../libraries/load-provider.js';
import powertools from 'node-powertools';
import safeCompare from '../../../helpers/safe-compare.js';
import env from '../../../libraries/env.js';

/**
 * POST /payments/dispute-alert?provider=chargeblast&key=XXX
 * Receives dispute alert webhooks (e.g., from Chargeblast), validates them,
 * and saves to Firestore for async processing via onWrite trigger
 *
 * Query params:
 *   - provider: alert provider name (default: 'chargeblast')
 *   - key: must match OMEGA_WEBHOOK_KEY
 *
 * This handler is provider-agnostic. Each provider module defines:
 *   - normalize(body) — extracts the standard dispute alert shape
 */
export default async ({ ctx, omega }) => {
  const admin = omega.firebase.admin;
  const body = ctx.request.body;
  const query = ctx.request.query;

  // Validate key
  const key = query.key;
  if (!safeCompare(key, env.get('OMEGA_WEBHOOK_KEY'))) {
    return ctx.respond('Invalid key', { code: 401 });
  }

  // Determine alert provider (default: chargeblast)
  const provider = query.provider || 'chargeblast';

  // Load the provider module
  let providerModule;
  try {
    providerModule = loadProvider(path.join(import.meta.dirname, 'providers'), provider);
  } catch (e) {
    return ctx.respond(`Unknown alert provider: ${provider}`, { code: 400 });
  }

  // Normalize the payload using the provider
  let alert;
  try {
    alert = providerModule.normalize(body);
  } catch (e) {
    return ctx.respond(`Failed to normalize alert: ${e.message}`, { code: 400 });
  }

  const alertId = alert.id;

  ctx.log(`Parsed dispute alert: id=${alertId}, alertProvider=${provider}, paymentProvider=${alert.provider}, amount=${alert.amount}, card=****${alert.card.last4}`);

  // Build timestamps
  const now = powertools.timestamp(new Date(), { output: 'string' });
  const nowUNIX = powertools.timestamp(now, { output: 'unix' });

  // Claim the alert, then save — in ONE transaction, for the same reason the
  // webhook route does: a read followed by a separate write leaves a window
  // where two same-instant deliveries both see no doc and both write, and a
  // dispute processed twice means two refunds ([#212]).
  const docRef = admin.firestore().doc(`payments-disputes/${alertId}`);
  const claimed = await admin.firestore().runTransaction(async (transaction) => {
    const existingDoc = await transaction.get(docRef);

    if (existingDoc.exists) {
      const existingStatus = existingDoc.data()?.status;

      // A failed alert is the one state that may be reclaimed — that IS the retry path
      if (existingStatus !== 'failed') {
        return { claimed: false, status: existingStatus };
      }
    }

    // Save with status=pending (trigger handles the rest)
    transaction.set(docRef, {
      id: alertId,
      provider: provider,
      status: 'pending',
      alert: alert,
      match: null,
      actions: {
        refund: 'pending',
        cancel: 'pending',
        email: 'pending',
      },
      errors: [],
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
      raw: body,
    });

    return { claimed: true, retried: existingDoc.exists };
  });

  if (!claimed.claimed) {
    ctx.log(`Duplicate dispute alert ${alertId}, existing status=${claimed.status}, skipping`);
    return ctx.respond({ received: true, duplicate: true });
  }

  if (claimed.retried) {
    ctx.log(`Retrying previously failed dispute alert ${alertId}`);
  }

  ctx.log(`Saved payments-disputes/${alertId}: alertProvider=${provider}, paymentProvider=${alert.provider}`);

  // Return 200 immediately — async processing via Firestore trigger
  return ctx.respond({ received: true });
};
