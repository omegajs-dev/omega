/**
 * Health-check implementations for the testing service — omega-manager's
 * target-checks helpers rebuilt for brand monorepos. Local checks read the
 * repo; live checks fetch the deployed site/API and shell out to npm/gh.
 *
 * Every check records into a shared recorder whose results shape matches
 * RunSummary's drill-down: passed = [name], warned = [{ name, warning }],
 * failed = [{ name, error }]. Dim notes and dry-run "would" lines are
 * display-only — they never enter the results.
 *
 * Injection seams (all via context.options — they ride runManage options so
 * the full-loop tests stay network-free): options.fetch, options.exec,
 * options.retryDelayMs.
 */

const fs = require('node:fs');
const { execSync } = require('node:child_process');
const path = require('node:path');
const chalk = require('chalk').default;
const jetpack = require('fs-jetpack');

const { sourceRepo, targetUrl, hasLogoSources, BRANDMARK_PNG_DEST, apiAddress, defaultAddressReason, targetType } = require('@omega.js/config');
const { recordDeploy, readDeployRecord } = require('@omega.js/devkit/deploy-record');
const { resolvePackageRealDir } = require('@omega.js/devkit/local');

const MAX_RETRIES = 3;
const MAX_FILES_SHOWN = 10;

// Mirrors @omega.js/backend: the API sits at apiAddress (api.<host> on an owned
// host, the project's omega_api functions url on a default Pages host) and
// mounts its routes under /omega (packages/backend route prefix)
const API_HEALTH_PATH = '/omega/health';

// The identity files a deployed site serves from the brand's minted set: the
// root favicon browsers probe with no link tag, and the bridged raster brandmark.
const BRAND_ASSET_PATHS = ['/favicon.ico', `/${BRANDMARK_PNG_DEST}`];

const FETCH_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'User-Agent': 'OmegaManager/1.0 HealthCheck',
};

/**
 * Create the shared check recorder. Prints each check as it lands and
 * accumulates the results arrays the handler returns.
 *
 * @returns {Object} - { pass, warn, fail, note, would, results, counts }
 */
function createRecorder() {
  const passed = [];
  const warned = [];
  const failed = [];

  return {
    pass(name, detail) {
      passed.push(name);
      console.log(`      ${chalk.green('✓')} ${name}${detail ? chalk.dim(`: ${detail}`) : ''}`);
    },
    warn(name, warning) {
      warned.push({ name, warning });
      console.log(`      ${chalk.yellow('⚠')} ${name}${warning ? `: ${chalk.yellow(warning)}` : ''}`);
    },
    fail(name, error) {
      failed.push({ name, error });
      console.log(`      ${chalk.red('✗')} ${name}${error ? `: ${chalk.red(error)}` : ''}`);
    },
    // Display-only informational line (check not applicable / not verifiable)
    note(name, detail) {
      console.log(`      ${chalk.dim(`– ${name}${detail ? `: ${detail}` : ''}`)}`);
    },
    // Display-only dry-run line for a skipped remote action
    would(action) {
      console.log(`      ${chalk.yellow('⊘')} would ${action} ${chalk.dim('[DRY RUN]')}`);
    },
    results() {
      return { passed, warned, failed };
    },
    counts() {
      return { passed: passed.length, warned: warned.length, failed: failed.length };
    },
  };
}

/**
 * Default exec — thin execSync wrapper so tests can inject a recording fake
 * with the same (command, options) → stdout surface.
 */
function defaultExec(command, options = {}) {
  return execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

/**
 * Fetch with retry — retries network errors AND non-2xx/3xx statuses with a
 * linear backoff (delayMs, 2×delayMs, …), returning the last response either
 * way. Success (2xx/3xx) returns immediately.
 *
 * @param {Object} ctx - Check context ({ fetchImpl, retryDelayMs })
 * @param {string} url - URL to fetch
 * @returns {Object} - { response, duration } or { error } after all retries
 */
async function fetchWithRetry(ctx, url) {
  let last = { error: 'unreachable' };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const start = Date.now();
      const response = await ctx.fetchImpl(url, { headers: FETCH_HEADERS, redirect: 'follow' });
      last = { response, duration: Date.now() - start };

      if (response.status >= 200 && response.status < 400) {
        return last;
      }
    } catch (error) {
      // Node's fetch wraps network errors ("fetch failed") — the cause has
      // the useful message (getaddrinfo ENOTFOUND, ECONNREFUSED, …)
      last = { error: error.cause?.message || error.message };
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, ctx.retryDelayMs * attempt));
    }
  }

  return last;
}

