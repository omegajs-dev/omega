/**
 * The brand image: one lookup order every target type shares (the target's own
 * file, then the brand's `assets/logo/brandmark.svg`, then the framework
 * default). A target type declares only its own candidates and its default.
 * The makers live beside it, split by the image library each needs.
 */
const path = require('node:path');
const jetpack = require('fs-jetpack');
const { BRANDMARK_SOURCE } = require('@omega.js/config');

/**
 * Resolve a target's brand image through the one order: the first of the
 * target's own candidates that exists, then the brand's brandmark, then the
 * framework default.
 *
 * @param {object} options
 * @param {string[]} [options.own] - The target's own candidate paths, in order.
 * @param {string|null} [options.brandRoot] - The brand folder, null for a framework used alone.
 * @param {string|null} [options.fallback] - The framework default, null where the type has none.
 * @returns {{ path: string|null, from: 'own'|'brand'|'default'|null }}
 */
function resolveBrandImage({ own = [], brandRoot = null, fallback = null }) {
  const ownFile = own.find((candidate) => jetpack.exists(candidate) === 'file');
  if (ownFile) {
    return { path: ownFile, from: 'own' };
  }

  const brandmark = brandRoot ? path.join(brandRoot, BRANDMARK_SOURCE) : null;
  if (brandmark && jetpack.exists(brandmark) === 'file') {
    return { path: brandmark, from: 'brand' };
  }

  if (fallback) {
    return { path: fallback, from: 'default' };
  }

  return { path: null, from: null };
}

/**
 * Wrap an SVG in a square canvas that contains it whole on a clear ground, so a
 * mark that is not square still makes square images. Text in, text out.
 *
 * @param {string|Buffer} svg - The SVG source.
 * @param {number} side - The square's side, in pixels.
 * @returns {string} the square SVG.
 */
function squareSvg(svg, side) {
  const href = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><image width="${side}" height="${side}" href="${href}"/></svg>`;
}

module.exports = { resolveBrandImage, squareSvg };
