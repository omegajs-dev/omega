import path from 'path';
import { loadHandler } from '../../../libraries/load-handler.js';

/**
 * POST /admin/cron - Run cron job manually
 * Admin-only endpoint to trigger cron jobs
 */
export default async ({ ctx, omega, user, data, analytics }) => {

  // Require authentication (allow in dev)
  if (!user.authenticated && ctx.isProduction()) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Require admin (allow in dev)
  if (!user.roles.admin && ctx.isProduction()) {
    return ctx.respond('Admin required.', { code: 403 });
  }

  // Check for required parameter
  if (!data.id) {
    return ctx.respond('Missing parameter {id}', { code: 400 });
  }

  ctx.log('Running cron job:', data.id);

  // Run the cron job
  const cronPath = path.resolve(import.meta.dirname, `../../../events/cron/${data.id}.js`);
  const cronHandler = loadHandler(cronPath);
  const result = await cronHandler({ ctx, omega, context: {} }).catch(e => e);

  if (result instanceof Error) {
    return ctx.respond(result.message, { code: 500 });
  }

  // Track analytics
  analytics.event('admin/cron', { id: data.id });

  return ctx.respond(result);
};
