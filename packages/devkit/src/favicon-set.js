/**
 * The favicon set: the one copy of the recipe that turns the brandmark into a
 * site's favicons. It needs `sharp` and `png2icons`, so a host that requires
 * this module declares both.
 */
const path = require('node:path');
const jetpack = require('fs-jetpack');
const { writeJson } = require('./write-json.js');
const { CLEAR } = require('./brand-image-raster.js');

// The favicon set's PNG ladder; favicon.ico and site.webmanifest join it.
const FAVICON_FILES = [
  { name: 'favicon-16x16.png', size: 16 },
  { name: 'favicon-32x32.png', size: 32 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'android-chrome-192x192.png', size: 192 },
  { name: 'android-chrome-512x512.png', size: 512 },
];
const FAVICON_ICO_SIZE = 512;

/**
 * Write the favicon set from one source image. The webmanifest is written
 * last, so a folder that holds it holds the whole set. Its icon paths are
 * relative to the manifest, which sits beside them.
 *
 * @param {object} options
 * @param {string} options.source - The source image (the brandmark).
 * @param {string} options.outDir - The folder the set lands in.
 * @param {string} options.name - The brand name the webmanifest carries.
 * @returns {Promise<string[]>} The files written, absolute.
 */
async function makeFaviconSet({ source, outDir, name }) {
  const sharp = require('sharp');
  const png2icons = require('png2icons');
  const written = [];

  jetpack.dir(outDir);

  for (const file of FAVICON_FILES) {
    const outFile = path.join(outDir, file.name);
    await sharp(source)
      .resize(file.size, file.size, { fit: 'contain', background: CLEAR })
      .png()
      .toFile(outFile);
    written.push(outFile);
  }

  const icoSource = await sharp(source)
    .resize(FAVICON_ICO_SIZE, FAVICON_ICO_SIZE, { fit: 'contain', background: CLEAR })
    .png()
    .toBuffer();
  const icoFile = path.join(outDir, 'favicon.ico');
  jetpack.write(icoFile, png2icons.createICO(icoSource, png2icons.BICUBIC, 0, true));
  written.push(icoFile);

  const manifestFile = path.join(outDir, 'site.webmanifest');
  writeJson(manifestFile, {
    name,
    short_name: name,
    icons: [
      { src: 'android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: 'android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    theme_color: '#ffffff',
    background_color: '#ffffff',
    display: 'standalone',
  });
  written.push(manifestFile);

  return written;
}

module.exports = { makeFaviconSet };
