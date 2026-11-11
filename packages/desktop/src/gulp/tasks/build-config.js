// Generate dist/electron-builder.yml entirely from @omega.js/desktop defaults + the consumer's
// config/omega.json5. The consumer NEVER ships an electron-builder.yml.
//
// Why:
//   - Single source of truth: consumer config (omega.json5) drives everything.
//   - Stops consumers from drifting into electron-builder-config-fork-of-our-defaults hell.
//   - Lets @omega.js/desktop evolve packaging defaults centrally (e.g. switch from NSIS to MSIX someday)
//     without per-consumer migrations.
//
// Consumer overrides:
//   `electronBuilder` block (under targets.desktop in omega.json5) gets shallow-merged
//   onto our defaults for genuine special cases. Most apps will never set this.

const path    = require('path');
const jetpack = require('fs-jetpack');
const yaml    = require('js-yaml');
const { deepMerge, FORMATS, enabledFormats, desktopArtifactName, sanitizeProductName, snapName, formatKeysSet, releasesRepo, repoMissing } = require('@omega.js/config');
const { PUBLISHING_WALK } = require('@omega.js/devkit/ship-plan');
const build = require('../../build.js');
const { desktopPlatform } = require('../../utils/platform.js');

const { writeMacEntitlements } = require('../../lib/sign-helpers/entitlements.js');
const { resolveAndCopy }       = require('../../lib/sign-helpers/resolve-icons.js');

const logger = build.logger('build-config');

module.exports = function buildConfig(done) {
  Promise.resolve().then(async () => {
    const projectRoot = process.cwd();
    const distRoot    = require('../../utils/dist-root.js')(projectRoot);
    const distPath    = path.join(distRoot, 'electron-builder.yml');

    const config      = build.getConfig();
    const startupMode = config.startup?.mode || 'normal';

    // 1. Generate entitlements.mac.plist into dist/config/. Consumer overrides live at
    // `platforms.mac.entitlements` (an object map of plist key → value, with `null` to
    // remove an @omega.js/desktop default). Top-level `entitlements.mac` is no longer read.
    const entitlementsPath = writeMacEntitlements(distRoot, config.platforms?.mac?.entitlements);
    logger.log(`wrote ${entitlementsPath}`);

    // 2. Resolve + copy icons (3-tier waterfall) into dist/config/icons/.
    const emDefaultsRoot = path.join(__dirname, '..', '..', 'defaults', 'config');
    const icons = await resolveAndCopy({ config, projectRoot, distRoot, emDefaultsRoot });
    logger.log(`resolved icons: mac=${Object.keys(icons.mac).length}, windows=${Object.keys(icons.windows).length}, linux=${Object.keys(icons.linux).length}`);

    // Build the full config object from @omega.js/desktop defaults + consumer overrides.
    let builderConfig = baseConfig(config, { entitlementsPath, icons, distRoot, projectRoot });

    // Pin the exact electron version for electron-builder. It refuses semver
    // ranges and resolves node_modules only from the project dir — in a brand
    // monorepo electron hoists to the workspace root, so the lookup fails
    // (the cp142 rehearsal catch). The framework resolves the INSTALLED
    // electron from its own module context instead.
    try {
      builderConfig.electronVersion = require('electron/package.json').version;
      logger.log(`electronVersion → ${builderConfig.electronVersion} (resolved from the installed electron)`);
    } catch (error) {
      logger.log('electronVersion not injected (electron unresolved) — electron-builder falls back to its own detection');
    }

    // Mode-dependent injections. LSUIElement=true in Info.plist → on macOS the
    // app launches with no dock icon, no Cmd+Tab presence, completely invisible.
    // Tray/notifications/networking still work; every window-surface path calls
    // app.dock.show() (window-manager._ensureDockVisible), so the dock icon
    // appears the moment a window actually shows. Baked for `hidden` mode AND
    // for openAtLogin.mode='hidden' — without the plist key, a login launch
    // flashes the dock before applyEarly()'s dock.hide() can run (the bounce
    // is a native animation that starts before any JS executes).
    if (shouldInjectLSUIElement(config)) {
      builderConfig.mac = builderConfig.mac || {};
      builderConfig.mac.extendInfo = builderConfig.mac.extendInfo || {};
      builderConfig.mac.extendInfo.LSUIElement = true;
      logger.log(`${startupMode === 'hidden' ? 'startup.mode' : 'startup.openAtLogin.mode'}=hidden → injected mac.extendInfo.LSUIElement=true`);
    }

    // Inject `publish` from config. This is the feed URL electron-updater bakes
    // into the shipped app, so it comes from the config alone (#799).
    const publish = publishConfig(config);
    if (publish) {
      builderConfig.publish = publish;
      logger.log(`releases → publish block: github ${publish.owner}/${publish.repo}`);
    } else if (config.releases?.enabled !== false) {
      logger.warn(`Could not address the releases repo; leaving publish block off. ${repoMissing('releases')}`);
    }

    // Inject the two notarize hooks (the .app, then each .dmg).
    for (const [hook, file] of Object.entries(notarizeHooks())) {
      builderConfig[hook] = file;
      logger.log(`${hook} → ${file}`);
    }

    // Apply consumer overrides last so they win.
    if (config.electronBuilder && typeof config.electronBuilder === 'object') {
      builderConfig = deepMerge(builderConfig, config.electronBuilder);
      logger.log('Applied electronBuilder overrides from omega.json5');
    }

    // The deb target's metadata, checked AFTER the overrides so a consumer that
    // spells `linux.maintainer` itself passes (#872).
    assertLinuxPackageMetadata(builderConfig);

    // Serialize to YAML and write.
    const yml = yaml.dump(builderConfig, { lineWidth: -1, noRefs: true });
    jetpack.write(distPath, yml);
    logger.log(`wrote ${distPath} (mode=${startupMode})`);
  }).then(() => done(), done);
};

