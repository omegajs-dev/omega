/**
 * Shared harness for the PLAIN-NODE webhook-pipeline suites (no emulator, no
 * network): the real payments-webhooks trigger run against a minimal in-memory
 * Firestore stand-in.
 *
 * The stand-in is the honest layer for these cases. The emulator cannot produce
 * a mid-batch write fault at all (the admin SDK bypasses rules, every write is
 * legal), and it cannot hand one test a user doc seeded into an exact prior
 * state without minting a persona and a payment history per permutation. The
 * emulator suites stay the integration surface for the happy paths.
 *
 * `_`-prefixed, so the runner never discovers it as a suite.
 */
const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const onWrite = loadHandler(require.resolve('../../../dist/omega/events/firestore/payments-webhooks/on-write.js'));

// A contended transaction re-runs; a stand-in that re-ran forever would hang a suite
// instead of failing it. Firestore's own client gives up too.
const MAX_TRANSACTION_ATTEMPTS = 5;

// The brand config the transformers read products out of
const CONFIG = {
  payment: {
    products: [
      { id: 'basic', name: 'Basic', type: 'subscription' },
      { id: 'premium', name: 'Premium', type: 'subscription', prices: { monthly: 4.99 }, stripe: { productId: '_test_premium' } },
    ],
  },
};

/**
 * Minimal in-memory Firestore stand-in: the doc reads/writes, the collection query
 * the test provider's fetchResource() makes, and the write batch. `failPath` is the
 * document path whose write rejects — mid-batch in the real world, before anything
 * lands once the writes are batched.
 *
 * `authUids` is the project's auth store: the pipeline asks it whether a uid is one
 * of ours before it will create a user doc ([#399]).
 *
 * @param {object} options
 * @param {object} options.seed - Document path → data, the state the run starts from
 * @param {string|function|null} options.failPath - The document path whose write rejects, or a
 *   `(path, data) => boolean` predicate for a fault that depends on WHICH write it is
 *   (the refusal stamp and the failure stamp land on the same doc — [#535])
 * @param {string[]} options.authUids - The uids that have a Firebase auth user
 * @param {function|null} options.onRead - Called with (path, { store, write }) the moment
 *   ANY read of a document resolves, transactional or not — the seam a suite writes
 *   THROUGH, to put a contending write exactly in the window between a read and the
 *   write that acts on it. Deliberately not transaction-only: a suite proving a
 *   read-then-write race must be able to reproduce the race against the racy shape too
 * @returns {{ admin: object, store: Map }}
 */
