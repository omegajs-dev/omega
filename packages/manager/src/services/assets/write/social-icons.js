/**
 * Generate social profile icons (the square brandmark centered on a white
 * background with padding, for profile pictures on YouTube, Twitter and the
 * like) as a wrapped SVG + PNGs into `.omega/assets/social/brandmark/`.
 * mtime-diffed against the brandmark. The recipe is the shared
 * `makeSocialSquare` (`@omega.js/devkit/brand-image-raster`).
 */
const { join } = require('node:path');
const chalk = require('chalk').default;
const { makeSocialSquare } = require('@omega.js/devkit/brand-image-raster');
const { SOCIAL_ICON_CONFIG } = require('../lib/assets-config.js');
const { socialIconFiles } = require('../lib/derived.js');
const { isStale } = require('../../../lib/stale.js');

module.exports = async function writeSocialIcons(context) {
  const { brandmarkPath, outDir, options } = context;
  const dryRun = options?.dryRun || false;

  const { outputDir: subDir, sizes, svgSize } = SOCIAL_ICON_CONFIG;
  const outputDir = join(outDir, subDir);

  const targets = socialIconFiles().filter((name) => isStale(brandmarkPath, join(outputDir, name)));

  if (targets.length === 0) {
    console.log(`      ${chalk.green('✓')} Social icons in sync ${chalk.dim(`(${1 + sizes.length} files fresh)`)}`);
    return { output: { socialIcons: { synced: true } } };
  }

  if (dryRun) {
    console.log(`      ${chalk.yellow('[DRY RUN]')} Would generate ${chalk.cyan(targets.length)} social icon files`);
    return { output: { socialIcons: { planned: targets.length } } };
  }

  for (const name of targets) {
    const size = name.endsWith('.svg') ? svgSize : parseInt(name.match(/-(\d+)\.png$/)[1], 10);
    await makeSocialSquare({ source: brandmarkPath, outFile: join(outputDir, name), size });
  }

  console.log(`      ${chalk.green('✓')} Generated ${chalk.bold(targets.length)} social icon files`);
  return { output: { socialIcons: { generated: targets.length } } };
};