// OMEGA's format words → electron-builder's target names (#867). THE one point
// where the foreign spelling is used: `appimage` is `AppImage` to
// electron-builder, and its per-target config block is `appImage` again.
const BUILDER_TARGETS = {
  dmg:      'dmg',
  nsis:     'nsis',
  deb:      'deb',
  appimage: 'AppImage',
  snap:     'snap',
};

// A platform's install-knob block. `platforms.<platform>: false` (the whole
// platform dropped) and an absent block read the same here: defaults, and no
// target, because enabledFormats already said it ships nothing.
function platformBlock(declaration) {
  return declaration && typeof declaration === 'object' ? declaration : {};
}

// Generic-category → per-platform mapping. Consumer sets `app.category` to one of these
// keys; @omega.js/desktop emits the corresponding mac UTI string and Linux freedesktop category.
//
// macOS: https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/LaunchServicesKeys.html#//apple_ref/doc/uid/TP40009250-SW8
// Linux: https://specifications.freedesktop.org/menu-spec/latest/apa.html
const CATEGORY_MAP = {
  'productivity':    { mac: 'public.app-category.productivity',        linux: 'Utility' },
  'developer-tools': { mac: 'public.app-category.developer-tools',     linux: 'Development' },
  'utilities':       { mac: 'public.app-category.utilities',           linux: 'Utility' },
  'media':           { mac: 'public.app-category.entertainment',       linux: 'AudioVideo' },
  'social':          { mac: 'public.app-category.social-networking',   linux: 'Network' },
  'network':         { mac: 'public.app-category.business',            linux: 'Network' },
};

function resolveCategory(category) {
  return CATEGORY_MAP[category] || CATEGORY_MAP.productivity;
}

// Substitute the {YEAR} token in a copyright string with the current year. Idempotent
// when no token is present. Called at YAML generation time so the year stays current
// across releases without consumers ever editing config.
function expandYear(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{YEAR\}/g, String(new Date().getFullYear()));
}

