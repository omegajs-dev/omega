/**
 * `omega dev` — the development loop:
 *   1. dev-mode assets (stable un-hashed names, no minify) → .omega/manifest
 *   2. programmatic Eleventy watch + serve over src/
 *   3. asset-source watchers (consumer src/assets + packaged theme/core
 *      layers) rebuild bundles IN PLACE — URLs are stable in dev, so the
 *      rendered HTML stays valid without a re-render; the dev server
 *      watches the built asset trees and live-reloads the browser (css
 *      hot-swaps, js reloads — no hand refresh).
 *
 * Port (N7): the website convention is 4000, resolved through the allocator —
 * taken ports bump +1. A brand running several web targets offsets
 * deterministically: each target wants 4000 + its position among the web
 * targets, so targets/web and targets/admin dev side-by-side. `omega dev
 * --port=4001` (or a config `ports.website` entry) PINS the port instead:
 * busy = hard error, never a silent bump. The
 * resolved map of a live sibling backend (its `.temp/ports.json`) plus this
 * website port and its resolved ORIGIN (protocol included,
 * [#262](https://github.com/Omega-JS-Stack/omega/issues/262)) are injected into
 * the page chrome as `dev` so
 * @omega.js/client connects to the stack that is ACTUALLY running — read PER
 * RESPONSE (the render-time bake is advisory, rewritten as the page is served,
 * [#346](https://github.com/Omega-JS-Stack/omega/issues/346)) and per request
 * for the auth-emulator proxy, because a backend that boots after this server
 * (or restarts onto bumped ports) is the normal case
 * ([#300](https://github.com/Omega-JS-Stack/omega/issues/300)).
 *
 * `omega dev --local` first links every @omega.js framework the brand uses to
 * the local Omega monorepo (file: installs, idempotent) and starts the
 * monorepo's src→dist watch, then runs the normal dev loop (master plan §8).
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const jetpack = require('fs-jetpack');
const Logger = require('@omega.js/devkit/logger');
const { refreshLiveManifest } = require('../live-manifest.js');
const {
  CLASSIC_PORTS, isPortFree, resolvePorts, envPort,
  readSiblingPorts, writePortsFile, clearPortsFile,
  findBrandRoot, hasOmegaConfig, loadConfig, targetPortOffset,
} = require('@omega.js/config');
const { setEnvironment } = require('@omega.js/config/environment');
const { emitIcons } = require('@omega.js/devkit/icons');
const { watchEnvChain } = require('@omega.js/devkit/env-watch');
const { STOP_SIGNALS } = require('@omega.js/devkit/stop-signals');
const attachLogFile = require('@omega.js/devkit/attach-log-file');
const { ensureTarget } = require('./lib/ensure-target.js');
const { emitLanguageFlags } = require('../language-flags.js');
const { buildAssets } = require('../assets.js');
const { buildServiceWorker, writeBuildMeta } = require('../service-worker.js');
const { resolveStaticDirs, copyStaticAssets, hasFaviconSet, brandmarkSvgUrl } = require('../static-assets.js');
const { devImageFallback } = require('../imagemin.js');
const { configureOmega } = require('../engine.js');
const reads = require('@omega.js/devkit/reads');
const { reconcileSampleContent } = require('../sample-content.js');
const { resolveThemeLayers } = require('../layers.js');
const { consumerPaths, loadSiteData } = require('../consumer.js');
const { PATHS, resolveClientEntry } = require('../paths.js');
const { writeJson } = require('@omega.js/devkit/write-json');

const logger = new Logger('dev');

const WATCH_DEBOUNCE_MS = 250;
// The rescan lane settles faster than the asset lane: a scan is a readdir, and
// the sooner it lands the sooner a permalink collision is on screen.
const RESCAN_DEBOUNCE_MS = 50;
// How often a re-arming watcher probes for its directory to come back. A
// prepare's wipe-to-rewrite gap is a build's worth of time, so a coarse probe
// costs nothing and never busy-loops.
const REARM_POLL_MS = 200;

module.exports = async function (options) {
  options = options || {};

  // The verb names the environment for the whole process (#817): a dev loop is
  // development, so the config overlay, the build meta and the emulator gates
  // all answer the same word without asking the machine.
  setEnvironment('development');

  // Tee the whole run to <targetRoot>/logs/dev.log — first statement of the verb
  // so a crash on the way up is already in the file (#197).
  attachLogFile(path.join(consumerPaths().root, 'logs', 'dev.log'));

  // The local half of the retired `omega setup` (#675) — idempotent, offline,
  // and quiet on a converged target.
  ensureTarget({ projectDir: consumerPaths().root, log: (line) => logger.log(line), warn: (line) => logger.warn(line) });

  if (options.local) {
    await linkBrandToMonorepo();
  }

  const paths = consumerPaths();
  const siteData = loadSiteData(paths.root);
  // The target's own package.json: read ONCE and handed to both consumers: the
  // build manifest and the page chrome's OMEGA_BUILD_JSON bake (the client's
  // release tag, #380).
  const projectPackage = jetpack.read(path.join(paths.root, 'package.json'), 'json');
  const version = projectPackage?.version;
  const clientEntry = resolveClientEntry();
  const { port, bumped } = await resolveWebsitePort(paths.root, Number(options.port) || null);

  // HTTPS (same contract as the backend's serve/emulator): the PUBLIC website
  // port speaks TLS through the shared mkcert proxy; eleventy sits on an
  // internal plain-http port behind it (WebSocket live-reload tunnels through).
  // `--no-https` or no mkcert → plain http on the public port, as before.
  const { ensureLocalHttpsCerts, startLocalHttpsProxy, mkcertInstallHint } = require('@omega.js/devkit/local-https');
  let httpsCerts = null;
  let internalPort = null;
  if (options.https !== false) {
    httpsCerts = await ensureLocalHttpsCerts({
      certsDir: path.join(paths.root, '.temp', 'certs'),
      log: (line) => logger.log(line),
    });

    if (httpsCerts) {
      ({ ports: { internal: internalPort } } = await resolvePorts({ wanted: { internal: 4443 } }));
    } else {
      logger.log(`HTTPS disabled — could not obtain certificates (install mkcert: ${mkcertInstallHint()})`);
    }
  }

  // The resolved website ORIGIN — protocol and port together, since only this
  // point in the boot knows whether the public port speaks TLS. Everything that
  // needs "where the dev website answers" reads THIS: site.url, the page chrome,
  // and the ports file siblings read (#262).
  const origin = devWebsiteOrigin(port, httpsCerts !== null);
  applyDevSiteUrl(siteData, origin);

  // LIVE, never a snapshot: both the baked page chrome and the auth-emulator
  // proxy resolve the sibling backend's map at use time (#300).
  const devPorts = devPortsOption(paths.root, port, origin);
  const authPort = () => devPorts().ports.auth;

  // ---- Sample content on disk (spec §8): mirror the injected filler under
  // the gitignored .omega/sample-content/ so it can be read and copied —
  // machine-owned, regenerated every boot, gone per-collection once the
  // consumer owns that collection.
  const samples = reconcileSampleContent({
    targetRoot: paths.root,
    consumerDir: paths.src,
    defaultsDir: PATHS.defaults,
  });
  if (samples.written.length) {
    logger.log(`Sample content: ${samples.written.length} files → ${path.relative(paths.root, samples.root)}/ (gitignored, regenerated each boot)`);
  }
  samples.removed.forEach((collectionDir) => logger.log(`Sample content: ${collectionDir} is yours now — materialized samples removed`));

  const activeTheme = (siteData.theme && siteData.theme.id) || 'classy';
  const themeLayerDirs = resolveAssetThemeLayers(paths, activeTheme);
  const layers = [
    ...(fs.existsSync(paths.assets) ? [paths.assets] : []),
    ...themeLayerDirs,
    PATHS.core,
  ];

  // ---- Fresh output + dev assets
  fs.rmSync(paths.out, { recursive: true, force: true });

  const build = (only) => buildAssets({
    layers,
    themeRoots: themeLayerDirs,
    sectionRoots: [paths.src, ...themeLayerDirs],
    themesDir: PATHS.themes,
    coreDir: PATHS.core,
    outDir: paths.out,
    clientEntry,
    dev: true,
    only,
  });

  // Static assets (the derived brand image + src/assets) resolve up front:
  // the manifest's favicon flag depends on what will ship
  const brandRoot = findBrandRoot(paths.root);
  const staticDirs = await resolveStaticDirs({ brandRoot, assetsDir: paths.assets, name: siteData.brand.name, log: (line) => logger.log(line) });

  const manifest = await build();
  manifest.favicons = hasFaviconSet(staticDirs);
  manifest.brandmarkSvg = brandmarkSvgUrl(staticDirs);
  writeJson(paths.manifest, manifest);
  logger.log('Assets built (dev mode: stable names, no minify, sourcemaps)');

  // ---- Service worker + build meta (/service-worker.js, /build.json;
  // /build.js is the engine's): dev serves the REAL service worker so push/caching are
  // testable; registration takeover + cache eviction keep one localhost
  // port safe across different projects.
  const buildSw = async () => {
    writeBuildMeta({
      siteData,
      outDir: paths.out,
      environment: 'development',
      version,
      consumerDir: paths.src,
      clientEntry,
      manifest,
    });
    await buildServiceWorker({
      consumerDir: paths.src,
      outDir: paths.out,
      clientEntry,
      dev: true,
    });
  };
  await buildSw();

  // Copied once at boot; they change rarely, so no watcher (restart to pick
  // up new ones)
  copyStaticAssets({
    staticDirs,
    outDir: paths.out,
  });

  // Runtime icon set (/assets/icons/) — the browser-side auto-renderer fetches
  // these on demand (JS-set fa-* markup, e.g. the share buttons); emitted once
  // at boot like the statics (the set never changes mid-dev).
  emitIcons({
    outDir: paths.out,
    coreIconsDir: path.join(PATHS.core, 'icons'),
  });
  emitLanguageFlags({ outDir: paths.out });

  // ---- Rebuild assets in place on source changes
  const watchDirs = [
    paths.assets,
    ...themeLayerDirs,
    path.join(PATHS.core, 'js'),
    path.join(PATHS.core, 'css'),
    // Consumer-local section/component assets (§7) live OUTSIDE the asset
    // trees (src/_sections) — theme-layer sections are covered by the theme
    // roots above.
    path.join(paths.src, '_sections'),
    path.join(paths.src, '_components'),
  ].filter((dir) => fs.existsSync(dir));

  // A rebuild folds its content lists (the font preloads, `js.imports`) into
  // the LIVE manifest, so the served head never waits on an unrelated edit.
  // The manifest file is the courier (the watch target registered below).
  watchAssetSources({
    dirs: watchDirs,
    clientDist: path.dirname(clientEntry),
    build,
    manifest,
    manifestPath: paths.manifest,
  });

  // The .env chain is a dev INPUT too (#681): an edit to any layer reloads the
  // cascade into process.env, so the next rebuild reads the new values instead
  // of the ones this process booted with.
  //
  // Reach, exactly: a NEW key AND an EDITED value both land on that next
  // rebuild, and a key dropped from the file is dropped from the process — the
  // reload re-reads what a file layer owns (#724). A SHELL-set value still wins
  // over every file, whatever the file now says.
  watchEnvSources(paths.root);

  // The consumer's service-worker entry lives OUTSIDE the asset trees
  // (src/service-worker.js) — its own watcher; the browser picks the new
  // worker up on the next reload's registration update check.
  const consumerSwEntry = path.join(paths.src, 'service-worker.js');
  if (fs.existsSync(consumerSwEntry)) {
    let swTimer = null;
    fs.watch(consumerSwEntry, () => {
      clearTimeout(swTimer);
      swTimer = setTimeout(() => {
        buildSw()
          .then(() => logger.log('Service worker rebuilt — reload to activate the new worker'))
          .catch((error) => logger.error('Service worker rebuild failed:', error));
      }, WATCH_DEBOUNCE_MS);
    });
  }

  // ---- Eleventy watch + serve
  const Eleventy = require('@11ty/eleventy').default;
  let rescanWatchers = [];
  const elev = new Eleventy(paths.src, paths.out, {
    quietMode: true,
    configPath: false,
    config: (eleventyConfig) => {
      eleventyConfig.setServerOptions(devServerOptions(paths.out, authPort, devPorts));
      // The asset manifest is a template INPUT (its URLs, font preloads and
      // `js.imports`), rewritten when a rebuild moves either list. Watching the
      // file re-renders with no config reset: the engine holds the object.
      eleventyConfig.addWatchTarget(paths.manifest);
      // Arms the watch registration for the config build below — the engine's
      // captured reads are what fill it in (#200). The reset union goes to
      // Eleventy, the rescan union to the light content watcher; a config
      // reset re-runs this callback, so the previous rescan watchers close
      // before the new union arms.
      registerTemplateWatchTargets(eleventyConfig, {
        onRescans: (rescans) => {
          rescanWatchers.forEach((watcher) => watcher.close());
          rescanWatchers = watchRescanTargets(rescans);
        },
      });
      return configureOmega(eleventyConfig, {
        consumerDir: paths.src,
        siteData,
        activeTheme,
        assetManifest: manifest,
        environment: 'development',
        version,
        packageName: projectPackage?.name,
        dev: devPorts,
      });
    },
  });

  await elev.init();
  await elev.watch();
  elev.serve(httpsCerts ? internalPort : port);

  // TLS terminator on the public port → eleventy on the internal one
  if (httpsCerts) {
    startLocalHttpsProxy({
      port,
      targetPort: internalPort,
      certs: httpsCerts,
      log: (line) => logger.log(line),
    });
  }

  // Publish the resolved website port for sibling tools (same contract as the
  // backend emulator's ports file) and retract it on shutdown. The PUBLIC
  // port is the published one — the internal eleventy port is plumbing. The
  // ORIGIN rides along, because a sibling reading `website: 4000` cannot know
  // whether this run speaks TLS (#262).
  writePortsFile(paths.root, { website: port }, { origin });
  process.on('exit', () => clearPortsFile(paths.root));
  // Every way this dev server is asked to stop exits deliberately, off the ONE
  // devkit list ([#629](https://github.com/Omega-JS-Stack/omega/issues/629)):
  // the `exit` hook above is what retracts the ports file, and a signal with no
  // listener never runs it.
  STOP_SIGNALS.forEach((signal) => process.on(signal, () => process.exit(0)));

  if (bumped) {
    logger.log(`Port ${CLASSIC_PORTS.website} was taken — bumped to ${port}`);
  }
  logger.log(`Dev server: ${httpsCerts ? 'https' : 'http'}://localhost:${port}`);
};

/**
 * The asset lane's theme layer chain (#137). `resolveThemeLayers` probes
 * `<consumerDir>/themes/<id>` for a consumer-local theme, and EVERY other
 * caller — the engine, the production build, customize, the override map —
 * passes the Eleventy input dir, so a consumer-local theme lives at
 * `src/themes/<id>`. Resolving the asset lane from the target ROOT instead made
 * that theme invisible to the scss/js build AND to the asset watcher (both
 * derive from this list), so a brand's own theme silently rendered with the
 * packaged theme's styles.
 * @param {object} paths - consumerPaths() output
 * @param {string} activeTheme - theme id
 * @returns {string[]} ordered theme layer dirs
 */
