/**
 * Full production build orchestration — the seed of `omega build` (B3):
 * assets (esbuild page modules + layered sass) → Eleventy → PurgeCSS, with
 * per-phase timings returned for benches and CLIs. Consumer-agnostic: the
 * caller supplies the consumer dir + site data; framework content (themes,
 * core, default pages) defaults to what ships with the package.
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildAssets, purgeCss } = require('./assets.js');
const { resolvePathPrefix } = require('./path-prefix.js');
const { buildServiceWorker, writeBuildMeta } = require('./service-worker.js');
const { copyStaticAssets, hasFaviconSet, brandmarkSvgUrl } = require('./static-assets.js');
const { processImages } = require('./imagemin.js');
const { configureOmega } = require('./engine.js');
const { emitIcons } = require('@omega.js/devkit/icons');
const { emitLanguageFlags } = require('./language-flags.js');
const { resolveThemeLayers } = require('./layers.js');
const { getEnvironment, setEnvironment } = require('@omega.js/config/environment');
const { PATHS } = require('./paths.js');
const { writeJson } = require('@omega.js/devkit/write-json');

/**
 * Build a consumer site end to end.
 * @param {object} options
 * @param {string} options.consumerDir - the consumer site (Eleventy input dir)
 * @param {object} options.siteData - raw site data (resolved omega config shape)
 * @param {string} options.outDir - output dir (cleared first)
 * @param {string} options.clientEntry - @omega.js/client entry for the `@omega.js/client` esbuild alias
 * @param {string} [options.version] - the consumer package version (build meta / service worker, and the OMEGA_BUILD_JSON bake the client reads)
 * @param {string} [options.packageName] - the consumer package name (the bake's `package` block, #894)
 * @param {string} [options.siteAssetsDir] - the consumer's own asset layer (js/pages page modules)
 * @param {string} [options.themesDir] - default: packaged themes
 * @param {string} [options.coreDir] - default: packaged core
 * @param {string} [options.defaultsDir] - default: packaged default pages
 * @param {string} [options.activeTheme] - default: siteData.theme.id
 * @param {Array<{src: string, dest: string}>} [options.staticDirs] - verbatim static copies (resolveStaticDirs), later entries win
 * @param {{ cacheDir: string, log?: function }} [options.imagemin] - responsive image matrix over the copied images (omit to skip — dev and `web.imagemin.enabled: false`)
 * @param {string} [options.layoutMode] - 'virtual' (default) or 'farm'
 * @param {string} [options.farmDir] - symlink-farm target (farm mode)
 * @param {boolean} [options.skipPurge] - skip the PurgeCSS pass
 * @param {string} [options.manifestPath] - also write the asset manifest here (the dev config reads it)
 * @param {string} [options.pathPrefix] - the base path the site is served under (#355) — default `process.env.OMEGA_PATH_PREFIX`, then the domain root
 * @param {object} [options.license] - the deploy-time license stamp (#320) the verb resolved → site.license (default: keyless)
 * @param {function} [options.onPhase] - (name, seconds) callback after each phase
 * @returns {Promise<{ timings: object, htmlCount: number, manifest: object, pathPrefix: string }>}
 */
