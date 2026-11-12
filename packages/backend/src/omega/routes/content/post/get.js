/**
 * GET /content/post - Fetch blog post from GitHub
 * Public endpoint to retrieve blog post content
 */
import { Octokit } from '@octokit/rest';
import { parse } from 'yaml';
import { cmsContext } from '../../../helpers/web-target.js';
import env from '../../../libraries/env.js';

export default async ({ ctx, omega, data, analytics }) => {

  // Check for GitHub configuration
  if (!env.has('GH_TOKEN')) {
    return ctx.respond('GitHub API key not configured.', { code: 500 });
  }

  // The SOURCE repo this reads from, and WHICH website inside it (#887): the
  // search is scoped to that target's folder, so two websites sharing one
  // backend never answer for each other
  let source;
  let target;
  try {
    ({ source, target } = cmsContext(omega.config, data.target));
  } catch (e) {
    return ctx.respond(e.message, { code: e.code });
  }

  // Setup Octokit
  const octokit = new Octokit({
    auth: env.get('GH_TOKEN'),
  });

  // Check for required parameters
  if (!data.url) {
    return ctx.respond('Missing required parameter: url', { code: 400 });
  }

  let url;
  try {
    url = new URL(data.url);
  } catch (e) {
    return ctx.respond('Invalid URL', { code: 400 });
  }

  // Get the post
  const filename = url.pathname.replace(/blog|\//ig, '');
  const repoInfo = { user: source.owner, name: source.name };
  const postsPath = `${target.path}/src/_posts`;
  const query = `title+repo:${repoInfo.user}/${repoInfo.name}+path:${postsPath}+filename:${filename}`;

  ctx.log('Running search', query, repoInfo);

  // Search the repo for the file matching the url
  const results = await octokit.rest.search.code({
    q: query,
  }).catch(e => e);

  ctx.log('Results', results);

  // Check for errors
  if (results instanceof Error) {
    return ctx.respond(`Error searching for post: ${results}`, { code: 500 });
  }
  if (results?.data?.total_count === 0) {
    return ctx.respond('Post not found', { code: 404 });
  }

  // Get the first result INSIDE this target: the `path:` qualifier narrows the
  // search, it does not bind it, so the folder is what decides here
  const firstResult = (results.data.items || []).find((item) => item.path.startsWith(`${postsPath}/`));
  if (!firstResult) {
    return ctx.respond(`Post not found in ${postsPath}`, { code: 404 });
  }

  // Fetch the content of the post
  const post = await octokit.rest.repos.getContent({
    owner: repoInfo.user,
    repo: repoInfo.name,
    path: firstResult.path,
  }).catch(e => e);

  ctx.log('Post', post);

  // Check for errors
  if (post instanceof Error) {
    return ctx.respond(`Error fetching post: ${post}`, { code: 500 });
  }

  // Decode the content
  const fullContent = Buffer.from(post.data.content, 'base64').toString();
  const splitContent = fullContent.split('---');
  const frontmatter = splitContent[1].trim();
  const body = splitContent.slice(2).join('---').trim();
  const parsed = parse(frontmatter);

  // Track analytics
  analytics.event('content/post', { action: 'get' });

  return ctx.respond({
    // Meta
    target: target.name,
    name: post.data.name,
    path: post.data.path,
    size: post.data.size,
    sha: post.data.sha,

    // Content
    frontmatter: frontmatter,
    body: body,

    // Parsed
    title: parsed.post.title,
    description: parsed.post.description,
    author: parsed.post.author,
    id: parsed.post.id,
    tags: parsed.post.tags,
    categories: parsed.post.categories,
    source: parsed.post.source || null,

    // Derived
    headerImageURL: `${url.origin}/assets/images/blog/post-${parsed.post.id}/${filename}.jpg`,
  });
};
