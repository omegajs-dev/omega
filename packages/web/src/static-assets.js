/**
 * Static-asset channel: files that ship to the built site VERBATIM: the
 * framework's core images, then the brand image the target lacks (derived
 * from the brand's brandmark into the brand's cache), then the consumer's
 * WHOLE src/assets tree but the pipeline lanes, copied LAST so its files win
 * collisions. Missing sources are skipped, so a brand with no brandmark
 * builds clean. buildSite runs the copies as its 'static' phase, then mirrors
 * the shipped favicon.ico to the site ROOT, which browsers probe unlinked.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jetpack = require('fs-jetpack');
const { resolveBrandImage } = require('@omega.js/devkit/brand-image');
const { makeSocialSquare, rasterizeBrandmark } = require('@omega.js/devkit/brand-image-raster');
const { makeFaviconSet } = require('@omega.js/devkit/favicon-set');
const {
  FAVICON_DEST, BRANDMARK_SVG_DEST, BRANDMARK_PNG_DEST, SOCIAL_PNG_DEST,
} = require('@omega.js/config');
const { PATHS } = require('./paths.js');

// The ASSET PIPELINE owns these src/assets children — it reads them as layer
// roots (assets.js) and writes its own dist/assets/<lane> from the layered
// union: content-hashed js/css bundles, and fonts pruned to the faces some
// emitted stylesheet references. The static phase runs after it, so a verbatim
// copy would drop unbundled sources beside the bundles and undo the font prune.
const PIPELINE_LANES = new Set(['js', 'css', 'fonts']);

// The brand images a site ships, each checked on its own: `own` is the
// target's file that wins (a favicon set counts when its webmanifest is
// there), `cached` the name derived under the brand's cache. The vector ships
// the brandmark itself, so it has no cached name.
const BRAND_IMAGES = [
  {
    dest: FAVICON_DEST,
    own: `${FAVICON_DEST}/site.webmanifest`,
    cached: 'favicon',
    make: ({ source, out, name }) => makeFaviconSet({ source, outDir: out, name }),
  },
  { dest: BRANDMARK_SVG_DEST, own: BRANDMARK_SVG_DEST, cached: null },
  {
    dest: BRANDMARK_PNG_DEST,
    own: BRANDMARK_PNG_DEST,
    cached: 'brandmark.png',
    make: ({ source, out }) => rasterizeBrandmark({ source, outFile: out, size: 512 }),
  },
  {
    dest: SOCIAL_PNG_DEST,
    own: SOCIAL_PNG_DEST,
    cached: 'social.png',
    make: ({ source, out }) => makeSocialSquare({ source, outFile: out, size: 1024 }),
  },
];

// The images made from the brandmark: one cache folder holds them all.
const MADE_IMAGES = BRAND_IMAGES.filter((image) => image.cached);

// Bump to derive every brand's images again when a recipe or size changes.
const RECIPE_VERSION = 1;

// Marks a cache folder still being written.
const TEMP_MARK = '.tmp-';

// A cache folder unused this long is removed: a set no target reads any more,
// or a temp folder a build left when it ended mid-derive.
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the ordered static copy list for a consumer build: the brand image
 * the target lacks first, the consumer's own asset layer last (it wins
 * collisions). Sources that don't exist are dropped.
 * @param {object} options
 * @param {string|null} options.brandRoot - brand monorepo root, null for a framework used alone
 * @param {string} options.assetsDir - the consumer's src/assets
 * @param {string} [options.name] - the brand name the derived webmanifest carries
 * @param {string} [options.coreDir] - the framework core layer (default: packaged core)
 * @param {function} [options.log] - progress logger (message: string)
 * @returns {Promise<Array<{ src: string, dest: string }>>}
 */
async function resolveStaticDirs(options) {
  const entries = [];

  // Framework-shipped images (core/images → /assets/images/core): the
  // packaged pictures core templates reference by fixed URL — today the
  // exit popup's social-proof faces. First, so both brand layers win.
  entries.push({ src: path.join(options.coreDir || PATHS.core, 'images'), dest: 'assets/images/core' });

  entries.push(...await deriveBrandImages(options));

  // images/ stays its OWN entry (imagemin and the favicon probe both address
  // that destination by name); everything else the consumer keeps under
  // src/assets rides beside it, one entry per child, in a stable order.
  // Hidden entries never ride: the widened lane listed .DS_Store & co. as
  // content and shipped Finder noise to dist.
  entries.push({ src: path.join(options.assetsDir, 'images'), dest: 'assets/images' });
  for (const name of (jetpack.list(options.assetsDir) || []).sort()) {
    if (name.startsWith('.') || name === 'images' || PIPELINE_LANES.has(name)) continue;
    entries.push({ src: path.join(options.assetsDir, name), dest: `assets/${name}` });
  }

  return entries.filter((entry) => jetpack.exists(entry.src));
}

