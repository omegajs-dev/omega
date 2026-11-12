/**
 * The brand's logo names: where the committed logo sources live, where the
 * manager's assets service mints its collateral, and the site paths a web
 * build ships the brand image at.
 *
 * A web build derives its favicon set, brandmark files and social image from
 * `assets/logo/brandmark.svg` itself (devkit's brand-image modules), so
 * nothing under the gitignored `.omega/assets/` ships with a site.
 */

const fs = require('node:fs');
const path = require('node:path');

// Brand-root relative, posix-spelled.
const MINT_ROOT = '.omega/assets';
// The committed logo sources, and the one every brand image derives from.
const LOGO_SOURCES_DIR = 'assets/logo';
const BRANDMARK_SOURCE = `${LOGO_SOURCES_DIR}/brandmark.svg`;

// The site paths read by name: the head's favicon links, the visible logo's
// vector read, the manager's live probe of the raster brandmark, and the
// social square.
const FAVICON_DEST = 'assets/images/favicon';
const BRANDMARK_SVG_DEST = 'assets/images/brand/brandmark.svg';
const BRANDMARK_PNG_DEST = 'assets/images/brand/brandmark.png';
const SOCIAL_PNG_DEST = 'assets/images/brand/social.png';

/**
 * Whether the brand has the logo source every brand image derives from:
 * `assets/logo/brandmark.svg`. A brand without it has nothing to derive.
 *
 * @param {string} brandRoot - The brand folder.
 * @returns {boolean}
 */
function hasLogoSources(brandRoot) {
  return fs.existsSync(path.join(brandRoot, BRANDMARK_SOURCE));
}

module.exports = {
  MINT_ROOT,
  LOGO_SOURCES_DIR,
  BRANDMARK_SOURCE,
  FAVICON_DEST,
  BRANDMARK_SVG_DEST,
  BRANDMARK_PNG_DEST,
  SOCIAL_PNG_DEST,
  hasLogoSources,
};