function resolveAssetThemeLayers(paths, activeTheme) {
  return resolveThemeLayers({ activeTheme, consumerDir: paths.src, themesDir: PATHS.themes });
}

// The session's server-options objects, keyed by (outDir, authPort) — why they
// must be the IDENTICAL object on every config reset is in devServerOptions.
const SERVER_OPTIONS = new Map();

/**
 * Dev-server options: the image-variant fallback middleware (dev never runs
 * the responsive matrix — missing -NNNpx/.webp URLs rewrite to the verbatim
 * original) + live-reload on ASSET rebuilds. Eleventy's dev server only
 * reloads on its own template re-renders; our asset watcher writes bundles
 * straight into the out dir, so the server chokidars those trees too — css
 * changes hot-swap without a full reload, js changes reload the page. Kills
 * the "refresh the browser" hand step.
 *
 * The auth-emulator proxy goes FIRST: it owns whole URL prefixes and answers
 * them itself, so it must run before the clean-URL rewriter gets a chance to
 * treat one as a page path.
 *
 * ONE object per (outDir, authPort), for the life of the process (#206). The
 * config callback runs again on every config RESET, and Eleventy decides
 * whether to restart the dev server by `assert.deepStrictEqual`-ing the
 * config's serverOptions against the copy it saved at boot
 * (EleventyServe.hasOptionsChanged) — where differing FUNCTION references can
 * only ever read as "changed". Handing back a rebuilt object therefore
 * restarted the server (close + relisten) on every single reset, and an edit
 * burst raced a queued build's restart against a socket the previous one had
 * not released yet: ERR_SERVER_ALREADY_LISTEN, process dead. Nothing here
 * varies during a session — the middleware closes over outDir and the auth
 * port RESOLVER, both fixed at boot — so the cache is the whole fix: Eleventy's
 * DeepCopy of the object shares the middleware array and its function
 * references, and the identical object compares equal across every reset.
 * @param {string} outDir
 * @param {number|function} [authPort] - the auth emulator port to proxy, or a
 *   GETTER resolving it per request (the live map, #300); a getter keys as
 *   `live`, since a session runs exactly one dev server and the getter's
 *   identity would otherwise change on every config reset
 * @param {function} [devChrome] - the live dev-chrome getter (devPortsOption);
 *   given, every HTML response is rewritten to carry it (#346)
 * @returns {object} setServerOptions() payload
 */
