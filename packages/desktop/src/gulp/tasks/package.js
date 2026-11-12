// Package the app via electron-builder, using the materialized config at
// `dist/electron-builder.yml` (produced by gulp/build-config from omega.json5).
// Consumers never ship an electron-builder.yml — the dist version is the only source of truth.
//
// This task does NOT publish — it just produces local artifacts under `release/`.
// For publishing, see gulp/release.js.
//
// Skip Windows code signing during this step on the windows runner if OMEGA_SKIP_WIN_SIGN=true
// is set — the windows-sign job in CI signs separately.

const path    = require('path');
const jetpack = require('fs-jetpack');
const build = require('../../build.js');
const { assertStoreLogins } = require('./build-config.js');

const logger = build.logger('package');

module.exports = function packageApp(done) {
  // Installers are made here, so a store format with no login stops it first
  try {
    assertStoreLogins(build.getConfig());
  } catch (error) {
    return done(error);
  }

  const projectRoot = process.cwd();
  const config = path.join(require('../../utils/dist-root.js')(projectRoot), 'electron-builder.yml');

  if (!jetpack.exists(config)) {
    return done(new Error(`Missing ${config}. Run gulp/build-config first (it generates this file from omega.json5).`));
  }

  // Resolve electron-builder from the consumer's node_modules first, then @omega.js/desktop's bundled one.
  let builder;
  try {
    builder = require('electron-builder');
  } catch (e) {
    return done(new Error(`Could not resolve electron-builder: ${e.message}. Run \`npm i -D electron-builder\` in the consumer.`));
  }

  const relConfig = path.relative(projectRoot, config);
  logger.log(`Packaging via electron-builder (config=${relConfig})...`);

  const opts = {
    config,
    publish: 'never',          // package only — release.js handles publishing
  };

  // electron-builder's programmatic API returns a Promise<string[]> of artifact paths.
  builder.build(opts)
    .then((artifacts) => {
      const list = (artifacts || []).map((a) => path.relative(projectRoot, a));
      logger.log(`Packaged ${list.length} artifact(s):`);
      list.forEach((a) => logger.log(`  • ${a}`));
      done();
    })
    .catch((e) => {
      logger.error(`electron-builder failed: ${e.message}`);
      done(e);
    });
};
