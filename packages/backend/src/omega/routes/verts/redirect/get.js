/**
 * GET /omega/verts/redirect - Fail-closed vert click redirect (public)
 *
 * Query params:
 *   id     — the vert to redirect for (required)
 *   parent — the referring host (the utm_source fallback)
 *   brand  — the referring brand's id (becomes utm_source when given)
 *
 * Looks the vert up by id and 302s to ITS stored link only — never to a
 * caller-supplied URL. Unknown id (or a vert without a valid http(s) link)
 * → 404. UTM params: utm_source=<brand id, else parent host, if given>,
 * utm_medium=omega-vert, utm_campaign=<vertId> — added by the shared tagger,
 * so any param the advertiser already put on the link wins.
 */
import { getVertById, normalizeHost, normalizeBrandId, isHttpUrl, buildClickDestination } from '../utils.js';

export default async ({ ctx, omega, data, analytics }) => {

  const vert = await getVertById(omega, data.id);

  // Fail closed — only a known vert's own stored link ever redirects
  if (!vert || !isHttpUrl(vert.link)) {
    return ctx.respond('Vert not found', { code: 404 });
  }

  const parentHost = normalizeHost(data.parent);
  const brandId = normalizeBrandId(data.brand);
  const destination = await buildClickDestination(vert, parentHost, brandId);

  // Track the click server-side (Analytics lane — no gtag inside the frame)
  analytics.event('verts/redirect', { action: 'click', vertId: vert.id, parent: parentHost });

  ctx.log('verts/redirect: Redirecting', { vertId: vert.id, url: destination });

  return ctx.redirect(destination);
};