/**
 * npm latest version of a package, cached per run. null when the registry
 * lookup fails (unpublished package, offline) — callers dim out, never warn.
 */
function getLatestVersion(ctx, packageName) {
  if (!(packageName in ctx.versionCache)) {
    try {
      ctx.versionCache[packageName] = ctx.exec(`npm view ${packageName} version`).trim();
    } catch {
      ctx.versionCache[packageName] = null;
    }
  }
  return ctx.versionCache[packageName];
}

/**
 * Compare two x.y.z versions numerically. -1 / 0 / 1.
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

/**
 * Resolve the INSTALLED version of a package via devkit's one node_modules
 * walk from a directory: handles file:/workspace refs where the declared
 * range says nothing. null when not installed.
 */
function installedVersion(fromDir, packageName) {
  const dir = resolvePackageRealDir(packageName, fromDir);
  if (!dir) return null;

  return jetpack.read(path.join(dir, 'package.json'), 'json').version || null;
}

// ── Local checks ────────────────────────────────────────────────────────────

/**
 * Per-target file checks: package.json parses; web targets produced a build;
 * backend targets have their Firebase scaffolding.
 */
function checkTargetFiles(recorder, entry) {
  const pkg = jetpack.read(path.join(entry.path, 'package.json'), 'json');
  if (pkg) {
    recorder.pass(`${entry.name}: package.json`);
  } else {
    recorder.fail(`${entry.name}: package.json`, 'missing or unparseable');
  }

  if (entry.target === 'web') {
    if (fs.existsSync(path.join(entry.path, 'dist', 'index.html'))) {
      recorder.pass(`${entry.name}: build output`);
    } else {
      recorder.fail(`${entry.name}: build output`, 'dist/index.html missing — run the update service');
    }
  }

  if (entry.target === 'backend') {
    // A custom-server backend (#584) deploys no Cloud Functions, so it has no
    // firebase.json to carry — the ONE Firebase-only check here, noted rather
    // than failed. The staged build below is checked in both modes.
    if (entry.projectType === 'custom') {
      recorder.note(`${entry.name}: firebase.json`, "skipped — projectType: 'custom' deploys no Cloud Functions");
    } else if (fs.existsSync(path.join(entry.path, 'firebase.json'))) {
      recorder.pass(`${entry.name}: firebase.json`);
    } else {
      recorder.fail(`${entry.name}: firebase.json`, 'missing');
    }
    // Staged output (src/dist pillar) — the backend's build-output twin of
    // web's dist/index.html check
    if (fs.existsSync(path.join(entry.path, 'dist', 'package.json'))) {
      recorder.pass(`${entry.name}: staged dist/`);
    } else {
      recorder.fail(`${entry.name}: staged dist/`, 'dist/package.json missing — run the update service (omega build)');
    }
  }
}

/**
 * Framework version check: the target's installed framework package vs the npm
 * latest. Silent when the target doesn't declare its framework;
 * dims out when the registry lookup fails (e.g. package not published yet).
 */
function checkFrameworkVersion(recorder, entry, ctx) {
  const framework = targetType(entry.target)?.framework;
  if (!framework) return;

  // Deps live on the ONE manifest per target (src/dist pillar)
  const pkgDir = entry.path;
  const pkg = jetpack.read(path.join(pkgDir, 'package.json'), 'json');
  const declared = pkg?.dependencies?.[framework] || pkg?.devDependencies?.[framework];
  if (!declared) return;

  const installed = installedVersion(pkgDir, framework) || declared.replace(/^[\^~>=<]+/, '');
  const name = `${entry.name}: ${framework}`;

  if (!/^\d/.test(installed)) {
    recorder.note(name, `${installed} (not installed — run the update service)`);
    return;
  }

  if (ctx.dryRun) {
    recorder.would(`npm view ${framework} version`);
    return;
  }

  const latest = getLatestVersion(ctx, framework);

  if (!latest) {
    recorder.note(name, `${installed} (could not check latest)`);
  } else if (compareVersions(installed, latest) >= 0) {
    recorder.pass(name, `${installed} (latest: ${latest})`);
  } else {
    recorder.warn(name, `outdated (${installed} → ${latest})`);
  }
}

