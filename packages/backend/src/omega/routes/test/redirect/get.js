/**
 * GET /test/redirect
 * Exercises ctx.redirect(). Development-only like the rest of the `test/`
 * folder (the middleware gates the whole family), and RELATIVE PATHS ONLY.
 */
export default async ({ ctx, data }) => {

  // Get URL from settings (defaults to the site root)
  const url = data.url;

  // Reflecting a caller-supplied absolute URL would make this an open redirect,
  // so anything the shared return-path rule does not call a site path is refused.
  // Loaded on a call, not at load.
  const { isSitePath } = await import('@omega.js/client/modules/site-path.js');

  if (!isSitePath(url)) {
    // The refused value is logged, never echoed into the response body.
    ctx.log('Refusing to redirect to a non-relative URL', url);

    return ctx.respond('Only relative paths may be redirected to', { code: 400 });
  }

  ctx.log('Redirecting', url);

  return ctx.redirect(url);
};
