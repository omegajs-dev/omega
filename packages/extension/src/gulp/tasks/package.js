// Libraries
const build = require('../../build.js');
const logger = build.logger('package');
const watcherLogger = build.logger('package:watcher');
const path = require('path');
const jetpack = require('fs-jetpack');
const { series, parallel, watch } = require('gulp');
const { execute, getKeys, template } = require('node-powertools');
const JSON5 = require('json5');
const { CLASSIC_DEV_ORIGIN } = require('@omega.js/config');
const { listingId, deriveFirefoxId } = require('../../lib/listings.js');
const { renderTokens, unresolvedTokens } = require('@omega.js/devkit/tokens');
const { writeJson } = require('@omega.js/devkit/write-json');

// Load package
const project = build.getPackage('project');
const config = build.getConfig('project');
const rootPathPackage = build.getRootPath('main');

// Glob
const input = [
  // Files to include
  'dist/**/*',

  // Files to exclude
  // '!dist/**',
];
const output = 'dist';
const delay = 250;

// Permissions Firefox has no API for: it rejects an unknown permission at
// install, so the firefox artifact drops every one of them.
const CHROME_ONLY_PERMISSIONS = ['sidePanel', 'offscreen'];

// Build targets with browser-specific configurations. The keys are OMEGA's
// browser vocabulary ([#867](https://github.com/Omega-JS-Stack/omega/issues/867)),
// which is the client's `getBrowser()`: `chrome`, never `chromium`. There are
// TWO builds, not three: `edge` ships the chrome artifact (one chromium zip,
// two stores), and the packaged dir a browser loads is `packaged/<target>/raw`.
const TARGETS = {
  chrome: {
    // Chrome, Edge, Brave, etc. - uses service_worker
    adjustManifest: (manifest) => {
      if (manifest.background) {
        delete manifest.background.scripts;
      }
      return manifest;
    },
  },
  firefox: {
    // Firefox - uses scripts array, no service_worker
    adjustManifest: (manifest) => {
      // Firefox REFUSES an add-on it cannot identify, and an id assigned at
      // submission time can never be updated from a self-hosted build: a
      // packaged, submittable-looking artifact that is dead on arrival (#264).
      //
      // CONFIG is the id's one home (#893): `targets.<name>.listings.firefox.id`
      // is the AMO add-on id, which IS this gecko id, so a brand declares it
      // once and the manifest is written from it. A manifest that declares a
      // DIFFERENT id is a contradiction, not an override, and a brand that has
      // declared neither still derives one from its brand facts (deterministic
      // per brand) so a fresh scaffold builds out of the box; only a project
      // with no brand facts at all fails loudly.
      const configuredId = listingId(config, 'firefox');
      const declaredId = manifest.browser_specific_settings?.gecko?.id;

      if (configuredId && declaredId && declaredId !== configuredId) {
        throw new Error(`Cannot package the firefox artifact: src/manifest.json declares browser_specific_settings.gecko.id "${declaredId}" while config/omega.json5 declares listings.firefox.id "${configuredId}". The config is the id's one home: delete the manifest key, or make the two match.`);
      }

      if (!declaredId) {
        let geckoId = configuredId;

        if (!geckoId) {
          geckoId = deriveFirefoxId(config);

          if (!geckoId) {
            throw new Error('Cannot package the firefox artifact: browser_specific_settings.gecko.id is missing. Declare listings.firefox.id in config/omega.json5 (e.g. my-extension@example.com)');
          }

          logger.log(`firefox: no listings.firefox.id declared; using the derived ${geckoId} (the local scaffold pins it into config/omega.json5)`);
        }

        manifest.browser_specific_settings = manifest.browser_specific_settings || {};
        manifest.browser_specific_settings.gecko = manifest.browser_specific_settings.gecko || {};
        manifest.browser_specific_settings.gecko.id = geckoId;
      }

      if (manifest.background) {
        if (manifest.background.service_worker) {
          if (!manifest.background.scripts) {
            manifest.background.scripts = [manifest.background.service_worker];
          }
          delete manifest.background.service_worker;
        }
      }

      // Chrome's side panel is `side_panel` + the `sidePanel` permission;
      // Firefox has neither — it ships the same surface as `sidebar_action`.
      // Shipping the chrome keys packaged fine and left the panel unreachable (#264).
      if (manifest.side_panel) {
        if (manifest.side_panel.default_path && !manifest.sidebar_action) {
          manifest.sidebar_action = {
            default_panel: manifest.side_panel.default_path,
            default_title: manifest.action?.default_title || manifest.name,
          };
        }
        delete manifest.side_panel;
      }

      if (Array.isArray(manifest.permissions)) {
        manifest.permissions = manifest.permissions.filter((permission) => !CHROME_ONLY_PERMISSIONS.includes(permission));
      }

      return manifest;
    },
  },
};

