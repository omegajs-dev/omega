/**
 * POST /admin/repo/content - Write content to GitHub repo
 * Admin/blogger endpoint to write files to GitHub
 */
import { Octokit } from '@octokit/rest';
import { cmsContext } from '../../../../helpers/web-target.js';
import env from '../../../../libraries/env.js';
import { uploadContent } from './upload-content.js';

export default async ({ ctx, omega, user, data, analytics }) => {

  // Require authentication
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Require admin or blogger
  if (!user.roles.admin && !user.roles.blogger) {
    return ctx.respond('Admin required.', { code: 403 });
  }

  // Check for GitHub configuration
  if (!env.has('GH_TOKEN')) {
    return ctx.respond('GitHub API key not configured.', { code: 500 });
  }

  // The SOURCE repo this commits to, and WHICH website inside it (#887):
  // `path` is SITE-relative, and the target's folder is what turns it into a
  // repo path
  let source;
  let target;
  try {
    ({ source, target } = cmsContext(omega.config, data.target));
  } catch (e) {
    return ctx.respond(e.message, { code: e.code });
  }

  ctx.log('main(): settings', data);

  const bemRepo = { user: source.owner, name: source.name };

  // Setup Octokit
  const octokit = new Octokit({
    auth: env.get('GH_TOKEN'),
  });

  // Check for required values
  if (!data.path) {
    return ctx.respond('Missing required parameter: path', { code: 400 });
  }
  if (!data.content) {
    return ctx.respond('Missing required parameter: content', { code: 400 });
  }

  // Fix other values
  data.type = data.type;
  // `path` stays the caller's site-relative value; `repoPath` is where it lands
  data.target = target.name;
  data.repoPath = `${target.path}/${data.path}`;
  // Always the brand's own repo — caller-supplied values would let a blogger-role
  // user point the shared GH_TOKEN at any repo it can write
  data.githubUser = bemRepo.user;
  data.githubRepo = bemRepo.name;

  ctx.log('main(): Creating file...', data);

  // Upload content
  const uploadResult = await uploadContent(ctx, octokit, data).catch(e => e);
  if (uploadResult instanceof Error) {
    return ctx.respond(uploadResult.message, { code: uploadResult.status || 500 });
  }

  ctx.log('main(): uploadContent', uploadResult);

  // Track analytics
  analytics.event('admin/repo/content', { action: 'write' });

  return ctx.respond(data);
};
