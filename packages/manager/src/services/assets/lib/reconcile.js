/**
 * Assets reconcile (#636) — every file under `.omega/assets/` derives from the
 * brand's sources and config, so the walk that writes them also DELETES the
 * ones those sources no longer derive. Dropping `assets/logo/wordmark.svg` is
 * a real removal: the wordmark's variants and ladders go with it, not on the
 * next hand-deletion of the cache.
 *
 * Deleting is safe HERE and only here: `.omega/assets/` is the machine-owned,
 * gitignored cache the reset already clears (lib/reset.js), and every file in
 * it is regenerable from the brand's committed sources. The brand's own
 * collateral (`assets/logo/*.svg`, `assets/templates/*.psd`) is a SOURCE and
 * is never touched.
 *
 * Two locks keep it honest: the derived set comes from the SAME names the
 * writers generate (lib/derived.js), and the diff runs only inside the
 * operations' own output dirs — a file the assets service never writes into
 * cannot be reached from here.
 */
const { join } = require('node:path');
const fs = require('node:fs');
const jetpack = require('fs-jetpack');

const { PROCESSING_RULES, SOCIAL_ICON_CONFIG, TEMPLATE_CONFIG } = require('./assets-config.js');
const {
  LOGO_VARIANTS, logoVariantFiles, socialIconFiles,
  templateExportFiles, appIconFiles, assetsOutputDirs,
} = require('./derived.js');

/**
 * The FULL set of files the brand's current sources derive, exactly as the
 * write operations name them. A logo source or a PSD that isn't in the brand
 * derives nothing — which is what makes a removed source remove its outputs.
 *
 * The brandmark is guaranteed by the service's setup, so the operations that
 * read it alone (social icons, app icons) always derive their set.
 *
 * @param {string} brandRoot - Absolute brand-monorepo root.
 * @returns {Set<string>} Paths relative to `.omega/assets/`.
 */
function derivedAssetFiles(brandRoot) {
  const files = [];

  for (const rule of Object.values(PROCESSING_RULES)) {
    if (!jetpack.exists(join(brandRoot, rule.source))) {
      continue;
    }
    for (const variant of LOGO_VARIANTS) {
      files.push(...logoVariantFiles(rule, variant).map((name) => join(rule.outputDir, name)));
    }
  }

  files.push(...socialIconFiles().map((name) => join(SOCIAL_ICON_CONFIG.outputDir, name)));

  for (const [name, config] of Object.entries(TEMPLATE_CONFIG)) {
    // The brand's PSD is the source — a template it does not carry (and the
    // company root could not seed) exports nothing
    if (!jetpack.exists(join(brandRoot, 'assets', 'templates', `${name}.psd`))) {
      continue;
    }
    files.push(...templateExportFiles(config));
  }

  files.push(...appIconFiles().map((entry) => entry.file));

  return new Set(files);
}

/**
 * Every file under a directory, relative to it.
 *
 * @param {string} dir - Absolute directory.
 * @returns {string[]} Relative paths.
 */
function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
    ? filesUnder(join(dir, entry.name)).map((nested) => join(entry.name, nested))
    : [entry.name]));
}

/**
 * Delete the files inside the assets operations' output dirs that the brand's
 * current sources no longer derive. Runs AFTER the write operations, so a file
 * this same walk just generated (or a PSD it just seeded) is already derived.
 *
 * @param {object} args
 * @param {string} args.brandRoot - Absolute brand-monorepo root.
 * @param {string} args.outDir - The brand's `.omega/assets/`.
 * @param {boolean} [args.dryRun] - Report what would go, delete nothing.
 * @returns {{ removed: string[] }} The relative paths that were strays (and,
 *   outside a dry run, are now gone).
 */
function reconcileAssets({ brandRoot, outDir, dryRun = false }) {
  const derived = derivedAssetFiles(brandRoot);
  const removed = [];

  for (const dir of assetsOutputDirs()) {
    const base = join(outDir, dir);

    if (jetpack.exists(base) !== 'dir') {
      continue;
    }

    for (const relative of filesUnder(base)) {
      const path = join(dir, relative);

      if (derived.has(path)) {
        continue;
      }

      if (!dryRun) {
        jetpack.remove(join(base, relative));
      }
      removed.push(path);
    }
  }

  return { removed: removed.sort() };
}

module.exports = { derivedAssetFiles, reconcileAssets };
