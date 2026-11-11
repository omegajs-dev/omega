/**
 * `omega build` — full production build: assets (esbuild + sass, hashed) →
 * Eleventy → PurgeCSS, into dist/. The asset manifest also lands in
 * .omega/asset-manifest.json for the dev config and post-build tooling.
 * When translation.languages is set, the built site is then translated into
 * /{lang}/ copies — cache-first (committed per-string cache), and cold
 * strings translate LIVE by default so a build always ships the complete
 * translated site. `omega build --cached-only`, and
 * every build on a CI runner, ships cold pages untranslated instead (with a
 * warning list) for LLM-free builds.
 */
const path = require('node:path');
const jetpack = require('fs-jetpack');
const Logger = require('@omega.js/devkit/logger');
const attachLogFile = require('@omega.js/devkit/attach-log-file');
const { resolveLicenseStamp } = require('@omega.js/devkit/license');
const { findBrandRoot, readPortsFile, pagesHost, targetNameFromDir } = require('@omega.js/config');
const { setEnvironment, ENVIRONMENT_VAR } = require('@omega.js/config/environment');
const { ensureTarget } = require('./lib/ensure-target.js');
const { buildSite } = require('../build.js');
const { consumerPaths, loadSiteData } = require('../consumer.js');
const { resolveStaticDirs, assertMintedAssets } = require('../static-assets.js');
const { resolveClientEntry } = require('../paths.js');
const { isCachedOnly } = require('@omega.js/devkit/translate');
const { translateSite, warnSkippedCold } = require('../translate/index.js');
const { fetchFirebaseAuthHelpers } = require('../firebase-auth-helpers.js');
const { visibleProducts } = require('../pricing.js');

const logger = new Logger('build');

/**
 * C2: payment.products is the only pricing source — surface the honest empty
 * state loudly so a bare catalog is a choice, not a surprise. The page composes
 * from the VISIBLE catalog (#348), so an all-hidden catalog renders the same
 * empty state and earns the same warning, named for what it actually is.
 * @param {object} payment - resolved config `payment` section
 * @returns {string|null} The warning to print, or null when /pricing has cards.
 */
function catalogWarning(payment) {
  if (visibleProducts(payment).length > 0) return null;

  const total = payment && Array.isArray(payment.products) ? payment.products.length : 0;
  const state = total > 0
    ? `payment.products lists ${total} product${total === 1 ? '' : 's'}, every one marked hidden`
    : 'payment.products is empty';

  return `${state} — /pricing renders the "no published pricing" empty state`;
}

/**
 * The port a LIVE `omega dev` is serving this target on, or null (#617).
 *
 * The dev server publishes its resolved port in the target's ports file for
 * sibling tools and retracts it on shutdown, so that file already IS the dev
 * run's lock — no second one to invent or keep in sync. Only the dev server
 * writes one in a website target, and the reader ignores a file whose pid is
 * gone, so a crash leftover can never wedge a build.
 * @param {string} root - the target root
 * @returns {number|null} The live dev server's port, or null when none runs.
 */
function liveDevPort(root) {
  const ports = readPortsFile(root);
  return (ports && ports.website) || null;
}

// A caller running the build in process (the test verb) gets its own environment back, success or throw.
module.exports = async function (options) {
  const found = process.env[ENVIRONMENT_VAR];
  try {
    return await build(options);
  } finally {
    if (found === undefined) delete process.env[ENVIRONMENT_VAR];
    else process.env[ENVIRONMENT_VAR] = found;
  }
};

