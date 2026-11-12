/**
 * Assets processing rules — which logo sources produce which derived files.
 *
 * Sources live in the brand repo at `assets/logo/*.svg` (committed brand
 * collateral — omega-manager read `.brands/{id}/assets/`); derived files
 * land in `.omega/assets/` (gitignored, regenerable — omega-manager's
 * `.output/{id}/assets/`).
 *
 * Logo naming conventions:
 * - brandmark: Square icon/symbol (no text)
 * - wordmark: Text-only logo
 * - combomark: Icon + text combined
 */

const { LOGO_SOURCES_DIR, BRANDMARK_SOURCE } = require('@omega.js/config');

const BRANDMARK_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024, 2048];
const WIDE_LOGO_SIZES = [128, 256, 512, 1024, 2048];

/**
 * Each logo source gets two variants — the SVG as-is (colors/gradients
 * preserved) and an all-black conversion — exported as SVG + PNGs at all
 * sizes.
 */
const PROCESSING_RULES = {
  brandmark: {
    source: BRANDMARK_SOURCE,
    outputDir: 'logo/brandmark',
    square: true,
    sizes: BRANDMARK_SIZES,
  },
  wordmark: {
    source: `${LOGO_SOURCES_DIR}/wordmark.svg`,
    outputDir: 'logo/wordmark',
    square: false,
    sizes: WIDE_LOGO_SIZES,
  },
  combomark: {
    source: `${LOGO_SOURCES_DIR}/combomark.svg`,
    outputDir: 'logo/combomark',
    square: false,
    sizes: WIDE_LOGO_SIZES,
  },
};

/**
 * Social profile icons: the square brandmark on a white background for
 * profile pictures. The padding and the white are the shared recipe's
 * (`makeSocialSquare`); `svgSize` is the wrapped SVG's canvas.
 */
const SOCIAL_ICON_CONFIG = {
  outputDir: 'social/brandmark',
  sizes: [512, 1024, 2048],
  svgSize: 1024,
};

/**
 * PSD templates — brand-editable Photoshop sources for app icons, social
 * images, and store promos. Each `{key}.psd` lives in the brand repo at
 * `assets/templates/` (seeded on first run from the company root's
 * `assets/templates/` when the brand is company-managed — omega-manager
 * baked ITW's binaries into its own `src/defaults/`); exports land in
 * `.omega/assets/{outputDir}/`.
 *
 * Layer replacement types:
 * - logo: replace the layer canvas with the brandmark SVG
 *   - path: slash-delimited layer path (e.g. 'Main/Logo/Logo')
 *   - size: logo size as a fraction of canvas width (0-1)
 *   - bounds: [left, top, right, bottom] fractions to center within (optional)
 *   - useBlackLogo: render the pure-black brandmark variant
 * - text: replace a text layer's content with a brandConfig value
 *   - path: slash-delimited layer path
 *   - value: dot-notation config path (e.g. 'brand.name')
 *   - maxWidth: max text width as a fraction of canvas width — shrinks the
 *     font when the value overflows
 */
const TEMPLATE_CONFIG = {
  // --- App: macOS ---
  'app-macos-icon': {
    dimensions: [1024, 1024],
    outputDir: 'app/macos',
    outputName: 'icon',
    layers: [
      { type: 'logo', path: 'Main/Logo/Logo', size: 0.575, bounds: [0.078, 0.089, 0.922, 0.933] },
    ],
  },
  'app-macos-tray': {
    dimensions: [32, 32],
    outputDir: 'app/macos',
    // The desktop framework consumes this as `tray.png` and renames its dist
    // output to `trayTemplate.png` itself (the `Template` suffix is a macOS
    // magic marker for dark-mode auto-inversion). Native @2x size; the
    // framework downscales the @1x sibling.
    outputName: 'tray',
    layers: [
      // macOS tray template images MUST be pure black (with alpha) so the
      // system can invert them in dark mode
      { type: 'logo', path: 'Main/Logo/Logo', size: 1.0, useBlackLogo: true },
    ],
  },
  'app-macos-dmg': {
    dimensions: [1080, 760],
    outputDir: 'app/macos',
    outputName: 'dmg',
  },

  // --- App: Windows ---
  'app-windows-icon': {
    dimensions: [1024, 1024],
    outputDir: 'app/windows',
    outputName: 'icon',
    layers: [
      { type: 'logo', path: 'Main/Logo/Logo', size: 0.7 },
    ],
  },

  // --- Social ---
  'social-og-image': {
    dimensions: [1200, 630],
    outputDir: 'social',
    outputName: 'og-image',
    layers: [
      { type: 'logo', path: 'Main/Logo/Logo', size: 0.25 },
      { type: 'text', path: 'Main/Text/Brand Name', value: 'brand.name', maxWidth: 0.8 },
      { type: 'text', path: 'Main/Text/Brand Tagline', value: 'brand.tagline', maxWidth: 0.7 },
    ],
  },

  // --- Store: Chrome Web Store ---
  'store-chrome-promo-small': {
    dimensions: [440, 280],
    outputDir: 'store/chrome',
    outputName: 'promo-small',
  },
  'store-chrome-promo-large': {
    dimensions: [920, 680],
    outputDir: 'store/chrome',
    outputName: 'promo-large',
  },
  'store-chrome-promo-marquee': {
    dimensions: [1400, 560],
    outputDir: 'store/chrome',
    outputName: 'promo-marquee',
  },
};

/**
 * App icon formats per platform. The composited `icon.png` from the
 * templates operation is the source when present, else the brandmark SVG.
 */
const ICON_PLATFORMS = {
  macos: { format: 'icns' },
  windows: { format: 'ico' },
};

module.exports = { PROCESSING_RULES, SOCIAL_ICON_CONFIG, TEMPLATE_CONFIG, ICON_PLATFORMS };
