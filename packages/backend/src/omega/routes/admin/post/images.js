/**
 * The image handling POST /admin/post applies to a post's downloaded images:
 * the CDN pre-scale, the readable download error, the JPEG conversion and the resize.
 */
const jetpack = require('fs-jetpack');
const path = require('path');

// Max dimension (px) for downloaded post images on the long edge, and JPEG
// re-encode quality. Sources above the max stall downstream Jekyll/imagemin
// pipelines on huge decodes (a 16384x10576 source decodes to ~520MB raw).
const IMAGE_MAX_DIMENSION = 2048;
const IMAGE_JPEG_QUALITY = 80;

// Apply CDN-side resize params so the server delivers a pre-scaled image.
// Unsplash (images.unsplash.com) supports Imgix-style params: w, q, fm.
// Other CDNs can be added here as needed.
function applyImageCDNParams(src) {
  try {
    const url = new URL(src);

    if (url.hostname === 'images.unsplash.com') {
      if (!url.searchParams.has('w')) {
        url.searchParams.set('w', String(IMAGE_MAX_DIMENSION));
      }
      if (!url.searchParams.has('q')) {
        url.searchParams.set('q', String(IMAGE_JPEG_QUALITY));
      }
    }

    if (url.hostname === 'images.pexels.com') {
      if (!url.searchParams.has('w')) {
        url.searchParams.set('w', String(IMAGE_MAX_DIMENSION));
      }
      if (!url.searchParams.has('auto')) {
        url.searchParams.set('auto', 'compress');
      }
    }

    return url.toString();
  } catch (e) {
    return src;
  }
}

// Helper: Build a readable message for a failed image download. Fetch errors
// can carry raw HTML bodies as the message (CDN 404 pages): strip tags and
// truncate so callers surface "Could not download image (<url>): 404" instead
// of markup that downstream HTML rendering swallows.
function formatImageDownloadError(src, e) {
  const reason = (e && typeof e.message === 'string' ? e.message : `${e}`)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated = reason.length > 200 ? `${reason.slice(0, 197)}...` : reason;

  return `Could not download image (${src}): ${truncated || 'unknown error'}`;
}

// Helper: Convert a downloaded png/webp to progressive JPEG in place. Alpha is
// flattened onto white (JPEG has no transparency). Mutates result.path/filename/ext
// to the new .jpg file and removes the original, so the rest of the pipeline
// (resize, base64, GitHub path) only ever sees JPGs.
async function convertToJpeg(ctx, result) {
  const sharp = ctx.omega.require('sharp');
  sharp.cache(false);

  const newPath = result.path.replace(/\.[^.]+$/, '.jpg');
  const buffer = await sharp(result.path)
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: IMAGE_JPEG_QUALITY, progressive: true })
    .toBuffer();

  jetpack.write(newPath, buffer);

  if (newPath !== result.path) {
    jetpack.remove(result.path);
  }

  result.path = newPath;
  result.filename = path.basename(newPath);
  result.ext = '.jpg';

  ctx.log(`convertToJpeg(): Converted to ${newPath}`);

  return result;
}

// Helper: Resize image in place if the long edge exceeds IMAGE_MAX_DIMENSION, as
// progressive JPEG at IMAGE_JPEG_QUALITY. sharp's pixel cache is off so decoded
// buffers free at once: several large images in a row can OOM a 256MB function.
async function resizeImage(ctx, filepath) {
  const sharp = ctx.omega.require('sharp');
  sharp.cache(false);

  const meta = await sharp(filepath).metadata();
  const longEdge = Math.max(meta.width, meta.height);

  if (longEdge <= IMAGE_MAX_DIMENSION) {
    ctx.log(`resizeImage(): No resize needed (${meta.width}x${meta.height})`);
    return { resized: false, width: meta.width, height: meta.height };
  }

  // Resize to a buffer (cannot read+write the same path in one sharp pipeline)
  const buffer = await sharp(filepath)
    .resize({
      width: IMAGE_MAX_DIMENSION,
      height: IMAGE_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: IMAGE_JPEG_QUALITY, progressive: true })
    .toBuffer();

  // Overwrite the file on disk
  jetpack.write(filepath, buffer);

  // Read the resized dimensions back for the log
  const resizedMeta = await sharp(filepath).metadata();
  ctx.log(`resizeImage(): Resized ${meta.width}x${meta.height} -> ${resizedMeta.width}x${resizedMeta.height} (max ${IMAGE_MAX_DIMENSION}px, q${IMAGE_JPEG_QUALITY})`);

  return { resized: true, width: resizedMeta.width, height: resizedMeta.height };
}

module.exports = {
  applyImageCDNParams,
  formatImageDownloadError,
  convertToJpeg,
  resizeImage,
  IMAGE_MAX_DIMENSION,
  IMAGE_JPEG_QUALITY,
};
