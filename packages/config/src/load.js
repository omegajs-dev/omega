/**
 * omega.json5 discovery + loading.
 *
 * ONE authored location per project dir: config/omega.json5. A deployed
 * backend still resolves its staged functions/config/omega.json5 naturally —
 * the runtime's projectDir IS the functions dir (its cwd), so the staged file
 * is that dir's own config/omega.json5. The old second probe location
 * (functions/config under the TARGET root) died with the src/dist pillar: the
 * staged compose output must never read back as an authored local layer, or a
 * brand edit goes stale behind the previous stage.
 *
 * Brand-monorepo hierarchy: when projectDir is a target inside a brand
 * monorepo ({brand}/targets/{target}), the brand root's config/omega.json5 is the
 * brand layer under the target's file, and a brand naming a company
 * (`company: { id }`) inherits that company's own config/omega.json5 underneath
 * that (#677). Resolution for a target:
 *
 *   schema defaults ← framework defaults ← company ← company.<environment> ← brand shared ← brand targets[name] ← brand root config/seo.json5 ← brand.<environment> ← local shared ← local targets[name] ← root config/seo.json5 (no brand layer) ← local.<environment>
 *
 * The bottom layer derives from the schema's own `default:` entries
 * ([#478](https://github.com/Omega-JS-Stack/omega/issues/478)) — the one home
 * of every default. `options.defaults` sits above it for the cases where a
 * framework genuinely differs.
 *
 * The company file layers exactly like the brand file (shared, then its
 * targets[name] entry) minus its `brands` key, which is company plumbing that
 * means nothing inside a brand.
 *
 * Every layer is TWO files, not one
 * ([#856](https://github.com/Omega-JS-Stack/omega/issues/856)): its omega.json5
 * and the `omega.<environment>.json5` overlay beside it, which wins over its
 * OWN base and still loses to the layer above (each file keeping the
 * shared-then-targets[name] split). The environment is envEnvironment()'s
 * answer, exactly the vocabulary the `.env.<environment>` overlays are suffixed
 * with (#586), so ONE word names the config overlay, the env overlay and the
 * runtime's own environment. Only the RUNNING environment's overlay composes,
 * and a missing overlay is nothing. A file named for anything else
 * (`omega.staging.json5`) is not a layer at all, so nothing reads it and there
 * is nothing to warn about. An overlay holds only the OVERRIDES: the validator
 * judges the merged result, never an overlay on its own.
 *
 * Targets are keyed by NAME (#886): the target dir IS the name
 * (targets/community → the `community` entry), and that entry is the target
 * layer of the chain. A standalone project has no such dir, so its name is the
 * single target of that framework's type its own file declares (a deployed
 * backend staged from `api: { type: 'backend' }` is still the `api` target).
 * The caller passes the framework TYPE it runs, and a name declared with a
 * different type fails loud (see targets.js).
 *
 * "shared" = the file minus its `targets` key. A target entry may override
 * ANY shared key — same agnostic deep merge at every step (see merge.js), so
 * a per-surface Sentry DSN or analytics id is just
 * targets.<name>.monitoring.providers.sentry.dsn.
 * Target-section keys land at the TOP LEVEL of the resolved config
 * (targets.desktop.platforms resolves to config.platforms, for a target NAMED desktop); the merged
 * `targets` map itself is kept on the result purely so enabled-target
 * enumeration survives resolution — settings are never read from it.
 *
 * Secrets hard-fail: raw files are scanned BEFORE any merge — a secret in
 * any target section (requested or not) throws. Schema findings come back
 * as `errors` so callers pick their strictness (audit throws, boot warns).
 */

const fs = require('node:fs');
const path = require('node:path');
const JSON5 = require('json5');

const { deepMerge, isPlainObject } = require('./merge.js');
const { resolveCompany, recordBrand, RESOLVED_COMPANY_KEYS } = require('./company.js');
const { findSecretKeys } = require('./secrets.js');
const { validateConfig } = require('./validate.js');
const { TARGETS } = require('./schema.js');
const { schemaDefaults } = require('./defaults.js');
const { targetNameFromDir, targetUrl } = require('./targets.js');
const { pagesAddress } = require('./repo.js');

const FILE_NAME = 'omega.json5';
const SEO_FILE_NAME = 'seo.json5';
const CONFIG_LOCATIONS = [
  path.join('config', FILE_NAME),
];

// Dirs a caller can resolve FROM that are one level below the target root: a
// backend's runtime cwd (functions/) and its staged build output (dist/, where
// `omega test` runs). Both normalize up before the brand walk.
const TARGET_SUBDIRS = ['functions', 'dist'];

/**
 * Resolve the omega.json5 path for a project dir.
 * @param {string} projectDir - The project root (target root in a brand monorepo).
 * @returns {string|null} Absolute path, or null when the project has none.
 */