// Recursively remove empty arrays and objects from an object
function removeEmptyValues(obj) {
  if (Array.isArray(obj)) {
    return obj;
  }

  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      // Recursively clean nested objects
      const cleaned = removeEmptyValues(value);

      // Skip empty arrays
      if (Array.isArray(cleaned) && cleaned.length === 0) {
        continue;
      }

      // Skip empty objects (after cleaning)
      if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) {
        continue;
      }

      result[key] = cleaned;
    }
    return result;
  }

  return obj;
}

// The origins the framework default lets message this extension. A packaged
// build needs the BRAND's own origin — it shipped the localhost dev origin
// alone, so the live site could not message the published extension (#583).
// The dev origin rides along in dev only. A consumer that DECLARES
// `externally_connectable` still wins outright (#260) — this is only the default.
function externallyConnectableOrigins() {
  const origins = [];

  let brandOrigin = null;
  try { brandOrigin = new URL(config.brand?.url).origin; } catch (e) { /* no brand url — dev origin only */ }

  if (brandOrigin) {
    origins.push(`${brandOrigin}/*`);
  } else if (build.isBuildMode()) {
    logger.warn('externally_connectable: no brand.url in config/omega.json5, so the packaged extension declares no messaging origin — your site will not be able to message it');
  }

  // The dev-website origin is BUILD-TIME-BAKED by design (N7 non-goal: a shipped
  // extension can't probe ports): the origin the LIVE sibling website published,
  // or the classic default when nothing is up (#262).
  if (!build.isBuildMode()) {
    origins.push(`${build.getDevWebsiteOrigin() || CLASSIC_DEV_ORIGIN}/*`);
  }

  return origins;
}

// Resolve config tokens in every string of a parsed manifest, per value so a
// resolved quote can never break the JSON around it. Returns the rendered tree.
function resolveManifestTokens(value) {
  if (typeof value === 'string') {
    return renderTokens(value, config);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveManifestTokens(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveManifestTokens(item)]));
  }

  return value;
}

