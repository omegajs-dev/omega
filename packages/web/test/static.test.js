/**
 * One classy build over the contract fixture WITHOUT site.meta: nav/footer
 * bind their JSON5 section data, <title> falls back to the brand name, and
 * the consumer's whole src/assets tree ships verbatim, its own favicon set
 * included.
 *
 * Then the brand image: one real `omega build` proves the wiring, and the
 * static copies prove the order in-process: a target's own files win, the
 * brand's brandmark fills in the rest, and nothing is written into the
 * target's source tree.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cheerio = require('cheerio');
const sharp = require('sharp');
const defineCases = require('@omega.js/devkit/test/define-cases');

// Every temp brand's config load records its brand: keep that off the real ~/.omega
require('@omega.js/devkit/test/temp-home');

// The lane NAMES the environment
// ([#817](https://github.com/Omega-JS-Stack/omega/issues/817)): the engine reads
// that ONE input instead of a loose `options.environment`, and a fixture build
// with no verb above it is a development build, which is what it always was.
const { setEnvironment } = require('@omega.js/config/environment');
const { findBrandRoot } = require('@omega.js/config');
const { buildSite } = require('../src/build.js');
const { resolveStaticDirs, copyStaticAssets, hasFaviconSet } = require('../src/static-assets.js');
const build = require('../src/commands/build.js');
const { ensureTarget } = require('../src/commands/lib/ensure-target.js');

const PKG = path.resolve(__dirname, '..');
const ROOT = path.resolve(PKG, '..', '..');
const SITE = path.join(__dirname, 'fixtures', 'contract-site');
const OUT = path.join(PKG, '.omega', 'static-gaps');
const siteData = JSON.parse(fs.readFileSync(path.join(SITE, 'site-data.json'), 'utf8'));

let assetsRoot; // the consumer's src/assets stand-in

/**
 * Write a file (and its directories) under the consumer stand-in.
 * @param {string[]} segments
 * @param {string} content
 */
function place(segments, content) {
  const file = path.join(assetsRoot, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * One classy build of the contract fixture, no site.meta, into `outDir`.
 * @param {string} outDir
 * @param {object[]} staticDirs
 */
async function buildFixture(outDir, staticDirs) {
  await buildSite({
    consumerDir: SITE,
    siteData: {
      ...siteData,
      meta: undefined, // the live playground shape: no meta key anywhere
      theme: { id: 'classy' },
      brand: {
        ...siteData.brand,
        images: { social: 'https://contract.test/assets/images/brand/social.png' },
      },
    },
    outDir,
    clientEntry: path.join(ROOT, 'packages', 'client', 'src', 'index.js'),
    skipPurge: true,
    staticDirs,
  });
}

// ─── The brand image through the real build ───

// A red disc that never reaches the corners of its box
const BRANDMARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#ff0000"/></svg>';
const BRAND_CONFIG = `{
  brand: { id: 'fixture', name: 'Fixture', url: 'https://fixture.example.com' },
  targets: { web: { type: 'web' } },
}`;
const TARGET_PACKAGE = JSON.stringify({ name: 'fixture-web', private: true, dependencies: { '@omega.js/web': '*' } });

/**
 * A scratch tree holding the given relative files (a Buffer is written as is),
 * removed when `owner` ends: a case's ctx, or the suite's own `sharedScratch`.
 * @param {{ after: Function }} owner
 * @param {Object<string, string|Buffer>} files
 * @returns {string} The root.
 */
function tree(owner, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-static-brand-'));
  owner.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), contents);
  }
  return root;
}

// The shared build's tree outlives each case that reads it: the suite cleanup removes it.
const sharedRemovals = [];
const sharedScratch = { after: (remove) => sharedRemovals.push(remove) };

/**
 * A brand with one web target; `brand` and `target` add brand-root and target-relative files.
 * @param {{ after: Function }} owner - As tree's.
 * @returns {{ brandRoot: string, target: string }}
 */