function devServerOptions(outDir, authPort, devChrome) {
  const key = `${outDir} ${typeof authPort === 'function' ? 'live' : authPort} ${devChrome ? 'inject' : 'plain'}`;

  if (!SERVER_OPTIONS.has(key)) {
    SERVER_OPTIONS.set(key, {
      middleware: [
        devAuthEmulator(authPort),
        // After the proxy, which answers its own prefixes and returns: the
        // emulator's pages are not this site's pages, and nothing rewrites them
        ...(devChrome ? [devInjectDevPorts(devChrome)] : []),
        devCleanUrls(outDir),
        devImageFallback(outDir),
      ],
      watch: [
        path.join(outDir, 'assets', 'css'),
        path.join(outDir, 'assets', 'js'),
      ],
    });
  }

  return SERVER_OPTIONS.get(key);
}

/**
 * Force a config RESET on edits under the template-source dirs (#49). Both
 * layered layouts (registered as virtual templates, content read at config
 * time) and the json-in-_includes data system (read into site.data._includes
 * at config time) are CAPTURES — and Eleventy reuses one config across watch
 * rebuilds unless the changed file triggers a reset, so without this the
 * rebuild logs "Wrote N files" and re-renders the stale capture until the
 * server is restarted.
 *
 * The targets are DERIVED, never listed (#200): `configureOmega` reads every
 * config-time input through the captured-read helper (@omega.js/devkit/reads), which
 * records the directory of each read — the union IS the set of dirs the
 * capture depends on, so a capture added to the engine later registers itself.
 * A hand list could only ever be the set someone remembered (#139).
 *
 * Ordering: Eleventy runs this before `configureOmega` in the same config
 * callback, so it ARMS the registration instead of doing it — the recorded
 * union only exists once the engine's capture scope closes, which happens on
 * the way out of `configureOmega`, still inside this callback and long before
 * Eleventy reads its watch targets.
 *
 * What lands in the union: each layer's machinery dirs (`_layouts`,
 * `_includes`, `_sections`, `_components`, a theme's `fonts/`), the packaged
 * `defaults` tree (#136), and the layer roots the theme chain PROBES — a
 * consumer-local `src/themes/<id>` included, so an scss edit inside a brand's
 * own theme rides BOTH lanes: the asset watcher's rebuild AND a config reset
 * (the same accepted cost the `_sections` dirs already pay, #138).
 *
 * Packaged targets register REAL paths (the helper realpaths anything outside
 * the consumer dir). A linked brand reaches the framework through a
 * `node_modules/@omega.js/web` symlink, and Eleventy's watcher ignores
 * everything under `node_modules` — the resolved path sidesteps it.
 *
 * BOTH path forms are registered for cwd-contained targets. The absolute form
 * alone carries the reset today (the dev loop hands Eleventy absolute dirs, so
 * the watcher's event arrives absolute and matches it). Registering the
 * relative form ADDS a second, relative event for the same edit — each event
 * decides the reset for itself and the last one wins the throttle, which is
 * why the relative form must never be registered ALONE — and is kept as
 * insurance so a reset still fires if Eleventy ever reports these edits in
 * relative form. Its observable cost is a duplicate "File changed" line per
 * save. A target OUTSIDE cwd (a linked brand's framework layers, a hoisted
 * node_modules) registers ONLY absolute: an escaping `../` watch target makes
 * Eleventy re-root its watcher to the common ancestor, after which NO event
 * path matches ANY registered target and every reset dies — including the
 * consumer ones (#134 verification).
 *
 * Dropping the relative form was TRIED and reverted (#344). It is not dead
 * insurance: with only the absolute form registered, the packaged-layer reset
 * starves — an interleaved A/B of dev-watch.test.js, one run per arm per
 * round, went 0/8 red on both forms and 5/8 red on absolute-only. The extra
 * registrations change how chokidar arranges its FSEvents streams (its
 * consolidation threshold is a count of watched paths under one parent), and
 * the arrangement the duplicates produce is the one that reliably delivers a
 * freshly created packaged tmp dir's events. Measure before touching this.
 *
 * ONLY the reset union lands here. The same scope also records the RESCAN
 * union (#200 Lane B) — the content scans, whose dirs must never carry a reset
 * — and `options.onRescans` hands it to the lane that owns it
 * (watchRescanTargets below).
 * @param {object} eleventyConfig
 * @param {object} [options]
 * @param {function} [options.onRescans] - (rescanTargets) => void, the rescan lane
 */
