/**
 * POST /general/email - Send templated email
 * Public endpoint to send email using predefined templates
 */
import path from 'path';
import lodash from 'lodash';
import { loadTemplate } from '../../../libraries/load-provider.js';

const { merge } = lodash;

export default async ({ ctx, omega, data }) => {
  // Validate required parameters
  if (!data.id) {
    return ctx.respond('Parameter {id} is required.', { code: 400 });
  }
  if (!data.email) {
    return ctx.respond('Parameter {email} is required.', { code: 400 });
  }

  const DEFAULT = {
    spamFilter: {
      ip: 3,
      email: 3,
    },
    delay: 1,
    payload: {},
  };

  // Load email template — colons in id are converted to nested folders
  // (e.g. "general:download-app-link" → templates/general/download-app-link.js);
  // loadTemplate validates the id so it can never resolve outside templates/
  let emailPayload;
  try {
    const script = loadTemplate(path.join(import.meta.dirname, 'templates'), data.id);
    emailPayload = merge(
      {},
      DEFAULT,
      script(data, omega.config),
    );
  } catch (e) {
    return ctx.respond(`${data.id} is not a valid email ID.`, { code: 400 });
  }

  // Check spam filter using local storage
  const storage = omega.storage({ temporary: true });
  const ipPath = ['api:general:email', 'ips', ctx.request.geolocation.ip || 'unknown'];
  const emailPath = ['api:general:email', 'emails', data.email];

  const ipData = storage.get(ipPath).value() || {};
  const emailData = storage.get(emailPath).value() || {};

  ipData.count = (ipData.count || 0) + 1;
  ipData.firstRequestTime = ipData.firstRequestTime || new Date().toISOString();
  ipData.lastRequestTime = new Date().toISOString();

  emailData.count = (emailData.count || 0) + 1;
  emailData.firstRequestTime = emailData.firstRequestTime || new Date().toISOString();
  emailData.lastRequestTime = new Date().toISOString();

  storage.set(ipPath, ipData).write();
  storage.set(emailPath, emailData).write();

  ctx.log('Storage:', storage.getState()['api:general:email']);

  // Check spam thresholds
  if (ipData.count >= emailPayload.spamFilter.ip || emailData.count >= emailPayload.spamFilter.email) {
    ctx.error(`Spam filter triggered ip=${ipData.count}, email=${emailData.count}`);
    return ctx.respond({ success: true });
  }

  // Add delay if specified
  if (emailPayload.delay) {
    emailPayload.payload.sendAt = Math.round((new Date().getTime() + emailPayload.delay) / 1000);
  }

  ctx.log('Email payload:', emailPayload);

  // Send email directly via library
  const email = ctx.email;
  const result = await email.send(emailPayload.payload).catch(e => e);

  if (result instanceof Error) {
    return ctx.respond(result.message, { code: result.code || 500 });
  }

  ctx.log('Response:', result.status);

  // Track analytics
  ctx.analytics.event('general/email', { id: data.id });

  return ctx.respond({ success: true });
};
