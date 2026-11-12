/**
 * POST /admin/payment - Payment provider webhook
 * Admin-only endpoint to process payment events
 */
import jetpack from 'fs-jetpack';
import { pathToFileURL } from 'url';

export default async ({ ctx, omega, user, data, analytics }) => {

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Require admin
  if (!user.roles.admin) {
    return ctx.respond('Admin required.', { code: 403 });
  }

  // Check for productId in payload
  const productId = data?.payload?.details?.productIdGlobal;
  if (!productId) {
    return ctx.respond('No productId', { code: 400 });
  }

  const providerPath = `${omega.cwd}/payment-providers/${productId}.js`;

  ctx.log('Loading payment provider:', providerPath);

  // Check if provider exists
  if (!jetpack.exists(providerPath)) {
    ctx.warn('Subprovider does not exist:', providerPath);
    return ctx.respond({});
  }

  // Load provider
  let provider;
  try {
    provider = new ((await import(pathToFileURL(providerPath).href)).default);
    provider.omega = omega;
  } catch (e) {
    ctx.error('Subprovider failed to load:', providerPath, e);
    return ctx.respond({});
  }

  // Process payment
  const result = await provider.process(data).catch(e => e);

  if (result instanceof Error) {
    return ctx.respond(`Payment provider @ "${providerPath}" failed: ${result}`, { code: 500 });
  }

  // Track analytics
  analytics.event('admin/payment', { productId: productId });

  return ctx.respond(result);
};
