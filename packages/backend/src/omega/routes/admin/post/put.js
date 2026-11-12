/**
 * PUT /admin/post - Edit blog post
 * Admin/blogger endpoint to edit existing blog posts via GitHub
 */
import moment from 'moment';
import powertools from 'node-powertools';
import { Octokit } from '@octokit/rest';

import dispatchDeploy from './dispatch-deploy.js';
import { uploadPost } from './upload-post.js';
import { cmsContext } from '../../../helpers/web-target.js';
import env from '../../../libraries/env.js';

export default async ({ ctx, omega, user, data, analytics }) => {
  const fetch = omega.require('wonderful-fetch');

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

  // The SOURCE repo this commits to, and WHICH website inside it (#887): the
  // read below is scoped to that target, so an edit lands in the same folder
  // the create wrote to
  let source;
  let target;
  try {
    ({ source, target } = cmsContext(omega.config, data.target));
  } catch (e) {
    return ctx.respond(e.message, { code: e.code });
  }

  ctx.log('main(): settings', data);

  const now = ctx.meta.startTime.timestamp;
  const bemRepo = { user: source.owner, name: source.name };

  // Setup Octokit
  const octokit = new Octokit({
    auth: env.get('GH_TOKEN'),
  });

  // Check for required values
  if (!data.url) {
    return ctx.respond('Missing required parameter: url', { code: 400 });
  }
  if (!data.body) {
    return ctx.respond('Missing required parameter: body', { code: 400 });
  }

  // Fix URL
  data.url = data.url
    .replace(/blog\//ig, '')
    .replace(/^\/|\/$/g, '')
    .trim();

  // Fix body
  data.body = data.body
    .replace(powertools.regexify(`/# ${data.title}/i`), '')
    .replace(/\n\n\n+/g, '\n\n')
    .trim();

  // Fix other values
  data.target = target.name;
  data.postPath = `${target.path}/src/_posts/${moment(now).format('YYYY')}/${data.postPath}`;
  // Always the brand's own repo — caller-supplied values would let a blogger-role
  // user point the shared GH_TOKEN at any repo it can write
  data.githubUser = bemRepo.user;
  data.githubRepo = bemRepo.name;

  ctx.log('main(): Editing post...', data);

  // Fetch existing post using NEW API format
  const fetchedPost = await fetchPost(ctx, data.url, data.target).catch(e => e);
  if (fetchedPost instanceof Error) {
    return ctx.respond(fetchedPost.message, { code: fetchedPost.status || 404 });
  }

  // Upload post
  const uploadResult = await uploadPost(ctx, octokit, data, fetchedPost).catch(e => e);
  if (uploadResult instanceof Error) {
    return ctx.respond(uploadResult.message, { code: uploadResult.status || 500 });
  }

  ctx.log('main(): uploadPost', uploadResult);

  // D13: content-publish implies deploy (deploy: false opts out)
  await dispatchDeploy(ctx, octokit, data);

  // Track analytics
  analytics.event('admin/post', { action: 'edit' });

  return ctx.respond(data);
};

// Helper: Fetch existing post
async function fetchPost(ctx, url, target) {
  const omega = ctx.omega;
  const fetch = omega.require('wonderful-fetch');

  // Use NEW API format
  const result = await fetch(`${omega.getApiUrl()}/omega/content/post`, {
    method: 'get',
    response: 'json',
    timeout: 190000,
    tries: 1,
    query: {
      url: url,
      // The read route searches inside THIS target's folder (#887)
      target: target,
    },
  });

  ctx.log('fetchPost(): Result', result);

  return result;
}
