/**
 * Responsive image matrix: a build-only pass that rewrites every jpg/jpeg/png
 * under dist/assets/images into widths 320/640/1024 + the original, each in
 * the source format AND webp at quality 80, so every variant name exists and
 * `@srcset` markup never 404s. Other formats stay verbatim, the favicon and
 * core dirs are exempt, and a file sharp can't decode warns and stays verbatim.
 * Cache: content-addressed entries under <brand>/.omega/cache/imagemin, never
 * committed (the build workflow restores it via actions/cache); a source-byte
 * or settings change re-processes that image, and stale entries prune.
 * Dev never processes: devImageFallback() rewrites a missing -NNNpx/.webp
 * variant URL to the original file.
 */
const path = require('node:path');
const crypto = require('node:crypto');
const jetpack = require('fs-jetpack');

// The matrix: 3 fixed widths + the original size, source format
// + webp each → 8 outputs per source image
const WIDTHS = [320, 640, 1024];
const QUALITY = 80;
const RESPONSIVE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
// Bump to invalidate every cache entry when encoder settings change
const FORMAT_VERSION = 1;
// Top-level dist/assets/images subtrees that stay verbatim: the favicon
// set is an exact-name set the head links, at fixed-purpose sizes, and the
// framework's core images have fixed URLs and are already avatar-sized;
// variants of either would be dead weight.
const EXEMPT_DIRS = new Set(['favicon', 'core']);

/**
 * The output plan for one source image: 8 variants, each with its final
 * on-disk name and its content-addressed name inside the cache entry.
 * @param {string} base - source basename without extension
 * @param {string} ext - lowercased source extension (with dot)
 * @returns {Array<{ outName: string, cacheName: string, width: number|null, format: string }>}
 */
function variantPlan(base, ext) {
  const plan = [];
  for (const width of [...WIDTHS, null]) {
    const suffix = width ? `-${width}px` : '';
    const key = width ? `w${width}` : 'orig';
    plan.push({ outName: `${base}${suffix}${ext}`, cacheName: `${key}${ext}`, width, format: ext });
    plan.push({ outName: `${base}${suffix}.webp`, cacheName: `${key}.webp`, width, format: '.webp' });
  }
  return plan;
}

/**
 * Apply the format encoder to a sharp pipeline.
 * @param {import('sharp').Sharp} pipeline
 * @param {string} format - lowercased extension (with dot)
 * @returns {import('sharp').Sharp}
 */
function encode(pipeline, format) {
  if (format === '.png') {
    return pipeline.png({ quality: QUALITY });
  }
  if (format === '.webp') {
    return pipeline.webp({ quality: QUALITY });
  }
  return pipeline.jpeg({ quality: QUALITY, progressive: true, mozjpeg: true });
}

/**
 * Content-addressed cache key for one source image: the bytes plus the
 * matrix settings, so a settings change re-processes everything.
 * @param {Buffer} bytes
 * @returns {string}
 */
