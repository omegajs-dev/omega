/**
 * The responsive image matrix (src/imagemin.js), against REAL encoded images:
 *   - 8 outputs per jpg/jpeg/png (320/640/1024/original × source-format +
 *     webp), quality 80, upscaling allowed so every variant name exists
 *   - gif/svg (and the favicon dir) ship verbatim, byte-identical
 *   - uppercase extensions lowercase safely on case-insensitive filesystems
 *   - content-addressed cache: byte-identical on a warm rerun, stale entries pruned
 *   - a file sharp can't decode warns and stays verbatim, never a failed build
 *   - devImageFallback: dev rewrites missing variant URLs to the original
 * The no-imagemin path is pinned by static.test.js (its text-byte "pngs" never decode).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const defineCases = require('@omega.js/devkit/test/define-cases');
const expect = require('@omega.js/devkit/test/expect');
const sharp = require('sharp');
const jetpack = require('fs-jetpack');
// The lane NAMES the environment
// ([#817](https://github.com/Omega-JS-Stack/omega/issues/817)): the engine reads
// that ONE input instead of a loose `options.environment`, and a fixture build
// with no verb above it is a development build, which is what it always was.
const { setEnvironment } = require('@omega.js/config/environment');
const { processImages, devImageFallback } = require('../src/imagemin.js');

let sourceDir; // pristine sources (simulates src/assets/images post-copy)
let imagesDir; // the working dist/assets/images tree processImages mutates
let cacheDir;
let firstRun; // result of the cold run
let firstHero320; // bytes of hero-320px.jpg from the cold run (cache determinism pin)

/** Reset imagesDir to a pristine copy of sourceDir. */
function restage() {
  jetpack.remove(imagesDir);
  jetpack.copy(sourceDir, imagesDir);
}

// ─── devImageFallback: dev serves originals for missing variant URLs ─────────

/** Run the middleware over a url and return the (possibly rewritten) req.url. */
function rewrite(middleware, url) {
  const req = { url };
  let nextCalled = false;
  middleware(req, {}, () => { nextCalled = true; });
  expect(nextCalled, `${url}: middleware always falls through to next()`).toBeTruthy();
  return req.url;
}

