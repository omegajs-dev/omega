/**
 * brand-image: the one lookup order every target's build takes its brand image
 * by (its own file, then the brand's brandmark, then the framework default),
 * and the three makers (brand-image-raster, favicon-set) that turn the
 * brandmark into a build's files. Real files
 * and the real image libraries throughout: the makers' output is read back with
 * sharp, pixel by pixel where the shape of the image is the promise.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { resolveBrandImage, squareSvg } = require('@omega.js/devkit/brand-image');
const { makeSocialSquare, rasterizeBrandmark } = require('@omega.js/devkit/brand-image-raster');
const { makeFaviconSet } = require('@omega.js/devkit/favicon-set');

// Where a site serves the favicon set's webmanifest: its icon paths resolve against this URL.
const MANIFEST_URL = 'https://fixture.test/assets/images/favicon/site.webmanifest';

// A red disc that never reaches the corners of its box: a clear corner proves a clear ground.
const DISC_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#ff0000"/></svg>';
// A red square filling its whole box: a white corner can only be the padding.
const FULL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#ff0000"/></svg>';

/** A scratch folder holding the given relative files. */
function scratch(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-brand-image-'));
  for (const [relative, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), contents);
  }
  return root;
}

/** The RGBA pixel at (x, y) of an image file, with its size. */
async function pixelAt(file, x, y) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * 4;
  return { r: data[at], g: data[at + 1], b: data[at + 2], a: data[at + 3], width: info.width, height: info.height };
}