function resolveConfigPath(projectDir) {
  const hit = CONFIG_LOCATIONS
    .map((relative) => path.join(projectDir, relative))
    .find((absolute) => fs.existsSync(absolute));

  return hit || null;
}

/**
 * The environment an overlay chain composes for. A lane that KNOWS the
 * environment its artifact is for (a production build, a deploy stage) names it
 * ([#856](https://github.com/Omega-JS-Stack/omega/issues/856)), exactly the way
 * composeTargetEnv() already takes one for the `.env.<environment>` overlay
 * beside it (#586); anything else gets `fallback`. One vocabulary, so a name
 * outside it is a caller defect and fails loud rather than resolving to no
 * overlay at all.
 * @param {string} [environment] - The environment the caller named, or undefined.
 * @param {string|null} fallback - What an unnamed environment resolves to.
 * @returns {string|null} The environment whose overlay composes, or null for none.
 */
function resolveOverlayEnvironment(environment, fallback) {
  // lazy require: env.js depends on this module (findBrandRoot)
  const { ENV_ENVIRONMENTS } = require('./env.js');

  if (environment === undefined || environment === null) return fallback;

  if (!ENV_ENVIRONMENTS.includes(environment)) {
    throw new Error(`Unknown environment "${environment}": must be one of [${ENV_ENVIRONMENTS.join(', ')}]`);
  }

  return environment;
}

/**
 * ONE layer's environment overlay (#856): the `omega.<environment>.json5`
 * beside its own base file, the config mirror of the `.env` + `.env.<environment>`
 * pair (#586). Only ONE environment is ever asked for, so an overlay named for
 * any other word is not a layer and is never read (nothing to warn about: it is
 * simply not part of the chain).
 * @param {string|null} basePath - The layer's omega.json5 path, or null when the layer has none.
 * @param {string|null} environment - The environment whose overlay composes (one of ENV_ENVIRONMENTS), or null for none.
 * @returns {string|null} Absolute overlay path, or null when there is no overlay.
 */
function resolveOverlayPath(basePath, environment) {
  if (!basePath || !environment) return null;

  const overlay = overlayPath(basePath, environment);
  return fs.existsSync(overlay) ? overlay : null;
}

/**
 * The ONE spelling of a layer's environment overlay: `omega.<environment>.json5`
 * beside its base file, whether or not either exists. Every reader and writer
 * of an overlay names it through here.
 * @param {string} basePath - The layer's omega.json5 path.
 * @param {string} environment - One of ENV_ENVIRONMENTS.
 * @returns {string} Absolute overlay path.
 */
function overlayPath(basePath, environment) {
  return path.join(path.dirname(basePath), `${path.basename(FILE_NAME, '.json5')}.${environment}.json5`);
}

/**
 * Cheap probe: does this project have an omega.json5 at all? Frameworks use it
 * to fail soft in non-consumer dirs (seeded-empty config); tooling uses it as
 * the "is this project migrated yet?" signal. Brand-aware like loadConfig:
 * a target inside a brand monorepo has a config even when its OPTIONAL
 * local-layer file is absent (the brand file is the config) — a target-dir-only
 * probe made every framework gate fail soft with an EMPTY config there
 * (desktop audit hard-failed loud; the extension build silently baked a
 * bundle with no brand config — the cp142 rehearsal catch).
 * @param {string} projectDir
 * @returns {boolean}
 */
function hasOmegaConfig(projectDir) {
  if (resolveConfigPath(projectDir) !== null || findBrandConfigPath(projectDir) !== null) {
    return true;
  }

  // Mirror loadConfig's TARGET_SUBDIR → target-root fallback so probe and load
  // always agree — a probe-false/load-success split makes framework gates
  // proceed with an empty config (the cp142-class failure this probe exists
  // to prevent).
  return TARGET_SUBDIRS.includes(path.basename(path.resolve(projectDir)))
    && resolveConfigPath(path.dirname(path.resolve(projectDir))) !== null;
}

