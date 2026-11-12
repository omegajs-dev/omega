import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { buildContext, connectionRecords, resolveConnection, droppedUidError } from './_context.js';
import { loadProvider, disabledProviderError, connectionLimitError } from './_providers.js';
import { decryptState, pkceChallenge, STATE_TTL_MINUTES } from './_state.js';
import { buildGrantContext, runStep } from './_grant.js';
import {
  acquireRefreshLease,
  awaitRefreshedToken,
  clearRefreshLease,
  LEASE_WAIT_MS,
} from './_lease.js';

/**
 * POST /user/connections - Write operations
 *
 * Actions:
 *   - tokenize (default): Exchange authorization code for tokens
 *   - refresh: Refresh access token
 */
export default async ({ ctx, user, data }) => {
  ctx.log('Connections POST request', { action: data.action });

  switch (data.action) {
    case 'refresh':
      return processRefresh({ ctx, user, data });

    case 'tokenize':
    default:
      return processTokenize({ ctx, data });
  }
};

// ============================================================================
// Handlers
// ============================================================================

async function processTokenize({ ctx, data }) {
  const omega = ctx.omega;
  const admin = omega.firebase.admin;

  // Tokenize builds no context (its provider and its user come from the
  // encrypted state), so it runs the same dropped-`uid` check itself: the code
  // belongs to the browser that carried it, and no admin can spend it for
  // somebody else ([#782](https://github.com/Omega-JS-Stack/omega/issues/782))
  const dropped = droppedUidError(data);

  if (dropped) {
    return ctx.respond(dropped.message, { code: dropped.code });
  }

  ctx.log('processTokenize settings', {
    hasCode: !!data.code,
    codeType: typeof data.code,
    codeLength: data.code?.length,
    hasEncryptedState: !!data.encryptedState,
    encryptedStateLength: data.encryptedState?.length,
  });

  // Validate required params
  if (!data.code) {
    return ctx.respond('Missing authorization code', { code: 400 });
  }

  if (!data.encryptedState) {
    return ctx.respond('Missing encrypted state', { code: 400 });
  }

  // Build redirect URI
  const redirectUri = `${omega.project.websiteUrl}/connections/callback`;

  // Decrypt and validate state
  let stateData;

  try {
    stateData = decryptState(data.encryptedState);
  } catch (e) {
    ctx.log('Failed to decrypt state:', e.message);
    return ctx.respond('Invalid OAuth state', { code: 400 });
  }

  // Validate timestamp (10 min TTL)
  const ageMinutes = (Date.now() - stateData.ts) / 1000 / 60;

  if (ageMinutes > STATE_TTL_MINUTES) {
    return ctx.respond('OAuth session expired. Please try again.', { code: 400 });
  }

  // Load provider from decrypted state (the brand's own dir first)
  const providerResult = loadProvider(stateData.provider, omega);

  if (providerResult.error) {
    return ctx.respond(providerResult.error.message, { code: providerResult.error.code });
  }

  const { connectionProvider, clientId, clientSecret } = providerResult;

  // The provider is known only now, out of the state: a brand that turned it
  // off between the authorize leg and this one gets no exchange
  const disabled = disabledProviderError(stateData.provider, omega);

  if (disabled) {
    return ctx.respond(disabled.message, { code: disabled.code });
  }

  // Retrieve stored CSRF token from user's usage document
  const usageDocRef = admin.firestore().doc(`usage/${stateData.uid}`);
  const usageDoc = await usageDocRef.get();

  if (!usageDoc.exists) {
    return ctx.respond('OAuth session not found. Please try again.', { code: 400 });
  }

  const storedSession = usageDoc.data()?.connections?.[stateData.provider];
  const storedCsrf = storedSession?.csrf;

  if (!storedCsrf) {
    return ctx.respond('OAuth session not found. Please try again.', { code: 400 });
  }

  // Validate CSRF token
  if (storedCsrf !== stateData.csrf) {
    ctx.log('CSRF mismatch', { stored: storedCsrf, received: stateData.csrf });
    return ctx.respond('Invalid OAuth session', { code: 400 });
  }

  // The session is SINGLE-USE, so it is spent here — the moment the CSRF token
  // has been validated and before anything can fail. Deleting it on the success
  // path alone left the verifier (and the CSRF token) behind on every other
  // exit — a failed exchange, a rejected identity check, a missing
  // refresh_token — for the same code to be replayed against
  // ([#771](https://github.com/Omega-JS-Stack/omega/issues/771)).
  await usageDocRef.update({
    [`connections.${stateData.provider}`]: FieldValue.delete(),
  });

  // PKCE: the verifier the authorize leg stored beside the CSRF token. A
  // provider that declares pkce and has no verifier stored started its flow
  // before the declaration existed — the exchange would be refused by the
  // provider anyway, so it is refused here, naming the fix
  const verifier = storedSession?.verifier;

  if (connectionProvider.pkce && !verifier) {
    return ctx.respond('OAuth session is missing its PKCE verifier. Please try again.', { code: 400 });
  }

  const pkce = verifier ? { verifier, challenge: pkceChallenge(verifier) } : null;

  // What every step of this leg is called with
  const context = buildGrantContext({
    provider: connectionProvider,
    providerName: stateData.provider,
    omega,
    ctx,
    uid: stateData.uid,
    clientId,
    clientSecret,
    redirectUri,
    code: data.code,
    pkce,
  });

  // Exchange code for tokens — the provider's own step when it declares one.
  // The step runs inside a promise chain because an OVERRIDE is consumer code:
  // it may return a value rather than a promise, or throw synchronously, and
  // either shape has to land on the same `instanceof Error` branch below
  const tokenResponse = await Promise.resolve().then(() => runStep(connectionProvider, 'exchange', context)).catch(e => e);

  if (tokenResponse instanceof Error) {
    return ctx.respond(`Token exchange failed: ${tokenResponse.message}`, { code: 500 });
  }

  // Who the fresh grant belongs to. `token` for THIS step is the exchange
  // response, not a stored record: nothing is stored yet
  // ([#793](https://github.com/Omega-JS-Stack/omega/issues/793))
  const identity = await Promise.resolve().then(() => runStep(connectionProvider, 'identity', { ...context, token: tokenResponse })).catch(e => e);

  if (identity instanceof Error) {
    return ctx.respond(identity.message, { code: 400 });
  }

  // The lane matches accounts on `identity.id`, so a provider that answers
  // without one is a PROGRAMMER error, not a caller's: it throws naming the
  // file, the way a missing url does at load
  // ([#793](https://github.com/Omega-JS-Stack/omega/issues/793))
  if (typeof identity?.id !== 'string' || !identity.id) {
    throw new Error(`Connection provider ${stateData.provider}.js answered an identity with no string id — that is what a connection is matched on`);
  }

  // ONE account per provider identity, and the check belongs HERE rather than
  // in every provider ([#791](https://github.com/Omega-JS-Stack/omega/issues/791)):
  // the copies each matched the CONNECTING user's own document too, so
  // reconnecting — to widen a scope, or after a failed refresh left the record —
  // told the owner their account belonged to somebody else. The path is a
  // FieldPath because the id is a map key now, and an id may carry a `.`
  const matches = await admin.firestore().collection('users')
    .where(new FieldPath('connections', stateData.provider, identity.id, 'identity', 'id'), '==', identity.id)
    .get();

  const takenBy = matches.docs.find((doc) => doc.id !== stateData.uid);

  if (takenBy) {
    return ctx.respond(
      `This ${connectionProvider.name} account is already connected to a ${omega.config.brand.name} account`,
      { code: 400 },
    );
  }

  if (!tokenResponse.refresh_token) {
    return ctx.respond(
      `Missing refresh_token. Visit ${connectionProvider.urls.removeAccess} and remove our app, then try again.`,
      { code: 400 }
    );
  }

  // Only necessary fields, no raw settings
  const record = {
    // Every connection record names its KIND: a connection will not always be
    // an OAuth grant (an API key or a bot token is a connection too), so the
    // shape says which one this is.
    type: 'oauth2',
    token: {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      token_type: tokenResponse.token_type,
      expires_in: tokenResponse.expires_in,
      scope: tokenResponse.scope,
    },
    identity: identity,
    updated: {
      timestamp: ctx.meta.startTime.timestamp,
      timestampUNIX: ctx.meta.startTime.timestampUNIX,
    },
  };

  const overLimit = await storeConnection({ ctx, omega, admin, uid: stateData.uid, provider: stateData.provider, record });

  if (overLimit) {
    return ctx.respond(overLimit.message, { code: overLimit.code });
  }

  ctx.log('Connections tokenize complete');

  // The destination the authorize leg was asked for, back out of the state
  // ([#784](https://github.com/Omega-JS-Stack/omega/issues/784)): the callback
  // page has no other way of knowing it — the browser left for the provider in
  // between. It was validated as a path when it was accepted, and the state is
  // ours (AES-256-GCM, our key), so what comes out is what went in. The page
  // re-checks it anyway before it navigates
  return ctx.respond({
    success: true,
    ...(stateData.returnUrl ? { returnUrl: stateData.returnUrl } : {}),
  });
}