// @omega.js/desktop's canonical electron-builder config. Driven by the consumer's omega.json5
// where it makes sense (appId, productName, copyright, category, languages, platform archs,
// installer flags); everything else (target list, file globs, signing) is @omega.js/desktop's opinionated
// default.
//
// Optional `extras` argument carries resolved icon paths + entitlements path from the
// build-config task. When called from tests with no extras, the bare config is returned
// (paths are left as project-relative defaults that may not exist on disk — fine for
// test assertions).
function baseConfig(config, extras = {}) {
  // Seed `app` + `brand` so callers (including tests passing bare {}) can deref without
  // optional-chaining at every site. Matches build.getConfig()'s own seeding.
  config.app   = config.app   || {};
  config.brand = config.brand || {};

  // build.getConfig() derives appId from the brand url/id; the literal here
  // only backstops bare test configs. Copyright derives from the BRAND, never
  // a hardcoded company (friction #18).
  const appId       = config.app.appId       || 'app.omega.consumer';
  const productName = config.app.productName || 'App';
  const copyright   = expandYear(config.app.copyright || (config.brand.name ? `© {YEAR}, ${config.brand.name}` : '© {YEAR}'));

  // Generic category → per-platform values via lookup table. Default 'productivity' is
  // a safe baseline that fits ~80% of business + utility apps.
  const category   = resolveCategory(config.app.category || 'productivity');
  const languages  = Array.isArray(config.app.languages) ? config.app.languages : ['en'];
  const darkModeSupport = config.app.darkModeSupport !== false;  // default true

  // What this brand SHIPS, from the ONE declaration (#867):
  // `platforms.<mac|windows|linux>.formats.<dmg|nsis|deb|appimage|snap>`, where
  // presence is the switch and every format defaults ON. @omega.js/config's
  // format table is the vocabulary; the electron-builder spelling of each
  // format is translated at ONE point below (BUILDER_TARGETS).
  const shipped = enabledFormats(config, 'desktop');
  const ships = (platform, format) => shipped.some((entry) => entry.platform === platform && entry.format === format);
  const formatOptions = (platform, format) => shipped.find((entry) => entry.platform === platform && entry.format === format)?.options || {};

  // Per-platform config blocks (the install knobs beside `formats`). Each is
  // fully optional: every key has a default. A platform switched off with
  // `false` reads as an empty block here and ships no target below.
  const macTargetCfg   = platformBlock(config.platforms?.mac);
  const winTargetCfg   = platformBlock(config.platforms?.windows);
  const linuxTargetCfg = platformBlock(config.platforms?.linux);

  const macArch   = Array.isArray(macTargetCfg.arch)   && macTargetCfg.arch.length   ? macTargetCfg.arch   : ['universal'];
  const winArch   = Array.isArray(winTargetCfg.arch)   && winTargetCfg.arch.length   ? winTargetCfg.arch   : ['x64', 'ia32'];
  const linuxArch = Array.isArray(linuxTargetCfg.arch) && linuxTargetCfg.arch.length ? linuxTargetCfg.arch : ['x64'];

  // The arch sets the versionless names can spell (#620) — checked HERE, the
  // last moment a colliding build is still fixable.
  assertArchRules({ mac: macArch, linux: linuxArch }, extras);

  // NSIS installer UX. Defaults match Slack/Discord-style "no friction" install:
  // one-click (no wizard), shortcut everywhere, launch on finish, per-user.
  const nsisOneClick           = winTargetCfg.oneClick !== false;
  const nsisDesktopShortcut    = winTargetCfg.desktopShortcut !== false;
  const nsisStartMenuShortcut  = winTargetCfg.startMenuShortcut !== false;
  const nsisRunAfterFinish     = winTargetCfg.runAfterFinish !== false;
  const nsisPerMachine         = winTargetCfg.perMachine === true;

  // Snap publishing rides the declaration like every other format
  // (`platforms.linux.formats.snap`, on unless dropped with `false`), and its
  // settings live inside it. The config always names it; the tasks that make
  // installers refuse without its login (assertStoreLogins), never this one.
  const snapCfg = formatOptions('linux', 'snap');
  const snapShips = ships('linux', 'snap');

  const { entitlementsPath, icons, distRoot, projectRoot } = extras;
  // Paths in dist/electron-builder.yml must be project-relative because electron-builder
  // resolves them against the cwd it was invoked from (which is projectRoot, not distRoot).
  // Falling back to distRoot for older callers, but projectRoot is correct.
  const rel = (abs) => {
    if (!abs) return abs;
    if (projectRoot) return path.relative(projectRoot, abs);
    if (distRoot)    return path.relative(distRoot, abs);
    return abs;
  };

  // Artifact filenames come from @omega.js/config's platforms.js: the ONE
  // naming rule (#620), shared with the website's direct-download URLs
  // (`site.targets.desktop.downloads`). They carry no version, which is what
  // makes `/releases/latest/download/<asset>` a link that never changes, and
  // they sanitize the productName (electron-builder's `${productName}` keeps
  // spaces, which become dots in NSIS output).
  const safeProductName = sanitizeProductName(productName);

  // The two METADATA facts the .deb target requires, both from the BRAND
  // ([#872](https://github.com/Omega-JS-Stack/omega/issues/872)). electron-builder
  // reads the homepage off the app's package.json, never off its own config, and
  // `extraMetadata` is the block it merges into that manifest at build time; the
  // maintainer is `linux.maintainer`, else the manifest's `author` name + email.
  // Missing, they fail the deb build LATE, after the AppImage has already
  // published, which is what run 34584322778 did. Absent values are left OUT
  // here (never an empty string) and named by assertLinuxPackageMetadata below.
  const homepage = trimmed(config.brand.url);
  const supportEmail = trimmed(config.brand.contact?.email);
  const maintainer = supportEmail ? `${config.brand.name || productName} <${supportEmail}>` : '';

  // The target lists, straight off the declaration: a format ships because the
  // brand declared it.
  const linuxTargets = shipped
    .filter((entry) => entry.platform === 'linux')
    .map((entry) => ({ target: BUILDER_TARGETS[entry.format], arch: linuxArch }));

  // mac ships the dmg the site links plus the auto-update ZIP electron-updater
  // fetches from the feed. The zip is NOT a declared format (nobody links it),
  // so it rides the dmg leg: no dmg, no mac build at all.
  const macTargets = ships('mac', 'dmg')
    ? [{ target: 'dmg', arch: macArch }, { target: 'zip', arch: macArch }]
    : [];

  const winTargets = shipped
    .filter((entry) => entry.platform === 'windows')
    .map((entry) => ({ target: BUILDER_TARGETS[entry.format], arch: winArch }));

  const out = {
    appId,
    productName,
    copyright,

    // Merged into the app's package.json for the build: the only way to hand
    // electron-builder a homepage, which the .deb target requires (#872).
    ...(homepage ? { extraMetadata: { homepage } } : {}),

    directories: {
      output:         'release',
      buildResources: 'config',        // dist/config/ (relative to dist/electron-builder.yml)
    },

    files: [
      '**/*',
      '!**/*.map',
      '!.env',
      '!.env.*',
      '!**/*.env',
      // Exclude project logs/ — gulp writes dev.log here during build, which
      // (a) shouldn't ship to end users, and (b) breaks @electron/universal's
      // merge step ("Can't reconcile two non-macho files logs/dev.log") when
      // the file content differs between the x64 and arm64 builds.
      '!logs/**',
      '!**/logs/**',
      // Scratch and state dirs are never app content (#866): the boot runner stages
      // .omega/test-app with symlinks into the target, and the packager followed
      // them (dangling after a folder rename). src/ stays: the runtime reads
      // src/integrations/* from the app root. Root-anchored on purpose: these dirs
      // exist only at the target root (logs/ above also appears inside node_modules).
      '!.omega/**',
      '!.claude/**',
      '!.temp/**',
      '!.cache/**',
      '!.gh-runners/**',
      '!test/**',
    ],

    asar: true,

    mac: {
      category:          category.mac,
      electronLanguages: languages,
      darkModeSupport:   darkModeSupport,
      // Universal binary — one .dmg + one .zip that runs on both Intel and Apple
      // Silicon. Trade-off: ~2x file size (~225MB vs ~117MB single-arch), ~2x mac
      // build time (electron-builder builds both archs then stitches them with lipo).
      // Win: one user-facing download, no "which one do I pick?" choice for end users.
      target: macTargets,
      hardenedRuntime:    true,
      gatekeeperAssess:   false,
      notarize: false,   // notarization runs via afterSign hook
      // mac.artifactName is the FALLBACK for mac targets with no name of their
      // own, which is the auto-update .zip: it carries no format segment
      // because it is not a format anyone declares or links (the feed names
      // it). The .dmg has its own name below, the one the site links. No
      // ${arch}: with arch=universal there is one artifact per target, and a
      // non-universal mac arch is refused outright (assertArchRules) because
      // nothing appends the arch back.
      artifactName: `${safeProductName}-mac.\${ext}`,
    },

    dmg: {
      artifactName: desktopArtifactName(productName, 'mac', 'dmg'),
      // Signed with the same Developer ID identity as the app: Gatekeeper
      // assesses a downloaded image by its OWN signature (the notarize-artifacts
      // hook's `--context context:primary-signature`), and electron-builder
      // leaves the image unsigned unless told (#891).
      sign: true,
    },

    win: {
      target: winTargets,
      signtoolOptions: {
        signingHashAlgorithms: ['sha256'],
      },
      legalTrademarks: copyright,
    },

    nsis: {
      // ONE installer for every winArch (electron-builder merges them), which
      // is why the name carries no arch: it is the file `/download/windows/nsis`
      // hands over.
      artifactName:            desktopArtifactName(productName, 'windows', 'nsis'),
      oneClick:                nsisOneClick,
      perMachine:              nsisPerMachine,
      // `createDesktopShortcut: 'always'` ensures the icon is created even when the
      // installer detects an upgrade (electron-builder's default is 'never' on upgrade).
      createDesktopShortcut:   nsisDesktopShortcut ? 'always' : false,
      createStartMenuShortcut: nsisStartMenuShortcut,
      runAfterFinish:          nsisRunAfterFinish,
      // Standard wizard mode: let the user pick install dir; one-click skips this.
      allowToChangeInstallationDirectory: !nsisOneClick,
    },

    linux: {
      target:       linuxTargets,
      category:     category.linux,
      ...(maintainer ? { maintainer } : {}),
      // The FALLBACK, which only the snap reaches — deb and AppImage are the
      // two published artifacts and carry their own names below. The snap is
      // never a release asset (the Snap Store publishes it), so it keeps ${arch}.
      artifactName: `${safeProductName}-linux-\${arch}.\${ext}`,
    },

    // The two linux artifacts the site links, each its own name (they share
    // linux.artifactName otherwise, and one template cannot say both). One
    // target apiece, so these are the finished filenames, not templates.
    deb: {
      artifactName: desktopArtifactName(productName, 'linux', 'deb'),
    },

    appImage: {
      artifactName: desktopArtifactName(productName, 'linux', 'appimage'),
    },
  };

  // Snap-specific block, only emitted when the snap ships. electron-builder
  // names the snap after the linux executable, so that is where the name the
  // publishing walk registers and the site links (snapName) is pinned.
  if (snapShips) {
    // Only a bare test config has no brand id: the validator requires one
    const name = snapName(config);
    if (name) out.linux.executableName = name;
    out.snap = {
      confinement: snapCfg.confinement || 'strict',
      grade:       snapCfg.grade       || 'stable',
      autoStart:   snapCfg.autoStart !== false,
      publish:     {
        provider: 'snapStore',
        channels: Array.isArray(snapCfg.channels) && snapCfg.channels.length ? snapCfg.channels : ['stable'],
      },
    };
  }

  // fileAssociations + protocols passthrough. framework-side `protocols` is ADDITIVE — the
  // brand.id:// scheme is registered automatically (handled by lib/protocol.js at runtime
  // and by Info.plist generation at build time elsewhere); this is for additional schemes.
  if (Array.isArray(config.fileAssociations) && config.fileAssociations.length > 0) {
    out.fileAssociations = config.fileAssociations;
  }
  if (Array.isArray(config.protocols) && config.protocols.length > 0) {
    out.protocols = config.protocols;
  }

  // Wire entitlements.
  if (entitlementsPath) {
    out.mac.entitlements        = rel(entitlementsPath);
    out.mac.entitlementsInherit = rel(entitlementsPath);
  }

  // Wire icons. electron-builder resolves these as paths relative to the cwd it was invoked from (projectRoot).
  if (icons?.mac?.app)  out.mac.icon   = rel(icons.mac.app);
  if (icons?.mac?.dmg)  out.dmg.background = rel(icons.mac.dmg);
  if (icons?.windows?.app) out.win.icon  = rel(icons.windows.app);
  if (icons?.linux?.app)   out.linux.icon = rel(icons.linux.app);

  return out;
}

