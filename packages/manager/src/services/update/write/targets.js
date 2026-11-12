/**
 * Install + build every target-mapped dir.
 *
 * Install is ONE `npm install` at the brand root (npm workspaces cover every
 * target), and it's dependency-resolution-gated for idempotency: if every
 * target's
 * declared deps already resolve through the node_modules climb, the install
 * is skipped — so a second run is a no-op, and a brand nested inside a larger
 * workspace (the monorepo's sandbox brand) never grows a stray node_modules.
 *
 * Build runs each target's own `npm run build`; targets without a build script are
 * recorded as skipped, not failed (a backend's "build" is its deploy story).
 * Those builds are the slow tail of every walk, so they are INCREMENTAL
 * (#445): a target whose own files AND whose installed `@omega.js/*` frameworks
 * are both unchanged since its last successful build is converged and skips
 * with one line (lib/fingerprint.js), the fingerprint pair living in
 * `.omega/cache/update.json` (lib/cache.js). Either set fresh → the full build
 * for that target; `--force` ignores the cache, and so does a brand whose cache
 * is missing or unreadable.
 *
 * Output shape matches omega-manager's update service so RunSummary's
 * drill-down works unchanged: { results: { [target]: { steps: [{ phase,
 * success, error?, skipped? }] } } }.
 */
const path = require('node:path');
const chalk = require('chalk').default;
const jetpack = require('fs-jetpack');

const { envLayerFiles, ENV_ENVIRONMENTS, resolveCompany, targetType } = require('@omega.js/config');
const { resolvePackageDir } = require('@omega.js/devkit/local');
const { ENV_FILE } = require('@omega.js/devkit/env-file');

const { runCommand } = require('../../../lib/run-command.js');
const { npmInstall } = require('../../../lib/npm-install.js');
const { fingerprintTarget } = require('../lib/fingerprint.js');
const { readCache, writeCache, CACHE_VERSION } = require('../lib/cache.js');

/**
 * One env LAYER's files: the base `.env` plus its `.env.<environment>` overlays.
 *
 * The overlay spelling is @omega.js/config's (`envLayerFiles`, #586), never a
 * join written out here, and EVERY environment is fingerprinted because a build
 * can run under any of them and an absent file digests as `absent` either way.
 * Fingerprinting the base file by exact path was the gap ([#681](https://github.com/Omega-JS-Stack/omega/issues/681)):
 * an overlay is a real layer of the cascade and carries the values that DIFFER
 * per environment, so an overlay edit left the target converged and its build
 * served the old value.
 *
 * @param {string} label - The layer's fingerprint label ('brand-env').
 * @param {string} root - The dir whose `.env` is this layer.
 * @returns {Array<{ label: string, file: string }>} One entry per layer file.
 */
function envLayerEntries(label, root) {
  const base = path.join(root, ENV_FILE);
  const files = [...new Set(ENV_ENVIRONMENTS.flatMap((environment) => envLayerFiles(base, environment)))];

  return files.map((file) => ({
    label: file === base ? label : `${label}.${file.slice(base.length + 1)}`,
    file,
  }));
}

/**
 * The merge-chain files OUTSIDE the target tree that its build still reads:
 * brand config/.env, and the company pair when the brand names a company
 * whose tree resolves on this machine (#677). A brand-config edit must dirty
 * every target's fingerprint, or the converged skip serves stale output.
 */
function chainFiles(brandRoot) {
  const files = [
    { label: 'brand-config', file: path.join(brandRoot, 'config', 'omega.json5') },
    ...envLayerEntries('brand-env', brandRoot),
  ];

  // The ONE inheritance rule: each file resolves from the company tree at the
  // same relative path, so a company that is not on this machine (or has no
  // tree yet) simply contributes nothing to fingerprint.
  const company = resolveCompany(brandRoot);
  const companyConfig = company.file(path.join('config', 'omega.json5'));
  const companyEnv = company.file(ENV_FILE);

  if (companyConfig) {
    files.push({ label: 'company-config', file: companyConfig });
  }
  if (companyEnv) {
    files.push(...envLayerEntries('company-env', path.dirname(companyEnv)));
  }

  return files;
}

/**
 * Collect declared deps (dependencies + devDependencies) missing from an
 * target's resolution climb.
 */
function missingDeps(targetPath) {
  const pkg = jetpack.read(path.join(targetPath, 'package.json'), 'json');
  if (!pkg) return [];

  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  return declared.filter((name) => !resolvePackageDir(name, targetPath));
}