function registerTemplateWatchTargets(eleventyConfig, options) {
  reads.onNextScope((targets, rescans) => {
    for (const { dir } of targets) {
      const relative = path.relative(process.cwd(), dir);
      const forms = relative.startsWith('..') ? [dir] : new Set([dir, relative]);
      for (const form of forms) {
        eleventyConfig.addWatchTarget(form, { resetConfig: true });
      }
    }
    if (options && options.onRescans) options.onRescans(rescans);
  });
}

/**
 * The ASSET lane's source watchers: one recursive fs.watch per asset source dir
 * and the @omega.js/client dist, feeding ONE debounced rebuild. A css-only
 * change set hot-swaps the stylesheets; anything else rebuilds js and reloads.
 * @param {object} options
 * @param {string[]} options.dirs - the asset source dirs (existing ones only)
 * @param {string} [options.clientDist] - the resolved @omega.js/client dist dir
 * @param {function} options.build - (only) => Promise, the dev asset rebuild
 * @param {object} [options.manifest] - the LIVE manifest: a moved font preload or `js.imports` list folds in
 * @param {string} [options.manifestPath] - where that manifest is written, again on a fold
 * @returns {{ close: function }} the live watchers (tests close them)
 */
function watchAssetSources(options) {
  let timer = null;
  let pendingKinds = new Set();
  const kindOf = (file) => {
    if (/\.(scss|css)$/.test(file || '')) return 'css';
    if (/\.(js|mjs)$/.test(file || '')) return 'js';
    return 'other';
  };
  const schedule = (file) => {
    pendingKinds.add(kindOf(file));
    clearTimeout(timer);
    timer = setTimeout(() => {
      const kinds = pendingKinds;
      pendingKinds = new Set();
      const only = kinds.size === 1 && !kinds.has('other') ? kinds.values().next().value : undefined;
      options.build(only)
        .then((next) => {
          // The font preloads and `js.imports` are manifest CONTENT: a moved list
          // folds into the live manifest and the FILE is rewritten, so Eleventy
          // re-renders after this build, never racing it, and only on a change.
          if (options.manifest && options.manifestPath && refreshLiveManifest(options.manifest, next)) {
            writeJson(options.manifestPath, options.manifest);
          }
          logger.log(`Assets rebuilt (${only || 'all'}) — browser live-reloads${only === 'css' ? ' via css hot-swap' : ''}`);
        })
        .catch((error) => logger.error('Asset rebuild failed:', error));
    }, WATCH_DEBOUNCE_MS);
  };

  const watchers = options.dirs.map((dir) => fs.watch(dir, { recursive: true }, (event, file) => schedule(file)));

  // The client dist is the one watched root that gets REPLACED rather than
  // written into (its own `npm run prepare` deletes dist/ and writes it again),
  // so it registers replace-safe. Absent at boot (no client installed) → not
  // watched, the same existence rule the dirs above are filtered by.
  if (options.clientDist && fs.existsSync(options.clientDist)) {
    watchers.push(watchReplaceable(options.clientDist, schedule));
  }

  return {
    close: () => {
      clearTimeout(timer);
      watchers.forEach((watcher) => watcher.close());
    },
  };
}