// A legal match pattern: scheme, host, an optional port (a number or `*`) and a
// path from `/`, where `file` alone takes an empty host. `<all_urls>` is legal beside it.
const MATCH_PATTERN = /^(?:(?:\*|https?|wss?|ftp):\/\/(?:\*|(?:\*\.)?[^/*:]+)(?::(?:\d+|\*))?|file:\/\/)\/.*$/;

// The distinct match patterns of a manifest no browser accepts, from every key
// that carries them.
function illegalMatchPatterns(manifest) {
  const patterns = [
    ...(manifest.content_scripts || []).flatMap((entry) => [...(entry.matches || []), ...(entry.exclude_matches || [])]),
    ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || []),
    ...(manifest.web_accessible_resources || []).flatMap((entry) => entry.matches || []),
  ];

  return [...new Set(patterns.filter((pattern) => typeof pattern === 'string'
    && pattern !== '<all_urls>'
    && !MATCH_PATTERN.test(pattern)))];
}

// Special Compilation Task for manifest.json with default settings
async function compileManifest(outputDir, target) {
  try {
    const manifestPath = path.join('dist', 'manifest.json');
    const outputPath = path.join(outputDir, 'manifest.json');
    const configPath = path.join(rootPathPackage, 'dist', 'config', 'manifest.json');

    // The consumer manifest renders the view `{{ }}` config tokens, and one
    // nothing resolves fails here: Chrome refuses a match pattern carrying it.
    // The framework defaults speak the bundle task's `%%%name%%%` idiom instead.
    let manifest = resolveManifestTokens(JSON5.parse(jetpack.read(manifestPath)));
    const leftover = unresolvedTokens(JSON.stringify(manifest));

    if (leftover.length > 0) {
      throw new Error(`Cannot build the manifest: src/manifest.json carries config token(s) nothing in config/omega.json5 resolves: ${leftover.join(', ')}`);
    }

    const illegal = illegalMatchPatterns(manifest);

    if (illegal.length > 0) {
      throw new Error(`Cannot build the manifest: src/manifest.json carries illegal match pattern(s): ${illegal.join(', ')}`);
    }

    const defaultConfig = JSON5.parse(template(jetpack.read(configPath), {
      externallyConnectableOrigins: externallyConnectableOrigins()
        .map((origin) => `'${origin}'`)
        .join(', '),
    }, {
      brackets: ['%%%', '%%%'],
    }));

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Apply defaults (shared across all targets)
    // ═══════════════════════════════════════════════════════════════════════════
    // A declared consumer value is AUTHORITATIVE — the defaults only fill keys
    // the consumer never wrote. Arrays used to UNION with the default, so a
    // framework-default entry could never be removed: an extension declaring an
    // empty `externally_connectable` still shipped the dev origin in every
    // production build (#260). An empty array is a decision, not an omission.
    getKeys(defaultConfig).forEach(key => {
      const defaultValue = key.split('.').reduce((o, k) => (o || {})[k], defaultConfig);
      const userValue = key.split('.').reduce((o, k) => (o || {})[k], manifest);

      if (userValue === undefined) {
        // Apply default if user value doesn't exist
        key.split('.').reduce((o, k, i, arr) => {
          if (i === arr.length - 1) o[k] = defaultValue;
          else o[k] = o[k] || {};
          return o[k];
        }, manifest);
      }
    });

    // Add package version to manifest. Chrome REFUSES a manifest with no
    // version — a target whose package.json has none used to build a perfectly
    // normal-looking extension that no browser would load (#46). Fail here.
    if (!project.version) {
      throw new Error('Cannot build the manifest: the extension app\'s package.json has no "version" (Chrome refuses to load a manifest without one)');
    }
    manifest.version = project.version;

    // Chrome and Firefox both link the store listing's developer-site link from
    // `homepage_url`, and nothing emitted it — the brand's site is right there in
    // the config (#576). A DECLARED value is authoritative; missing, it is
    // derived from the brand config, the same mechanism as the firefox gecko id.
    if (manifest.homepage_url === undefined && config.brand?.url) {
      manifest.homepage_url = config.brand.url;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: Apply target-specific adjustments
    // ═══════════════════════════════════════════════════════════════════════════
    const targetConfig = TARGETS[target];
    if (targetConfig?.adjustManifest) {
      manifest = targetConfig.adjustManifest(manifest);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: Clean up (shared across all targets)
    // ═══════════════════════════════════════════════════════════════════════════

    // Declare only icons the build actually produced. The defaults name the
    // full size ladder, but the icons task makes nothing without a
    // `config/icon.{svg,png}` or the brand's brandmark, and Chrome REFUSES to
    // load an extension whose manifest points at an icon that isn't there, silently.
    const iconMissing = (relative) => !jetpack.exists(path.join('dist', relative));
    const prunedIcons = [];

    for (const [size, file] of Object.entries(manifest.icons || {})) {
      if (iconMissing(file)) {
        delete manifest.icons[size];
        prunedIcons.push(file);
      }
    }

    // `action.default_icon` is legally EITHER a path string or a size→path map
    // (both shapes ship in dist/config/manifest.json) — prune the map per entry
    // and drop the key only when nothing survives.
    const defaultIcon = manifest.action?.default_icon;

    if (typeof defaultIcon === 'string') {
      if (iconMissing(defaultIcon)) {
        prunedIcons.push(defaultIcon);
        delete manifest.action.default_icon;
      }
    } else if (defaultIcon && typeof defaultIcon === 'object') {
      for (const [size, file] of Object.entries(defaultIcon)) {
        if (iconMissing(file)) {
          delete defaultIcon[size];
          prunedIcons.push(file);
        }
      }

      if (Object.keys(defaultIcon).length === 0) {
        delete manifest.action.default_icon;
      }
    }

    if (prunedIcons.length > 0) {
      logger.warn(`[${target}] Dropped ${prunedIcons.length} missing icon reference(s) from the manifest: add config/icon.png, or the brand's assets/logo/brandmark.svg, to ship icons`);
    }

    // Remove empty arrays and objects from manifest
    const cleanedManifest = removeEmptyValues(manifest);

    // Save as regular JSON
    writeJson(outputPath, cleanedManifest);

    logger.log(`[${target}] Manifest compiled with defaults`);
  } catch (e) {
    // Report, then FAIL the build. A swallowed error here shipped the raw JSON5
    // source manifest as `manifest.json` and finished green — including the
    // versionless case the guard above exists to catch (#46).
    logger.error(`Error compiling manifest`, e);
    throw e;
  }
}

// Special Compilation Task for _locales
async function compileLocales(outputDir) {
  try {
    const localesDir = path.join('dist', '_locales');
    const outputLocalesDir = path.join(outputDir, '_locales');

    // Ensure the directory exists
    jetpack.dir(outputLocalesDir);

    // Process each locale file
    jetpack.find(localesDir, { matching: '**/*.json' }).forEach(filePath => {
      const relativePath = path.relative(localesDir, filePath);
      const outputPath = path.join(outputLocalesDir, relativePath);

      // Read and parse using JSON5
      const localeData = JSON5.parse(jetpack.read(filePath));

      // Save as regular JSON
      writeJson(outputPath, localeData);

      logger.log(`Locale compiled and saved: ${outputPath}`);
    });
  } catch (e) {
    // Report, then re-throw — a broken locale finishing green loads as a
    // Chrome refusal when default_locale is declared (#46).
    logger.error(`Error compiling locales`, e);
    throw e;
  }
}