/**
 * The arch rules the versionless artifact names impose
 * ([#620](https://github.com/Omega-JS-Stack/omega/issues/620)).
 *
 * A name with no `${arch}` token gets no arch back: electron-builder's
 * macro expander only REPLACES the token where it appears, and the
 * `getArchSuffix()` a suffix could come from is staging-dir and NSIS-internal.
 * So two linux archs write over one deb name, and a non-universal mac build
 * ships under a name that says `universal`. Windows is exempt — NSIS merges
 * every arch into ONE installer, which is why its multi-arch default is safe.
 *
 * A build/publish run refuses; anything else warns and keeps going, because the
 * collision only lands when a build actually publishes those files.
 *
 * @param {object} arch - The resolved per-platform arch lists (`{ mac, linux }`).
 * @param {object} [options]
 * @param {object} [options.mode] - The build module's mode (`{ build, publish, … }`).
 * @param {object} [options.logger] - Logger with `warn` (default: this task's).
 * @throws {Error} in build/publish mode, naming the offending config key.
 */
function assertArchRules(arch, options) {
  options = options || {};
  const mode = options.mode || build.getMode();
  const warn = (options.logger || logger).warn.bind(options.logger || logger);

  const violations = [];
  if (arch.mac.length !== 1 || arch.mac[0] !== 'universal') {
    violations.push(`platforms.mac.arch (${arch.mac.join(', ')}) — the mac artifact is named \`-mac-universal\`, so a non-universal build ships mislabelled`);
  }
  if (arch.linux.length > 1) {
    violations.push(`platforms.linux.arch (${arch.linux.join(', ')}) — the deb and the AppImage carry ONE name each, so the second arch overwrites the first`);
  }
  if (violations.length === 0) return;

  const message = `The versionless artifact names (#620) cannot spell this build's arch set: ${violations.join('; ')}. `
    + 'They support a universal mac and a single linux arch (windows is unaffected — NSIS merges every arch into one installer); '
    + 'per-arch names are a future additive change.';

  if (mode.build || mode.publish) {
    throw new Error(message);
  }

  warn(message);
}