/**
 * The ENV lane's watcher (#681): every layer of the `.env` chain — company,
 * brand, this target — and each layer's `.env.<environment>` overlay. A change
 * reloads the cascade into process.env, and the log line names the FILE, never
 * a value. Resolution and watching live in @omega.js/devkit/env-watch, shared
 * with the desktop and extension dev lanes; this binds web's own target name.
 * @param {string} root - the target root
 * @param {object} [options]
 * @param {string} [options.environment] - the environment whose overlay counts
 * @returns {{ inputs: Array<{ layer: string, path: string }>, close: function }}
 */
function watchEnvSources(root, options) {
  return watchEnvChain({
    projectDir: root,
    target: 'web',
    environment: options && options.environment,
    log: (line) => logger.log(line),
  });
}

/**
 * A recursive fs.watch over a directory that may be REPLACED under it. A
 * handle is bound to the directory it was opened on: once that directory is
 * deleted, the handle is watching something the filesystem no longer resolves
 * — on some platforms it errors or closes, on others it stays quietly useless.
 * So: whenever the root is gone (an event that finds it missing, an `error`, a
 * `close` nobody asked for), drop the handle, probe until the directory is back,
 * watch the NEW one, and report the replacement as one change.
 * @param {string} dir - the directory to watch
 * @param {function} onChange - (file) => void, the same sink the plain watchers use
 * @returns {{ close: function }}
 */
function watchReplaceable(dir, onChange) {
  let watcher = null;
  let poll = null;
  let closed = false;

  const arm = () => {
    watcher = fs.watch(dir, { recursive: true }, (event, file) => {
      if (!fs.existsSync(dir)) return rearm();
      return onChange(file);
    });
    watcher.on('error', rearm);
    watcher.on('close', rearm);
  };

  // Arming the probe FIRST makes every re-entrant call (closing the handle
  // emits its own 'close') a no-op instead of a second interval.
  const rearm = () => {
    if (closed || poll) return;

    poll = setInterval(() => {
      if (!fs.existsSync(dir)) return;
      try {
        arm();
      } catch (error) {
        return; // replaced again between the probe and the watch — keep probing
      }
      clearInterval(poll);
      poll = null;
      onChange(dir);
    }, REARM_POLL_MS);

    const dead = watcher;
    watcher = null;
    if (dead) dead.close();
  };

  arm();

  return {
    close: () => {
      closed = true;
      clearInterval(poll);
      if (watcher) watcher.close();
    },
  };
}

