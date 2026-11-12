/**
 * The brandmark's raster makers: the plain square on a clear ground and the
 * social square (the brandmark padded on white). Each is the one copy of its
 * recipe. They need `sharp`, so a host that requires this module declares it.
 */
const path = require('node:path');
const jetpack = require('fs-jetpack');

// The social square: the brandmark inset by this share of the side, on white.
const SOCIAL_PADDING = 0.15;
const SOCIAL_BACKGROUND = { r: 255, g: 255, b: 255, alpha: 1 };

const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

/**
 * Write the brandmark as a padded square on white: a PNG, or, for an `.svg`
 * out file, the source wrapped in a padded canvas of that size.
 *
 * @param {object} options
 * @param {string} options.source - The source image (the brandmark).
 * @param {string} options.outFile - The file to write.
 * @param {number} options.size - The side, in pixels.
 * @returns {Promise<string>} The file written.
 */
async function makeSocialSquare({ source, outFile, size }) {
  if (outFile.endsWith('.svg')) {
    jetpack.write(outFile, wrapSvgWithBackground(jetpack.read(source), size));
    return outFile;
  }

  const sharp = require('sharp');
  const logoSize = Math.round(size * (1 - SOCIAL_PADDING * 2));
  const offset = Math.round(size * SOCIAL_PADDING);

  const logoPng = await sharp(jetpack.read(source, 'buffer'))
    .resize(logoSize, logoSize, { fit: 'contain', background: CLEAR })
    .png()
    .toBuffer();

  jetpack.dir(path.dirname(outFile));
  await sharp({ create: { width: size, height: size, channels: 4, background: SOCIAL_BACKGROUND } })
    .composite([{ input: logoPng, left: offset, top: offset }])
    .png()
    .toFile(outFile);

  return outFile;
}

/**
 * Write the brandmark as a square PNG on a clear ground.
 *
 * @param {object} options
 * @param {string} options.source - The source image (the brandmark).
 * @param {string} options.outFile - The PNG to write.
 * @param {number} options.size - The side, in pixels.
 * @returns {Promise<string>} The file written.
 */
async function rasterizeBrandmark({ source, outFile, size }) {
  const sharp = require('sharp');

  jetpack.dir(path.dirname(outFile));
  await sharp(source)
    .resize(size, size, { fit: 'contain', background: CLEAR })
    .png()
    .toFile(outFile);

  return outFile;
}

/**
 * Wrap an SVG's content in a padded square canvas with a white rect behind
 * it, keeping the source's aspect ratio.
 *
 * @param {string} svgContent - The source SVG.
 * @param {number} canvasSize - The canvas side.
 * @returns {string} The wrapped SVG.
 */
function wrapSvgWithBackground(svgContent, canvasSize) {
  const viewBoxMatch = svgContent.match(/viewBox="([^"]+)"/);
  const widthMatch = svgContent.match(/<svg[^>]*\swidth="([^"]+)"/);
  const heightMatch = svgContent.match(/<svg[^>]*\sheight="([^"]+)"/);

  let srcWidth, srcHeight;
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].split(/\s+/);
    srcWidth = parseFloat(parts[2]);
    srcHeight = parseFloat(parts[3]);
  } else {
    srcWidth = parseFloat(widthMatch?.[1]) || 100;
    srcHeight = parseFloat(heightMatch?.[1]) || 100;
  }

  const pad = canvasSize * SOCIAL_PADDING;
  const availableSize = canvasSize - pad * 2;

  const scale = Math.min(availableSize / srcWidth, availableSize / srcHeight);
  const offsetX = pad + (availableSize - srcWidth * scale) / 2;
  const offsetY = pad + (availableSize - srcHeight * scale) / 2;

  const innerContent = svgContent
    .replace(/<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '');

  const bgHex = `#${[SOCIAL_BACKGROUND.r, SOCIAL_BACKGROUND.g, SOCIAL_BACKGROUND.b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvasSize} ${canvasSize}" width="${canvasSize}" height="${canvasSize}">
  <rect width="${canvasSize}" height="${canvasSize}" fill="${bgHex}"/>
  <g transform="translate(${offsetX}, ${offsetY}) scale(${scale})">
    ${innerContent.trim()}
  </g>
</svg>`;
}

module.exports = { rasterizeBrandmark, makeSocialSquare, CLEAR };
