/**
 * Beehiiv webhook provider: one event per POST, each carrying a `publication_id`.
 * The parent fans every event to each child, and only a brand whose configured
 * publication matches processes it; any other is a silent skip.
 *
 * Revoking events (anything else is ignored): 'subscription.unsubscribed',
 * 'subscription.deleted', and 'subscription.paused' (a pause reads as a revoke).
 *
 * No idempotency ledger: the revoke and the cross-provider remove are idempotent,
 * so a provider retry re-runs safely with the same end state.
 */

const REVOKE_EVENT_TYPES = new Set([
  'subscription.unsubscribed',
  'subscription.deleted',
  'subscription.paused',
]);

/**
 * Parse the raw webhook request into a normalized array (single-element).
 * Beehiiv sends one event per POST. Some HTTP clients serialize objects with
 * extra keys merged in (e.g. our test client merges query params into the body) —
 * we tolerate that by pulling fields explicitly.
 */
function parseWebhook(req) {
  const body = req.body;

  if (!body || typeof body !== 'object') {
    throw new Error('Empty or non-object webhook body');
  }

  // Beehiiv's event ID lives at `data.id` (per their docs) but their actual
  // delivery shape can vary across endpoints. Try common locations.
  const eventId = body.id
    || body.event_id
    || body.data?.id
    || null;

  const eventType = body.event || body.type || null;

  // Email may be at top-level or nested under `data`
  const rawEmail = body.email || body.data?.email || null;
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : null;

  // Publication ID — required to decide whether THIS brand should handle it
  const publicationId = body.publication_id || body.data?.publication_id || null;

  // Timestamp — Beehiiv uses ISO 8601. Fall back to data.created_at variants.
  const timestampISO = body.created_at
    || body.timestamp
    || body.data?.created_at
    || null;

  const timestampUNIX = timestampISO
    ? Math.floor(new Date(timestampISO).getTime() / 1000) || null
    : null;

  return [{
    eventId,
    eventType,
    email,
    timestamp: timestampUNIX,
    publicationId,
    raw: body,
  }];
}

/**
 * Returns true if this event type represents a revocation we should act on.
 */
function isSupported(parsed) {
  return REVOKE_EVENT_TYPES.has(parsed.eventType);
}

/**
 * Process a single parsed event. Called by the dispatcher for each supported event.
 * Returns a result object summarizing what happened.
 */
async function handleEvent({ omega, ctx, parsed }) {
  const admin = omega.firebase.admin;
  const { eventId, eventType, email, timestamp, publicationId } = parsed;

  if (!email) {
    ctx.log(`beehiiv webhook: event ${eventId} (${eventType}) missing email, skipping`);
    return { handled: false, reason: 'missing-email' };
  }

  // Publication filter: silent skip when the event isn't for our publication, which
  // routes a shared publication's events to only the brands that share it. The
  // publication id is config's, read by the provider's getPublicationId(), an
  // operation its row pins.
  if (publicationId) {
    const ourPublicationId = require('../../../../libraries/email/providers/beehiiv.js').getPublicationId();

    if (!ourPublicationId) {
      ctx.log(`beehiiv webhook: no publication configured for this brand, skipping event ${eventId}`);
      return { handled: false, reason: 'no-local-publication' };
    }

    if (ourPublicationId !== publicationId) {
      ctx.log(`beehiiv webhook: publication mismatch (event=${publicationId}, ours=${ourPublicationId}), skipping`);
      return { handled: false, reason: 'publication-mismatch' };
    }
  }

  // Build the canonical revokedAt timestamp from the event (or server time if missing)
  const startTime = ctx.meta.startTime;
  const eventUNIX = typeof timestamp === 'number' ? timestamp : startTime.timestampUNIX;
  const eventISO = new Date(eventUNIX * 1000).toISOString();

  // Look up the user by email
  const snapshot = await admin.firestore().collection('users')
    .where('auth.email', '==', email)
    .limit(1)
    .get()
    .catch((e) => {
      ctx.error(`beehiiv webhook: user lookup failed for ${email}:`, e);
      return null;
    });

  if (!snapshot || snapshot.empty) {
    // Silent skip — this email may not map to a customer of THIS brand even if
    // the publication matched (legitimate for shared-devbeans where 6 brands
    // process every event but only one has the user).
    ctx.log(`beehiiv webhook: no user found for ${email}, skipping doc update`);
    return { handled: false, reason: 'user-not-found', email };
  }

  const userDoc = snapshot.docs[0];
  const uid = userDoc.id;

  // Write consent.marketing.status = 'revoked' (preserve grantedAt — informational audit trail)
  await admin.firestore().doc(`users/${uid}`).set({
    consent: {
      marketing: {
        status: 'revoked',
        revokedAt: {
          timestamp: eventISO,
          timestampUNIX: eventUNIX,
          source: 'beehiiv',
          ip: null,
          text: null,
        },
      },
    },
    metadata: ctx.metadata({ tag: 'marketing/webhook:beehiiv' }),
  }, { merge: true });

  ctx.log(`beehiiv webhook: revoked consent.marketing for ${uid} (${email}) — eventType=${eventType}`);

  // Cross-provider sync: also remove from SendGrid (best-effort, idempotent on 404)
  const shouldCallExternalAPIs = !ctx.isTesting() || process.env.TEST_EXTENDED_MODE;

  if (shouldCallExternalAPIs) {
    try {
      const mailer = ctx.email;
      await mailer.remove(email);
      ctx.log(`beehiiv webhook: cross-provider sync complete for ${email}`);
    } catch (e) {
      // Best-effort — user doc is already updated. Log + continue.
      ctx.error(`beehiiv webhook: cross-provider sync failed for ${email}:`, e);
    }
  } else {
    ctx.log('beehiiv webhook: skipping cross-provider sync (OMEGA_ENVIRONMENT=testing)');
  }

  return { handled: true, uid, email, eventType };
}

module.exports = {
  parseWebhook,
  isSupported,
  handleEvent,
};