function brandWithWeb(owner, { brand = {}, target = {} } = {}) {
  const prefixed = Object.fromEntries(Object.entries(target).map(([relative, contents]) => [`targets/web/${relative}`, contents]));
  const brandRoot = tree(owner, {
    'config/omega.json5': BRAND_CONFIG,
    'package.json': JSON.stringify({ name: 'fixture-brand', private: true }),
    'targets/web/package.json': TARGET_PACKAGE,
    ...brand,
    ...prefixed,
  });
  return { brandRoot, target: path.join(brandRoot, 'targets', 'web') };
}

/** Run the real `omega build` in `dir`. */
async function buildIn(dir) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    await build({ logFile: false });
  } finally {
    process.chdir(previous);
  }
}

/** Every file under `dir` but the build's own output, with a digest of its bytes and its mtime. */
function sourceState(dir) {
  const state = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(dir, file);
    if (/^(dist|\.omega|node_modules)(\/|$)/.test(relative)) continue;
    state[relative] = `${crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')} ${fs.statSync(file).mtimeMs}`;
  }
  return state;
}

/** Every file under `dir`, relative, with its mtime; empty when the folder is absent. */
function filesWithMtimes(dir) {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .map((file) => [path.relative(dir, file), fs.statSync(file).mtimeMs]));
}

/** The site paths of the head's favicon and manifest links on a built page. */
function faviconLinks(html) {
  const $ = cheerio.load(html);
  const pathOf = (element) => new URL($(element).attr('href'), 'https://fixture.example.com').pathname;
  return {
    icons: $('link[rel~="icon"], link[rel="apple-touch-icon"]').toArray().map(pathOf),
    manifest: $('link[rel="manifest"]').toArray().map(pathOf),
  };
}

/** The brand with a brandmark and a web target with no image files, built once for the cases that read it. */
let brandmarkOnly;
function brandmarkOnlyBuild() {
  brandmarkOnly ||= (async () => {
    const fixture = brandWithWeb(sharedScratch, { brand: { 'assets/logo/brandmark.svg': BRANDMARK_SVG } });
    // The scaffold every verb runs is the target's own business; the record starts after it
    ensureTarget({ projectDir: fixture.target });
    const sourceBefore = sourceState(fixture.target);
    await buildIn(fixture.target);
    return { ...fixture, sourceBefore, dist: path.join(fixture.target, 'dist') };
  })();
  return brandmarkOnly;
}

/**
 * The static copies a build of `target` makes, in-process: the brand root as
 * the build finds it, then resolveStaticDirs and copyStaticAssets into its dist.
 * @returns {Promise<{ staticDirs: object[], dist: string, rootFavicon: boolean }>}
 */
async function shipStatic(target) {
  const staticDirs = await resolveStaticDirs({ brandRoot: findBrandRoot(target), assetsDir: path.join(target, 'src', 'assets'), name: 'Fixture' });
  const dist = path.join(target, 'dist');
  const { rootFavicon } = copyStaticAssets({ staticDirs, outDir: dist });
  return { staticDirs, dist, rootFavicon };
}