async function build(options) {
  options = options || {};

  // The verb names the environment for the whole process
  // ([#817](https://github.com/Omega-JS-Stack/omega/issues/817)): a build bakes
  // a PRODUCTION artifact, so every read below (the config overlay, the build
  // meta, the collision gate) answers production without asking the machine.
  setEnvironment('production');

  const paths = consumerPaths();

  // Dev and build write the SAME dist/, so a build under a running dev server
  // replaces the pages it is serving with production-stamped ones — and nothing
  // re-renders them until that server restarts (#617). Refuse, before anything
  // touches the target: stop dev first, or deploy, which runs its own build.
  const devPort = liveDevPort(paths.root);
  if (devPort) {
    throw new Error(`omega dev is serving this target on :${devPort} and both write dist/ — stop that dev leg first, then build (a deploy builds too, so it refuses the same way)`);
  }

  // Tee the whole run to <targetRoot>/logs/build.log (#197). `omega test` runs this
  // build INSIDE its own logs/test.log tee and passes logFile: false — a second
  // attach would detach that tee and the rest of the run would go uncaptured.
  if (options.logFile !== false) {
    attachLogFile(path.join(paths.root, 'logs', 'build.log'));
  }

  // The local half of the retired `omega setup` (#675) — idempotent, offline,
  // and quiet on a converged target.
  ensureTarget({ projectDir: paths.root, log: (line) => logger.log(line), warn: (line) => logger.warn(line) });

  // `omega build` IS the production build (the license check below says so
  // too), so the config it loads is the PRODUCTION one: the environment overlay
  // that composes is named by the lane, never by the machine the build runs on
  // ([#856](https://github.com/Omega-JS-Stack/omega/issues/856)).
  const siteData = loadSiteData(paths.root, { environment: 'production' });
  const brandRoot = findBrandRoot(paths.root);

  // A runner gets the minted set only through the deploy snapshot, so a CI
  // build without it would ship a site with no logo: stop before building.
  assertMintedAssets({ brandRoot, env: process.env });

  const emptyCatalog = catalogWarning(siteData.payment);
  if (emptyCatalog) {
    logger.warn(emptyCatalog);
  }

  // The license check ([#320](https://github.com/Omega-JS-Stack/omega/issues/320)),
  // once per build: `omega build` IS the production build — on a runner for a
  // deploy, or here for a local one — so this is where the verdict is asked
  // for and where the artifact records it. A keyless brand and a demo-*
  // project short-circuit offline; a key that cannot be answered for THROWS,
  // which is what gates a deploy on a bad key.
  const license = await resolveLicenseStamp({ config: siteData, production: true });
  logger.log(`License: ${license.status} (attribution ${license.attribution}, payments ${license.payments})`);

  // The target's own package.json: the version is the client's release tag
  // (#380) and the name rides the page bake's `package` block (#894).
  const projectPackage = jetpack.read(path.join(paths.root, 'package.json'), 'json');

  const result = await buildSite({
    consumerDir: paths.src,
    siteAssetsDir: paths.assets,
    siteData,
    outDir: paths.out,
    clientEntry: resolveClientEntry(),
    environment: 'production',
    license,
    version: projectPackage?.version,
    packageName: projectPackage?.name,
    manifestPath: paths.manifest,
    staticDirs: resolveStaticDirs({
      brandRoot,
      assetsDir: paths.assets,
    }),
    // Responsive image matrix — on unless the
    // brand opts out via `web.imagemin.enabled: false`. The cache is
    // machine-owned at the brand's .omega (never committed); CI restores it
    // via actions/cache in the scaffolded build workflow.
    imagemin: siteData.imagemin && siteData.imagemin.enabled === false ? null : {
      cacheDir: path.join(brandRoot || paths.root, '.omega', 'cache', 'imagemin'),
      log: (message) => logger.log(message),
    },
    onPhase: (name, seconds) => logger.log(`${name}: ${seconds.toFixed(2)}s`),
  });

  if (result.imagemin) {
    result.imagemin.warnings.forEach((warning) => logger.warn(`imagemin: ${warning} — shipped verbatim`));
  } else if (siteData.imagemin && siteData.imagemin.enabled === false) {
    logger.log('imagemin: disabled via web.imagemin.enabled — images ship verbatim');
  }

  logger.log(`Built ${result.htmlCount} pages in ${result.timings.total.toFixed(2)}s → ${path.relative(paths.root, paths.out)}/`);

  // A mounted build looks identical on disk and wrong at the domain root, so
  // say the base path out loud whenever OMEGA_PATH_PREFIX supplied one (#355).
  if (result.pathPrefix) {
    logger.log(`Base path: ${result.pathPrefix} — every emitted URL is mounted under it (OMEGA_PATH_PREFIX)`);
  }

  // GH Pages custom domain: every production build carries dist/CNAME so
  // BOTH deploy lanes publish it: a push without the file clears the Pages
  // domain. The derivation is the config's
  // ONE `pagesHost`, the same one the manage walk sets the domain from (#883).
  const cname = pagesHost(siteData, targetNameFromDir(paths.root) || 'web');
  if (cname) {
    jetpack.write(path.join(paths.out, 'CNAME'), cname);
  }

  // Self-host Firebase's /__/auth/* helper files so authDomain can be the
  // brand host on static hosting (translation excludes __/auth by design).
  // The fetch writes through to the brand's machine-owned cache (never
  // committed, same home as the imagemin cache) so an offline build serves
  // the last good copy instead of failing after emitting every page (#548).
  await fetchFirebaseAuthHelpers({
    siteData,
    outDir: paths.out,
    logger,
    cacheDir: path.join(brandRoot || paths.root, '.omega', 'cache', 'firebase-auth'),
  });

  // Post-build translation: warm strings from the committed cache, cold ones
  // live through the provider. --cached-only, or a CI runner, ships cold pages
  // untranslated and unadvertised instead (the warning lists them), at their
  // language path so no language link ever dangles.
  const cachedOnly = isCachedOnly(options.cachedOnly, process.env);
  if (cachedOnly) {
    logger.log(`${options.cachedOnly ? '--cached-only' : 'CI runner'}: cold pages will ship untranslated, not be translated`);
  }

  const translation = await translateSite({
    root: paths.root,
    outDir: paths.out,
    config: siteData,
    logger,
    only: process.env.OMEGA_TRANSLATE_ONLY,
    cachedOnly,
  });

  if (!translation.skipped) {
    logger.log(`Translated ${translation.pages} pages → ${translation.languages.join(', ')} (${translation.newStrings} new, ${translation.cachedStrings} cached strings)`);
    translation.failures.forEach((failure) => logger.warn(`translation: ${failure}; the copy shipped untranslated`));
    warnSkippedCold(translation, logger);
  }

  return result;
}

module.exports.catalogWarning = catalogWarning;
