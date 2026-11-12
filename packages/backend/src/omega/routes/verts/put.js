/**
 * PUT /omega/verts - Update a house vert
 * Admin-only. Only provided fields are updated; id and metadata.created
 * are immutable.
 */
import { isHttpUrl, resetInventoryCache } from './utils.js';

// Fields a PUT may update (id + metadata are immutable)
const EDITABLE_FIELDS = ['enabled', 'title', 'description', 'button', 'link', 'image', 'footer', 'weight', 'targeting', 'whitelist', 'blacklist'];

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

  // Presence comes from the RAW request data (the schema engine coerces
  // absent fields to type-empty values, so settings alone can't distinguish
  // "absent" from "cleared")
  const provided = Object.keys(ctx.request.data || {});

  if (provided.includes('link') && !isHttpUrl(data.link)) {
    return ctx.respond('link must be a valid http(s) URL', { code: 400 });
  }

  const docRef = admin.firestore().doc(`verts/${vertId}`);
  const doc = await docRef.get();

  if (!doc.exists) {
    return ctx.respond('Vert not found', { code: 404 });
  }

  // Build update from provided fields only
  const update = {
    metadata: {
      updated: {
        timestamp: ctx.meta.startTime.timestamp,
        timestampUNIX: ctx.meta.startTime.timestampUNIX,
      },
    },
  };

  for (const field of EDITABLE_FIELDS) {
    if (provided.includes(field) && data[field] !== undefined) {
      update[field] = data[field];
    }
  }

  await docRef.set(update, { merge: true });

  // Same-instance inventory freshness
  resetInventoryCache();

  ctx.log('verts updated:', { vertId, update });

  analytics.event('verts', { action: 'update' });

  // Fetch updated doc
  const updated = await docRef.get();

  return ctx.respond({
    success: true,
    vert: { id: vertId, ...updated.data() },
  });
};