/**
 * Refuse to make installers for a platform that ships a `store` format whose
 * own keys are not all set. The `package` and `release` tasks call it first:
 * electron-builder builds the HOST platform only, so a Linux run with the snap
 * on and no snap login fails naming both, and a mac or Windows run goes on.
 * A plain build, a dev run and a test boot make no installer and never call it.
 * @param {object} config - The resolved desktop config.
 * @param {object} [options] - `platform` (Node's word, default: the host's)
 *   and `env` (default: process.env).
 * @throws {Error} naming each format and its keys.
 */
function assertStoreLogins(config, options) {
  options = options || {};
  const platform = desktopPlatform(options.platform);
  const env = options.env || process.env;

  const unset = enabledFormats(config, 'desktop').filter((entry) => entry.platform === platform
    && FORMATS.desktop[entry.platform][entry.format].kind === 'store'
    && !formatKeysSet('desktop', entry.platform, entry.format, env));
  if (unset.length === 0) return;

  const lines = unset.map((entry) => {
    const spec = FORMATS.desktop[entry.platform][entry.format];
    return `platforms.${entry.platform}.formats.${entry.format} (on by default until set to false) publishes to the ${spec.label} and needs ${spec.requires.join(', ')}, which is not set`;
  });
  throw new Error(`This ${platform} run cannot make its installers: ${lines.join('; ')}. `
    + `Run \`${PUBLISHING_WALK}\` (it asks for the key and writes the brand .env), or set the format to \`false\`.`);
}