function entryHash(bytes) {
  return crypto.createHash('sha256')
    .update(`v${FORMAT_VERSION}|${WIDTHS.join(',')}|q${QUALITY}|`)
    .update(bytes)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Process every eligible image under imagesDir in place: originals are
 * re-encoded at quality 80 under their own (lowercased-extension) name and
 * the -320px/-640px/-1024px + webp variants land beside them. Cache-first;
 * stale cache entries prune at the end.
 * @param {object} options
 * @param {string} options.imagesDir - the built site's assets/images dir
 * @param {string} options.cacheDir - content-addressed cache root (never committed)
 * @param {function} [options.log] - progress logger (message: string)
 * @returns {Promise<{ images: number, processed: number, fromCache: number, failed: number, outputs: number, pruned: number, sizeBefore: number, sizeAfter: number, warnings: string[] }>}
 */
async function processImages(options) {
  const { imagesDir, cacheDir, log = () => {} } = options;
  const result = {
    images: 0, processed: 0, fromCache: 0, failed: 0,
    outputs: 0, pruned: 0, sizeBefore: 0, sizeAfter: 0, warnings: [],
  };

  if (!jetpack.exists(imagesDir)) {
    return result;
  }

  const sharp = require('sharp');
  const files = jetpack.find(imagesDir, { matching: '**/*' }).filter((file) => {
    const rel = path.relative(imagesDir, file);
    if (EXEMPT_DIRS.has(rel.split(path.sep)[0])) {
      return false;
    }
    return RESPONSIVE_EXTENSIONS.has(path.extname(file).toLowerCase());
  });
  result.images = files.length;

  const validEntries = new Set();
  let index = 0;

  for (const file of files) {
    index++;
    const rel = path.relative(imagesDir, file);
    const bytes = jetpack.read(file, 'buffer');
    const ext = path.extname(file);
    const extLower = ext.toLowerCase();
    const base = path.basename(file, ext);
    const dir = path.dirname(file);
    const plan = variantPlan(base, extLower);
    const hash = entryHash(bytes);
    const entryDir = path.join(cacheDir, hash);

    // Uppercase-extension sources ship lowercased (IMG.JPG → IMG.jpg).
    // Remove BEFORE writing outputs: on case-insensitive filesystems the
    // lowercased write would hit the same inode and a later remove would
    // delete the fresh output. The failure path restores the verbatim copy.
    if (ext !== extLower) {
      jetpack.remove(file);
    }

    const cacheHit = plan.every((variant) => jetpack.exists(path.join(entryDir, variant.cacheName)));

    if (cacheHit) {
      for (const variant of plan) {
        jetpack.copy(path.join(entryDir, variant.cacheName), path.join(dir, variant.outName), { overwrite: true });
        result.sizeAfter += jetpack.inspect(path.join(dir, variant.outName)).size;
      }
      result.fromCache++;
    } else {
      try {
        const buffers = [];
        for (const variant of plan) {
          let pipeline = sharp(bytes);
          if (variant.width) {
            pipeline = pipeline.resize({ width: variant.width });
          }
          buffers.push({ variant, buffer: await encode(pipeline, variant.format).toBuffer() });
        }
        // All variants encoded — commit the cache entry and the outputs
        for (const { variant, buffer } of buffers) {
          jetpack.write(path.join(entryDir, variant.cacheName), buffer);
          jetpack.write(path.join(dir, variant.outName), buffer);
          result.sizeAfter += buffer.length;
        }
        result.processed++;
        log(`imagemin: [${index}/${files.length}] ${rel} → ${plan.length} outputs`);
      } catch (error) {
        // Undecodable image: warn, drop the half-written entry, keep the
        // verbatim copy the static phase already shipped
        jetpack.remove(entryDir);
        jetpack.write(file, bytes);
        result.failed++;
        result.warnings.push(`${rel}: ${error.message}`);
        continue;
      }
    }

    validEntries.add(hash);
    result.sizeBefore += bytes.length;
    result.outputs += plan.length;
  }

  // Prune cache entries whose source is gone (or re-encoded differently)
  for (const entry of jetpack.list(cacheDir) || []) {
    if (!validEntries.has(entry)) {
      jetpack.remove(path.join(cacheDir, entry));
      result.pruned++;
    }
  }

  const failedNote = result.failed ? `, ${result.failed} failed` : '';
  const prunedNote = result.pruned ? `, ${result.pruned} stale cache entries pruned` : '';
  log(`imagemin: ${result.processed} processed, ${result.fromCache} from cache → ${result.outputs} outputs (${formatBytes(result.sizeBefore)} source → ${formatBytes(result.sizeAfter)} shipped)${failedNote}${prunedNote}`);

  return result;
}

/**
 * Dev-server middleware: variant URLs resolve without processing. A missing
 * /assets/images/…-NNNpx or .webp request rewrites to the original file
 * (which dev ships verbatim), so markup can reference the build-time matrix
 * unconditionally.
 * @param {string} outDir - the dev output dir static files serve from
 * @returns {function} connect-style (req, res, next) middleware
 */
function devImageFallback(outDir) {
  const root = path.resolve(outDir);
  const inRoot = (pathname) => {
    const resolved = path.resolve(root, `.${pathname}`);
    return resolved.startsWith(root + path.sep) ? resolved : null;
  };

  return (req, res, next) => {
    const pathname = decodeURIComponent((req.url || '').split('?')[0]);
    const requested = pathname.startsWith('/assets/images/') ? inRoot(pathname) : null;
    if (!requested || jetpack.exists(requested)) {
      return next();
    }

    // Strip the size suffix first: hero-640px.jpg → hero.jpg
    const stripped = pathname.replace(/-\d+px(\.[^./]+)$/, '$1');
    const strippedFile = stripped === pathname ? null : inRoot(stripped);
    if (strippedFile && jetpack.exists(strippedFile)) {
      req.url = stripped;
      return next();
    }

    // A .webp variant of a non-webp source: try the source extensions
    if (stripped.endsWith('.webp')) {
      const base = stripped.slice(0, -'.webp'.length);
      for (const ext of ['.jpg', '.jpeg', '.png', '.gif']) {
        const candidate = inRoot(base + ext);
        if (candidate && jetpack.exists(candidate)) {
          req.url = base + ext;
          return next();
        }
      }
    }

    return next();
  };
}

/**
 * Human-readable byte count for the summary line.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  const order = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / 1024 ** order).toFixed(1))} ${units[order]}`;
}

module.exports = { processImages, devImageFallback, WIDTHS, QUALITY };