// Package Task for raw - creates builds for all browser targets
async function packageRaw() {
  // Log
  logger.log(`Starting raw packaging...`);

  try {
    // Build for each target
    for (const target of Object.keys(TARGETS)) {
      await packageRawForTarget(target);
    }

    // Log completion
    logger.log(`Finished raw packaging for all targets`);
  } catch (e) {
    // Report, then re-throw so packageFn's handler fails the gulp task — a
    // half-packaged target is never a green build (#46).
    logger.error(`Error during raw packaging`, e);
    throw e;
  }
}

// Files to exclude from packaged output (development/source files)
const PACKAGE_EXCLUDE_PATTERNS = [
  '**/*.scss',
  '**/*.sass',
  '**/*.ts',
  '**/.DS_Store',
  // Maps stay in dist for local reading: they carry the remote-script URLs the
  // redaction strips, and the post-build rewrites leave their positions stale.
  '**/*.map',
];

// Package raw for a specific target (chrome or firefox)
async function packageRawForTarget(target) {
  logger.log(`[${target}] Starting raw packaging...`);

  const outputDir = `packaged/${target}/raw`;

  // Ensure the directory exists (this also cleans it)
  jetpack.dir(outputDir, { empty: true });

  // Copy files to raw package directory
  await execute(`cp -r dist/* ${outputDir}`);

  // Remove development/source files that shouldn't be in the package
  const filesToRemove = jetpack.find(outputDir, { matching: PACKAGE_EXCLUDE_PATTERNS });
  filesToRemove.forEach(file => {
    jetpack.remove(file);
    logger.log(`[${target}] Removed dev file: ${path.relative(outputDir, file)}`);
  });

  // Loop thru outputDir/assets/js all JS files for redactions
  const jsFiles = jetpack.find(path.join(outputDir, 'assets', 'js'), { matching: '*.js' });
  const redactions = getRedactions();

  jsFiles.forEach(filePath => {
    // Load the content
    let content = jetpack.read(filePath);

    // Replace keys with their corresponding values
    Object.keys(redactions).forEach(key => {
      const value = redactions[key];
      const regex = new RegExp(key, 'g'); // Create a global regex for the key
      content = content.replace(regex, value);

      // Log replacement
      logger.log(`[${target}] Redacted ${key} in ${filePath}`);
    });

    // Write the new content to the file
    jetpack.write(filePath, content);
  });

  // Compile manifest (target-specific) and locales
  await compileManifest(outputDir, target);
  await compileLocales(outputDir);

  logger.log(`[${target}] Finished raw packaging`);
}

