/**
 * Test: routes/user/connections — the refresh lease
 * ([#783](https://github.com/Omega-JS-Stack/omega/issues/783)).
 *
 * Run (from the framework repo): npm test routes/user/connections-refresh-lease
 *
 * A backend never runs as ONE process. Two instances refreshing the same user's
 * same provider at once spend a one-time refresh token twice (Twitch rotates its
 * own on every use): the loser's exchange is refused, and the token it writes
 * back is dead. Nothing serialized them — no in-flight map could, since the
 * other refresh is in another process. What does is a LEASE on the record,
 * taken in a Firestore transaction.
 *
 * What this pins:
 *
 *   1. the transaction decides: an absent lease and a lease older than 30
 *      seconds are both WON; a fresh one is LOST, with nothing written;
 *   2. a winner runs the provider once, stores the token and removes the lease
 *      in the same write — and a FAILING winner removes it too, so a crash never
 *      wedges the record past the expiry;
 *   3. a loser never touches the provider: it waits for the stored token and
 *      answers it, or answers 409 naming the stalled refresh and writes nothing;
 *   4. both paths answer `{ success: true, token }`.
 *
 * Everything is offline. The offline lane has no Firestore, so the seam is the
 * `admin` handle the route already takes: an in-memory store that applies a
 * `set(..., { merge: true })` the way Firestore does (deep merge, and
 * `FieldValue.delete()` removes the key) and answers a transaction from the same
 * documents. No emulator, no network, no provider.
 */

const path = require('path');
const jetpack = require('fs-jetpack');
const { FieldValue } = require('firebase-admin/firestore');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const postRoute = loadHandler(require.resolve('../../../dist/omega/routes/user/connections/post.js'));
const {
  acquireRefreshLease,
  clearRefreshLease,
  awaitRefreshedToken,
  INSTANCE_ID,
  LEASE_TTL_SECONDS,
} = require('../../../dist/omega/routes/user/connections/_lease.js');
const { REFRESH_TIMEOUT_MS } = require('../../../dist/omega/routes/user/connections/_grant.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const PROVIDER_ID = 'lease-fixture-783';
const PROVIDER_ENV_KEY = 'LEASE_FIXTURE_783';
const USER_UID = 'user-783';

// The one linked account: the record is keyed by the identity the fixture answers
const IDENTITY_ID = 'fixture-user';

// The one sentinel a merge removes a field with — `FieldValue.delete()` is a
// singleton, so the store below compares it by identity.
const DELETE = FieldValue.delete();

// The credentials the lane resolves for the fixture provider. Restored in
// cleanup() — a run that leaves them behind changes what the next file reads.
const originalEnv = {
  [`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_ID`]: process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_ID`],
  [`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_SECRET`]: process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_SECRET`],
};