/**
 * Parse `git status --porcelain` output into { status, file } entries.
 * Lines must NOT be trimmed before slicing — the two status columns can
 * legitimately start with a space (` M path`), so a leading trim shifts
 * the path offset and eats the first character.
 * @param {string} stdout - raw porcelain output
 * @returns {Array<{ status: string, file: string }>}
 */
function parseWorkingTree(stdout) {
  return stdout.split('\n').filter((line) => line.trim()).map((line) => ({
    status: line.substring(0, 2).trim(),
    file: line.substring(3),
  }));
}

/**
 * Working tree check — uncommitted files under the brand root (scoped with
 * `-- .` so a brand nested in a larger workspace only sees its own files).
 * Silent when the brand isn't in a git repository.
 */
function checkWorkingTree(recorder, ctx) {
  let stdout;
  try {
    stdout = ctx.exec('git status --porcelain -- .', { cwd: ctx.brandRoot });
  } catch {
    return;
  }

  const files = parseWorkingTree(stdout);

  if (files.length === 0) {
    recorder.pass('working tree', 'clean');
    return;
  }

  recorder.warn('working tree', `${files.length} uncommitted file${files.length === 1 ? '' : 's'}`);
  for (const { status, file } of files.slice(0, MAX_FILES_SHOWN)) {
    console.log(`        ${chalk.dim(status)} ${chalk.dim(file)}`);
  }
  if (files.length > MAX_FILES_SHOWN) {
    console.log(`        ${chalk.dim(`... and ${files.length - MAX_FILES_SHOWN} more`)}`);
  }
}

// ── Live checks ─────────────────────────────────────────────────────────────

/**
 * Homepage check: the deployed site answers on ITS OWN url, which the target
 * NAME resolves (#886) through the one derivation (`targetUrl`): the entry's
 * url, else the name AS a subdomain of the brand host (#588), else the brand
 * url for a target named for its type. Deploy records key per name too, so a
 * never-deployed admin target nudges without failing a live web.
 * @returns {Promise<boolean>} Whether the site answered live.
 */
async function checkHomepage(recorder, entry, ctx) {
  const url = targetUrl(ctx.brandConfig, entry.name);
  const name = `${entry.name}: homepage`;

  if (!url) {
    recorder.warn(name, 'no brand.url configured — cannot check');
    return false;
  }

  if (ctx.dryRun) {
    recorder.would(`fetch ${url}`);
    return false;
  }

  // No deploy record → a live miss means "not deployed yet", not an outage
  // (never-deployed vs deployed-but-down — Ian 2026-07-17). A live HIT on a
  // record-less brand adopts: the record is per-machine, so fresh clones of
  // deployed brands self-heal here.
  const deployed = readDeployRecord({ dir: ctx.brandRoot, target: entry.name });
  const { response, duration, error } = await fetchWithRetry(ctx, url);
  const live = !error && response.status >= 200 && response.status < 400;

  if (live) {
    recorder.pass(name, `${url} → ${response.status} (${duration}ms)`);
    if (!deployed) {
      recordDeploy({ dir: ctx.brandRoot, target: entry.name, detail: { adopted: true } });
    }
  } else if (!deployed) {
    recorder.warn(name, `not deployed yet — run \`omega deploy\` when ready (${url})`);
  } else {
    recorder.fail(name, `${url} → ${error || response.status}`);
  }

  return live;
}

/**
 * Brand-asset check: a deployed site whose brand has logo sources serves its
 * minted identity, so a snapshot that left the set behind fails here naming the
 * URL instead of shipping a site with no logo. Runs once the homepage is live;
 * a dry run lists the probes.
 */
async function checkBrandAssets(recorder, entry, ctx) {
  if (!hasLogoSources(ctx.brandRoot)) return;

  const base = targetUrl(ctx.brandConfig, entry.name);
  if (!base) return;

  for (const assetPath of BRAND_ASSET_PATHS) {
    const url = `${base.replace(/\/+$/, '')}${assetPath}`;
    const name = `${entry.name}: ${assetPath}`;

    if (ctx.dryRun) {
      recorder.would(`fetch ${url}`);
      continue;
    }

    const { response, duration, error } = await fetchWithRetry(ctx, url);
    if (!error && response.status >= 200 && response.status < 400) {
      recorder.pass(name, `${url} → ${response.status} (${duration}ms)`);
    } else {
      recorder.fail(name, `${url} → ${error || response.status}`);
    }
  }
}