function buildAdmin({ seed = {}, failPath = null, authUids = [], onRead = null } = {}) {
  const store = new Map(Object.entries(seed));
  const shouldFail = typeof failPath === 'function' ? failPath : (path) => path === failPath;

  // Per-document write counter — the stand-in's version stamp, so a transaction can
  // tell "nobody touched this since I read it" from "somebody did"
  const versions = new Map();

  const write = (path, data, options) => {
    if (shouldFail(path, data)) {
      throw new Error(`Firestore write to ${path} failed`);
    }

    store.set(path, options?.merge ? merge(store.get(path) || {}, data) : data);
    versions.set(path, (versions.get(path) || 0) + 1);
  };

  // A read is a POINT-IN-TIME snapshot, captured before the seam below can move the
  // store — anything else would hand a racy read-then-write the winner's data and
  // hide the very race a suite is trying to reproduce.
  const read = async (path) => {
    const captured = store.get(path);
    const snapshot = { exists: store.has(path), data: () => captured };

    if (onRead) {
      await onRead(path, { store, write });
    }

    return snapshot;
  };

  const doc = (path) => ({
    path,
    get: async () => read(path),
    set: async (data, options) => write(path, data, options),
  });

  const query = (collection, filters) => ({
    where: (field, op, value) => query(collection, [...filters, { field, op, value }]),
    limit: () => query(collection, filters),
    get: async () => {
      const paths = [...store.keys()]
        .filter(path => path.startsWith(`${collection}/`))
        .filter(path => filters.every(f => matches(fieldValue(store.get(path), f.field), f.op, f.value)));

      return {
        empty: paths.length === 0,
        size: paths.length,
        docs: paths.map(path => ({
          id: path.split('/').pop(),
          ref: doc(path),
          data: () => store.get(path),
        })),
      };
    },
  });

  const admin = {
    auth: () => ({
      getUser: async (uid) => {
        if (!authUids.includes(uid)) {
          // The admin SDK's own not-found shape — the code branches on the code
          const error = new Error(`There is no user record corresponding to the provided identifier.`);
          error.code = 'auth/user-not-found';
          throw error;
        }

        return { uid: uid };
      },
    }),
    firestore: () => ({
      doc,
      collection: (name) => query(name, []),
      batch: () => {
        const staged = [];

        return {
          set: (ref, data, options) => staged.push([ref.path, data, options]),
          commit: async () => {
            // A real batch is atomic: one rejected write means none of them landed
            for (const [path, data] of staged) {
              if (shouldFail(path, data)) {
                throw new Error(`Firestore batch write to ${path} failed`);
              }
            }

            staged.forEach(args => write(...args));
          },
        };
      },
      runTransaction: async (body) => {
        // Firestore's actual contract, which is the whole point of the caller
        // using one: reads are versioned, writes are staged, and if any document
        // the block READ changed before the commit, the block RE-RUNS against the
        // new state. Modelled here rather than assumed — a guard-then-write that
        // is only atomic because nothing raced it proves nothing.
        for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt++) {
          const versionsRead = new Map();
          const staged = [];

          const result = await body({
            get: async (ref) => {
              versionsRead.set(ref.path, versions.get(ref.path) || 0);
              return read(ref.path);
            },
            set: (ref, data, options) => staged.push([ref.path, data, options]),
          });

          const contended = [...versionsRead].some(([path, version]) => (versions.get(path) || 0) !== version);

          if (contended) {
            continue;
          }

          staged.forEach(args => write(...args));

          return result;
        }

        throw new Error('Firestore transaction failed after too many contended attempts');
      },
    }),
  };

  return { admin, store };
}

/** Firestore addresses nested fields with a dotted path — `subscription.status` */
function fieldValue(data, field) {
  return field.split('.').reduce((node, key) => (node == null ? undefined : node[key]), data);
}

/** The query operators the suites here filter on */
function matches(value, op, expected) {
  if (op === '>=') { return value >= expected; }
  if (op === '<=') { return value <= expected; }
  if (op === '>') { return value > expected; }
  if (op === '<') { return value < expected; }

  return value === expected;
}

/** Deep-merge for the stand-in's `{ merge: true }` writes (metadata nests one level) */
function merge(existing, data) {
  const result = { ...existing };

  for (const [key, value] of Object.entries(data)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(existing[key] || {}, value)
      : value;
  }

  return result;
}

/**
 * A Stripe-shaped active subscription — the test provider's payload shape
 *
 * @param {object} options - uid, orderId, resourceId
 * @returns {object}
 */
function subscriptionPayload({ uid, orderId, resourceId }) {
  const nowUNIX = Math.floor(Date.now() / 1000);

  return {
    id: resourceId,
    object: 'subscription',
    status: 'active',
    metadata: { uid: uid, orderId: orderId },
    cancel_at_period_end: false,
    current_period_start: nowUNIX,
    current_period_end: nowUNIX + 86400,
    start_date: nowUNIX,
    plan: { product: '_test_premium', interval: 'month' },
  };
}

