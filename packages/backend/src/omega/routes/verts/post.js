/**
 * POST /omega/verts - Create a house vert
 * Admin-only. Saves to the verts collection (the serve route's inventory).
 */
import { isHttpUrl, resetInventoryCache } from './utils.js';

export default async ({ ctx, omega, user, data, analytics }) => {

  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }
  if (!user.roles.admin) {
    return ctx.respond('Admin access required', { code: 403 });
  }

  if (!isHttpUrl(data.link)) {
    return ctx.respond('link must be a valid http(s) URL', { code: 400 });
  }

  const admin = omega.firebase.admin;
  const vertId = data.id;

  const doc = {
    id: vertId,
    enabled: data.enabled,
    title: data.title,
    description: data.description,
    button: data.button,
    link: data.link,
    image: data.image,
    footer: data.footer,
    weight: data.weight,
    targeting: data.targeting,
    whitelist: data.whitelist,
    blacklist: data.blacklist,
    metadata: {
      created: {
        timestamp: ctx.meta.startTime.timestamp,
        timestampUNIX: ctx.meta.startTime.timestampUNIX,
      },
      updated: {
        timestamp: ctx.meta.startTime.timestamp,
        timestampUNIX: ctx.meta.startTime.timestampUNIX,
      },
    },
  };

  await admin.firestore().doc(`verts/${vertId}`).set(doc);

  // Same-instance inventory freshness
  resetInventoryCache();

  ctx.log('verts created:', { vertId });

  analytics.event('verts', { action: 'create' });

  return ctx.respond({
    success: true,
    vert: { ...doc },
  });
};