function readConfigFile(absolutePath) {
  try {
    return JSON5.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse ${absolutePath}: ${e.message}`);
  }
}

/**
 * The ONE spelling of the seo sidecar's path: `seo.json5` beside a base file.
 * @param {string} basePath - A base omega.json5 path.
 * @returns {string} The sidecar path beside it, whether or not it exists.
 */
function seoSidecarPath(basePath) {
  return path.join(path.dirname(basePath), SEO_FILE_NAME);
}

/**
 * The brand root's seo sidecar, whose root IS that layer's `seo` section, so it
 * merges and is judged exactly like the base.
 * @param {string|null} basePath - The brand root's omega.json5 path, or null to read none.
 * @returns {{ path: string|null, layer: object|null }} The sidecar's path and its
 *   `{ seo }` layer, both null when there is no sidecar.
 */
function readSeoSidecar(basePath) {
  const sidecarPath = basePath ? seoSidecarPath(basePath) : null;
  if (!sidecarPath || !fs.existsSync(sidecarPath)) return { path: null, layer: null };

  return { path: sidecarPath, layer: { seo: readConfigFile(sidecarPath) } };
}

/**
 * {brand}/targets/{target} → the brand root — only counts when the brand root
 * actually carries a config (a plain `targets` folder outside a brand monorepo
 * has none, so the walk-up is a no-op there). The env cascade (env.js) walks
 * the same way — this is the ONE definition of the hierarchy.
 * @param {string} projectDir - The target dir (or one of its TARGET_SUBDIRS: functions/, dist/).
 * @returns {string|null} Absolute brand root, or null outside a brand monorepo.
 */
function findBrandRoot(projectDir) {
  let targetDir = path.resolve(projectDir);

  // A backend's runtime cwd is its functions/ dir (Cloud Functions and the
  // emulator both boot there), and `omega test` resolves from the staged
  // dist/ — the target root is one level up from either. Mirrors the
  // functions/config/omega.json5 entry in CONFIG_LOCATIONS. Without dist/
  // here the walk looked for targets/ one level too low, so a brand-root .env
  // never joined the cascade
  // ([#257](https://github.com/Omega-JS-Stack/omega/issues/257)).
  if (TARGET_SUBDIRS.includes(path.basename(targetDir))) {
    targetDir = path.dirname(targetDir);
  }

  const targetsDir = path.dirname(targetDir);
  if (path.basename(targetsDir) !== 'targets') return null;

  const brandRoot = path.dirname(targetsDir);
  return fs.existsSync(path.join(brandRoot, 'config', FILE_NAME)) ? brandRoot : null;
}

/**
 * The BRAND layer's omega.json5 for a project dir — the file a target inside a
 * brand monorepo rides when it has no local-layer file of its own.
 * @param {string} projectDir - Target dir, brand root, or a TARGET_SUBDIR of one (functions/, dist/).
 * @returns {string|null} Absolute brand omega.json5 path, or null outside a brand.
 */
function findBrandConfigPath(projectDir) {
  const brandRoot = findBrandRoot(projectDir);
  return brandRoot ? path.join(brandRoot, 'config', FILE_NAME) : null;
}

/**
 * The BRAND ROOT every company question is asked from: a target resolves it
 * through its brand, a brand root (or standalone project) answers for itself.
 *
 * Same normalization as findBrandRoot: the company is named by the brand's own
 * config, never by anything inside the runtime cwd or the staged build output.
 * Reading only `functions/` left a STANDALONE project resolving from dist/ (the
 * view `omega test` loads) looking one level too low, so its company layer
 * vanished ([#257](https://github.com/Omega-JS-Stack/omega/issues/257)).
 * @param {string} projectDir - Target dir, brand root, or a TARGET_SUBDIR of one (functions/, dist/).
 * @returns {string} Absolute brand (or standalone-project) root.
 */
function companyHostRoot(projectDir) {
  let dir = path.resolve(projectDir);
  if (TARGET_SUBDIRS.includes(path.basename(dir))) dir = path.dirname(dir);

  return findBrandRoot(dir) || dir;
}

/**
 * The inheritable company layer: the company file minus `brands` — the
 * discovery roots are company plumbing and mean nothing inside a brand.
 */
function stripCompanyPlumbing(config) {
  if (!config) return null;
  const { brands, ...inheritable } = config;
  return inheritable;
}

/**
 * SEARCH upward from any directory to the nearest brand-monorepo root: the
 * first ancestor carrying an omega.json5 that is not itself a TARGET of a brand
 * above it (target rule = findBrandRoot's: directly under a targets/ dir with a
 * brand-level config/omega.json5 one level above — so a brand living inside
 * some larger workspace's targets/ folder still resolves as a brand root).
 *
 * Complements findBrandRoot, which CLASSIFIES one target dir (target → its brand,
 * else null): resolveBrandRoot works from anywhere in the tree — the brand
 * root itself, targets/{target}, targets/{target}/functions, or any subdirectory — and a
 * standalone config-carrying project resolves to itself.
 *
 * The walk is BOUNDED at the nearest `.git` (that directory is still checked
 * first — a brand root is normally its own git root): past the repo boundary
 * is somebody else's tree, never this project's brand. The plugin's inject
 * hook bounds its identical walk the same way.
 *
 * @param {string} startDir - Any directory inside the project tree
 * @returns {string|null} Absolute brand (or standalone-project) root, or null
 *   when no omega.json5 exists anywhere up the tree.
 */
function resolveBrandRoot(startDir) {
  let dir = path.resolve(startDir);

  while (true) {
    // A backend's functions/ dir carries the target's config (functions/config/)
    // but is never a root itself — its target dir one level up is. Its staged
    // dist/ carries the same compose output and is no more a root than
    // functions/ is ([#299](https://github.com/Omega-JS-Stack/omega/issues/299)).
    if (!TARGET_SUBDIRS.includes(path.basename(dir)) && resolveConfigPath(dir)) {
      const grandparent = path.dirname(path.dirname(dir));
      // `apps` here is DETECTION, not compatibility: a pre-#443 brand must
      // resolve to its TRUE root so discovery fails loud with the
      // targets-rename pointer. Stopping at a config-carrying target dir
      // would instead load that target AS the brand — and let the migration
      // itself no-op when run from inside one.
      const parentName = path.basename(path.dirname(dir));
      const isTargetOfBrand = (parentName === 'targets' || parentName === 'apps')
        && fs.existsSync(path.join(grandparent, 'config', FILE_NAME));

      if (!isTargetOfBrand) {
        return dir;
      }
    }

    // Repo boundary — stop here rather than statting out through the host
    // filesystem to /.
    if (fs.existsSync(path.join(dir, '.git'))) return null;

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function stripTargets(config) {
  if (!config) return null;
  const { targets, ...shared } = config;
  return shared;
}

/**
 * The company keys nobody types, refused where a human writes them: the BRAND
 * file and the COMPANY file (#677). The local layer is deliberately exempt,
 * because a target's `config/omega.json5` may be a staged compose output, which
 * carries the RESOLVED facts on purpose (the deployed runtime has no registry
 * and no company tree to re-resolve them from).
 * @param {string|null} file - The layer's path, for the message.
 * @param {object|null} data - The parsed layer.
 */
function assertNoTypedCompany(file, data) {
  if (!data || !isPlainObject(data.company)) return;

  const typed = RESOLVED_COMPANY_KEYS.filter((key) => data.company[key] !== undefined);
  if (typed.length) {
    throw new Error(`${typed.map((key) => `company.${key}`).join(', ')} in ${file} is resolved from the company, delete it (#677): the brand types company: { id: '<parent brand.id>' } (or 'self') and the loader fills the rest`);
  }
}

/**
 * Raw-file hard fails, applied BEFORE any merge: secrets anywhere in the
 * file (requested target or not) and the legacy targets ARRAY (it would
 * silently mangle into {0: 'web', …} through the merge).
 */
function assertUsableRawFile(file, data) {
  if (!data) return;

  const secrets = findSecretKeys(data);
  if (secrets.length) {
    throw new Error(`Secret-shaped keys in ${file} — secrets live in .env, never in ${FILE_NAME}: ${secrets.join(', ')}`);
  }

  if (data.targets !== undefined && !isPlainObject(data.targets)) {
    throw new Error(`targets in ${file} must be an object keyed by target name (key presence = enabled) — the legacy array form is not valid ${FILE_NAME}`);
  }
}

/**
 * Each layer's environment overlay and the brand root's seo sidecar (the brand
 * slot from a target, the local slot with no brand above), then the raw-file
 * gate every one of those files passes. ONE copy for both readers of the
 * chain: an overlay or a sidecar meets the SAME hard fails as its base, so the
 * gate is one block that cannot drift.
 * @param {object} options - Each layer's base path (`companyPath`, `brandPath`,
 *   `localPath`) and parsed file, and the `environment` the overlays are FOR (null reads none).
 * @returns {{ companyOverlay: object|null, brandOverlay: object|null, localOverlay: object|null, brandSeo: object|null, localSeo: object|null }}
 *   Each layer's overlay and `{ seo }` sidecar layer, or null where it has none.
 */
function resolveLayerFiles({ companyPath, company, brandPath, brand, localPath, local, environment }) {
  const companyOverlayPath = resolveOverlayPath(companyPath, environment);
  const brandOverlayPath = resolveOverlayPath(brandPath, environment);
  const localOverlayPath = resolveOverlayPath(localPath, environment);

  const companyOverlay = companyOverlayPath ? readConfigFile(companyOverlayPath) : null;
  const brandOverlay = brandOverlayPath ? readConfigFile(brandOverlayPath) : null;
  const localOverlay = localOverlayPath ? readConfigFile(localOverlayPath) : null;
  // The sidecar is the brand root's file only: a target reads it as the brand
  // layer, and the local layer reads it only where there is no brand above.
  const brandSeo = readSeoSidecar(brandPath);
  const localSeo = readSeoSidecar(brandPath ? null : localPath);

  assertUsableRawFile(companyPath, company);
  assertUsableRawFile(brandPath, brand);
  assertUsableRawFile(localPath, local);
  assertUsableRawFile(brandSeo.path, brandSeo.layer);
  assertUsableRawFile(localSeo.path, localSeo.layer);
  assertUsableRawFile(companyOverlayPath, companyOverlay);
  assertUsableRawFile(brandOverlayPath, brandOverlay);
  assertUsableRawFile(localOverlayPath, localOverlay);
  assertNoTypedCompany(companyPath, company);
  assertNoTypedCompany(brandPath, brand);
  assertNoTypedCompany(companyOverlayPath, companyOverlay);
  assertNoTypedCompany(brandOverlayPath, brandOverlay);

  return { companyOverlay, brandOverlay, localOverlay, brandSeo: brandSeo.layer, localSeo: localSeo.layer };
}

/**
 * WHICH target a STANDALONE project is (no brand root above it, so no dir to
 * read the name off): the single declared target of the framework's type, else
 * the type word. A deployed backend staged from `api: { type: 'backend' }` is
 * the `api` target, so its entry is the target layer, `enabled` is true and its
 * url derives, exactly as it does inside the brand it was staged from. Two
 * targets of one type have no single answer, so the type word stands.
 * @param {object} targets - The merged targets map.
 * @param {string} target - The framework type this project runs.
 * @returns {string} The target name.
 */
function standaloneTargetName(targets, target) {
  const matches = Object.keys(targets || {})
    .filter((name) => isPlainObject(targets[name]) && targets[name].type === target);

  return matches.length === 1 ? matches[0] : target;
}

/**
 * ONE layer's contribution to a target's config: its `targets.<name>` entry,
 * or null when that layer says nothing about this target. Every merge chain
 * (loadConfig and composeTargetConfig alike) folds the layers through this.
 * @param {object|null} layer - A raw config layer (company, brand, or local).
 * @param {string|null} name - The resolved target name.
 * @returns {object|null} The target layer, or null.
 */
function targetLayerOf(layer, name) {
  return layer && layer.targets && isPlainObject(layer.targets[name]) ? layer.targets[name] : null;
}

/**
 * Enabled targets of a config (raw or resolved): the keys of its `targets`
 * object — key presence IS the enablement signal.
 * @param {object} config
 * @returns {string[]}
 */
function getEnabledTargets(config) {
  const targets = config ? config.targets : undefined;
  return targets && typeof targets === 'object' ? Object.keys(targets) : [];
}

/**
 * The RESOLVED `company` section: the same keys the consumer typed (`{ id }`,
 * and `{ webhooks }` when the brand opts out), filled with the company's public
 * facts (#677). A brand with no company resolves to its OWN name and url under
 * a null id, so no reader anywhere needs a fallback.
 * @param {string} hostRoot - The brand root the company is named from.
 * @param {object} config - The merged config (its `company` and `brand` blocks).
 * @returns {{ id: string|null, name: string|null, url: string|null, images: object, webhooks: boolean }}
 */
function companyFacts(hostRoot, config) {
  const { id, name, url, images, webhooks } = resolveCompany(hostRoot, config);

  return { id, name, url, images, webhooks };
}

/**
 * Fill an unset `brand.url` with the `web` target's default Pages address:
 * a brand with no domain of its own writes nothing (or nulls a declared one
 * out) and every reader still gets a real url. Mutates the merged config.
 * @param {object} config - The merged config (its `brand` and `repo` blocks).
 * @param {object} targets - The merged `targets` map, every entry whole.
 * @returns {boolean} Whether `brand.url` was filled.
 */
function fillPagesBrandUrl(config, targets) {
  if (config.brand && config.brand.url) return false;

  const entry = isPlainObject(targets) ? targets.web : null;
  if (!isPlainObject(entry) || entry.type !== 'web') return false;

  const address = pagesAddress({ ...config, targets }, 'web');
  if (!address) return false;

  // pagesAddress resolved, so brand.id did and config.brand exists
  config.brand.url = address;
  return true;
}

/**
 * Load + resolve a project's omega.json5.
 * @param {string} projectDir - The project root (target root in a brand monorepo).
 * @param {string} [target] - The framework TYPE this project runs ('web',
 *   'backend', ...). When given, the target sections overlay the shared
 *   namespace. When omitted, the brand + local files merge whole (targets map
 *   included): the shape tools like omega-manager's disperse want.
 * @param {object} [options]
 * @param {object} [options.defaults] - Framework defaults, layered directly on
 *   top of the schema defaults (#478) — only what this framework does differently.
 * @param {string} [options.environment] - The environment this load is FOR (one
 *   of ENV_ENVIRONMENTS): which `omega.<environment>.json5` overlay composes
 *   ([#856](https://github.com/Omega-JS-Stack/omega/issues/856)). Every lane
 *   that produces a PRODUCTION artifact names it, the way stageFunctions()
 *   already names one for the `.env` overlay beside it (#586), because the
 *   ambient answer is the composing machine's and a build from a terminal
 *   resolves `development`. Omitted (a dev boot, a deployed runtime) = the
 *   running environment, envEnvironment().
 * @param {boolean} [options.record] - `false` skips the brand's line in the
 *   machine registry, for a caller that writes nothing (`omega status`).
 * @returns {{ config: object, errors: string[], warnings: string[], enabled: boolean|null, name: string|null, files: { local: string, brand: string|null, company: string|null } }}
 *   `enabled` = whether the resolved NAME is listed under `targets` (null when
 *   no target was requested); schema `errors` are returned, not thrown; only
 *   secrets and unusable files throw. `warnings` are advisory findings (e.g. >1
 *   backend target); `name` is the target-dir-resolved target name (for a
 *   standalone project, the single declared target of that type, else the type
 *   word; null when no target was requested).
 */
function loadConfig(projectDir, target, options) {
  options = options || {};

  if (target && !TARGETS.includes(target)) {
    throw new Error(`Unknown target "${target}" — must be one of [${TARGETS.join(', ')}]`);
  }

  // From a TARGET_SUBDIR (functions/, dist/) the local layer is its own
  // config/omega.json5 (the STAGED compose — the deployed runtime's view).
  // Before any stage exists, fall back to the target root's authored file one
  // level up, so a bare emulator/loadConfig from the functions cwd — or a test
  // run resolving from the not-yet-staged dist/ — sees the same layers the
  // stage would compose.
  let localPath = resolveConfigPath(projectDir);
  if (!localPath && TARGET_SUBDIRS.includes(path.basename(path.resolve(projectDir)))) {
    localPath = resolveConfigPath(path.dirname(path.resolve(projectDir)));
  }
  const brandPath = findBrandConfigPath(projectDir);

  // The local-layer file is OPTIONAL inside a brand monorepo (Ian 2026-07-13:
  // the brand file's targets section IS the per-target home) — a target with
  // no omega.json5 of its own rides the brand file alone. Standalone
  // projects (no brand config above) still require their own file.
  if (!localPath && !brandPath) {
    throw new Error(`No ${FILE_NAME} found under ${projectDir} (looked in ${CONFIG_LOCATIONS.join(', ')}) — probe with hasOmegaConfig() first; legacy configs must be migrated (see docs/shared/config.md)`);
  }

  const local = localPath ? readConfigFile(localPath) : {};
  const brand = brandPath ? readConfigFile(brandPath) : null;

  // The company layer comes from the brand's typed `company: { id }` through the
  // ONE resolver (#677), which also answers for a runner that received a
  // generated layer instead of a machine to resolve on.
  const company = resolveCompany(companyHostRoot(projectDir), brand || local);
  const companyPath = company.configFile;

  // Each layer's environment overlay (#856), found beside its own base file.
  // The environment is the one the CALLER named when it named one (a lane that
  // knows what its artifact is FOR), else this machine's ambient answer, which
  // is what a dev boot and a deployed runtime both want.
  // lazy require: env.js depends on this module (findBrandRoot)
  const { envEnvironment } = require('./env.js');
  const environment = resolveOverlayEnvironment(options.environment, envEnvironment());
  const { companyOverlay, brandOverlay, localOverlay, brandSeo, localSeo } = resolveLayerFiles({
    companyPath, company: company.config, brandPath, brand, localPath, local, environment,
  });

  const inherited = stripCompanyPlumbing(company.config);

  // ─── Resolve ─────────────────────────────────────────────────────────────
  // The chain, weakest first: every layer's base file, the brand root's seo
  // sidecar in its slot, then its overlay, which beats both and loses to the
  // layer above. Each entry contributes shared, then targets[name], below.
  const layers = [
    inherited,
    stripCompanyPlumbing(companyOverlay),
    brand,
    brandSeo,
    brandOverlay,
    local,
    localSeo,
    localOverlay,
  ];

  const hasTargets = layers.some((layer) => !!(layer && layer.targets));
  const targets = deepMerge(...layers.map((layer) => (layer ? layer.targets : null)));

  // WHICH target this is comes from its dir name (#886): targets/community is
  // the `community` entry. Only brand-monorepo targets resolve through the
  // walk: a standalone project's dir name is arbitrary, so it is named by what
  // its own file declares for the framework it runs.
  const name = target ? (targetNameFromDir(projectDir) || standaloneTargetName(targets, target)) : null;

  // A dir whose entry runs a DIFFERENT framework has no honest resolution: the
  // caller would silently merge somebody else's target layer.
  const declared = name ? targets[name] : null;
  if (target && declared && declared.type && declared.type !== target) {
    throw new Error(`targets.${name} is type ${declared.type}; this project runs the ${target} framework`);
  }

  const config = target
    ? deepMerge(
        schemaDefaults(target),
        options.defaults,
        ...layers.flatMap((layer) => [stripTargets(layer), targetLayerOf(layer, name)]),
      )
    : deepMerge(schemaDefaults(), options.defaults, ...layers);

  // Keep the merged targets map on the resolved config (presence = enabled)
  if (target && hasTargets) {
    config.targets = targets;
  }

  const filledBrandUrl = fillPagesBrandUrl(config, targets);

  // The target's own public URL (#588): an entry's explicit `url` already
  // merged to the top level above, and a bare `community: { type: 'web' }`
  // derives https://community.<brand host> through the ONE resolver, landing in
  // that same place, so every reader of the resolved config (site-global's
  // site.url, the web deploy's host + CNAME) sees THIS target's url and not the
  // main site's. A target named for its type derives nothing: brand.url IS its
  // url.
  //
  // A brand.url OVERRIDE that reached this target (the entry's own `brand.url`,
  // the target dir's local layer, a dev layer pointing at localhost) IS the
  // target url already, never a base to stack the name on: deriving there gave
  // shop.shop.acme.test and https://admin.localhost:4000. The test is whether
  // the resolved brand.url still equals the BRAND layer's.
  if (target && name !== target && !config.url) {
    // A layer's environment overlay IS that layer's statement of brand.url
    // (#856), so a development brand.url is a brand-layer value like any
    // other: the targets under it keep deriving their own names off it.
    // A filled Pages address IS the brand layer's url: no layer stated one.
    const brandLayerUrl = (filledBrandUrl ? config.brand.url : null)
      || (brandOverlay && brandOverlay.brand && brandOverlay.brand.url)
      || (brand && brand.brand && brand.brand.url)
      || (companyOverlay && companyOverlay.brand && companyOverlay.brand.url)
      || (inherited && inherited.brand && inherited.brand.url)
      // A standalone project has no brand layer above it, so its OWN shared
      // brand.url IS the brand's: only a target entry below it overrides.
      || (!brandPath && localOverlay && localOverlay.brand ? localOverlay.brand.url : null)
      || (!brandPath && local.brand ? local.brand.url : null)
      || null;
    const resolvedUrl = (config.brand && config.brand.url) || null;

    const resolvedTargetUrl = resolvedUrl && resolvedUrl !== brandLayerUrl
      ? resolvedUrl
      : targetUrl(config, name);

    if (resolvedTargetUrl) {
      config.url = resolvedTargetUrl;
    }
  }

  const enabled = target
    ? hasTargets && Object.prototype.hasOwnProperty.call(targets, name)
    : null;

  const { errors, warnings } = validateConfig(config, { target });

  // The `company` section is RESOLVED, never typed past its `id` (#677): the
  // same key the consumer wrote comes back filled, so every reader of a parent
  // fact (the footer's credit, an email wordmark, the in-house ads api) reads
  // one shape whether the brand has a company, IS one, or stands alone. Filled
  // AFTER validation, so a typed name/url/images is still the author's key when
  // the validator judges it.
  config.company = companyFacts(companyHostRoot(projectDir), config);

  // Every brand run writes its own line in the machine registry, which is what
  // makes a sibling brand's `company: { id }` resolvable here without anyone
  // maintaining a map (#677). Never fails the load.
  if (options.record !== false) {
    recordBrand({
      id: config.brand && config.brand.id,
      root: companyHostRoot(projectDir),
      name: config.brand && config.brand.name,
      url: config.brand && config.brand.url,
    });
  }

  return { config, errors, warnings, enabled, name, files: { local: localPath, brand: brandPath, company: companyPath } };
}

/**
 * Compose the company+brand+local layers into ONE self-contained config file for
 * a target's deploy upload (friction #31). The runtime's brand walk-up dies at
 * the upload boundary — `firebase deploy` ships only the functions folder —
 * so the staged file must carry the layers above it itself. The target's full
 * interleave (company shared ← company targets[target] ← brand shared ← brand
 * targets[target] ← local shared ← local targets[target]) is frozen into the
 * shared namespace: the deployed
 * runtime's own `deepMerge(defaults, shared, targets[name])` then yields
 * EXACTLY the local resolution. `targets` keeps presence-and-type keys
 * (presence = enabled, and the `type` every entry must declare; every other
 * value is already folded in, so nothing re-applies above the frozen
 * interleave: a raw merged targets map would let a brand-target value beat a
 * local-shared one, flipping the chain).
 * Framework defaults are NOT baked in: the deployed runtime applies its
 * own, so defaults evolve with the shipped package, not the deploy moment.
 *
 * Environment overlays (#856) compose only for an environment the CALLER named:
 * a compose is a BUILD-time op over the authored layers, and the environment an
 * artifact is FOR is the LANE's answer, never the composing machine's (`omega
 * deploy` from a terminal resolves `development`, which would bake a
 * development override into a production upload). So the ambient answer is
 * never read here, and a compose told nothing freezes the base layers alone.
 * The knob is the one stageFunctions() already takes for the `.env` overlay
 * beside it, spelled the same: `options.environment`.
 *
 * The local-layer file is OPTIONAL inside a brand monorepo (same rule as
 * loadConfig since cp121c): a target with no omega.json5 of its own composes
 * from the brand file alone. Standalone projects still require their file.
 *
 * @param {string} projectDir - Target root or one of its TARGET_SUBDIRS (functions/, dist/).
 * @param {string} target - Canonical target the upload serves ('backend').
 * @param {object} [options]
 * @param {string} [options.environment] - The environment the upload is FOR (one
 *   of ENV_ENVIRONMENTS): which `omega.<environment>.json5` overlay is frozen
 *   into the composed file. Omitted = no overlay at all.
 * @returns {{ config: object, files: { local: string|null, brand: string|null, company: string|null } }}
 *   `files.brand` null = no brand layer above the target (already self-contained);
 *   `files.local` null = the target rides the brand file alone; `files.company`
 *   null = the brand names no company with a tree on this machine.
 */
function composeTargetConfig(projectDir, target, options) {
  options = options || {};

  if (!TARGETS.includes(target)) {
    throw new Error(`Unknown target "${target}" — must be one of [${TARGETS.join(', ')}]`);
  }

  // No fallback: an unnamed environment composes NO overlay (see above).
  const environment = resolveOverlayEnvironment(options.environment, null);

  // Compose is a BUILD-time op over the AUTHORED layers: a TARGET_SUBDIR
  // (functions/, dist/) normalizes up to its target root, so a previously-staged
  // config/omega.json5 (compose OUTPUT) can never read back in as a local
  // layer — that would freeze brand edits behind the last stage.
  let targetRoot = path.resolve(projectDir);
  if (TARGET_SUBDIRS.includes(path.basename(targetRoot))) {
    targetRoot = path.dirname(targetRoot);
  }

  const localPath = resolveConfigPath(targetRoot);
  const brandPath = findBrandConfigPath(targetRoot);
  if (!localPath && !brandPath) {
    throw new Error(`No ${FILE_NAME} found under ${projectDir} (looked in ${CONFIG_LOCATIONS.join(', ')})`);
  }

  const local = localPath ? readConfigFile(localPath) : {};
  const brand = brandPath ? readConfigFile(brandPath) : null;

  const company = resolveCompany(companyHostRoot(targetRoot), brand || local);
  const companyPath = company.configFile;

  // Each layer's overlay for THIS environment and the brand root's seo sidecar,
  // read and gated by the same one helper loadConfig uses.
  const { companyOverlay, brandOverlay, localOverlay, brandSeo, localSeo } = resolveLayerFiles({
    companyPath, company: company.config, brandPath, brand, localPath, local, environment,
  });

  const inherited = stripCompanyPlumbing(company.config);
  const inheritedOverlay = stripCompanyPlumbing(companyOverlay);

  // The chain, weakest first: every layer's base file, the brand root's seo
  // sidecar in its slot, then its environment overlay, exactly the order
  // loadConfig folds them in.
  const layers = [inherited, inheritedOverlay, brand, brandSeo, brandOverlay, local, localSeo, localOverlay];

  // Same collapse as loadConfig: the target dir NAMES the entry that is this
  // compose's target layer (outside a brand, the file's single target of this
  // framework's type).

  const mergedTargets = deepMerge(...layers.map((layer) => (layer ? layer.targets : null)));
  const name = targetNameFromDir(targetRoot) || standaloneTargetName(mergedTargets, target);

  const config = deepMerge(
    ...layers.flatMap((layer) => [stripTargets(layer), targetLayerOf(layer, name)]),
  );

  const hasTargets = layers.some((layer) => !!(layer && layer.targets));
  if (hasTargets) {
    config.targets = Object.fromEntries(Object.keys(mergedTargets).map((entryName) => {
      const entry = mergedTargets[entryName];
      return [entryName, isPlainObject(entry) && entry.type ? { type: entry.type } : {}];
    }));
  }

  fillPagesBrandUrl(config, mergedTargets);

  // The resolved company rides the upload like every other layer above it: the
  // deployed runtime has no registry and no company tree, so the facts have to
  // be frozen in here (#677).
  config.company = companyFacts(companyHostRoot(targetRoot), config);

  return { config, files: { local: localPath, brand: brandPath, company: companyPath } };
}

module.exports = { loadConfig, composeTargetConfig, hasOmegaConfig, resolveConfigPath, overlayPath, seoSidecarPath, getEnabledTargets, findBrandRoot, findBrandConfigPath, resolveBrandRoot, FILE_NAME, CONFIG_LOCATIONS, TARGET_SUBDIRS };