// The electron-builder `publish` block: the brand's ONE public releases repo,
// resolved by @omega.js/config's releasesRepo (`<brand.id>-releases` under the
// brand's owner, #883: never a typed name). Config-only on purpose:
// this address is baked into app-update.yml and polled by every installed copy
// forever, and a brand-monorepo app's git remote is the repo it is NESTED in
// (the playground inside the framework monorepo), which would bake a feed that
// 404s. `releases.enabled: false` publishes nowhere, and an unaddressable repo
// emits no block at all rather than half an address.
function publishConfig(config) {
  if (config?.releases?.enabled === false) {
    return null;
  }

  const releases = releasesRepo(config);
  if (!releases) {
    return null;
  }

  return { provider: 'github', owner: releases.owner, repo: releases.name, releaseType: 'release' };
}

// The electron-builder hooks that notarize ([#891](https://github.com/Omega-JS-Stack/omega/issues/891)):
// `afterSign` for the .app, and `artifactBuildCompleted` for each .dmg. The
// ticket stapled to the app INSIDE an image is not stapled to the image, and a
// user's Mac assesses the image first. The DMG hook is PER ARTIFACT because
// electron-builder awaits it before it emits the `artifactCreated` its
// publisher uploads on; `afterAllArtifactBuild` fires after every upload is
// queued, so a proof there ships an unstapled image (run 34738410986).
function notarizeHooks() {
  return {
    afterSign: require.resolve('@omega.js/desktop/hooks/notarize'),
    artifactBuildCompleted: require.resolve('@omega.js/desktop/hooks/notarize-artifacts'),
  };
}