/**
 * Store one account's record at `connections.<provider>.<identityId>`, counted
 * against the brand's `max` in the SAME transaction as the write, so two
 * simultaneous connects cannot both pass the cap. The record REPLACES what sat
 * at that id: a reconnect leaves none of an older identity's fields behind.
 *
 * @param {object} options - `ctx`, `omega`, `admin`, the `uid`, the `provider` key and the full `record`
 * @returns {Promise<object|null>} The limit error, or null once stored
 */
async function storeConnection({ ctx, omega, admin, uid, provider, record }) {
  const firestore = admin.firestore();
  const docRef = firestore.doc(`users/${uid}`);
  const metadata = ctx.metadata({ tag: 'user/connections' });

  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(docRef);
    const records = connectionRecords(snapshot.data(), provider);
    const overLimit = connectionLimitError(provider, omega, records, record.identity.id);

    if (overLimit) {
      return overLimit;
    }

    // An update at the record's own path replaces it whole (a FieldPath: the id
    // may carry a `.`). Metadata goes key by key so `metadata.created` stays
    if (snapshot.exists) {
      transaction.update(
        docRef,
        new FieldPath('connections', provider, record.identity.id), record,
        new FieldPath('metadata', 'updated'), metadata.updated,
        new FieldPath('metadata', 'tag'), metadata.tag,
      );
    } else {
      transaction.set(docRef, { connections: { [provider]: { [record.identity.id]: record } }, metadata });
    }

    return null;
  });
}

