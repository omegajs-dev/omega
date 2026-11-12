/**
 * POST /admin/notification - Send FCM push notification
 * Admin-only endpoint to send push notifications.
 * Uses shared notification library (also used by marketing-campaigns cron).
 */
import notification from '../../../libraries/notification.js';

export default async ({ ctx, user, data, analytics }) => {
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }
  if (!user.roles.admin) {
    return ctx.respond('Admin required.', { code: 403 });
  }

  if (!data.notification.title || !data.notification.body) {
    return ctx.respond('Parameters <title> and <body> required', { code: 400 });
  }

  const result = await notification.send(ctx, {
    title: data.notification.title,
    body: data.notification.body,
    icon: data.notification.icon,
    clickAction: data.notification.clickAction
      || data.notification.click_action,
    filters: {
      tags: data.filters.tags || false,
      owner: data.filters.owner || null,
      token: data.filters.token || null,
      limit: data.filters.limit || null,
    },
  });

  analytics.event('admin/notification', { sent: result.sent });

  return ctx.respond(result);
};