module.exports = defineCases({
  type: 'group',
  description: 'imagemin',
  setup: async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-imagemin-'));
    sourceDir = path.join(base, 'sources');
    imagesDir = path.join(base, 'dist-images');
    cacheDir = path.join(base, 'cache');

    // Real images, varied shapes: downscale + upscale + alpha + uppercase ext
    await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 40, b: 40 } } })
      .jpeg().toFile(path.join(jetpack.dir(sourceDir).path(), 'hero.jpg'));
    await sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 0, g: 120, b: 255, alpha: 0.5 } } })
      .png().toFile(path.join(jetpack.dir(path.join(sourceDir, 'sub')).path(), 'logo.png'));
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 200, b: 10 } } })
      .jpeg().toFile(path.join(sourceDir, 'UPPER.JPG'));
    await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .gif().toFile(path.join(sourceDir, 'anim.gif'));
    await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .png().toFile(path.join(jetpack.dir(path.join(sourceDir, 'favicon')).path(), 'favicon-32x32.png'));
    jetpack.write(path.join(sourceDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

    restage();
    firstRun = await processImages({ imagesDir, cacheDir });
    firstHero320 = jetpack.read(path.join(imagesDir, 'hero-320px.jpg'), 'buffer');
  },
  tests: [
    {
      name: 'imagemin: the 8-output matrix per responsive image, correct dimensions + formats',
      run: async (ctx) => {
        ctx.expect({ images: firstRun.images, processed: firstRun.processed, fromCache: firstRun.fromCache, failed: firstRun.failed, outputs: firstRun.outputs }).toEqual({ images: 3, processed: 3, fromCache: 0, failed: 0, outputs: 24 });

        // hero.jpg: full matrix, exact widths, webp really is webp
        const hero320 = await sharp(path.join(imagesDir, 'hero-320px.jpg')).metadata();
        ctx.expect(hero320.width).toBe(320);
        ctx.expect(hero320.format).toBe('jpeg');
        const hero1024webp = await sharp(path.join(imagesDir, 'hero-1024px.webp')).metadata();
        ctx.expect(hero1024webp.width).toBe(1024);
        ctx.expect(hero1024webp.format).toBe('webp');

        // The original NAME survives (URL contract) but is re-encoded at q80
        const heroOut = await sharp(path.join(imagesDir, 'hero.jpg')).metadata();
        ctx.expect(heroOut.width).toBe(1600);
        ctx.expect(jetpack.read(path.join(imagesDir, 'hero.jpg'), 'buffer'), 'original re-encoded, not the verbatim copy').not.toEqual(jetpack.read(path.join(sourceDir, 'hero.jpg'), 'buffer'));
        ctx.expect(jetpack.exists(path.join(imagesDir, 'hero.webp')), 'full-size webp twin').toBeTruthy();
      },
    },

    {
      name: 'imagemin: small sources UPSCALE so every variant name exists (the no-404 contract)',
      run: async (ctx) => {
        // logo.png is 200px wide — 640/1024 variants must still exist, enlarged
        const logo640 = await sharp(path.join(imagesDir, 'sub', 'logo-640px.png')).metadata();
        ctx.expect(logo640.width).toBe(640);
        ctx.expect(logo640.hasAlpha, 'alpha survives the png pipeline').toBe(true);
        ctx.expect(jetpack.exists(path.join(imagesDir, 'sub', 'logo-1024px.webp'))).toBeTruthy();
      },
    },

    {
      name: 'imagemin: uppercase extensions ship lowercased — safe on case-insensitive filesystems',
      run: async (ctx) => {
        const files = jetpack.list(imagesDir).filter((name) => name.startsWith('UPPER'));
        ctx.expect(!files.includes('UPPER.JPG'), 'uppercase original gone').toBeTruthy();
        ctx.expect(files.includes('UPPER.jpg'), 'lowercased re-encoded original present').toBeTruthy();
        ctx.expect(files.includes('UPPER-320px.webp'), 'variants lowercased too').toBeTruthy();
        const meta = await sharp(path.join(imagesDir, 'UPPER.jpg')).metadata();
        ctx.expect(meta.width).toBe(400);
      },
    },

    {
      name: 'imagemin: gif/svg and the favicon dir ship verbatim, byte-identical',
      run: (ctx) => {
        for (const rel of ['anim.gif', 'icon.svg', path.join('favicon', 'favicon-32x32.png')]) {
          ctx.expect(jetpack.read(path.join(imagesDir, rel), 'buffer'), `${rel} untouched`).toEqual(jetpack.read(path.join(sourceDir, rel), 'buffer'));
        }
        ctx.expect(!jetpack.exists(path.join(imagesDir, 'anim-320px.gif')), 'no gif variants').toBeTruthy();
        ctx.expect(!jetpack.exists(path.join(imagesDir, 'favicon', 'favicon-32x32-320px.png')), 'favicon dir exempt').toBeTruthy();
      },
    },

    {
      name: 'imagemin: warm rerun serves everything from cache, byte-identical outputs',
      run: async (ctx) => {
        restage();
        const rerun = await processImages({ imagesDir, cacheDir });

        ctx.expect(rerun.processed).toBe(0);
        ctx.expect(rerun.fromCache).toBe(3);
        ctx.expect(rerun.pruned).toBe(0);
        ctx.expect(jetpack.read(path.join(imagesDir, 'hero-320px.jpg'), 'buffer'), 'cache round-trip is byte-identical').toEqual(firstHero320);
      },
    },

    {
      name: 'imagemin: deleted sources prune their cache entries',
      run: async (ctx) => {
        jetpack.remove(path.join(sourceDir, 'hero.jpg'));
        restage();
        const rerun = await processImages({ imagesDir, cacheDir });

        ctx.expect(rerun.fromCache).toBe(2);
        ctx.expect(rerun.pruned, 'hero entry pruned').toBe(1);
        ctx.expect((jetpack.list(cacheDir) || []).length, 'exactly the live entries remain').toBe(2);
      },
    },

    {
      name: 'imagemin: an undecodable image warns and ships verbatim — the build never fails',
      run: async (ctx) => {
        const corruptDir = path.join(path.dirname(imagesDir), 'corrupt-images');
        jetpack.write(path.join(corruptDir, 'broken.png'), 'this is not a png');
        const result = await processImages({ imagesDir: corruptDir, cacheDir: path.join(path.dirname(cacheDir), 'corrupt-cache') });

        ctx.expect(result.failed).toBe(1);
        ctx.expect(result.warnings[0]).toMatch(/^broken\.png: /);
        ctx.expect(jetpack.read(path.join(corruptDir, 'broken.png')), 'verbatim copy kept').toBe('this is not a png');
        ctx.expect(!jetpack.exists(path.join(corruptDir, 'broken-320px.png')), 'no half-made variants').toBeTruthy();
      },
    },

    {
      name: 'imagemin: a missing images dir is a clean no-op (sites without static images)',
      run: async (ctx) => {
        const result = await processImages({ imagesDir: path.join(os.tmpdir(), 'omega-imagemin-nope'), cacheDir });
        ctx.expect({ images: result.images, outputs: result.outputs }).toEqual({ images: 0, outputs: 0 });
      },
    },

    // ─── buildSite wiring: the imagemin phase over a real build ──────────────────

    {
      name: 'buildSite: imagemin phase processes the shipped images and reports back',
      run: async (ctx) => {
        const { buildSite } = require('../src/build.js');
        const { resolveStaticDirs } = require('../src/static-assets.js');
        const PKG = path.resolve(__dirname, '..');
        const SITE = path.join(__dirname, 'fixtures', 'contract-site');
        const siteData = JSON.parse(fs.readFileSync(path.join(SITE, 'site-data.json'), 'utf8'));

        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-imagemin-build-'));
        const consumerAssets = path.join(base, 'consumer-assets');
        await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 60, g: 60, b: 200 } } })
          .jpeg().toFile(path.join(jetpack.dir(path.join(consumerAssets, 'images')).path(), 'photo.jpg'));

        const outDir = path.join(PKG, '.omega', 'imagemin-build');
        setEnvironment('development');
        const result = await buildSite({
          consumerDir: SITE,
          siteData,
          outDir,
          clientEntry: path.join(PKG, '..', 'client', 'src', 'index.js'),
          skipPurge: true,
          staticDirs: await resolveStaticDirs({ brandRoot: null, assetsDir: consumerAssets }),
          imagemin: { cacheDir: path.join(base, 'cache') },
        });

        ctx.expect(result.imagemin.processed).toBe(1);
        ctx.expect(result.timings.imagemin >= 0, 'imagemin phase timed like every other phase').toBeTruthy();
        const meta = await sharp(path.join(outDir, 'assets', 'images', 'photo-640px.webp')).metadata();
        ctx.expect(meta.width).toBe(640);
        ctx.expect(meta.format).toBe('webp');
      },
    },

    {
      name: 'devImageFallback: missing variants rewrite to the verbatim original; real files untouched',
      run: (ctx) => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-devfallback-'));
        jetpack.write(path.join(outDir, 'assets', 'images', 'hero.jpg'), 'jpg-bytes');
        jetpack.write(path.join(outDir, 'assets', 'images', 'real.webp'), 'webp-bytes');
        const middleware = devImageFallback(outDir);

        // Size suffix strips; .webp variants walk back to the source extension
        ctx.expect(rewrite(middleware, '/assets/images/hero-640px.jpg')).toBe('/assets/images/hero.jpg');
        ctx.expect(rewrite(middleware, '/assets/images/hero-320px.webp')).toBe('/assets/images/hero.jpg');
        ctx.expect(rewrite(middleware, '/assets/images/hero.webp?cb=123')).toBe('/assets/images/hero.jpg');

        // Files that exist (or aren't images) pass through untouched
        ctx.expect(rewrite(middleware, '/assets/images/real.webp')).toBe('/assets/images/real.webp');
        ctx.expect(rewrite(middleware, '/assets/js/main.js')).toBe('/assets/js/main.js');
        ctx.expect(rewrite(middleware, '/assets/images/missing-640px.png')).toBe('/assets/images/missing-640px.png');

        // Traversal attempts never resolve outside the out dir
        ctx.expect(rewrite(middleware, '/assets/images/../../../../etc/passwd-640px.png')).toBe('/assets/images/../../../../etc/passwd-640px.png');
      },
    },
  ],
});