/**
 * Run the real trigger over a pending webhook doc against the stand-in
 *
 * @param {object} options
 * @param {string} options.uid - The subscriber the event belongs to
 * @param {string} options.orderId - The order the event writes
 * @param {string} options.resourceId - The subscription the event is about
 * @param {string} options.eventId - The webhook doc id
 * @param {string} options.eventType - The provider's event name
 * @param {string} options.resourceType - The parsed event's resource type (a subscription-category event can ride an invoice or sale resource)
 * @param {string} options.category - The parsed event's category ('subscription' | 'one-time')
 * @param {object|null} options.payload - The resource the webhook envelope carries (defaults to an active subscription)
 * @param {object|null} options.raw - The whole envelope, for a provider that nests its resource
 *   somewhere other than Stripe's `data.object` (PayPal `resource`, Chargebee `content.<type>`)
 * @param {string|null} options.refundId - The refund's own id, as the parser threads it ([#510])
 * @param {object} options.seed - Extra documents the run starts from
 * @param {string|function|null} options.failPath - The document path whose write rejects, or a
 *   `(path, data) => boolean` predicate
 * @param {string[]} [options.authUids] - The uids that have a Firebase auth user (default: the subscriber, as every real one does)
 * @param {boolean} [options.reporting] - Whether a Sentry handle is configured at all (false = no DSN, `omega.sentry` is null)
 * @param {string} [options.provider] - The provider library the event loads (default: the test provider; a real one lets a suite stub its API at the transport boundary)
 * @param {number|null} [options.receivedUNIX] - The second the event ARRIVED (`metadata.created`), which is the staleness clock the pipeline compares against the order
 * @param {boolean} [options.previouslyCompleted] - Whether this doc already completed once (a redelivery, or the retry sweep re-flipping it)
 * @returns {Promise<{ store: Map, logs: string[], captures: object[] }>}
 */
async function runTrigger({ uid, orderId, resourceId, eventId, eventType = 'customer.subscription.updated', resourceType = 'subscription', category = 'subscription', payload = null, raw = null, refundId = null, seed = {}, failPath = null, authUids = null, reporting = true, provider = 'test', receivedUNIX = null, previouslyCompleted = false } = {}) {
  const resource = payload || subscriptionPayload({ uid, orderId, resourceId });
  const envelope = raw || { id: eventId, type: eventType, data: { object: resource } };
  const webhookDoc = {
    id: eventId,
    provider: provider,
    status: 'pending',
    raw: envelope,
    owner: uid,
    event: { type: eventType, category: category, resourceType: resourceType, resourceId: resourceId, refundId: refundId },
    metadata: { created: { timestampUNIX: receivedUNIX || Math.floor(Date.now() / 1000) } },
  };

  const { admin, store } = buildAdmin({
    seed: { [`payments-webhooks/${eventId}`]: webhookDoc, ...seed },
    failPath: failPath,
    authUids: authUids || [uid],
  });

  const logs = [];

  // The error reporter is an external SINK, recorded rather than run — the same
  // treatment the route harness gives `res`. `omega.sentry` IS the backend's
  // one capture handle (context/respond.js reads exactly this), and it is
  // null whenever no DSN is configured, which `reporting: false` reproduces.
  const captures = [];
  const sentry = reporting
    ? { captureMessage: (message, context) => captures.push({ message, ...context }) }
    : null;

  const omega = { config: CONFIG, firebase: { admin }, sentry };
  const ctx = {
    omega,
    isTesting: () => true,
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
  };

  // `before` is what the trigger reads to decide a doc is being REPROCESSED — a
  // redelivery, or the retry sweep putting a failed doc back to pending. Same doc
  // by default (no prior completion), the completed shape when a suite asks.
  const before = previouslyCompleted ? { ...webhookDoc, status: 'completed' } : webhookDoc;

  await onWrite({
    ctx,
    change: { before: { data: () => before }, after: { data: () => webhookDoc } },
    context: { params: { eventId: eventId } },
  });

  return { store, logs, captures };
}

module.exports = { CONFIG, buildAdmin, merge, subscriptionPayload, runTrigger };