/** Every file under a folder, absolute, sorted. */
function filesUnder(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

module.exports = defineCases({
  type: 'group',
  description: 'brand-image',
  tests: [
    // ─── The lookup order ───

    {
      name: 'resolveBrandImage: the first own candidate on disk wins over the brandmark and the default',
      run: (ctx) => {
        const target = scratch({ 'config/icon.png': 'own', 'fallback/icon.png': 'default' });
        const brandRoot = scratch({ 'assets/logo/brandmark.svg': DISC_SVG });
        const own = [path.join(target, 'config', 'icon.svg'), path.join(target, 'config', 'icon.png')];

        const found = resolveBrandImage({ own, brandRoot, fallback: path.join(target, 'fallback', 'icon.png') });

        ctx.expect(found).toEqual({ path: path.join(target, 'config', 'icon.png'), from: 'own' });
      },
    },

    {
      name: 'resolveBrandImage: with no own file on disk, the brand\'s brandmark wins over the default',
      run: (ctx) => {
        const target = scratch({ 'fallback/icon.png': 'default' });
        const brandRoot = scratch({ 'assets/logo/brandmark.svg': DISC_SVG });

        const found = resolveBrandImage({ own: [path.join(target, 'config', 'icon.png')], brandRoot, fallback: path.join(target, 'fallback', 'icon.png') });

        ctx.expect(found).toEqual({ path: path.join(brandRoot, 'assets', 'logo', 'brandmark.svg'), from: 'brand' });
      },
    },

    {
      name: 'resolveBrandImage: the default answers for a brand with no brandmark and for no brand root at all',
      run: (ctx) => {
        const target = scratch({ 'fallback/icon.png': 'default' });
        const fallback = path.join(target, 'fallback', 'icon.png');
        const own = [path.join(target, 'config', 'icon.png')];

        ctx.expect(resolveBrandImage({ own, brandRoot: scratch({ 'config/omega.json5': '{}' }), fallback }), 'a brand with no brandmark').toEqual({ path: fallback, from: 'default' });
        ctx.expect(resolveBrandImage({ own, brandRoot: null, fallback }), 'a framework used on its own').toEqual({ path: fallback, from: 'default' });
      },
    },

    {
      name: 'resolveBrandImage: no own file, no brandmark and no default answers nothing',
      run: (ctx) => {
        const target = scratch();

        ctx.expect(resolveBrandImage({ own: [path.join(target, 'config', 'icon.png')], brandRoot: null, fallback: null })).toEqual({ path: null, from: null });
      },
    },

    {
      name: 'squareSvg: a mark wider than tall comes back as a square SVG with the whole mark inside it',
      run: async (ctx) => {
        const wide = '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="100" viewBox="0 0 150 100"><rect width="150" height="100" fill="#ff0000"/></svg>';
        const file = path.join(scratch({ 'square.svg': squareSvg(wide, 300) }), 'square.svg');

        const top = await pixelAt(file, 150, 10);
        ctx.expect([top.width, top.height], 'a square at the asked side').toEqual([300, 300]);
        ctx.expect(top.a, 'the band above the mark is clear').toBe(0);
        ctx.expect((await pixelAt(file, 150, 290)).a, 'the band below the mark is clear').toBe(0);
        for (const [x, edge] of [[1, 'left'], [298, 'right'], [150, 'middle']]) {
          const pixel = await pixelAt(file, x, 150);
          ctx.expect([pixel.r, pixel.g, pixel.b, pixel.a], `the mark reaches the ${edge}`).toEqual([255, 0, 0, 255]);
        }
      },
    },

    // ─── The makers ───

    {
      name: 'makeFaviconSet: five square PNGs, a multi-size favicon.ico and a webmanifest, drawn from the source',
      run: async (ctx) => {
        const source = path.join(scratch({ 'brandmark.svg': DISC_SVG }), 'brandmark.svg');
        const outDir = path.join(scratch(), 'favicon');

        const written = await makeFaviconSet({ source, outDir, name: 'Fixture Brand' });

        // The answer is the set on disk, nothing more and nothing less
        const onDisk = filesUnder(outDir);
        ctx.expect(written.map((file) => path.resolve(outDir, file)).sort()).toEqual(onDisk);
        ctx.expect(onDisk.length, 'five PNGs, favicon.ico and site.webmanifest').toBe(7);

        const pngs = onDisk.filter((file) => file.endsWith('.png'));
        const sizes = [];
        for (const png of pngs) {
          const meta = await sharp(png).metadata();
          ctx.expect(meta.format, `${path.basename(png)} is a PNG`).toBe('png');
          ctx.expect(meta.width, `${path.basename(png)} is square`).toBe(meta.height);
          sizes.push(meta.width);
          const centre = await pixelAt(png, Math.floor(meta.width / 2), Math.floor(meta.height / 2));
          ctx.expect([centre.r, centre.g, centre.b, centre.a], `${path.basename(png)} draws the brandmark`).toEqual([255, 0, 0, 255]);
        }
        ctx.expect(sizes.sort((a, b) => a - b), 'the browser, apple-touch and android sizes').toEqual([16, 32, 180, 192, 512]);

        // An ICO header, then one directory entry per size; a width byte of 0 means 256
        const ico = fs.readFileSync(path.join(outDir, 'favicon.ico'));
        ctx.expect([...ico.subarray(0, 4)], 'the ICO magic').toEqual([0, 0, 1, 0]);
        const icoWidths = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => ico[6 + index * 16] || 256);
        ctx.expect(icoWidths.includes(16) && icoWidths.includes(32), `the ico carries 16 and 32 (has ${icoWidths})`).toBeTruthy();

        const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'site.webmanifest'), 'utf8'));
        ctx.expect(manifest.name).toBe('Fixture Brand');
        ctx.expect(manifest.short_name).toBe('Fixture Brand');
        ctx.expect(manifest.icons.length > 0, 'the manifest names its icons').toBeTruthy();
        // The set is served from the manifest's own folder, so each src must name a file in it
        for (const icon of manifest.icons) {
          const sitePath = new URL(icon.src, MANIFEST_URL).pathname;
          const file = path.join(outDir, path.posix.relative('/assets/images/favicon', sitePath));
          ctx.expect(onDisk, `manifest icon ${icon.src} (served at ${sitePath}) is in the set`).toContain(file);
        }
      },
    },

    {
      name: 'makeSocialSquare: the brandmark padded on white, at the asked size',
      run: async (ctx) => {
        const source = path.join(scratch({ 'brandmark.svg': FULL_SVG }), 'brandmark.svg');
        const outFile = path.join(scratch(), 'social', 'social.png');

        await makeSocialSquare({ source, outFile, size: 300 });

        const corner = await pixelAt(outFile, 2, 2);
        ctx.expect([corner.width, corner.height], 'a square at the asked size').toEqual([300, 300]);
        ctx.expect([corner.r, corner.g, corner.b, corner.a], 'a full-bleed mark still leaves a white margin').toEqual([255, 255, 255, 255]);
        const centre = await pixelAt(outFile, 150, 150);
        ctx.expect([centre.r, centre.g, centre.b, centre.a], 'the mark sits in the middle').toEqual([255, 0, 0, 255]);
      },
    },

    {
      name: 'rasterizeBrandmark: the brandmark as a square PNG on a clear ground, at the asked size',
      run: async (ctx) => {
        const source = path.join(scratch({ 'brandmark.svg': DISC_SVG }), 'brandmark.svg');
        const outFile = path.join(scratch(), 'brand', 'brandmark.png');

        await rasterizeBrandmark({ source, outFile, size: 128 });

        ctx.expect((await sharp(outFile).metadata()).format).toBe('png');
        const corner = await pixelAt(outFile, 1, 1);
        ctx.expect([corner.width, corner.height], 'a square at the asked size').toEqual([128, 128]);
        ctx.expect(corner.a, 'the ground is clear').toBe(0);
        const centre = await pixelAt(outFile, 64, 64);
        ctx.expect([centre.r, centre.g, centre.b, centre.a], 'the mark is drawn').toEqual([255, 0, 0, 255]);
      },
    },
  ],
});