// Create zipped version of raw packages for each target
async function packageZip() {
  // Log
  logger.log(`Zipping raw packages...`);

  // Skip if not in build mode
  if (!build.isBuildMode()) {
    logger.log(`Skipping zip (not in build mode)`);
    return;
  }

  try {
    // Create zip for each target
    for (const target of Object.keys(TARGETS)) {
      const inputDir = `packaged/${target}/raw`;
      const zipPath = `packaged/${target}/extension.zip`;

      // Remove existing zip if it exists
      jetpack.remove(zipPath);

      // Zip contents of raw directory (not the directory itself)
      // This ensures manifest.json is at the root of the zip
      await execute(`cd ${inputDir} && zip -r ../extension.zip .`);
      logger.log(`[${target}] Zipped package created at ${zipPath}`);
    }
  } catch (e) {
    // Report, then re-throw — a build-mode run without its zip artifact is
    // never a green build (#46).
    logger.error(`Error zipping package`, e);
    throw e;
  }
}

// Create source code zip for Firefox review
async function packageSource() {
  const { template } = require('node-powertools');
  const os = require('os');

  // Log
  logger.log(`Zipping source code...`);

  try {
    const sourceZipPath = 'packaged/source.zip';

    // Only in build mode
    if (!build.isBuildMode()) {
      logger.log(`Skipping source zip (not in build mode)`);
      return;
    }

    // Remove existing zip if it exists
    jetpack.remove(sourceZipPath);

    // Get system info
    const platform = os.platform();
    const platformName = {
      darwin: 'macOS',
      win32: 'Windows',
      linux: 'Linux',
    }[platform] || platform;

    // Read template and replace variables
    const templatePath = path.join(rootPathPackage, 'dist', 'gulp', 'templates', 'BUILD_INSTRUCTIONS.md');
    const templateContent = jetpack.read(templatePath);
    const instructions = template(templateContent, {
      system: {
        platform: platformName,
        release: os.release(),
        arch: os.arch(),
        nodeVersion: process.version,
      },
    });

    // Create source zip using git archive (respects .gitignore)
    await execute(`git archive --format=zip --output=${sourceZipPath} HEAD`);

    // Write build instructions to .temp/README.md
    const tempReadmePath = path.join(process.cwd(), '.temp', 'README.md');
    jetpack.write(tempReadmePath, instructions);

    // Update the zip - replace README.md with build instructions
    await execute(`cd .temp && zip -u ../${sourceZipPath} README.md`);

    // Clean up temp file
    jetpack.remove(tempReadmePath);

    logger.log(`Source code zip created at ${sourceZipPath}`);
  } catch (e) {
    // Report, then re-throw — a build-mode run without its source zip is
    // never a green build (#46).
    logger.error(`Error zipping source code`, e);
    throw e;
  }
}

