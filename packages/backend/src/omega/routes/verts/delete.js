/**
 * DELETE /omega/verts - Delete a house vert
 * Admin-only.
 */
import { resetInventoryCache } from './utils.js';

export default async ({ ctx, omega, user, data, analytics }) => {

  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }
  if (!user.roles.admin) {
    return ctx.respond('Admin access required', { code: 403 });
  }

  const admin = omega.firebase.admin;
  const vertId = (data.id || '').trim();

  if (!vertId) {
    return ctx.respond('Vert ID is required', { code: 400 });
  }

  const docRef = admin.firestore().doc(`verts/${vertId}`);
  const doc = await docRef.get();

  if (!doc.exists) {
    return ctx.respond('Vert not found', { code: 404 });
  }

  await docRef.delete();

  // Same-instance inventory freshness
  resetInventoryCache();

  ctx.log('verts deleted:', { vertId });

  analytics.event('verts', { action: 'delete' });

  return ctx.respond({
    success: true,
    deleted: vertId,
  });
};