/**
 * The RESCAN lane (#200 Lane B): a light watcher per recorded rescan dir that
 * re-runs just the capture whose input changed. No config reset ever — that is
 * the entire reason these dirs are a separate union: they hold the brand's
 * CONTENT (pages/, the collection dirs), and a reset there would drag every
 * page edit off Eleventy's incremental lane.
 *
 * What a re-run buys: the live decision object is current the moment a file
 * lands (the permalink-collision diagnostic re-emits right there, before any
 * rebuild finishes). It is NOT what makes a render fresh — the engine
 * re-scans on `eleventy.before`, so whichever watcher sees the file first, the
 * render that follows reads current answers.
 *
 * Debounced like the asset lane: an editor's save is several events, and a
 * scan per event is pure waste. A dir that does not exist yet is skipped —
 * fs.watch cannot arm a missing path, and a collection dir appearing under
 * Eleventy's input dir triggers a rebuild (and its re-scan) by itself.
 *
 * Closing DROPS the queued re-run: every config reset closes this union and
 * opens the new one, and a debounce still in flight belongs to captures the
 * previous build owned.
 * @param {Array<{ dir: string, rerun: function }>} targets - the recorded rescan union
 * @returns {Array<{ close: function }>} the live watchers (the caller closes them)
 */
function watchRescanTargets(targets) {
  return targets.filter((target) => fs.existsSync(target.dir)).map((target) => {
    let timer = null;
    const watcher = fs.watch(target.dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          target.rerun();
        } catch (error) {
          logger.error('Rescan failed:', error);
        }
      }, RESCAN_DEBOUNCE_MS);
    });

    return {
      close: () => {
        clearTimeout(timer);
        watcher.close();
      },
    };
  });
}

/**
 * Serve the Firebase auth emulator THROUGH the site origin (#156) — the dev
 * counterpart of the self-hosted /__/auth/* helpers a production build ships
 * (src/firebase-auth-helpers.js).
 *
 * The emulator's OAuth handler hands a redirect credential back by writing
 * `firebase:redirectEvent:*` into sessionStorage on ITS OWN origin, and the
 * SDK's helper iframe reads it back from there. Served on the emulator's port,
 * that origin is a third party to the site, and browser storage partitioning
 * gives the iframe a different, empty partition — the return leg dead-ends.
 * Proxied here, handler and iframe are both first-party to the site, so they
 * share one partition and signInWithRedirect completes in dev exactly as it
 * does in production.
 *
 * The prefixes are the emulator's whole surface, mounted at the site ROOT
 * because connectAuthEmulator() discards any path on the URL it is given
 * (@firebase/auth: "Always replace path with /") — a sub-path mount is not
 * available to us. `/emulator/*` covers the handler, the helper iframe and the
 * out-of-band action links; the two googleapis.com prefixes are the REST
 * surface, which the SDK addresses as `<emulator origin>/<apiHost><path>`.
 * None of them can collide with a page URL.
 *
 * The target port is resolved PER REQUEST (#300). With the proxy on, this —
 * not the baked `dev.ports` — is where every auth call actually goes, so a
 * boot-time number kept sending sign-ins to whatever emulator held the
 * classic 9099 (a neighbouring project's, in the report) long after this
 * brand's suite came up bumped.
 * @param {number|function} [authPort] - the port, or a getter for the live one
 * @returns {function} connect-style middleware
 */