async function buildSite(options) {
  // The environment (#717, one module since
  // [#817](https://github.com/Omega-JS-Stack/omega/issues/817)): a lane that
  // named one (`omega build` is production, `omega dev` is development) makes
  // it THE input for this process, and everything downstream reads that one
  // answer instead of each re-testing a loose `options.environment`.
  const environment = options.environment ? setEnvironment(options.environment) : getEnvironment();
  const themesDir = options.themesDir || PATHS.themes;
  const coreDir = options.coreDir || PATHS.core;
  const defaultsDir = options.defaultsDir || PATHS.defaults;
  const activeTheme = options.activeTheme || (options.siteData.theme && options.siteData.theme.id) || 'classy';
  const themeLayerDirs = resolveThemeLayers({ activeTheme, consumerDir: options.consumerDir, themesDir });
  // Base path (#355), read ONCE here and handed to both emit lanes. The env var
  // is the publisher's channel (workkit's publish derives it from the Pages
  // API); `omega dev` never comes through here, so the dev server keeps serving
  // at the root no matter what the environment says.
  const pathPrefix = resolvePathPrefix(
    options.pathPrefix === undefined ? process.env.OMEGA_PATH_PREFIX : options.pathPrefix,
  );

  const timings = {};
  const started = process.hrtime.bigint();
  const phase = async (name, fn) => {
    const t0 = process.hrtime.bigint();
    const result = await fn();
    timings[name] = Number(process.hrtime.bigint() - t0) / 1e9;
    if (options.onPhase) options.onPhase(name, timings[name]);
    return result;
  };

  fs.rmSync(options.outDir, { recursive: true, force: true });

  // ---- assets first: the manifest feeds the head/foot includes
  const manifest = await phase('assets', () =>
    buildAssets({
      layers: [
        ...(options.siteAssetsDir ? [options.siteAssetsDir] : []),
        ...themeLayerDirs,
        coreDir,
      ],
      themeRoots: themeLayerDirs,
      sectionRoots: [options.consumerDir, ...themeLayerDirs],
      themesDir,
      coreDir,
      outDir: options.outDir,
      clientEntry: options.clientEntry,
      pathPrefix,
    })
  );
  manifest.favicons = hasFaviconSet(options.staticDirs);
  manifest.brandmarkSvg = brandmarkSvgUrl(options.staticDirs);
  if (options.manifestPath) {
    writeJson(options.manifestPath, manifest);
  }

  // ---- service worker + build meta: /service-worker.js, /build.json
  //      (/build.js is the engine's, written on the way into the Eleventy run)
  await phase('service-worker', async () => {
    writeBuildMeta({
      siteData: options.siteData,
      outDir: options.outDir,
      environment,
      version: options.version,
      consumerDir: options.consumerDir,
      clientEntry: options.clientEntry,
      manifest,
    });
    return buildServiceWorker({
      consumerDir: options.consumerDir,
      outDir: options.outDir,
      clientEntry: options.clientEntry,
    });
  });

  // ---- runtime icon set (assets/icons/) — feeds the browser-side auto-render,
  //      plus the language-named flag aliases the client switcher fetches
  await phase('icons', () => {
    const icons = emitIcons({
      outDir: options.outDir,
      coreIconsDir: path.join(coreDir, 'icons'),
    });
    emitLanguageFlags({ outDir: options.outDir });
    return icons;
  });

  // ---- static assets: core images, derived brand images, consumer src/assets
  if (options.staticDirs && options.staticDirs.length) {
    await phase('static', () => copyStaticAssets({ staticDirs: options.staticDirs, outDir: options.outDir }));
  }

  // ---- responsive image matrix over the shipped images (build-time only)
  let imagemin = null;
  if (options.imagemin) {
    imagemin = await phase('imagemin', () => processImages({
      imagesDir: path.join(options.outDir, 'assets', 'images'),
      cacheDir: options.imagemin.cacheDir,
      log: options.imagemin.log,
    }));
  }

  // ---- Eleventy
  await phase('eleventy', async () => {
    const Eleventy = require('@11ty/eleventy').default;
    const elev = new Eleventy(options.consumerDir, options.outDir, {
      quietMode: true,
      configPath: false,
      config: (eleventyConfig) =>
        configureOmega(eleventyConfig, {
          consumerDir: options.consumerDir,
          siteData: options.siteData,
          themesDir,
          coreDir,
          defaultsDir,
          activeTheme,
          layoutMode: options.layoutMode,
          farmDir: options.farmDir,
          assetManifest: manifest,
          environment,
          version: options.version,
          packageName: options.packageName,
          pathPrefix,
          license: options.license,
        }),
    });
    await elev.write();
  });

  // ---- PurgeCSS over the rendered HTML
  if (!options.skipPurge) {
    await phase('purge', () => purgeCss({ outDir: options.outDir, manifest, purgecss: options.siteData.purgecss }));
  }

  timings.total = Number(process.hrtime.bigint() - started) / 1e9;
  return { timings, htmlCount: countHtml(options.outDir), manifest, imagemin, pathPrefix };
}

/**
 * Count .html files under a directory.
 * @param {string} dir
 * @returns {number}
 */
function countHtml(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.html')) count++;
  }
  return count;
}

module.exports = { buildSite };
