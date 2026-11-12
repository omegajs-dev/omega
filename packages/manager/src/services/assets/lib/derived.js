/**
 * The derived output NAMES every assets operation owns — the one home of the
 * naming conventions, read by the writers that produce the files, by the
 * `--reset-assets` cache clear (lib/reset.js), and by the reconcile that
 * deletes what the current sources no longer derive (lib/reconcile.js).
 *
 * It has to be ONE list: a name a writer produces but the reconcile does not
 * derive would be deleted on every walk and regenerated on the next one, so
 * the two views of "what belongs under .omega/assets/" can never be allowed
 * to drift apart.
 *
 * Everything here is relative to `.omega/assets/`; the shapes come from
 * assets-config.js, so a new rule/template/platform is covered without a
 * second registry to update.
 */
const { join } = require('node:path');

const {
  PROCESSING_RULES, SOCIAL_ICON_CONFIG, TEMPLATE_CONFIG, ICON_PLATFORMS,
} = require('./assets-config.js');

/** The two variants every logo source produces: the SVG as-is, and all-black. */
const LOGO_VARIANTS = ['color', 'black'];

/**
 * One logo variant's files, relative to the rule's output dir.
 *
 * @param {object} rule - A PROCESSING_RULES entry.
 * @param {string} variant - A LOGO_VARIANTS entry.
 * @returns {string[]} The variant SVG plus a PNG per ladder size.
 */
function logoVariantFiles(rule, variant) {
  return [`${variant}-x.svg`, ...rule.sizes.map((size) => `${variant}-${size}.png`)];
}

/**
 * The social profile icons, relative to SOCIAL_ICON_CONFIG.outputDir.
 *
 * @returns {string[]} The wrapped SVG plus a PNG per size.
 */
function socialIconFiles() {
  return ['color-x.svg', ...SOCIAL_ICON_CONFIG.sizes.map((size) => `color-${size}.png`)];
}

/**
 * One PSD template's exports.
 *
 * @param {object} config - A TEMPLATE_CONFIG entry.
 * @returns {string[]} Paths relative to `.omega/assets/`.
 */
function templateExportFiles(config) {
  return (config.exports || [{ suffix: '' }])
    .map((exp) => join(config.outputDir, `${config.outputName}${exp.suffix || ''}.png`));
}

/**
 * The platform app icons.
 *
 * @returns {Array<{ platform: string, format: string, file: string }>} `file`
 *   is relative to `.omega/assets/`.
 */
function appIconFiles() {
  return Object.entries(ICON_PLATFORMS).map(([platform, { format }]) => ({
    platform,
    format,
    file: join('app', platform, `icon.${format}`),
  }));
}

/**
 * Every directory under `.omega/assets/` an assets operation writes into —
 * the reconcile's output BOUNDARY. Nested entries are dropped (a recursive
 * walk of `social` already covers `social/brandmark`), so each file is
 * visited once.
 *
 * @returns {string[]} Paths relative to `.omega/assets/`.
 */
function assetsOutputDirs() {
  const dirs = [...new Set([
    ...Object.values(PROCESSING_RULES).map((rule) => rule.outputDir),
    SOCIAL_ICON_CONFIG.outputDir,
    ...Object.values(TEMPLATE_CONFIG).map((config) => config.outputDir),
    ...Object.keys(ICON_PLATFORMS).map((platform) => join('app', platform)),
  ])];

  return dirs.filter((dir) => !dirs.some((other) => other !== dir && dir.startsWith(`${other}/`)));
}

module.exports = {
  LOGO_VARIANTS,
  logoVariantFiles,
  socialIconFiles,
  templateExportFiles,
  appIconFiles,
  assetsOutputDirs,
};