/**
 * API health check — the deployed backend answers on
 * {apiAddress}{API_HEALTH_PATH}, plus a deployed-version comparison
 * from the health payload. Skipped for shared Firebase projects (the owning
 * brand deploys the backend).
 */
async function checkApiHealth(recorder, entry, ctx) {
  const name = `${entry.name}: API health`;

  if (ctx.brandConfig.cloud?.shared === true) {
    recorder.note(name, 'shared Firebase project (owning brand deploys the backend)');
    return;
  }

  const baseUrl = ctx.brandConfig.brand?.url;
  if (!baseUrl) {
    recorder.warn(name, 'no brand.url configured — cannot check');
    return;
  }

  const api = apiAddress(baseUrl, ctx.brandConfig.cloud?.config?.projectId);
  if (!api) {
    recorder.note(name, defaultAddressReason(baseUrl));
    return;
  }
  const apiUrl = `${api}${API_HEALTH_PATH}`;

  if (ctx.dryRun) {
    recorder.would(`fetch ${apiUrl}`);
    return;
  }

  // Same never-deployed vs deployed-but-down split as checkHomepage
  const deployRecord = readDeployRecord({ dir: ctx.brandRoot, target: entry.name });
  const { response, duration, error } = await fetchWithRetry(ctx, apiUrl);
  const live = !error && response.status >= 200 && response.status < 400;

  if (!live) {
    if (!deployRecord) {
      recorder.warn(name, `not deployed yet — run \`omega deploy\` when ready (${apiUrl})`);
    } else {
      recorder.fail(name, `${apiUrl} → ${error || response.status}`);
    }
    return;
  }

  recorder.pass(name, `${apiUrl} → ${response.status} (${duration}ms)`);
  if (!deployRecord) {
    recordDeploy({ dir: ctx.brandRoot, target: entry.name, detail: { adopted: true } });
  }

  // Deployed-version comparison from the health payload
  let data = null;
  try {
    data = await response.json();
  } catch {
    return;
  }

  const framework = targetType(entry.target)?.framework;
  const deployed = data?.backendVersion;
  if (!deployed) return;

  const deployedName = `${entry.name}: deployed backend`;
  const latest = getLatestVersion(ctx, framework);

  if (!latest) {
    recorder.note(deployedName, `${deployed} (could not check latest)`);
  } else if (deployed === latest) {
    recorder.pass(deployedName, `${deployed} (up to date)`);
  } else {
    recorder.warn(deployedName, `outdated (${deployed} → ${latest})`);
  }
}

/**
 * GitHub Actions check: the latest workflow run of the brand's SOURCE repo, the
 * one every workflow runs in (#883). Silent when the brand declares no
 * `repo.owner` (the repo service already reports that skip) or when the gh CLI
 * is unavailable.
 */
function checkGitHubActions(recorder, ctx) {
  // The service's own brand id stands in for a config that names no brand.
  const source = sourceRepo({ ...ctx.brandConfig, brand: { ...ctx.brandConfig.brand, id: ctx.brandConfig.brand?.id || ctx.brandId } });
  if (!source) return;

  const repo = source.slug;

  if (ctx.dryRun) {
    recorder.would(`gh run list --repo ${repo}`);
    return;
  }

  let runs;
  try {
    runs = JSON.parse(ctx.exec(`gh run list --repo ${repo} --limit 1 --json status,conclusion,name`));
  } catch {
    recorder.note('GitHub Actions', 'could not check (gh unavailable or no access)');
    return;
  }

  if (!runs.length) {
    recorder.note('GitHub Actions', 'no runs found');
    return;
  }

  const run = runs[0];
  if (run.status === 'completed' && run.conclusion === 'success') {
    recorder.pass('GitHub Actions', `${run.name} → success`);
  } else if (run.status === 'in_progress') {
    recorder.warn('GitHub Actions', `${run.name} → in progress`);
  } else {
    recorder.fail('GitHub Actions', `${run.name} → ${run.conclusion || run.status}`);
  }
}

module.exports = {
  createRecorder,
  defaultExec,
  fetchWithRetry,
  compareVersions,
  installedVersion,
  parseWorkingTree,
  checkTargetFiles,
  checkFrameworkVersion,
  checkWorkingTree,
  checkHomepage,
  checkBrandAssets,
  checkApiHealth,
  checkGitHubActions,
};