function devAuthEmulator(authPort) {
  const prefixes = ['/emulator', '/identitytoolkit.googleapis.com', '/securetoken.googleapis.com'];
  const resolvePort = () => (typeof authPort === 'function' ? authPort() : authPort) || CLASSIC_PORTS.auth;

  // Hop-by-hop framing headers belong to THIS connection, not the upstream's —
  // copying them makes Node chunk a body it is already re-chunking.
  const skipHeaders = new Set(['connection', 'keep-alive', 'transfer-encoding']);

  // setHeader + statusCode, never writeHead. Eleventy's dev server wraps `res`
  // to inject its live-reload script (eleventy-dev-server/server/wrapResponse):
  // a writeHead carrying a text/html content-type is DEFERRED into a replay
  // queue, but a piped Buffer write flushes the real headers first, and the
  // replay then throws ERR_HTTP_HEADERS_SENT and takes the whole dev server
  // down. Going through setHeader keeps that queue empty. It also keeps the
  // wrapper's html transform off the emulator's pages — the live-reload script
  // has no business inside the OAuth handler.
  const answer = (res, status, headers) => {
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) {
      if (!skipHeaders.has(name.toLowerCase())) {
        res.setHeader(name, value);
      }
    }
  };

  // The emulator deliberately binds 127.0.0.1 only, while the site listens on
  // every interface — proxying for a LAN client would silently remove that
  // safety property and hand the emulator's whole REST surface to the network.
  const isLoopback = (address) => address === '::1'
    || (address || '').startsWith('127.')
    || (address || '').startsWith('::ffff:127.');

  return (req, res, next) => {
    const pathname = (req.url || '').split('?')[0];

    if (!prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      return next();
    }
    if (!isLoopback(req.socket?.remoteAddress)) {
      return next();
    }

    const port = resolvePort();
    const upstream = http.request({
      host: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    }, (upstreamRes) => {
      answer(res, upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    // A website-only dev session (no emulator suite running) is an expected
    // external condition, not our bug: answer the auth call with a 502 that
    // names the port instead of hanging the request.
    upstream.on('error', (error) => {
      logger.error(`Auth emulator proxy: ${pathname} → :${port} failed (${error.message})`);
      answer(res, 502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(Buffer.from(`Auth emulator on port ${port} is not reachable`));
    });

    return req.pipe(upstream);
  };
}

/**
 * The dev map the build snapshot carries, as @omega.js/devkit writes it into
 * `build.js` (`self.OMEGA_BUILD_JSON.config.dev = {…};`, #743): its own
 * statement on its own line, one compact JSON object or `null` on a build with
 * no local stack. The coupling to that writer is pinned by the served-file
 * test, which rewrites a REAL emitted build.js.
 */
const DEV_CHROME = /(\n?self\.OMEGA_BUILD_JSON\.config\.dev = )(?:\{.*\}|null)(?=;)/s;

/**
 * Serve-time dev-ports injection (#346): the snapshot this server hands out
 * carries the map of the stack running RIGHT NOW, whatever the build baked.
 *
 * The build-time write is a snapshot of the moment a site was built, and the
 * normal boot order builds every page before the backend publishes anything:
 * the website build finishes in under a second while the emulator suite seeds
 * for minutes, so the build bakes `{ website }` alone and nothing re-runs it,
 * because no source file changed. Same hole for a mid-session emulator restart
 * onto bumped numbers. Rewriting the one file as it goes out covers both by
 * construction; the file on disk stays as the build wrote it.
 *
 * ONE file instead of every HTML response (#743): every page and the service
 * worker load the same `/build.js`, so the rewrite happens once per request for
 * it rather than once per page, and a page served from any other path is
 * untouched. The rewrite wraps `res.end` rather than the response object:
 * eleventy wrapped `res` before the middleware chain ran (its live-reload
 * injection), so ours is the OUTER end, rewriting what the static handler hands
 * over. A response that carries no dev statement matches nothing and passes
 * through untouched.
 * @param {function} devChrome - the live dev-chrome getter (devPortsOption)
 * @returns {function} connect-style middleware
 */
function devInjectDevPorts(devChrome) {
  return (req, res, next) => {
    const url = String(req.url || '').split('?')[0];
    if (url !== '/build.js') return next();

    const end = res.end;

    res.end = (data, ...rest) => {
      const body = typeof data === 'string' ? data
        : (Buffer.isBuffer(data) ? data.toString('utf8') : null);

      if (body !== null) {
        const rewritten = body.replace(DEV_CHROME, (match, open) => `${open}${JSON.stringify(devChrome())}`);
        // The body length changes with the map, so the header the static
        // handler set for the file on disk has to move with it.
        if (res.setHeader && !res.headersSent) res.setHeader('content-length', Buffer.byteLength(rewritten));
        return end.call(res, rewritten, ...rest);
      }

      return end.call(res, data, ...rest);
    };

    return next();
  };
}

/**
 * Clean-URL resolution, the legacy serve.js contract: pages are flat `.html`
 * files with slash-free URLs, so `/signin` (and a stray `/signin/`) serves
 * `signin.html`. Mirrors production GitHub Pages, which resolves extensionless
 * paths against `.html` files natively.
 * @param {string} outDir
 * @returns {function} connect-style middleware
 */
function devCleanUrls(outDir) {
  const root = path.resolve(outDir);

  return (req, res, next) => {
    const [pathname, query] = (req.url || '').split('?');

    // A malformed percent-escape throws URIError — not a clean-URL
    // candidate, fall through to the static handler.
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch (e) {
      return next();
    }

    const clean = decoded.replace(/\/+$/, '');

    if (!clean) {
      return next();
    }

    // Legacy serve.js contract: rewrite only when the request doesn't hit a
    // real file but `<path>.html` exists. No extension sniffing — dotted
    // slugs (/updates/v1.0.0) are page URLs too.
    const original = path.resolve(root, `.${decoded}`);
    const resolved = path.resolve(root, `.${clean}.html`);
    if (
      resolved.startsWith(root + path.sep)
      && jetpack.exists(original) !== 'file'
      && jetpack.exists(resolved) === 'file'
    ) {
      req.url = `${clean}.html${query ? `?${query}` : ''}`;
    }

    return next();
  };
}

/**
 * The dev website ORIGIN this run answers on — the ONE place protocol and port
 * are put together (#262). Every consumer of "where the dev website is" derives
 * from this: site.url, the published ports file, and the page chrome.
 * @param {number} port - the resolved dev-server (public) port
 * @param {boolean} [https] - whether the public port speaks TLS (mkcert proxy)
 * @returns {string} the origin, protocol included
 */
function devWebsiteOrigin(port, https) {
  return `${https ? 'https' : 'http'}://localhost:${port}`;
}

/**
 * Dev builds link to THIS server, never the live site (legacy _config_dev.yml
 * url-override parity): site.url is the one root every absolute-URL surface
 * derives from — canonicals/og tags, omega_external, absolute_url, redirect
 * pages, nav — so pointing it at the local origin keeps every click in dev.
 * @param {object} siteData - the loaded site global (mutated)
 * @param {string} origin - the resolved dev website origin (devWebsiteOrigin)
 */
function applyDevSiteUrl(siteData, origin) {
  siteData.url = origin;
}

/**
 * Resolve the website port through the allocator (N7). An explicit `--port`
 * flag or a config `ports.website` entry PINS the port (busy = hard error);
 * otherwise start from OMEGA_WEBSITE_PORT (a parent that already allocated)
 * or the classic 4000 and bump +1 while taken.
 */
async function resolveWebsitePort(root, flagPort) {
  const pins = {};

  if (flagPort) {
    if (!(await isPortFree(flagPort))) {
      throw new Error(`Port ${flagPort} (pinned via --port) is already in use — free it or pick another`);
    }
    pins.website = flagPort;
  } else {
    const configPin = loadPortPins(root).website;
    if (typeof configPin === 'number') {
      pins.website = configPin;
    }
  }

  const wanted = { website: websiteWantedPort(root) };
  const { ports, bumped } = await resolvePorts({ wanted, pins });
  return { port: ports.website, bumped: bumped.length > 0 };
}

/**
 * The wanted (pre-allocator) website port: OMEGA_WEBSITE_PORT (a parent that
 * already allocated) or the classic 4000, plus this target's deterministic
 * offset (a brand's Nth web target wants base + its position among the web
 * targets, so N web targets dev side-by-side off the same base). Lenient like
 * loadPortPins: no config means no offset.
 */
function websiteWantedPort(root) {
  const base = envPort('website') || CLASSIC_PORTS.website;

  try {
    if (!hasOmegaConfig(root)) {
      return base;
    }
    const { config, name } = loadConfig(root, 'web');
    return base + targetPortOffset(config, name);
  } catch (error) {
    return base;
  }
}

/**
 * Read explicit port pins from the consumer's config `ports` section.
 * Lenient — a missing/broken config means no pins, never a dev-loop failure.
 */
function loadPortPins(root) {
  try {
    if (!hasOmegaConfig(root)) {
      return {};
    }
    const config = loadConfig(root, 'web').config;
    return config.ports && typeof config.ports === 'object' ? config.ports : {};
  } catch (error) {
    return {};
  }
}

/**
 * The `dev` chrome the engine bakes into every page — as a GETTER, called per
 * render (#300). The sibling backend's published map (its live emulator
 * ports) merges OVER this server's own website port, so the browser always
 * connects to the stack that is actually running: a backend that booted after
 * this server, or an emulator that restarted onto bumped numbers, lands in
 * the very next render instead of never.
 *
 * The website ORIGIN rides the same map (#262): a page knows its own origin,
 * but a desktop/extension surface reading this chrome does not, and protocol is
 * not derivable from a port number.
 * @param {string} root - this target's root (its own ports file is skipped)
 * @param {number} port - the resolved website port
 * @param {string} origin - the resolved website origin (devWebsiteOrigin)
 * @returns {function} () => the dev chrome object
 */
function devPortsOption(root, port, origin) {
  return () => ({
    // The classic map is the FLOOR, from @omega.js/config, the one place the
    // numbers are defined ([#834](https://github.com/Omega-JS-Stack/omega/issues/834)).
    // A live sibling backend's resolved (possibly bumped) numbers land on top
    // of it, and this server's own resolved website port on top of those, so a
    // page always receives a COMPLETE map and @omega.js/client needs no
    // browser-side copy of the defaults to fall back to.
    ports: { ...CLASSIC_PORTS, ...readSiblingPorts(root), website: port },
    origin,
    authEmulatorProxy: true,
  });
}

/**
 * `--local` prelude: file:-install every @omega.js framework used anywhere in
 * this brand (all targets, walked up from cwd) from the local Omega monorepo,
 * then start the monorepo's src→dist watch as a session-scoped child.
 */
// Exposed for tests (the command function stays the main export)
module.exports.resolveWebsitePort = resolveWebsitePort;
module.exports.websiteWantedPort = websiteWantedPort;
module.exports.devPortsOption = devPortsOption;
module.exports.devServerOptions = devServerOptions;
module.exports.resolveAssetThemeLayers = resolveAssetThemeLayers;
module.exports.registerTemplateWatchTargets = registerTemplateWatchTargets;
module.exports.watchAssetSources = watchAssetSources;
module.exports.watchEnvSources = watchEnvSources;
module.exports.watchRescanTargets = watchRescanTargets;
module.exports.applyDevSiteUrl = applyDevSiteUrl;
module.exports.devWebsiteOrigin = devWebsiteOrigin;

async function linkBrandToMonorepo() {
  const local = require('@omega.js/devkit/local');
  const monorepoRoot = local.resolveMonorepoRoot();
  const brandRoot = local.findBrandRoot(process.cwd());
  logger.log(`Local mode: linking @omega.js packages from ${monorepoRoot}`);

  for (const targetDir of local.discoverTargets(brandRoot)) {
    await local.linkLocalPackages({ dir: targetDir, monorepoRoot, logger });
  }

  // Session-scoped by the helper itself — the watch dies with this dev server
  // (no orphans), the same way the brand-root `omega dev` gets it (#587). All
  // that is left here is the dev server's own Ctrl-C policy: a SIGINT listener
  // suppresses node's default kill, so it has to exit deliberately.
  const watch = local.startMonorepoWatch({ monorepoRoot, logger });
  if (watch.child) {
    STOP_SIGNALS.forEach((signal) => process.on(signal, () => process.exit(0)));
  }

  // The same gate the brand-root boot uses (#670): nothing reads a dist while a
  // prepare is still rewriting it — a fresh watch's initial pass, and an
  // already-running watch's, read from its log (#622). Awaited on BOTH
  // branches, which is why this prelude never had the skip #622 fixed.
  await watch.ready;
}
