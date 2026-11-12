import { projectUserForLog } from '../../../helpers/log-redaction.js';

export default async ({ ctx, user }) => {

  // Log user info — the allow-listed projection, never the document: it carries
  // api.privateKey ([#632](https://github.com/Omega-JS-Stack/omega/issues/632))
  ctx.log('User:', projectUserForLog(user));

  // Return user info: the stored document, plus the verdict it cannot carry
  // (authenticated is the request's answer, never a stored field)
  return ctx.respond({ user, authenticated: user.authenticated });
};