function liveReload() {
  // Log
  logger.log('Reloading live server clients...');

  // Quit if in build mode
  if (build.isBuildMode()) {
    return logger.log('Skipping live reload in build mode');
  }

  // Quit if no websocket server
  if (!global.websocket) {
    return logger.log('No live reload server found');
  }

  // Reload each client
  global.websocket.clients.forEach((client) => {
    // Get client IP
    const clientIp = client._socket?.remoteAddress || 'Unknown IP';

    // Log
    logger.log(`Sending to client at IP: ${clientIp}`);

    // Send
    client.send(JSON.stringify({ command: 'reload' }))
  })

  // Complete
  return;
}

// Deploy store submission assets to packaged/assets/
async function deployStoreAssets() {
  const assetsDir = path.join('packaged', 'assets');

  // Copy 128x128 icon for store submission
  const iconSrc = path.join('dist', 'assets', 'images', 'icons', 'icon-128x.png');
  if (jetpack.exists(iconSrc)) {
    const iconDest = path.join(assetsDir, 'icon', 'icon-128x.png');
    jetpack.dir(path.dirname(iconDest));
    jetpack.copy(iconSrc, iconDest, { overwrite: true });
    logger.log('Store asset: icon-128x.png');
  }

  // Render brand tokens the same way the html task templates a view — a store
  // listing ships the resolved brand, never a literal `{{ brand.name }}` (#289)
  const renderDescription = (contents, label) => {
    const rendered = renderTokens(contents, { brand: config.brand || {} });
    const leftover = unresolvedTokens(rendered);

    // An unresolvable token (typo, missing config key) passes through literally
    // and would ship to the live store listing — say so instead of shipping quiet
    if (leftover.length > 0) {
      logger.warn(`Store description ${label}: unresolved token(s) ship literally: ${leftover.join(', ')}. Check config/omega.json5`);
    }

    return rendered;
  };

  // Write English description (brand tokens rendered)
  const enDescSrc = path.join(process.cwd(), 'config', 'description.md');
  if (jetpack.exists(enDescSrc)) {
    const descDir = path.join(assetsDir, 'description');
    jetpack.dir(descDir);
    jetpack.write(path.join(descDir, 'en.md'), renderDescription(jetpack.read(enDescSrc), 'en'));
    logger.log('Store asset: description/en.md');
  }

  // Write translated descriptions: the committed translations/ cache's entry for the current source
  const translationsDir = path.join(process.cwd(), 'translations');
  if (jetpack.exists(translationsDir)) {
    const { readTranslatedDescription } = require('./translate.js');
    const descDir = path.join(assetsDir, 'description');

    let count = 0;
    for (const file of jetpack.find(translationsDir, { matching: '*/description.json' })) {
      const lang = path.basename(path.dirname(file));
      const content = readTranslatedDescription(lang);

      if (content) {
        jetpack.dir(descDir);
        jetpack.write(path.join(descDir, `${lang}.md`), renderDescription(content, lang));
        count++;
      }
    }

    if (count > 0) {
      logger.log(`Store asset: ${count} translated descriptions`);
    }
  }
}

// Package Task
async function packageFn(complete) {
  try {
    // Log
    logger.log('Starting...');

    // Run build:pre hook
    await hook('build:pre');

    // Run packageRaw
    await packageRaw();

    // Run packageZip
    await packageZip();

    // Run packageSource
    await packageSource();

    // Deploy store submission assets
    await deployStoreAssets();

    // Run build:post hook
    await hook('build:post');

    // Run liveReload
    liveReload();

    // Log
    logger.log('Finished!');

    // Complete
    return complete();
  } catch (error) {
    // Handle any errors that occur during package build
    return build.reportBuildError(Object.assign(error, { plugin: 'Package' }), complete);
  }
}