// Whether the packaged app gets LSUIElement=true in Info.plist. True for
// hidden-mode apps AND for normal-mode apps whose login launch is hidden —
// the dock bounce is a native animation that starts before any JS runs, so
// runtime dock.hide() can never fully suppress it.
function shouldInjectLSUIElement(config) {
  return config?.startup?.mode === 'hidden'
    || config?.startup?.openAtLogin?.mode === 'hidden';
}

// A config string with something in it, else ''. Never `undefined` leaking into
// a rendered YAML value.
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Refuse to write a config whose .deb target cannot build (#872). electron-builder
 * fails on a missing homepage or maintainer at PACKAGE time, one target into the
 * linux run and after the AppImage has uploaded; this says the same thing at
 * config time, naming the omega.json5 key to set.
 *
 * @param {object} builderConfig - The composed electron-builder config.
 */
function assertLinuxPackageMetadata(builderConfig) {
  const targets = (builderConfig.linux?.target || []).map((entry) => (typeof entry === 'string' ? entry : entry?.target));
  if (!targets.includes('deb')) {
    return;
  }

  const missing = [];
  if (!builderConfig.extraMetadata?.homepage) {
    missing.push('brand.url (the .deb needs a project homepage)');
  }
  if (!builderConfig.linux?.maintainer) {
    missing.push('brand.contact.email (the .deb needs a package maintainer)');
  }

  if (missing.length === 0) {
    return;
  }

  throw new Error(`The linux .deb target cannot be built from this config. Set in config/omega.json5: ${missing.join('; ')}. A brand that genuinely has neither can spell targets.desktop.electronBuilder.linux.maintainer and .extraMetadata.homepage directly.`);
}

// Exported for tests. deepMerge is @omega.js/config's (cp73c consolidation) —
// same contract the local copy had: objects merge per-key, arrays REPLACE
// (consumer `mac.target: [...]` fully replaces ours, never concatenates).
module.exports.baseConfig    = baseConfig;
module.exports.deepMerge     = deepMerge;
module.exports.shouldInjectLSUIElement = shouldInjectLSUIElement;
module.exports.publishConfig = publishConfig;
module.exports.notarizeHooks = notarizeHooks;
module.exports.expandYear    = expandYear;
module.exports.resolveCategory = resolveCategory;
module.exports.CATEGORY_MAP  = CATEGORY_MAP;
module.exports.assertLinuxPackageMetadata = assertLinuxPackageMetadata;
module.exports.assertStoreLogins = assertStoreLogins;