module.exports = defineCases({
  type: 'group',
  description: 'static',
  setup: async () => {
    assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-static-'));

    // The consumer's own favicon set: site.webmanifest makes it a set
    place(['images', 'favicon', 'favicon.ico'], 'consumer-ico');
    place(['images', 'favicon', 'favicon-32x32.png'], 'consumer-32');
    place(['images', 'favicon', 'site.webmanifest'], '{"name":"Contract"}');
    place(['images', 'hero.png'], 'consumer-hero');
    // Non-image media (#295): the live break was alarm mp3s 404ing
    place(['audio', 'alarm.mp3'], 'consumer-alarm');
    place(['downloads', 'guide.pdf'], 'consumer-guide');
    // Hidden entries: Finder/editor noise sitting in src/assets is not content
    place(['.DS_Store'], 'finder-noise');
    // The PIPELINE's lanes: the asset phase owns dist/assets/{js,css,fonts}
    // (hashed bundles, and fonts pruned to referenced faces), so these must
    // never ride the static copy
    place(['js', 'main.js'], 'raw-source-must-not-ship');
    place(['css', 'main.scss'], 'raw-source-must-not-ship');
    place(['fonts', 'unreferenced.woff2'], 'pruned-face-must-not-return');

    setEnvironment('development');
    await buildFixture(OUT, await resolveStaticDirs({ brandRoot: null, assetsDir: assetsRoot }));
  },
  cleanup: () => {
    for (const remove of sharedRemovals) remove();
  },
  tests: [
    {
      name: 'resolveStaticDirs: core images first, the consumer layer after them, missing sources dropped',
      run: async (ctx) => {
        const dirs = await resolveStaticDirs({ brandRoot: null, assetsDir: assetsRoot });
        ctx.expect(dirs.map((entry) => entry.dest)).toEqual([
          'assets/images/core', // framework-shipped pictures (exit-popup faces)
          'assets/images', // consumer layer after them, so it wins collisions
          'assets/audio', // …and the rest of src/assets rides with it (#295)
          'assets/downloads',
        ]);

        // No consumer assets at all → the framework's own images still ship
        ctx.expect((await resolveStaticDirs({ brandRoot: null, assetsDir: path.join(assetsRoot, 'nope') }))
            .map((entry) => entry.dest)).toEqual(['assets/images/core']);
      },
    },

    {
      name: '#295: the whole src/assets tree ships, but never the pipeline-owned lanes',
      run: (ctx) => {
        ctx.expect(fs.readFileSync(path.join(OUT, 'assets', 'audio', 'alarm.mp3'), 'utf8'), 'audio ships (was silently dropped: 404 on the live site)').toBe('consumer-alarm');
        ctx.expect(fs.readFileSync(path.join(OUT, 'assets', 'downloads', 'guide.pdf'), 'utf8')).toBe('consumer-guide');
        ctx.expect(fs.readFileSync(path.join(OUT, 'assets', 'images', 'hero.png'), 'utf8')).toBe('consumer-hero');

        // js/, css/ and fonts/ belong to the asset phase: its hashed bundles already
        // sit in dist/assets, and a verbatim source copy would land beside them and
        // put the pruned font faces back
        ctx.expect(!fs.existsSync(path.join(OUT, 'assets', 'js', 'main.js')), 'js sources never ride the static lane').toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(OUT, 'assets', 'css', 'main.scss')), 'css sources never ride the static lane').toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(OUT, 'assets', 'fonts', 'unreferenced.woff2')), 'fonts never ride the static lane (the assets phase prunes unreferenced faces)').toBeTruthy();

        // …and neither does hidden noise: the widened lane lists every child of
        // src/assets, and .DS_Store shipped to dist with it
        ctx.expect(!fs.existsSync(path.join(OUT, 'assets', '.DS_Store')), 'dotfiles never ship').toBeTruthy();
      },
    },

    {
      name: 'the shipped favicon.ico mirrors to the site root (#161: the browser probes /favicon.ico)',
      run: (ctx) => {
        const root = path.join(OUT, 'favicon.ico');
        ctx.expect(fs.existsSync(root), 'root favicon.ico shipped').toBeTruthy();
        ctx.expect(fs.readFileSync(root, 'utf8'), 'the root copy is the shipped one').toBe('consumer-ico');

        // No favicon set shipped → nothing lands at the root
        const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-static-bare-'));
        copyStaticAssets({ staticDirs: [], outDir: bare });
        ctx.expect(!fs.existsSync(path.join(bare, 'favicon.ico')), 'no set, no root favicon').toBeTruthy();
      },
    },

    {
      name: 'nav + footer render their section data (JSON5 json-in-_includes)',
      run: (ctx) => {
        const html = fs.readFileSync(path.join(OUT, 'about.html'), 'utf8');

        // nav.json: links + actions
        ctx.expect(html.includes('href="/pricing"'), 'nav links render').toBeTruthy();
        ctx.expect(html.includes('Sign up'), 'nav actions render').toBeTruthy();

        // footer.json: link groups
        ctx.expect(html.includes('About us'), 'footer link groups render').toBeTruthy();
      },
    },

    {
      name: 'admin sidebar renders its section data too (was silently empty under JSON.parse)',
      run: (ctx) => {
        const html = fs.readFileSync(path.join(OUT, 'admin.html'), 'utf8');
        ctx.expect(html.includes('Dashboard'), 'admin sidebar labels render').toBeTruthy();
        ctx.expect(html.includes('href="/admin/verts"'), 'verts card is reachable from the sidebar').toBeTruthy();
      },
    },

    {
      name: '<title> falls back to the brand name: no page ever renders an empty title',
      run: (ctx) => {
        let sawBrandFallback = false;

        for (const entry of fs.readdirSync(OUT, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
          const file = path.join(entry.parentPath, entry.name);
          const match = fs.readFileSync(file, 'utf8').match(/<title>([^<]*)<\/title>/);
          if (!match) continue; // pages without a head (bare fragments) are fine
          ctx.expect(match[1].trim(), `${path.relative(OUT, file)}: empty <title>`).not.toBe('');
          if (match[1].trim() === 'Contract') sawBrandFallback = true;
        }

        ctx.expect(sawBrandFallback, 'at least one page used the brand-name fallback').toBeTruthy();
      },
    },

    {
      name: 'head wires the shipped favicon set: webmanifest link + og:image brand fallback',
      run: (ctx) => {
        const html = fs.readFileSync(path.join(OUT, 'about.html'), 'utf8');
        ctx.expect(html.includes('/assets/images/favicon/site.webmanifest'), 'manifest link points at the shipped webmanifest').toBeTruthy();
        ctx.expect(!html.includes('/manifest.json'), 'the old never-emitted /manifest.json link is gone').toBeTruthy();
        ctx.expect(!html.includes('browserconfig.xml') && !html.includes('safari-pinned-tab'), 'legacy favicon tags dropped (no set carries them)').toBeTruthy();
        ctx.expect(html.includes('property="og:image" content="https://contract.test/assets/images/brand/social.png"'), 'og:image falls back to brand.images.social').toBeTruthy();
      },
    },

    // ─── The brand image: own file, then the brand's brandmark ───

    {
      name: 'a brandmark and no image files of the target\'s own: the build ships the favicon set, both brandmark files, the social image and /favicon.ico, and the head links them',
      run: async (ctx) => {
        const { dist } = await brandmarkOnlyBuild();
        const favicons = path.join(dist, 'assets', 'images', 'favicon');

        const set = fs.readdirSync(favicons).sort();
        ctx.expect(set.includes('favicon.ico') && set.includes('site.webmanifest'), `the set carries favicon.ico and site.webmanifest (has ${set})`).toBeTruthy();
        ctx.expect(set.filter((file) => file.endsWith('.png')).length, 'and five PNGs').toBe(5);
        const ico = fs.readFileSync(path.join(favicons, 'favicon.ico'));
        ctx.expect([...ico.subarray(0, 4)], 'a real ICO').toEqual([0, 0, 1, 0]);
        ctx.expect(fs.readFileSync(path.join(dist, 'favicon.ico')).equals(ico), 'the root /favicon.ico is the set\'s').toBeTruthy();

        const brand = path.join(dist, 'assets', 'images', 'brand');
        ctx.expect((await sharp(path.join(brand, 'brandmark.svg')).metadata()).format, 'brandmark.svg').toBe('svg');
        for (const name of ['brandmark.png', 'social.png']) {
          const meta = await sharp(path.join(brand, name)).metadata();
          ctx.expect(meta.format, `${name} is a PNG`).toBe('png');
          ctx.expect(meta.width, `${name} is square`).toBe(meta.height);
        }

        const links = faviconLinks(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'));
        ctx.expect(links.icons.length > 0, 'the head carries favicon links').toBeTruthy();
        ctx.expect(links.manifest, 'and the manifest link').toEqual(['/assets/images/favicon/site.webmanifest']);
        for (const sitePath of [...links.icons, ...links.manifest]) {
          ctx.expect(fs.existsSync(path.join(dist, sitePath)), `${sitePath} is in the build`).toBeTruthy();
        }

        // The manifest's icon paths resolve against the manifest's own URL
        const manifestUrl = `https://fixture.example.com${links.manifest[0]}`;
        const manifest = JSON.parse(fs.readFileSync(path.join(dist, links.manifest[0]), 'utf8'));
        ctx.expect(manifest.icons.length > 0, 'the manifest names its icons').toBeTruthy();
        for (const icon of manifest.icons) {
          const sitePath = new URL(icon.src, manifestUrl).pathname;
          ctx.expect(fs.existsSync(path.join(dist, sitePath)), `manifest icon ${icon.src} (served at ${sitePath}) is in the build`).toBeTruthy();
        }
      },
    },

    {
      name: 'the nav takes the brandmark svg the build derived',
      run: async (ctx) => {
        const { dist } = await brandmarkOnlyBuild();
        const $ = cheerio.load(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'));

        const src = $('a.omega-nav__brand img').attr('src');
        ctx.expect(src && src.split('?')[0], 'the nav logo is the vector').toBe('/assets/images/brand/brandmark.svg');
      },
    },

    {
      name: 'an unchanged brandmark built twice: the second run derives nothing new',
      run: async (ctx) => {
        const { brandRoot, target } = await brandmarkOnlyBuild();
        const cache = path.join(brandRoot, '.omega', 'cache', 'brand-image');
        const first = filesWithMtimes(cache);
        ctx.expect(Object.keys(first).length > 0, 'the first run kept what it derived in the brand-image cache').toBeTruthy();

        await buildIn(target);

        ctx.expect(filesWithMtimes(cache), 'no file added, none rewritten').toEqual(first);
      },
    },

    {
      name: 'the brand-image cache removes a folder unused for a day, finished or temp, keeps a newer one, and refreshes the folder in use',
      run: async (ctx) => {
        const { brandRoot, target } = brandWithWeb(ctx, { brand: { 'assets/logo/brandmark.svg': BRANDMARK_SVG } });
        const cache = path.join(brandRoot, '.omega', 'cache', 'brand-image');
        await shipStatic(target);
        const [inUse] = fs.readdirSync(cache);

        const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
        for (const name of ['old-set', 'old-set.tmp-dead', 'other-target']) {
          fs.mkdirSync(path.join(cache, name));
        }
        for (const name of [inUse, 'old-set', 'old-set.tmp-dead']) {
          fs.utimesSync(path.join(cache, name), dayAgo, dayAgo);
        }

        await shipStatic(target);

        ctx.expect(fs.readdirSync(cache).sort()).toEqual([inUse, 'other-target'].sort());
        ctx.expect(Date.now() - fs.statSync(path.join(cache, inUse)).mtimeMs < 60 * 60 * 1000, 'the folder in use was refreshed').toBe(true);
      },
    },

    {
      name: 'the build writes or changes no file in the target\'s source tree',
      run: async (ctx) => {
        const { target, sourceBefore } = await brandmarkOnlyBuild();

        ctx.expect(sourceState(target)).toEqual(sourceBefore);
      },
    },

    {
      name: 'a target\'s own favicon set ships unchanged and none is derived',
      run: async (ctx) => {
        const own = { 'favicon.ico': 'own-ico', 'favicon-32x32.png': 'own-32', 'site.webmanifest': '{"name":"Own"}' };
        const { target } = brandWithWeb(ctx, {
          brand: { 'assets/logo/brandmark.svg': BRANDMARK_SVG },
          target: Object.fromEntries(Object.entries(own).map(([name, contents]) => [`src/assets/images/favicon/${name}`, contents])),
        });

        const { dist } = await shipStatic(target);

        const favicons = path.join(dist, 'assets', 'images', 'favicon');
        const shipped = Object.fromEntries(fs.readdirSync(favicons).map((name) => [name, fs.readFileSync(path.join(favicons, name), 'utf8')]));
        ctx.expect(shipped, 'exactly the own set, byte for byte').toEqual(own);
        ctx.expect(fs.readFileSync(path.join(dist, 'favicon.ico'), 'utf8'), 'the root copy is the own one').toBe('own-ico');
      },
    },

    {
      name: 'a target\'s own favicon.ico with no webmanifest: its bytes ship over the derived one, and the rest of the set is derived',
      run: async (ctx) => {
        const { target } = brandWithWeb(ctx, {
          brand: { 'assets/logo/brandmark.svg': BRANDMARK_SVG },
          target: { 'src/assets/images/favicon/favicon.ico': 'own-ico' },
        });

        const { dist } = await shipStatic(target);

        const favicons = path.join(dist, 'assets', 'images', 'favicon');
        ctx.expect(fs.readFileSync(path.join(favicons, 'favicon.ico'), 'utf8'), 'the own favicon.ico wins the collision').toBe('own-ico');
        ctx.expect(fs.readFileSync(path.join(dist, 'favicon.ico'), 'utf8'), 'the root copy is the own one').toBe('own-ico');
        const set = fs.readdirSync(favicons).sort();
        ctx.expect(set.includes('site.webmanifest'), `the webmanifest derived (has ${set})`).toBeTruthy();
        const pngs = set.filter((name) => name.endsWith('.png'));
        ctx.expect(pngs.length, 'five derived PNGs').toBe(5);
        for (const name of pngs) {
          ctx.expect((await sharp(path.join(favicons, name)).metadata()).format, `${name} is a derived PNG`).toBe('png');
        }
      },
    },

    {
      name: 'a target\'s own brand/brandmark.png alone ships, and the rest are derived',
      run: async (ctx) => {
        // A shape no derived brandmark has: derived ones are square
        const ownPng = await sharp({ create: { width: 40, height: 24, channels: 4, background: '#00ff00' } }).png().toBuffer();
        const { target } = brandWithWeb(ctx, {
          brand: { 'assets/logo/brandmark.svg': BRANDMARK_SVG },
          target: { 'src/assets/images/brand/brandmark.png': ownPng },
        });

        const { dist } = await shipStatic(target);

        const brand = path.join(dist, 'assets', 'images', 'brand');
        const shipped = await sharp(path.join(brand, 'brandmark.png')).metadata();
        ctx.expect([shipped.width, shipped.height], 'the own brandmark.png').toEqual([40, 24]);
        ctx.expect((await sharp(path.join(brand, 'brandmark.svg')).metadata()).format, 'brandmark.svg derived').toBe('svg');
        ctx.expect((await sharp(path.join(brand, 'social.png')).metadata()).format, 'social.png derived').toBe('png');
        const set = fs.readdirSync(path.join(dist, 'assets', 'images', 'favicon'));
        ctx.expect(set.includes('site.webmanifest') && set.includes('favicon.ico'), `the favicon set derived (has ${set})`).toBeTruthy();
      },
    },

    {
      name: 'a brand with no brandmark and a target with no image files: the static copies pass and the head has no favicon set to link',
      run: async (ctx) => {
        const { target } = brandWithWeb(ctx);

        const { staticDirs, dist, rootFavicon } = await shipStatic(target);

        // The head links its favicons only when hasFaviconSet says a set ships
        ctx.expect(hasFaviconSet(staticDirs), 'no favicon set to link').toBe(false);
        ctx.expect(fs.existsSync(path.join(dist, 'assets', 'images', 'favicon')), 'none shipped').toBe(false);
        ctx.expect(rootFavicon, 'no root /favicon.ico').toBe(false);
      },
    },

    {
      name: 'a web project with no brand root and no image files of its own: the static copies pass, with no favicon set to link',
      run: async (ctx) => {
        const project = tree(ctx, { 'config/omega.json5': BRAND_CONFIG, 'package.json': TARGET_PACKAGE });
        ctx.expect(findBrandRoot(project), 'a framework used on its own').toBe(null);

        const { staticDirs, dist, rootFavicon } = await shipStatic(project);

        ctx.expect(hasFaviconSet(staticDirs), 'no favicon set to link').toBe(false);
        ctx.expect(fs.existsSync(path.join(dist, 'assets', 'images', 'favicon')), 'none shipped').toBe(false);
        ctx.expect(rootFavicon, 'no root /favicon.ico').toBe(false);
      },
    },
  ],
});
