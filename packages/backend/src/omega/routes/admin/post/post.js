/**
 * POST /admin/post - Create blog post
 * Admin/blogger endpoint to create blog posts via GitHub
 * Uses Git Trees API to commit all files (images + post) in a single commit
 */
import moment from 'moment';
import jetpack from 'fs-jetpack';
import powertools from 'node-powertools';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { Octokit } from '@octokit/rest';
import lodash from 'lodash';

import deduplicateImageAlts from './deduplicate-image-alts.js';
import dispatchDeploy from './dispatch-deploy.js';
import { applyImageCDNParams, formatImageDownloadError, convertToJpeg, resizeImage } from './images.js';
import { commitAll } from './commit-all.js';
import { cmsContext } from '../../../helpers/web-target.js';
import env from '../../../libraries/env.js';

const { get, set } = lodash;

const POST_TEMPLATE = jetpack.read(`${import.meta.dirname}/templates/post.html`);
// SITE-relative, like every path here: the web target's folder is prefixed at
// composition time
const IMAGE_PATH_SRC = `src/assets/images/blog/post-{id}/`;
const IMAGE_REGEX = /(?:!\[(.*?)\]\((.*?)\))/img;

// Non-JPG raster sources are converted to JPEG at ingest rather than rejected
// — stock CDNs beyond Unsplash (Pexels, Pixabay) commonly serve png/webp.
// Anything not in this list (and not already .jpg) is still rejected.
const CONVERTIBLE_IMAGE_EXTS = ['.png', '.webp'];

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

  // The SOURCE repo this commits to, and WHICH website inside it (#887): the
  // brand's one web target by default, the named one when it runs several
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
  if (!data.title) {
    return ctx.respond('Missing required parameter: title', { code: 400 });
  }
  if (!data.url) {
    return ctx.respond('Missing required parameter: url', { code: 400 });
  }
  if (!data.description) {
    return ctx.respond('Missing required parameter: description', { code: 400 });
  }
  if (!data.headerImageURL) {
    return ctx.respond('Missing required parameter: headerImageURL', { code: 400 });
  }
  if (!data.body) {
    return ctx.respond('Missing required parameter: body', { code: 400 });
  }

  // Fix URL — strip blog/ prefix then slugify (slugify handles slashes/special chars)
  data.url = omega.utilities.slugify(data.url.replace(/blog\//ig, ''));

  // Fix body
  data.body = data.body
    .replace(powertools.regexify(`/# ${data.title}/i`), '')
    .replace(/\n\n\n+/g, '\n\n')
    .trim();

  // Fix other values
  data.author = data.author || powertools.random(['alex-raeburn', 'rare-ivy', 'christina-hill']);
  data.affiliate = data.affiliate;
  data.tags = data.tags;
  data.categories = data.categories;
  data.layout = data.layout;
  data.source = data.source || null;
  data.date = moment(data.date || now).subtract(1, 'days').format('YYYY-MM-DD');
  data.id = data.id || Math.round(new Date(now).getTime() / 1000);
  data.target = target.name;
  data.directory = `${target.path}/src/_posts/${moment(now).format('YYYY')}/${data.postPath}`;
  // Always the brand's own repo — caller-supplied values would let a blogger-role
  // user point the shared GH_TOKEN at any repo it can write
  data.githubUser = bemRepo.user;
  data.githubRepo = bemRepo.name;

  ctx.log('main(): Creating post...', data);

  // Download all images and collect file data
  const imageFiles = await downloadImages(ctx, data, target).catch(e => e);
  if (imageFiles instanceof Error) {
    return ctx.respond(imageFiles.message, { code: 400 });
  }

  // Rewrite body to use @post/ prefix for extracted images
  for (const file of imageFiles) {
    if (file.originalUrl) {
      data.body = data.body.split(file.originalUrl).join(`@post/${file.filename}`);
    }
  }

  // Generate post content from template
  const formattedContent = powertools.template(
    POST_TEMPLATE,
    formatClone(data),
  );

  // Build post file entry
  data.path = `${data.directory}/${data.date}-${data.url}.md`;
  const allFiles = [
    ...imageFiles.map(img => ({
      path: img.githubPath,
      content: img.base64,
      encoding: 'base64',
    })),
    {
      path: data.path,
      content: Buffer.from(formattedContent).toString('base64'),
      encoding: 'base64',
    },
  ];

  // Commit all files in a single commit
  const commitResult = await commitAll(ctx, octokit, data, allFiles).catch(e => e);
  if (commitResult instanceof Error) {
    return ctx.respond(commitResult.message, { code: 500 });
  }

  ctx.log('main(): commitAll', commitResult);

  // D13: content-publish implies deploy (deploy: false opts out)
  await dispatchDeploy(ctx, octokit, data);

  // Track analytics
  analytics.event('admin/post', { action: 'create' });

  return ctx.respond(data);
};

// Helper: Download all images and return file data (no GitHub uploads)
async function downloadImages(ctx, data, target) {
  const files = [];
  const assetsPath = `${target.path}/${powertools.template(IMAGE_PATH_SRC, data)}`;

  const matches = data.body.matchAll(IMAGE_REGEX);
  const images = Array.from(matches).map(match => ({
    src: match[2] || '',
    alt: match[1] || uuidv4(),
    header: false,
  }));

  // Add heading image to beginning
  images.unshift({
    src: data.headerImageURL,
    alt: data.url,
    header: true,
  });

  // Deduplicate alt-text across different image URLs (mutates images in place,
  // returns rewritten body). See deduplicate-image-alts.js for full rationale.
  const dedup = deduplicateImageAlts(images, data.body);
  data.body = dedup.body;

  ctx.log('downloadImages(): images', images);

  if (!images.length) {
    return files;
  }

  for (let index = 0; index < images.length; index++) {
    const image = images[index];

    // Download image
    const download = await downloadImage(ctx, image.src, image.alt).catch(e => e);

    ctx.log('downloadImages(): download', download);

    if (download instanceof Error) {
      if (image.header) {
        throw download;
      } else {
        ctx.warn('downloadImages(): Skipping NON-HEADER image download due to error', download);
        continue;
      }
    }

    // Read file content as base64
    const base64 = jetpack.read(download.path, 'buffer').toString('base64');

    files.push({
      githubPath: `${assetsPath}${download.filename}`,
      filename: download.filename,
      base64: base64,
      originalUrl: image.header ? null : image.src,
    });
  }

  return files;
}

// Helper: Download image
async function downloadImage(ctx, src, alt) {
  const fetch = ctx.omega.require('wonderful-fetch');
  const hyphenated = ctx.omega.utilities.slugify(alt);

  // Request a server-side resize from supported CDNs so we never download
  // a massive original (e.g. 5184×3456 → ~71MB decoded). This keeps peak
  // memory well within Cloud Functions limits even at 256MB.
  const url = applyImageCDNParams(src);

  ctx.log(`downloadImage(): src=${src}, url=${url}, alt=${alt}, hyphenated=${hyphenated}`);

  const result = await fetch(url, {
    method: 'get',
    download: `${ctx.tmpdir}/${hyphenated}`,
  }).catch(e => {
    throw new Error(formatImageDownloadError(src, e));
  });

  result.filename = path.basename(result.path);
  result.ext = path.extname(result.path);

  ctx.log('downloadImage(): Result', result.path);

  // Convert supported non-JPG formats in place (mutates result.path/filename/ext)
  if (CONVERTIBLE_IMAGE_EXTS.includes(result.ext)) {
    await convertToJpeg(ctx, result);
  }

  if (result.ext !== '.jpg') {
    throw new Error(`Images must be .jpg, .png, or .webp (got ${result.ext}): ${src}`);
  }

  // Resize in place if the long edge exceeds IMAGE_MAX_DIMENSION
  await resizeImage(ctx, result.path);

  return result;
}

// Helper: Format clone for templating
function formatClone(payload) {
  powertools.getKeys(payload).forEach((item) => {
    const value = get(payload, item);
    const isArray = Array.isArray(value);

    if (isArray) {
      set(payload, item, JSON.stringify(value));
    }
  });

  return payload;
}

