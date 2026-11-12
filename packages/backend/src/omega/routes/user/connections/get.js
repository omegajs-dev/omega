import { FieldValue } from 'firebase-admin/firestore';
import { buildContext, connectionRecords, resolveConnection, returnUrlError } from './_context.js';
import { disabledProviderError } from './_providers.js';
import { generateCsrfToken, generatePkcePair, encryptState } from './_state.js';
import { buildGrantContext, runStep } from './_grant.js';

/**
 * GET /user/connections - Read operations
 *
 * Actions:
 *   - authorize (default): Get authorization URL
 *   - status: Check connection status (one account, or every one of the provider)
 */
export default async ({ ctx, user, data }) => {
  // `status` takes an admin's `uid` — it checks the connection AT THE PROVIDER
  // (and may delete a dead one), which a trusted server may do on a user's
  // behalf. `authorize` does not: the URL it answers is opened by the
  // connecting user's OWN browser ([#782](https://github.com/Omega-JS-Stack/omega/issues/782))
  const context = await buildContext({ ctx, user, data, honorUid: data.action === 'status' });

  if (context.error) {
    return ctx.respond(context.error.message, { code: context.error.code });
  }

  ctx.log('Connections GET request', { action: data.action, provider: data.provider });

  switch (data.action) {
    case 'status':
      return processStatus(context);

    case 'authorize':
    default:
      return processAuthorize(context);
  }
};

// ============================================================================
// Handlers
// ============================================================================

async function processAuthorize(context) {
  const { ctx, omega, admin, connectionProvider, data, targetUid, clientId, clientSecret, redirectUri } = context;

  const disabled = disabledProviderError(data.provider, omega);

  if (disabled) {
    return ctx.respond(disabled.message, { code: disabled.code });
  }

  // The optional destination this connect comes back to
  // ([#784](https://github.com/Omega-JS-Stack/omega/issues/784)): a caller's
  // value, refused here — before anything is minted — when it is not a path
  const invalidReturn = returnUrlError(data);

  if (invalidReturn) {
    return ctx.respond(invalidReturn.message, { code: invalidReturn.code });
  }

  if (!clientId) {
    return ctx.respond(`Missing client_id for ${data.provider} provider`, { code: 500 });
  }

  // Generate CSRF token
  const csrfToken = generateCsrfToken();

  // PKCE, when the provider declares it: the verifier is minted here and rides
  // the SAME usage entry as the CSRF token, read back (and deleted) at tokenize
  const pkce = connectionProvider.pkce ? generatePkcePair() : null;

  // Store CSRF token in user's usage document (auto-cleaned daily)
  await admin.firestore().doc(`usage/${targetUid}`).set({
    connections: {
      [data.provider]: {
        csrf: csrfToken,
        // A verifier is a one-time secret, never a log line and never the state
        verifier: pkce ? pkce.verifier : null,
        createdAt: Date.now(),
      },
    },
  }, { merge: true });

  // Build minimal state (no unnecessary data)
  const stateData = {
    provider: data.provider,
    uid: targetUid,
    csrf: csrfToken,
    ts: Date.now(),
    // Where the callback page lands when this connect comes back
    // ([#784](https://github.com/Omega-JS-Stack/omega/issues/784)). It rides the
    // ENCRYPTED state because that is the only thing that survives the trip out
    // to the provider and back, and the key stays absent when no returnUrl was
    // passed — the page's own default is what answers then
    ...(data.returnUrl ? { returnUrl: data.returnUrl } : {}),
  };

  // Encrypt state
  let encryptedState;

  try {
    encryptedState = encryptState(stateData);
  } catch (e) {
    return ctx.respond(e.message, { code: 500 });
  }

  // Set scopes from app config, fall back to provider defaults
  const appScopes = omega.config?.connections?.[data.provider]?.scope || [];
  const finalScopes = appScopes.length > 0 ? appScopes : (connectionProvider.scope || []);

  // Build authorization URL — the provider's own step when it declares one
  const urlString = await runStep(connectionProvider, 'authorize', buildGrantContext({
    provider: connectionProvider,
    providerName: data.provider,
    omega,
    ctx,
    uid: targetUid,
    clientId,
    clientSecret,
    redirectUri,
    scope: finalScopes,
    state: encryptedState,
    pkce,
  }));

  ctx.log('Connections authorize URL generated');

  if (data.redirect) {
    return ctx.redirect(urlString);
  }

  return ctx.respond({ url: urlString });
}

async function processStatus(context) {
  const { ctx, data, targetUser } = context;

  // `returnUrl` belongs to `authorize` alone; a caller passing it here fails
  // loudly rather than being silently landed nowhere (the #782 rule for `uid`)
  if (data.returnUrl) {
    return ctx.respond('The returnUrl parameter is only accepted by action=authorize.', { code: 400 });
  }

  // With no `id` and several accounts linked, every one is checked and listed,
  // each entry the single answer's `status` plus the account it is for
  const records = connectionRecords(targetUser, data.provider);

  if (!data.id && Object.keys(records).length > 1) {
    const connections = [];

    for (const [id, record] of Object.entries(records)) {
      connections.push({ id, identity: record.identity, status: await checkConnection(context, id, record) });
    }

    return ctx.respond({ connections });
  }

  const { id, record } = resolveConnection(targetUser, data);

  return ctx.respond({ status: await checkConnection(context, id, record) });
}

/**
 * One stored account's status: `disconnected` with no refresh token, else the
 * provider's own `status` step when it has one. A dead account is deleted when
 * the call asked for `removeInvalidTokens`.
 *
 * @param {object} context - The route context buildContext() answered
 * @param {string|null} id - The account's identity id, null when none is stored
 * @param {object|null} record - The stored record
 * @returns {Promise<string>} `connected`, `disconnected` or `error`
 */
async function checkConnection(context, id, record) {
  const { ctx, omega, admin, connectionProvider, data, targetUid, clientId, clientSecret } = context;
  const storedToken = record?.token;

  if (!storedToken?.refresh_token) {
    return 'disconnected';
  }

  // A provider that can ASK answers from there; without a `status` step, a
  // stored refresh token IS the answer: there is nothing else to read
  if (typeof connectionProvider.status !== 'function') {
    return 'connected';
  }

  const status = await Promise.resolve().then(() => runStep(connectionProvider, 'status', buildGrantContext({
    provider: connectionProvider,
    providerName: data.provider,
    omega,
    ctx,
    uid: targetUid,
    clientId,
    clientSecret,
    token: storedToken,
  }))).catch(() => 'error');

  if ((status === 'disconnected' || status === 'error') && data.removeInvalidTokens) {
    await admin.firestore().doc(`users/${targetUid}`).set({
      connections: { [data.provider]: { [id]: FieldValue.delete() } },
      metadata: ctx.metadata({ tag: 'user/connections' }),
    }, { merge: true });
    ctx.log(`Removed invalid token for user: ${targetUid}`);
  }

  return status;
}
