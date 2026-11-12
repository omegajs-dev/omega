// Libraries
const build = require('../../build.js');
const logger = build.logger('icons');
const watcherLogger = build.logger('icons:watcher');
const path = require('path');
const { Transform } = require('stream');
const { src, dest, watch, series } = require('gulp');
const responsive = require('gulp-responsive-modern');
const { findBrandRoot, BRANDMARK_SOURCE } = require('@omega.js/config');
const { resolveBrandImage, squareSvg } = require('@omega.js/devkit/brand-image');

// Load package
const package = build.getPackage('main');
const project = build.getPackage('project');
const config = build.getConfig('project');
const rootPathPackage = build.getRootPath('main');
const rootPathProject = build.getRootPath('project');

// The target's own icon, in the order its candidates win; the brand's brandmark follows.
const ownIcons = [
  'config/icon.svg',
  'config/icon.png',
].map((file) => path.join(rootPathProject, file));
const output = 'dist/assets/images/icons';
const delay = 250;

// The source icon through the shared brand-image order: { path, from }.
function resolveIcon() {
  return resolveBrandImage({
    own: ownIcons,
    brandRoot: findBrandRoot(rootPathProject),
  });
}

// Square each SVG in the stream, so a brandmark that is not square still makes square icons.
function squareEach(side) {
  return new Transform({
    objectMode: true,
    transform(file, encoding, callback) {
      file.contents = Buffer.from(squareSvg(file.contents, side));
      callback(null, file);
    },
  });
}

// Main task
function icons(complete) {
  // Define sizes
  const sizes = [1024, 512, 256, 128, 64, 48, 32, 24, 16];

  // Log
  logger.log('Starting...');

  // Resolve the one source icon
  const icon = resolveIcon();

  // If there's no source, complete
  if (!icon.path) {
    // Log
    logger.log('Found 0 images to process');

    // Complete
    return complete();
  }

  // Log
  logger.log(`Using ${icon.path} (${icon.from})`);

  // Filter out files that already exist in the destination
  // const filesToProcess = files.filter(file => {
  //   const fileName = path.basename(file);
  //   const destFile = path.join(output, fileName);
  //   return !jetpack.exists(destFile);
  // });

  // If there's no files to process, complete
  // if (filesToProcess.length === 0) {
  //   // Log
  //   logger.log('No new images to process');

  //   // Complete
  //   return complete();
  // }

  // Log
  // logger.log(`Processing ${filesToProcess.length} images`, filesToProcess);

  // Process images: resize and convert to webp
  // encoding: false — gulp 5 decodes as UTF-8 by default, which corrupts binary
  // buffers before sharp reads them (same guard distribute.js uses)
  // basename: the brandmark's outputs carry the icon's names
  const source = src(icon.path, { encoding: false });
  const squared = icon.from === 'brand' ? source.pipe(squareEach(Math.max(...sizes))) : source;

  return squared
    .pipe(
      responsive({
        '**/*.{jpg,jpeg,png,svg}': [
          // Generate configurations dynamically
          ...sizes.map((size) => ({
            width: size,
            rename: { basename: 'icon', suffix: `-${size}x`, extname: '.png' },
          })),
          // Original size in original format
          {
            rename: { basename: 'icon', suffix: '', extname: '.png' },
          },
        ]
      }, {
        quality: 100,
        progressive: true,
        withMetadata: false,
        withoutEnlargement: false,
        skipOnEnlargement: false,
      })
    )
    .pipe(dest(output, { encoding: false }))
    .on('end', () => {
      // Log
      logger.log('Finished!');

      // Complete
      return complete();
    });
}

// Watcher task
function iconsWatcher(complete) {
  // Quit if in build mode
  if (build.isBuildMode()) {
    watcherLogger.log('Skipping watcher in build mode');
    return complete();
  }

  // The target's own icons always, so one dropped in later takes over; the brandmark when in a brand
  const brandRoot = findBrandRoot(rootPathProject);
  const watched = brandRoot ? [...ownIcons, path.join(brandRoot, BRANDMARK_SOURCE)] : ownIcons;

  // Log
  watcherLogger.log('Watching for changes...', watched);

  // Watch for changes
  watch(watched, { delay: delay, dot: true }, icons)
  .on('change', function(path) {
    watcherLogger.log(`File ${path} was changed`);
  });

  // Complete
  return complete();
}

// Default Task
module.exports = series(icons, iconsWatcher);