/**
 * The static entries for the brand images this target lacks. The ones made
 * from the brand's brandmark come from `<brandRoot>/.omega/cache/brand-image/
 * <key>/`, which holds the whole made set; a folder already there is reused,
 * so an unchanged brandmark derives nothing.
 * @param {object} options - As resolveStaticDirs.
 * @returns {Promise<Array<{ src: string, dest: string }>>}
 */
async function deriveBrandImages({ brandRoot, assetsDir, name, log = () => {} }) {
  const lacking = [];

  for (const image of BRAND_IMAGES) {
    const own = path.join(assetsDir, path.relative('assets', image.own));
    const found = resolveBrandImage({ own: [own], brandRoot, fallback: null });
    if (found.from === 'brand') {
      lacking.push({ image, source: found.path });
    }
  }

  const made = lacking.filter(({ image }) => image.cached);
  if (!made.length) {
    return lacking.map(({ image, source }) => ({ src: source, dest: image.dest }));
  }

  const { source } = made[0];
  const cacheRoot = path.join(brandRoot, '.omega', 'cache', 'brand-image');
  const cacheDir = path.join(cacheRoot, cacheKey(source, name));
  const fromCache = holdsMadeSet(cacheDir);
  if (!fromCache) {
    await deriveMadeSet({ cacheDir, source, name });
  }
  pruneCache(cacheRoot, cacheDir);

  const names = made.map(({ image }) => image.cached).join(', ');
  log(`brand-image: ${fromCache ? 0 : made.length} derived, ${fromCache ? made.length : 0} from cache → ${names}`);

  return lacking.map(({ image, source: from }) => ({
    src: image.cached ? path.join(cacheDir, image.cached) : from,
    dest: image.dest,
  }));
}

/**
 * Make the whole set into a temp folder beside `cacheDir` and rename it into
 * place, so a build reading the cache meanwhile never meets a half-written
 * file.
 * @param {object} options
 * @param {string} options.cacheDir - the folder this brandmark and recipe name
 * @param {string} options.source - the brand's brandmark
 * @param {string} [options.name] - the brand name the webmanifest carries
 * @returns {Promise<void>}
 */
async function deriveMadeSet({ cacheDir, source, name }) {
  const temp = `${cacheDir}${TEMP_MARK}${crypto.randomBytes(4).toString('hex')}`;

  try {
    for (const image of MADE_IMAGES) {
      await image.make({ source, out: path.join(temp, image.cached), name });
    }

    if (!holdsMadeSet(cacheDir)) {
      jetpack.remove(cacheDir);
      try {
        fs.renameSync(temp, cacheDir);
      } catch (error) {
        // Another build renamed the same set into place first.
        if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
      }
    }
  } finally {
    jetpack.remove(temp);
  }
}

/**
 * Mark `cacheDir` used now, then remove every other folder under the cache
 * root, finished or temp, unused for longer than CACHE_MAX_AGE_MS. Age alone
 * decides, so two targets of one brand with different names keep each other's
 * folder, and a temp folder a build left behind goes in a day.
 * @param {string} cacheRoot - `<brandRoot>/.omega/cache/brand-image`
 * @param {string} cacheDir - the folder this build reads
 */
function pruneCache(cacheRoot, cacheDir) {
  const now = new Date();
  fs.utimesSync(cacheDir, now, now);

  for (const entry of jetpack.list(cacheRoot)) {
    const dir = path.join(cacheRoot, entry);
    // Another build may have removed it since the list
    const info = jetpack.inspect(dir, { times: true });
    if (dir !== cacheDir && info && now - info.modifyTime > CACHE_MAX_AGE_MS) {
      jetpack.remove(dir);
    }
  }
}

/**
 * Whether a cache folder holds the whole made set. A folder only ever lands
 * by rename, whole, so a partial one was changed by hand.
 * @param {string} dir
 * @returns {boolean}
 */