async function processRefresh({ ctx, user, data }) {
  // An admin may pass `uid`: a refresh happens AT THE PROVIDER, on the user's
  // behalf, and needs no browser ([#782](https://github.com/Omega-JS-Stack/omega/issues/782))
  const context = await buildContext({ ctx, user, data, honorUid: true });

  if (context.error) {
    return ctx.respond(context.error.message, { code: context.error.code });
  }

  const { omega, admin, connectionProvider, targetUid, targetUser, clientId, clientSecret } = context;

  const disabled = disabledProviderError(data.provider, omega);

  if (disabled) {
    return ctx.respond(disabled.message, { code: disabled.code });
  }

  const connection = resolveConnection(targetUser, data);

  if (connection.error) {
    return ctx.respond(connection.error.message, { code: connection.error.code });
  }

  const { id } = connection;
  const refreshToken = connection.record?.token?.refresh_token;

  if (!refreshToken) {
    return ctx.respond('No refresh token found', { code: 400 });
  }

  // The lease decides who talks to the provider
  // ([#783](https://github.com/Omega-JS-Stack/omega/issues/783)): a refresh
  // token is one-time at providers that rotate it (Twitch), so two instances
  // refreshing at once spend it twice and the loser stores a dead token.
  const { won, missing, lease, updatedUNIX, token: leasedToken } = await acquireRefreshLease({ admin, uid: targetUid, provider: data.provider, id });

  // The record vanished between the read above and the lease: nothing to spend
  if (missing) {
    return ctx.respond('No refresh token found', { code: 400 });
  }

  // The LOSER touches the provider not at all — it waits for the winner's write
  // and answers the token that landed
  if (!won) {
    ctx.log('Connections refresh already in flight', { provider: data.provider, instance: lease.instance });

    const waited = await awaitRefreshedToken({
      admin,
      uid: targetUid,
      provider: data.provider,
      id,
      since: updatedUNIX,
    });

    if (waited.outcome === 'refreshed') {
      return ctx.respond({ success: true, token: waited.token });
    }

    // The winner's own call failed, so the stored token is the PRE-refresh one:
    // answering it as a success would hand back a token the provider may already
    // have invalidated. A conflict is the honest answer, and a retry wins the
    // lease outright
    if (waited.outcome === 'abandoned') {
      return ctx.respond(
        `The refresh of ${data.provider} started by another instance did not complete. Try again.`,
        { code: 409 },
      );
    }

    return ctx.respond(
      `A refresh of ${data.provider} started by instance ${lease.instance} has not finished after ${LEASE_WAIT_MS / 1000} seconds. Try again.`,
      { code: 409 },
    );
  }

  // The lease is held from here: every exit below either writes it away with the
  // token or clears it in the finally, so a failure never wedges the record
  let released = false;

  try {
    // The provider is called with the token the TRANSACTION saw, never the
    // pre-lease read: between buildContext() and the lease another instance may
    // have rotated it, and spending a superseded refresh token is the whole bug.
    // A record that vanished in that window has nothing to spend
    if (!leasedToken?.refresh_token) {
      return ctx.respond('No refresh token found', { code: 400 });
    }

    // Refresh — the provider's own step when it declares one (same promise chain
    // as the exchange above: an override may return or throw synchronously)
    const refreshResponse = await Promise.resolve().then(() => runStep(connectionProvider, 'refresh', buildGrantContext({
      provider: connectionProvider,
      providerName: data.provider,
      omega,
      ctx,
      uid: targetUid,
      clientId,
      clientSecret,
      token: leasedToken,
    }))).catch(e => e);

    if (refreshResponse instanceof Error) {
      return ctx.respond(`Token refresh failed: ${refreshResponse.message}`, { code: 500 });
    }

    const token = {
      access_token: refreshResponse.access_token,
      refresh_token: refreshResponse.refresh_token || leasedToken.refresh_token, // Some providers don't return new refresh token
      token_type: refreshResponse.token_type,
      expires_in: refreshResponse.expires_in,
      scope: refreshResponse.scope,
    };

    // Update stored tokens — and drop the lease in the SAME write, so the record
    // is never one write away from consistent
    await admin.firestore().doc(`users/${targetUid}`).set({
      connections: {
        [data.provider]: {
          [id]: {
            type: 'oauth2',
            token,
            updated: {
              timestamp: ctx.meta.startTime.timestamp,
              timestampUNIX: ctx.meta.startTime.timestampUNIX,
            },
            refreshing: FieldValue.delete(),
          },
        },
      },
      metadata: ctx.metadata({ tag: 'user/connections' }),
    }, { merge: true });

    released = true;

    // The token rides the answer, so a trusted service refreshes and reads in
    // ONE call — and a loser answers the same shape
    return ctx.respond({ success: true, token });
  } finally {
    if (!released) {
      // The lease expires on its own in 30 seconds; a clear that fails on the
      // way out of a failure must not replace the failure being reported
      await clearRefreshLease({ admin, uid: targetUid, provider: data.provider, id })
        .catch((e) => ctx.log('Connections refresh lease clear failed', { provider: data.provider, message: e.message }));
    }
  }
}
