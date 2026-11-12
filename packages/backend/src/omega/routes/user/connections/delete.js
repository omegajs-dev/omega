import { FieldValue } from 'firebase-admin/firestore';
import { buildContext, resolveConnection } from './_context.js';
import { buildGrantContext, runStep, REVOKE_UNSUPPORTED } from './_grant.js';

/**
 * DELETE /user/connections - Remove a connection
 *
 * Revokes tokens with the provider (best effort) and removes the connection.
 */
export default async ({ ctx, user, data }) => {
  // An admin may pass `uid`: revoking happens AT THE PROVIDER, on the user's
  // behalf, and needs no browser ([#782](https://github.com/Omega-JS-Stack/omega/issues/782))
  const context = await buildContext({ ctx, user, data, honorUid: true });

  if (context.error) {
    return ctx.respond(context.error.message, { code: context.error.code });
  }

  const { omega, admin, connectionProvider, targetUid, targetUser, clientId, clientSecret } = context;

  ctx.log('Connections DELETE request', { provider: data.provider });

  const connection = resolveConnection(targetUser, data);

  if (connection.error) {
    return ctx.respond(connection.error.message, { code: connection.error.code });
  }

  const storedToken = connection.record?.token;

  // Revoking is BEST EFFORT and never gates the delete
  // ([#793](https://github.com/Omega-JS-Stack/omega/issues/793)): the default
  // step is the RFC 7009 POST, a provider that declares no `urls.revoke` answers
  // `unsupported` (Spotify has no endpoint at all), and a provider that refuses
  // throws — the user asked to be disconnected either way.
  if (storedToken?.access_token) {
    const outcome = await Promise.resolve()
      .then(() => runStep(connectionProvider, 'revoke', buildGrantContext({
        provider: connectionProvider,
        providerName: data.provider,
        omega,
        ctx,
        uid: targetUid,
        clientId,
        clientSecret,
        token: storedToken,
      })))
      .then((answer) => (answer === REVOKE_UNSUPPORTED ? REVOKE_UNSUPPORTED : 'revoked'))
      .catch((e) => `failed: ${e.message}`);

    ctx.log('Connections revoke', { provider: data.provider, outcome });
  }

  // Delete that one account's record; the provider's other accounts stay. With
  // no record stored there is nothing to delete, and the answer is the same
  if (connection.id) {
    await admin.firestore().doc(`users/${targetUid}`).set({
      connections: { [data.provider]: { [connection.id]: FieldValue.delete() } },
      metadata: ctx.metadata({ tag: 'user/connections' }),
    }, { merge: true });
  }

  return ctx.respond({ success: true });
};