module.exports = async ({ brandRoot, targets, options }) => {
  const mappedTargets = targets.filter((entry) => entry.target);
  const results = {};
  let failed = false;

  // ─── Install phase (once, at the brand root) ──────────────────────────────
  const missing = mappedTargets.flatMap((entry) => missingDeps(entry.path).map((dep) => `${entry.name}:${dep}`));
  const installSteps = [];

  if (missing.length === 0) {
    console.log(`      ${chalk.dim('⊘ install: all dependencies resolve')}`);
    installSteps.push({ phase: 'install', success: true, skipped: true });
  } else if (options.dryRun) {
    console.log(`      ${chalk.yellow('⊘')} install: would run npm install ${chalk.dim(`(missing: ${missing.join(', ')})`)} ${chalk.dim('[DRY RUN]')}`);
    installSteps.push({ phase: 'install', success: true, skipped: true, dryRun: true });
  } else {
    console.log(`      ${chalk.dim('→')} npm install ${chalk.dim(`(missing: ${missing.join(', ')})`)}`);
    const result = await npmInstall(brandRoot);
    installSteps.push({ phase: 'install', ...result });
    if (!result.success) {
      failed = true;
      // Local-first era: the frameworks aren't on the registry yet
      if (missing.some((entry) => entry.includes('@omega.js/'))) {
        console.log(`      ${chalk.yellow('⚠')} @omega.js/* packages are not published yet: link the brand with ${chalk.bold('omega i local')} at the brand root (or a workspace/file: reference).`);
      }
    }
  }

  results.root = { steps: installSteps };

  // ─── Build phase (per target, incremental) ────────────────────────────────
  const cache = readCache(brandRoot);
  const chain = chainFiles(brandRoot);
  const nextTargets = {};

  for (const entry of mappedTargets) {
    const steps = [];
    const cached = cache.targets[entry.name];

    if (failed) {
      // Nothing was rebuilt, so last run's verdict for this target still stands
      if (cached) nextTargets[entry.name] = cached;
      steps.push({ phase: 'build', success: true, skipped: true, reason: 'install failed' });
      results[entry.name] = { steps };
      continue;
    }

    const pkg = jetpack.read(path.join(entry.path, 'package.json'), 'json');
    // Only worth sweeping when there's a cached verdict to compare against
    // and the run is allowed to honour it
    const fingerprint = cached && pkg?.scripts?.build && !options.force
      ? fingerprintTarget(entry.path, chain)
      : null;
    const converged = Boolean(fingerprint)
      && cached.files === fingerprint.files
      && cached.frameworks === fingerprint.frameworks;

    if (!pkg?.scripts?.build) {
      console.log(`      ${chalk.dim(`⊘ ${entry.name}: no build script`)}`);
      steps.push({ phase: 'build', success: true, skipped: true, reason: 'no build script' });
    } else if (converged) {
      console.log(`      ${chalk.dim(`⊘ ${entry.name}: converged (target files + @omega.js/* unchanged)`)}`);
      nextTargets[entry.name] = cached;
      steps.push({ phase: 'build', success: true, skipped: true, reason: 'converged' });
    } else if (options.dryRun) {
      console.log(`      ${chalk.yellow('⊘')} ${entry.name}: would run npm run build ${chalk.dim('[DRY RUN]')}`);
      steps.push({ phase: 'build', success: true, skipped: true, dryRun: true });
    } else {
      // Non-interactive runs (pipeline, CI, `omega dev`'s boot manage cycle)
      // must be deterministic: every build that translates reads the committed
      // cache only, never a live provider call mid-run (the law deploys follow).
      // New strings translate on the next interactive run.
      const buildArgs = ['run', 'build'];
      if (targetType(entry.target)?.translates && process.env.OMEGA_NON_INTERACTIVE === '1') {
        buildArgs.push('--', '--cached-only');
      }
      console.log(`      ${chalk.dim('→')} ${entry.name}: npm ${buildArgs.join(' ')}`);
      const result = await runCommand('npm', buildArgs, entry.path);
      steps.push({ phase: 'build', ...result });

      if (result.success) {
        // Re-fingerprint AFTER the build: a build that writes back into its
        // own sources (the web translation cache) would otherwise leave the
        // target looking fresh forever. A failed build records nothing, so the
        // next run retries it.
        nextTargets[entry.name] = { ...fingerprintTarget(entry.path, chain), updatedAt: new Date().toISOString() };
      } else {
        failed = true;
      }
    }

    results[entry.name] = { steps };
  }

  // One write, only when something moved (a build landed, a target left the
  // brand, or the file was missing/unreadable and this rebuilds it). Keys are
  // sorted so a converged rerun produces the byte-identical file it read.
  const nextCache = {
    version: CACHE_VERSION,
    targets: Object.fromEntries(Object.keys(nextTargets).sort().map((name) => [name, nextTargets[name]])),
  };

  if (!options.dryRun && JSON.stringify(nextCache) !== JSON.stringify(cache)) {
    writeCache(brandRoot, nextCache);
  }

  return {
    status: failed ? 'error' : 'success',
    output: { results },
  };
};