function holdsMadeSet(dir) {
  return MADE_IMAGES.every((image) => jetpack.exists(path.join(dir, image.cached)));
}

/**
 * The cache folder's name: the recipe version and the brand name the
 * webmanifest carries, hashed with the brandmark's bytes, so a change to any
 * of them derives again.
 * @param {string} source - the brand's brandmark
 * @param {string} [name] - the brand name
 * @returns {string}
 */
function cacheKey(source, name) {
  return crypto.createHash('sha256')
    .update(`v${RECIPE_VERSION}|${name}|`)
    .update(jetpack.read(source, 'buffer'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Whether a favicon set will ship with these static copies — the head only
 * renders its favicon/manifest links when the derived set (or a consumer-
 * authored one) actually exists, so a virgin brand serves zero dangling
 * links (cp194 wizard-rehearsal catch).
 * @param {Array<{ src: string, dest: string }>} staticDirs - From resolveStaticDirs().
 * @returns {boolean}
 */
function hasFaviconSet(staticDirs) {
  return (staticDirs || []).some(({ src, dest }) =>
    (dest === FAVICON_DEST && isFaviconSet(src))
    || (dest === 'assets/images' && isFaviconSet(path.join(src, 'favicon'))));
}

/**
 * Whether one favicon folder holds a set the head can link. The head's links
 * hang on site.webmanifest, so a folder without it is no set at all.
 * @param {string} dir - a favicon folder
 * @returns {boolean}
 */
function isFaviconSet(dir) {
  return jetpack.exists(path.join(dir, 'site.webmanifest')) === 'file';
}

/**
 * The site url of the VECTOR brandmark when these static copies will ship one
 * (same shape as hasFaviconSet, and the same reason): whether an svg ships
 * is a build-time fact, so the templates that render the
 * VISIBLE logo (nav, footer, app sidebar) read it off the asset manifest
 * instead of guessing a filename ([#467](https://github.com/Omega-JS-Stack/omega/issues/467)).
 * `brand.images.brandmark` stays the RASTER it has always been — payment sync
 * (the Stripe/PayPal product image) and OG/social cards need one.
 * @param {Array<{ src: string, dest: string }>} staticDirs - From resolveStaticDirs().
 * @returns {string|null}
 */
function brandmarkSvgUrl(staticDirs) {
  const shipped = (staticDirs || []).some(({ src, dest }) =>
    (dest === BRANDMARK_SVG_DEST && jetpack.exists(src) === 'file')
    || (dest === 'assets/images' && jetpack.exists(path.join(src, 'brand', 'brandmark.svg')) === 'file'));

  return shipped ? `/${BRANDMARK_SVG_DEST}` : null;
}

/**
 * Copy the resolved entries into the build output, in order (later entries
 * overwrite earlier ones — that's the consumer-wins contract), then mirror
 * the shipped favicon.ico to the site root.
 * @param {object} options
 * @param {Array<{ src: string, dest: string }>} [options.staticDirs]
 * @param {string} options.outDir
 * @returns {{ copied: number, rootFavicon: boolean }}
 */
function copyStaticAssets(options) {
  let copied = 0;

  for (const { src, dest } of options.staticDirs || []) {
    jetpack.copy(src, path.join(options.outDir, dest), { overwrite: true });
    copied += 1;
  }

  return { copied, rootFavicon: mirrorRootFavicon(options.outDir) };
}

/**
 * Mirror the shipped favicon set's .ico to <outDir>/favicon.ico. Browsers
 * probe /favicon.ico directly (no link tag), so the built site answers it in
 * dev and in production alike. Sourced from the COPIED set, so the
 * consumer-wins collision result is what lands at the root; no set shipped,
 * nothing to mirror.
 * @param {string} outDir
 * @returns {boolean} Whether a root favicon.ico was written.
 */
function mirrorRootFavicon(outDir) {
  const shipped = path.join(outDir, 'assets', 'images', 'favicon', 'favicon.ico');
  if (jetpack.exists(shipped) !== 'file') return false;

  jetpack.copy(shipped, path.join(outDir, 'favicon.ico'), { overwrite: true });

  return true;
}

module.exports = { resolveStaticDirs, copyStaticAssets, hasFaviconSet, brandmarkSvgUrl };