process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_ID`] = 'client-id-783';
process.env[`CONNECTIONS_${PROVIDER_ENV_KEY}_CLIENT_SECRET`] = 'client-secret-783';

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// The provider module is loaded from a FILE by the lane's own resolver, so what
// its refresh was called with lives where both the file and the case can see it:
// the one thing "spent twice" means is `calls` reaching 2, and the one thing
// "spent the SUPERSEDED token" means is `tokens` naming the pre-lease one.
const CALL_STATE = '__omegaLeaseRefresh783';

/** A provider whose refresh takes `delayMs`, records its calls, and never leaves the process. */
function providerSource({ delayMs = 0, fail = false } = {}) {
  return [
    'module.exports = {',
    `  provider: '${PROVIDER_ID}',`,
    "  name: 'Lease Fixture',",
    "  urls: { authorize: 'https://provider.test/a', token: 'https://provider.test/t' },",
    '  async refresh(context) {',
    `    const state = global['${CALL_STATE}'] = global['${CALL_STATE}'] || { calls: 0, tokens: [] };`,
    '    state.calls += 1;',
    '    state.tokens.push(context.token && context.token.refresh_token);',
    `    await new Promise((resolve) => setTimeout(resolve, ${delayMs}));`,
    ...(fail ? ["    throw new Error('the provider said no');"] : []),
    "    return { access_token: 'refreshed-783', refresh_token: 'rotated-783', token_type: 'Bearer', expires_in: 3600, scope: 'identify' };",
    '  },',
    "  async identity() { return { id: 'fixture-user' }; },",
    '};',
  ].join('\n');
}

function refreshCalls() {
  return (global[CALL_STATE] || {}).calls || 0;
}

function refreshTokensSpent() {
  return (global[CALL_STATE] || {}).tokens || [];
}

function resetRefreshCalls() {
  global[CALL_STATE] = { calls: 0, tokens: [] };
}

/** The stored connection record a refresh acts on, plus whatever a case adds to it. */
function storedRecord(extra) {
  return {
    id: USER_UID,
    connections: {
      [PROVIDER_ID]: {
        [IDENTITY_ID]: {
          type: 'oauth2',
          token: { access_token: 'access-old', refresh_token: 'refresh-783' },
          identity: { id: IDENTITY_ID },
          ...extra,
        },
      },
    },
  };
}

/** A lease note as another instance would have left it, `ageSeconds` ago. */
function heldLease(ageSeconds, instance) {
  const timestampUNIX = Math.floor(Date.now() / 1000) - ageSeconds;

  return {
    instance: instance || 'other-instance-783',
    timestamp: new Date(timestampUNIX * 1000).toISOString(),
    timestampUNIX,
  };
}

/** Firestore's merge, as much of it as a connection record needs. */
function mergeInto(target, payload) {
  for (const [key, value] of Object.entries(payload)) {
    if (value === DELETE) {
      delete target[key];
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Copied, never merged in place: a stored document is not the object the
      // case handed in, and a lease note taken over must not rewrite the
      // fixture's own copy of the note it replaced
      const existing = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key]) ? { ...target[key] } : {};

      target[key] = mergeInto(existing, value);
      continue;
    }

    target[key] = value;
  }

  return target;
}

/**
 * The Firestore stand-in: documents in memory, writes APPLIED (so the next read
 * sees the lease the transaction just took), and a `runTransaction` reading and
 * writing the same store. `onRead` is the hook a case moves the record under a
 * waiting loser with.
 */
function leaseFirestore(docs, onRead) {
  const writes = [];
  const reads = [];

  const snapshot = (docPath) => ({ exists: !!docs[docPath], data: () => docs[docPath] });

  const read = async (docPath) => {
    reads.push(docPath);

    if (onRead) {
      await onRead(reads.length, docs);
    }

    return snapshot(docPath);
  };

  const write = (verb, docPath, payload) => {
    writes.push({ verb, path: docPath, payload });
    docs[docPath] = mergeInto(docs[docPath] || {}, payload);
  };

  const firestore = {
    doc: (docPath) => ({
      path: docPath,
      get: () => read(docPath),
      set: async (payload) => write('set', docPath, payload),
      update: async (payload) => write('update', docPath, payload),
    }),
    runTransaction: (fn) => fn({
      get: (ref) => read(ref.path),
      set: (ref, payload) => write('transaction.set', ref.path, payload),
    }),
  };

  return { admin: { firestore: () => firestore }, docs, writes, reads };
}

/** The lane, wired: a brand provider dir, the store above, and a ctx. */
function lane({ docs, provider, onRead } = {}) {
  const cwd = jetpack.tmpDir({ prefix: 'omega-connections-783' }).path();

  jetpack.write(path.join(cwd, 'connections', `${PROVIDER_ID}.js`), provider || providerSource());

  const store = leaseFirestore(docs || {}, onRead);

  const omega = {
    cwd,
    firebase: { admin: store.admin },
    project: { websiteUrl: 'https://brand.test' },
    config: {},
  };

  const responses = [];

  const ctx = {
    omega,
    metadata: () => ({}),
    log() {},
    respond: (message, options) => {
      responses.push({ message, options: options || {} });
      return { message, options: options || {} };
    },
    meta: { startTime: { timestamp: 'now', timestampUNIX: Math.floor(Date.now() / 1000) } },
  };

  return { ...store, ctx, omega, responses };
}

/** The caller's own record IS what the self path reads (it only goes to Firestore for another uid). */
function userWithConnection(extra) {
  return {
    authenticated: true,
    auth: { uid: USER_UID },
    roles: { admin: false },
    connections: storedRecord(extra).connections,
  };
}

/** The last thing the route answered. */
function answered(responses) {
  return responses[responses.length - 1] || {};
}

/** The connection record as it stands in the store. */
function recordIn(docs) {
  return docs[`users/${USER_UID}`]?.connections?.[PROVIDER_ID]?.[IDENTITY_ID] || {};
}

module.exports = defineCases({
  description: 'Connections refresh: the cross-instance lease',
  type: 'group',

  cleanup() {
    restoreEnv();
    delete global[CALL_STATE];
  },

  tests: [
    {
      // The lease has to outlive the call it protects. The refresh POST used to
      // carry a 60s timeout under a 30s lease, so a slow provider let a second
      // caller reclaim the lease and spend the same one-time refresh token —
      // the exact race the lease exists to stop.
      name: 'the-lease-outlives-the-refresh-call-it-protects',

      async run({ expect }) {
        expect(LEASE_TTL_SECONDS * 1000 > REFRESH_TIMEOUT_MS, `the ${LEASE_TTL_SECONDS}s lease must outlast the ${REFRESH_TIMEOUT_MS}ms refresh timeout`).toBe(true);
        expect(REFRESH_TIMEOUT_MS, 'the refresh step is the shorter call (the exchange keeps its 60s — it holds no lease)').toBe(20000);

        // The relationship is enforced at LOAD, not just here: the module refuses
        // to boot rather than run with a lease that can expire under a refresh
        const source = jetpack.read(path.join(__dirname, '../../../dist/omega/routes/user/connections/_lease.js'));

        expect(source, 'the guard reads the one home of the timeout, so the two cannot drift').toMatch(/LEASE_TTL_SECONDS \* 1000 <= REFRESH_TIMEOUT_MS/);
        expect(source, 'and it throws — a programmer error, not a warning').toMatch(/throw new Error/);
      },
    },

    {
      name: 'a-record-with-no-lease-is-won-and-the-note-is-written',

      async run({ expect }) {
        const { admin, docs, writes } = leaseFirestore({
          [`users/${USER_UID}`]: storedRecord({ updated: { timestamp: 'then', timestampUNIX: 1700000000 } }),
        });

        const lease = await acquireRefreshLease({ admin, uid: USER_UID, provider: PROVIDER_ID, id: IDENTITY_ID });

        expect(lease.won, 'nobody holds the record, so this caller refreshes').toBe(true);
        expect(lease.updatedUNIX, 'and it carries the updated stamp seen at entry, for a loser to watch').toBe(1700000000);
        expect(lease.token.refresh_token, 'plus the stored token AS THE TRANSACTION SAW IT — the one the winner spends').toBe('refresh-783');

        expect(writes.length, 'one write, and it is the transaction\'s').toBe(1);
        expect(writes[0].verb, 'taken IN the transaction — two instances reading the same absent lease cannot both write one').toBe('transaction.set');
        expect(writes[0].path, 'on the user document').toBe(`users/${USER_UID}`);

        const note = recordIn(docs).refreshing;

        expect(note, 'the note is on the record').toBeTruthy();
        expect(note.instance, 'naming this process').toBe(INSTANCE_ID);
        expect(note.instance, 'the same id the caller was handed').toBe(lease.lease.instance);
        expect(typeof note.timestampUNIX, 'with the seconds stamp the expiry is measured on').toBe('number');
        expect(Math.floor(new Date(note.timestamp).getTime() / 1000), 'and the ISO twin every stamp in this codebase carries, of the same instant').toBe(note.timestampUNIX);
        expect(recordIn(docs).token.access_token, 'and nothing else on the record moved').toBe('access-old');
      },
    },

    {
      name: 'a-lease-older-than-the-expiry-is-taken-over',

      async run({ expect }) {
        const stale = heldLease(LEASE_TTL_SECONDS + 5);

        const { admin, docs } = leaseFirestore({
          [`users/${USER_UID}`]: storedRecord({ refreshing: stale }),
        });

        const lease = await acquireRefreshLease({ admin, uid: USER_UID, provider: PROVIDER_ID, id: IDENTITY_ID });

        expect(lease.won, `a lease older than ${LEASE_TTL_SECONDS}s is stale — the instance holding it died, and the record cannot stay locked forever`).toBe(true);
        expect(recordIn(docs).refreshing.instance, 'and the note is now this process\'s').toBe(INSTANCE_ID);
        expect(recordIn(docs).refreshing.timestampUNIX, 'stamped now, so the next caller measures against THIS refresh').not.toBe(stale.timestampUNIX);
      },
    },

    {
      name: 'a-fresh-lease-is-lost-and-nothing-is-written',

      async run({ expect }) {
        const held = heldLease(5);

        const { admin, docs, writes } = leaseFirestore({
          [`users/${USER_UID}`]: storedRecord({ refreshing: held, updated: { timestamp: 'then', timestampUNIX: 1700000000 } }),
        });

        const lease = await acquireRefreshLease({ admin, uid: USER_UID, provider: PROVIDER_ID, id: IDENTITY_ID });

        expect(lease.won, 'another instance is spending the refresh token right now').toBe(false);
        expect(lease.lease.instance, 'and the loser is told which one').toBe(held.instance);
        expect(lease.updatedUNIX, 'plus the stamp to watch for movement past').toBe(1700000000);
        expect(writes.length, 'a loser writes nothing — not even its own note').toBe(0);
        expect(recordIn(docs).refreshing.instance, "the holder's note is untouched").toBe(held.instance);
      },
    },

    {
      name: 'clearing-the-lease-removes-the-note-and-nothing-else',

      async run({ expect }) {
        const { admin, docs } = leaseFirestore({
          [`users/${USER_UID}`]: storedRecord({ refreshing: heldLease(1, INSTANCE_ID) }),
        });

        await clearRefreshLease({ admin, uid: USER_UID, provider: PROVIDER_ID, id: IDENTITY_ID });

        expect('refreshing' in recordIn(docs), 'the note is gone, so the next caller wins immediately').toBe(false);
        expect(recordIn(docs).token.refresh_token, 'and the token it was taken over is still stored').toBe('refresh-783');
        expect(recordIn(docs).type, 'as is the kind of connection this is').toBe('oauth2');
      },
    },

    {
      name: 'a-waiting-loser-gives-up-when-the-refresh-never-settles',

      async run({ expect }) {
        const { admin, reads } = leaseFirestore({
          [`users/${USER_UID}`]: storedRecord({ refreshing: heldLease(1), updated: { timestamp: 'then', timestampUNIX: 1700000000 } }),
        });

        // The window is the contract (500ms polls, 10s); the case drives a short
        // one so the give-up path costs the suite milliseconds, not ten seconds
        const waited = await awaitRefreshedToken({
          admin,
          uid: USER_UID,
          provider: PROVIDER_ID,
          id: IDENTITY_ID,
          since: 1700000000,
          pollMs: 10,
          timeoutMs: 50,
        });

        expect(waited.outcome, 'the lease never cleared and the stamp never moved, so the wait gives up').toBe('timeout');
        expect(waited.token, 'with no token to answer').toBe(null);
        expect(reads.length > 1, `and it re-read the record rather than deciding once: ${reads.length} reads`).toBe(true);
      },
    },

    {
      name: 'the-winner-stores-the-token-clears-the-lease-and-answers-it',

      async run({ expect }) {
        resetRefreshCalls();

        const { ctx, docs, writes, responses } = lane({ docs: { [`users/${USER_UID}`]: storedRecord() } });

        await postRoute({
          ctx,
          user: userWithConnection(),
          data: { provider: PROVIDER_ID, action: 'refresh' },
        });

        const response = answered(responses);

        expect(response.options.code, `the refresh succeeded: ${JSON.stringify(response.message)}`).toBe(undefined);
        expect(response.message.success, 'reporting success').toBe(true);
        expect(response.message.token.access_token, 'and the answer CARRIES the token, so a trusted service refreshes and reads in one call').toBe('refreshed-783');
        expect(response.message.token.refresh_token, 'the rotated refresh token included').toBe('rotated-783');
        expect(refreshCalls(), 'the provider ran once').toBe(1);

        const record = recordIn(docs);

        expect(record.token.access_token, 'the stored token is the new one').toBe('refreshed-783');
        expect(record.updated.timestampUNIX, 'stamped with the request').toBe(ctx.meta.startTime.timestampUNIX);
        expect('refreshing' in record, 'and the lease is gone').toBe(false);

        const storeWrite = writes.find((entry) => entry.verb === 'set');

        expect(storeWrite, 'the token landed in a plain merge write').toBeTruthy();
        expect(storeWrite.payload.connections[PROVIDER_ID][IDENTITY_ID].refreshing, 'which removes the lease in the SAME write — the record is never one write away from consistent').toBe(DELETE);
        expect(writes.filter((entry) => entry.verb === 'set').length, 'and there is no second write to clear it').toBe(1);
      },
    },

    {
      // The pre-lease read can be one rotation old: it happens before the
      // transaction, and another instance may have finished a refresh in
      // between. Spending a SUPERSEDED refresh token is the bug this issue is
      // about, so the winner uses what the transaction saw.
      name: 'the-winner-spends-the-token-the-transaction-saw',

      async run({ expect }) {
        resetRefreshCalls();

        // Firestore holds a rotated token; the caller's own (pre-lease) record
        // still carries the superseded one
        const rotated = storedRecord();

        rotated.connections[PROVIDER_ID][IDENTITY_ID].token = { access_token: 'access-newer', refresh_token: 'rotated-elsewhere-783' };

        const { ctx, docs, responses } = lane({ docs: { [`users/${USER_UID}`]: rotated } });

        await postRoute({
          ctx,
          user: userWithConnection(),
          data: { provider: PROVIDER_ID, action: 'refresh' },
        });

        expect(answered(responses).options.code, 'the refresh succeeded').toBe(undefined);
        expect(refreshTokensSpent(), "the provider was handed the record's CURRENT refresh token, never the pre-lease one").toEqual(['rotated-elsewhere-783']);
        expect(recordIn(docs).token.access_token, 'and the new token landed').toBe('refreshed-783');
      },
    },

    {
      // The record was disconnected between the pre-lease read and the
      // transaction. There is nothing to spend, and the pre-lease token is not a
      // fallback: refreshing a connection the user just removed is worse than a
      // 400.
      name: 'a-record-that-vanished-under-the-lease-is-the-same-400',

      async run({ expect }) {
        resetRefreshCalls();

        const { ctx, docs, responses } = lane({ docs: {} });

        await postRoute({
          ctx,
          user: userWithConnection(),
          data: { provider: PROVIDER_ID, action: 'refresh' },
        });

        const response = answered(responses);

        expect(response.options.code, `the same 400 the pre-lease check answers: ${response.message}`).toBe(400);
        expect(response.message, 'with the same message').toBe('No refresh token found');
        expect(refreshCalls(), 'the provider was never called').toBe(0);
        expect('refreshing' in recordIn(docs), 'and the lease it took on the way in is gone').toBe(false);
      },
    },

    {
      name: 'a-winner-whose-provider-fails-still-clears-the-lease',

      async run({ expect }) {
        resetRefreshCalls();

        const { ctx, docs, writes, responses } = lane({
          docs: { [`users/${USER_UID}`]: storedRecord() },
          provider: providerSource({ fail: true }),
        });

        await postRoute({
          ctx,
          user: userWithConnection(),
          data: { provider: PROVIDER_ID, action: 'refresh' },
        });

        const response = answered(responses);

        expect(response.options.code, `the provider failure is still reported: ${response.message}`).toBe(500);
        expect(response.message, 'with its own message').toMatch(/Token refresh failed/);

        const record = recordIn(docs);

        expect(writes.some((entry) => entry.verb === 'transaction.set'), 'the lease WAS taken — this caller ran the provider').toBe(true);
        expect('refreshing' in record, 'and it is gone, so a crash never wedges the record for the whole expiry').toBe(false);
        expect(writes.some((entry) => entry.verb === 'set'), 'the clear is its own write on the failure path (the success path folds it into the token write)').toBe(true);
        expect(record.token.access_token, 'the stored token is untouched — there was no new one').toBe('access-old');
      },
    },

    {
      name: 'a-loser-answers-the-stored-token-once-the-record-moves',

      async run({ expect }) {
        resetRefreshCalls();

        const held = heldLease(1);
        const since = Math.floor(Date.now() / 1000) - 60;

        // The winner is another INSTANCE: it holds the lease, and its write
        // lands under this caller while it waits (read 2 moves the stamp, and
        // the note stays — a loser settles on either).
        const { ctx, writes, responses } = lane({
          docs: {
            [`users/${USER_UID}`]: storedRecord({ refreshing: held, updated: { timestamp: 'then', timestampUNIX: since } }),
          },
          onRead: (count, docs) => {
            if (count === 2) {
              docs[`users/${USER_UID}`].connections[PROVIDER_ID][IDENTITY_ID].token = { access_token: 'refreshed-elsewhere-783', refresh_token: 'rotated-783' };
              docs[`users/${USER_UID}`].connections[PROVIDER_ID][IDENTITY_ID].updated = { timestamp: 'now', timestampUNIX: since + 30 };
            }
          },
        });

        await postRoute({
          ctx,
          user: userWithConnection(),
          data: { provider: PROVIDER_ID, action: 'refresh' },
        });

        const response = answered(responses);

        expect(response.options.code, `the loser answers success, not an error: ${JSON.stringify(response.message)}`).toBe(undefined);
        expect(response.message.token.access_token, "and the token is the WINNER's, read back from the record").toBe('refreshed-elsewhere-783');
        expect(refreshCalls(), 'the loser never touched the provider — the refresh token is one-time and the winner is spending it').toBe(0);
        expect(writes.length, 'and it wrote nothing at all').toBe(0);
      },
    },

    {
      // The winner's own provider call failed, so it cleared the note without
      // writing a token. The record still holds the PRE-refresh token — which the
      // provider may already have invalidated — so answering it as a success
      // would hand back a dead credential.
      name: 'a-loser-answers-409-when-the-winners-refresh-never-completed',

      async run({ expect }) {
        resetRefreshCalls();

        const since = Math.floor(Date.now() / 1000) - 60;

        const { ctx, writes, responses } = lane({
          docs: {
            [`users/${USER_UID}`]: storedRecord({ refreshing: heldLease(1), updated: { timestamp: 'then', timestampUNIX: since } }),
          },
          onRead: (count, docs) => {
            // The winner's failure path: the note goes, the stamp does not move
            if (count === 2) {
              delete docs[`users/${USER_UID}`].connections[PROVIDER_ID][IDENTITY_ID].refreshing;
            }
          },
        });

        await postRoute({
          ctx,
          user: userWithConnection(),
          data: { provider: PROVIDER_ID, action: 'refresh' },
        });

        const response = answered(responses);

        expect(response.options.code, `an abandoned refresh is a conflict, not a token: ${response.message}`).toBe(409);
        expect(response.message, 'and the message says the refresh never completed, not that it stalled').toBe(`The refresh of ${PROVIDER_ID} started by another instance did not complete. Try again.`);
        expect(refreshCalls(), 'this caller still never touched the provider').toBe(0);
        expect(writes.length, 'and wrote nothing — a retry wins the lease outright').toBe(0);
      },
    },

    {
      name: 'a-winner-and-a-loser-at-once-spend-the-refresh-token-once',

      async run({ expect }) {
        resetRefreshCalls();

        const docs = { [`users/${USER_UID}`]: storedRecord() };
        const cwd = jetpack.tmpDir({ prefix: 'omega-connections-783-pair' }).path();

        jetpack.write(path.join(cwd, 'connections', `${PROVIDER_ID}.js`), providerSource({ delayMs: 300 }));

        // ONE store, two callers — the shape two Cloud Functions instances have
        const store = leaseFirestore(docs);

        const callers = [0, 1].map(() => {
          const responses = [];

          return {
            responses,
            ctx: {
              omega: {
                cwd,
                firebase: { admin: store.admin },
                project: { websiteUrl: 'https://brand.test' },
                config: {},
              },
              metadata: () => ({}),
              log() {},
              respond: (message, options) => {
                responses.push({ message, options: options || {} });
                return { message, options: options || {} };
              },
              meta: { startTime: { timestamp: 'now', timestampUNIX: Math.floor(Date.now() / 1000) } },
            },
          };
        });

        const call = (caller) => postRoute({
          ctx: caller.ctx,
          user: userWithConnection(),
          data: { provider: PROVIDER_ID, action: 'refresh' },
        });

        const first = call(callers[0]);

        // The second caller arrives while the first is at the provider
        await new Promise((resolve) => setTimeout(resolve, 50));

        const second = call(callers[1]);

        await Promise.all([first, second]);

        expect(refreshCalls(), 'the provider was called ONCE across the pair — the whole point: a rotating refresh token spent twice leaves a dead token stored').toBe(1);

        const answers = callers.map((caller) => answered(caller.responses));

        for (const answer of answers) {
          expect(answer.options.code, `both callers get a token, not an error: ${JSON.stringify(answer.message)}`).toBe(undefined);
          expect(answer.message.success, 'both report success').toBe(true);
          expect(answer.message.token.access_token, 'and both answer the same stored token').toBe('refreshed-783');
        }

        expect('refreshing' in recordIn(docs), 'the lease is gone when the pair is done').toBe(false);
        expect(store.writes.filter((entry) => entry.verb === 'transaction.set').length, 'only one caller ever wrote a lease note').toBe(1);
      },
    },

    {
      // The one case that costs its own SLA: the loser polls the real 500ms for
      // the real 10 seconds, because the 409 IS that window expiring.
      name: 'a-loser-times-out-with-a-409-naming-the-stalled-refresh',
      timeout: 30000,

      async run({ expect }) {
        resetRefreshCalls();

        const held = heldLease(1);

        const { ctx, writes, responses } = lane({
          docs: {
            [`users/${USER_UID}`]: storedRecord({ refreshing: held, updated: { timestamp: 'then', timestampUNIX: 1700000000 } }),
          },
        });

        await postRoute({
          ctx,
          user: userWithConnection(),
          data: { provider: PROVIDER_ID, action: 'refresh' },
        });

        const response = answered(responses);

        expect(response.options.code, `a refresh that never settles is a conflict, not a success: ${response.message}`).toBe(409);
        expect(response.message, `and the message names the stalled refresh: ${response.message}`).toMatch(new RegExp(held.instance));
        expect(response.message, 'and the provider it is stuck on').toMatch(new RegExp(PROVIDER_ID));
        expect(refreshCalls(), 'the provider was never called').toBe(0);
        expect(writes.length, 'and nothing was written — no token, no lease, no stamp').toBe(0);
      },
    },
  ],
});