// Watcher Task
function packageFnWatcher(complete) {
  // Quit if in build mode
  if (build.isBuildMode()) {
    watcherLogger.log('Skipping watcher in build mode');
    return complete();
  }

  // Log
  watcherLogger.log('Watching for changes...');

  // Watch for changes in the dist folder
  watch(input, { delay: delay, dot: true }, packageFn)
    .on('change', function (path) {
      watcherLogger.log(`File ${path} was changed`);
    });

  // Complete
  return complete();
}

// Export tasks
module.exports = series(packageFn, packageFnWatcher);
module.exports.packageFn = packageFn;
module.exports.packageZip = packageZip;
module.exports.compileManifest = compileManifest;
module.exports.illegalMatchPatterns = illegalMatchPatterns;
module.exports.compileLocales = compileLocales;
module.exports.deployStoreAssets = deployStoreAssets;
module.exports.hook = hook;
// The browser targets the package lane builds: the one list the publish task's
// release upload is checked against (it ships packaged/<target>/extension.zip).
module.exports.TARGETS = TARGETS;

// Run hooks
async function hook(file, ctx) {
  // Candidate paths, in order: the NESTED form the defaults scaffold writes and
  // setup's migration moves flat files to (`hooks/build/pre.js`), then the flat
  // pre-migration form (`hooks/build:pre.js`) as a transition fallback. Resolving
  // only the flat one left every migrated consumer's hooks dead (#571).
  const candidates = [
    path.join(process.cwd(), 'hooks', `${file.split(':').join(path.sep)}.js`),
    path.join(process.cwd(), 'hooks', `${file}.js`),
  ];

  // Find the first one that exists
  const fullPath = candidates.find((candidate) => jetpack.exists(candidate));

  // Quit if there is none — a consumer may delete a scaffolded hook, so the
  // miss is an informational line through the framework logger (the bare
  // console.warn it replaces carried no tag and read as build noise, #571)
  if (!fullPath) {
    return logger.log(`No ${file} hook found at ${candidates[0]}`);
  }

  // Log
  logger.log(`Running hook: ${fullPath}`);

  // Load hook
  let hook;
  try {
    // Load the hook
    hook = require(fullPath);
  } catch (e) {
    throw new Error(`Error loading hook: ${fullPath} ${e.stack}`);
  }

  // Execute hook — the ONE hook-argument shape across OMEGA frameworks: the same
  // `{ build, projectRoot, mode }` ctx @omega.js/desktop hands its lifecycle
  // hooks. This used to pass the package task's internal watch counter while both
  // docs described a build-info object nothing ever built, so a hook written from
  // the docs read `undefined` at its first property (#591). Everything those docs
  // promised is reachable through `build` (getManifest/getConfig/getPackage).
  try {
    return await hook({
      build,
      projectRoot: process.cwd(),
      // Build mode answers the BUILD lane's hooks. A caller that knows better
      // says so: the deploy verb's hook runs outside a build and what it is
      // about to publish is a release, so it names `production` itself.
      mode: build.isBuildMode() ? 'production' : 'development',
      ...(ctx || {}),
    });
  } catch (e) {
    throw new Error(`Error running hook: ${fullPath} ${e.stack}`);
  }
}

// Get redactions
function getRedactions() {
  const REDACTED = './REDACTED_REMOTE_CODE';

  return {
    'https://app.chatsy.ai/resources/script.js': REDACTED + 1,
    // '/https://cdnjs.cloudflare.com/polyfill/v3/polyfill.min.js\\?[^"\'\\s]*/g': REDACTED + 2,
    'https://cdnjs.cloudflare.com/polyfill/v3/polyfill.min.js': REDACTED + 2,
    'https://www.google.com/recaptcha/enterprise.js': REDACTED + 3,
    'https://apis.google.com/js/api.js': REDACTED + 4,
    'https://www.google.com/recaptcha/api.js': REDACTED + 5,
    'https://browser.sentry-cdn.com': REDACTED + 6,
  }
}
