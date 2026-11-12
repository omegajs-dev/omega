/**
 * POST /special/electron-client - Setup a @omega.js/desktop client
 * Returns client configuration with optional auth
 */
import { buildPublicConfig } from '../../brand/public-config.js';

export default async ({ ctx, omega, data, analytics }) => {
  const admin = omega.firebase.admin;

  // brandId/brand fallback to omega.config
  let uid = data.uid;
  let config = data.config;

  let uuid = null;
  let signInToken = null;

  // If authenticated, get user and create custom token
  const user = ctx.user;
  if (user.authenticated && user.roles?.admin) {
    uid = user.auth?.uid ?? null;

    if (uid) {
      try {
        signInToken = await admin.auth().createCustomToken(uid);
      } catch (e) {
        return ctx.respond(`Failed to create custom token: ${e}`, { code: 500 });
      }
    }
  }

  // Generate UUID if uid is available
  if (uid) {
    const uuidLib = omega.require('uuid');
    const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    uuid = uuidLib.v5(uid, NAMESPACE);
  }

  // Validate config — kept only when the REQUEST is admin-authenticated (the
  // omega-admin-key header); the config payload itself never carries a secret
  if (user.roles?.admin) {
    ctx.log('Validated config', config);
  } else {
    config = {};
  }

  // Track analytics
  analytics.event('special/electron-client', { action: 'setup' });

  return ctx.respond({
    uuid: uuid,
    signInToken: signInToken,
    timestamp: new Date().toISOString(),
    ip: ctx.request.geolocation.ip,
    country: ctx.request.geolocation.country,
    brand: buildPublicConfig(omega.config),
    config: config,
  });
};
