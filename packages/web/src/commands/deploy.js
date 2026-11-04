/**
 * `omega deploy` — the explicit publish verb (D13: commits never
 * auto-publish). Delivers the brand to its repo and dispatches the scaffolded
 * build workflow so CI runs the SAME build and publishes to gh-pages.
 *
 * ONE lane, the same one every target takes
 * ([#872](https://github.com/Omega-JS-Stack/omega/issues/872),
 * [#915](https://github.com/Omega-JS-Stack/omega/issues/915)): the executor
 * resolves it from the brand (`@omega.js/devkit/deploy`'s resolveDeployLane),
 * packs any local frameworks and pushes a SNAPSHOT of the brand folder to
 * `omega-deploy`, the one branch CI ever builds. Then it waits for the workflow
 * and dispatches. A linked tree no longer switches itself to the direct lane;
 * `--direct` is how a human asks for that.
 *
 * Every run starts with the local scaffold the retired `omega setup` used to
 * own (ensureTarget) and its NETWORK half as a precheck: the brand's .env keys
 * are published as repo secrets so CI has what the scaffolded workflow asks
 * for. `--no-secrets` opts out.
 *
 * Flags: --dry-run (print the exact dispatch, send nothing; skips the push),
 * --local (production build only: no push, no dispatch),
 * --direct (build + push dist straight to the WEBSITE repo's gh-pages, the
 * `<brand.id>-<target name>` repo of #883: the lane the scaffolded CI workflow
 * runs too, and the no-CI path for any brand whose repo has no workflows yet;
 * CI dispatch stays the default verb).
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync, execFileSync } = require('node:child_process');
const Logger = require('@omega.js/devkit/logger');
const { deployViaDispatch, dispatchTarget, laneLabel, resolveToken } = require('@omega.js/devkit/deploy');
const attachLogFile = require('@omega.js/devkit/attach-log-file');
const { assertBrandVersion } = require('@omega.js/devkit/brand-version');
const { ensureTarget } = require('./lib/ensure-target.js');
const { deployPrecheck } = require('./lib/deploy-precheck.js');
const { resolvePathPrefix } = require('../path-prefix.js');

const logger = new Logger('deploy');

// The Pages custom domain is ONE derivation, shared with the manage walk that
// sets it on the repo ([#883](https://github.com/Omega-JS-Stack/omega/issues/883)):
// this lane writes the CNAME file the push publishes, and the two claiming
// different domains for one site is the bug that pairing them prevents.
const { pagesHost, pagesAddress, brandHost, repoMissing } = require('@omega.js/config');

/**
 * The URL this deploy PUBLISHES to, split where the host ends: the two facts
 * every derivation below reasons from. Parsed by hand, not through
 * `new URL()`, because the value is allowed to arrive without a scheme.
 *
 * The resolved config's top-level `url` answers first: it is THIS target's
 * own public url ([#588](https://github.com/Omega-JS-Stack/omega/issues/588),
 * derived from the target name or declared on its entry), so a
 * `targets/admin` deploy writes admin.acme.test into the CNAME and
 * mounts the build there instead of publishing over the main site. `brand.url`
 * is the fallback, which IS the answer for a brand running one web target.
 *
 * @param {object} config - Composed omega config (brand + local layers).
 * @returns {{ host: string, path: string }} '' each when no URL is known.
 */
function brandUrlParts(config) {
  const value = String(config.url || config.brand?.url || '').replace(/^https?:\/\//, '');
  const slash = value.indexOf('/');

  return slash === -1
    ? { host: value, path: '' }
    : { host: value.slice(0, slash), path: value.slice(slash) };
}

/**
 * WHICH target this lane runs in: its folder name inside a brand monorepo. A
 * standalone project's dir name is arbitrary, and `web` is the name its
 * scaffold declares.
 *
 * @param {string} cwd - The target dir.
 * @returns {string} The target name.
 */
function targetName(cwd) {
  const { targetNameFromDir } = require('@omega.js/config');

  return targetNameFromDir(cwd) || 'web';
}

/**
 * The WEBSITE repo this deploy publishes to: `<brand.id>-<target name>` under
 * the brand's owner, holding the BUILT site only
 * ([#883](https://github.com/Omega-JS-Stack/omega/issues/883)). The SOURCE
 * monorepo is a different repo (`sourceRepo`, where the dispatch lane sends its
 * workflow_dispatch), which is what lets a private brand serve a public site.
 *
 * Config-only: GITHUB_REPOSITORY and the working tree's `origin` remote both
 * name the repo the checkout SITS IN, which is the source repo on a runner and
 * the enclosing monorepo in a nested brand. Neither is ever the push target.
 *
 * @param {object} config - Composed omega config (brand + local layers).
 * @param {string} cwd - The target dir (its basename is the target name inside a brand).
 * @returns {{ owner: string, name: string, slug: string }|null} Null when the config names no owner (or no brand id), and null when another provider hosts this target.
 * @throws {Error} When the resolved target name is not declared in the config.
 */
function websiteAddress(config, cwd) {
  const { websiteRepo } = require('@omega.js/config');

  return websiteRepo(config, targetName(cwd));
}

/**
 * The base path this deploy publishes under ([#358](https://github.com/Omega-JS-Stack/omega/issues/358)) —
 * the `OMEGA_PATH_PREFIX` the #355 build lanes mount every root-relative URL
 * under, filled from facts a deploy already resolves so an ordinary gh-pages
 * brand never sees an env var:
 *
 *   brand.url = a domain    → the site serves at that domain's ROOT (the CNAME
 *                             both lanes publish cannot carry a path) → `/`.
 *   brand.url = a *.github.io
 *                address     → the path it carries IS the mount (#366) →
 *                             `/<name>/`; a bare Pages host falls through.
 *   brand.url unset         → the default project address
 *                             `https://<owner>.github.io/<name>/` → `/<name>/`,
 *                             from the same website repo the direct plan pushes
 *                             to.
 *
 * An explicitly exported value WINS: publisher machinery (workkit's publish
 * reads the mount point off the Pages API) knows better than this derivation.
 * A blank export is an ABSENCE, not a value — an Actions secret that was never
 * set renders as an empty string, and that must not suppress the autofill.
 * Normalization is #355's (src/path-prefix.js), never a second copy.
 *
 * @param {object} config - Composed omega config (brand + local layers).
 * @param {object} [env] - Environment to read (defaults to process.env).
 * @param {string} [cwd] - The target dir, which names the target (defaults to cwd).
 * @returns {string} '/' (domain root) or '/<name>/' (project address).
 */
function deployPathPrefix(config, env, cwd) {
  env = env || process.env;

  const explicit = String(env.OMEGA_PATH_PREFIX || '').trim();
  if (explicit) return explicit;

  if (pagesHost(config, targetName(cwd || process.cwd()))) return '/';

  // A `*.github.io` brand.url names its own mount (#366): the path it carries
  // IS the base path, so the Pages address the loader fills an unset brand.url
  // with mounts where the website repo does. A bare Pages host names no
  // project and falls through to the slug.
  const fromBrandUrl = resolvePathPrefix(brandUrlParts(config).path);
  if (fromBrandUrl) return `${fromBrandUrl}/`;

  // ONE repo resolution with the direct plan: the address a plan publishes to
  // and the base path its build mounts under can never disagree.
  const website = websiteAddress(config, cwd || process.cwd());
  const prefix = website ? resolvePathPrefix(website.name) : '';

  return prefix ? `${prefix}/` : '/';
}

/**
 * A target's composed config, with validation findings treated as FATAL — the
 * deploy lanes' twin of the build's loadSiteData
 * ([#426](https://github.com/Omega-JS-Stack/omega/issues/426)). Every finding
 * the loader returns names a key nothing will read at runtime, so deriving a
 * deploy address or publishing from that config ships a site the config does
 * not describe. The build refuses the same file; these lanes refuse it first.
 *
 * @param {string} dir - The consumer target dir.
 * @returns {object} The resolved config.
 * @throws {Error} When the config carries validation findings.
 */
function loadDeployConfig(dir) {
  const { loadConfig, formatErrors } = require('@omega.js/config');
  // Both lanes deploy a PRODUCTION site, so both read the production config
  // (#856): the address, the CNAME and the base path this derives have to be
  // the ones the artifact is built with, never the ones this machine's ambient
  // environment would overlay.
  const { config, errors } = loadConfig(dir, 'web', { environment: 'production' });

  if (errors && errors.length) {
    throw new Error(`config/omega.json5 is invalid:\n${formatErrors(errors)}`);
  }

  return config;
}


/**
 * `deployPathPrefix` for a target dir, loading that target's composed config —
 * the entry point for callers holding no config yet. The scaffolded CI
 * workflow runs exactly this (`@omega.js/web/deploy`) from the target dir, so
 * the dispatch lane and the direct lane derive through ONE function.
 *
 * @param {string} [dir] - The consumer target dir (defaults to cwd).
 * @param {object} [env] - Environment to read (defaults to process.env).
 * @returns {string} '/' or '/<name>/'.
 */
function targetPathPrefix(dir, env) {
  dir = dir || process.cwd();

  return deployPathPrefix(loadDeployConfig(dir), env, dir);
}

/**
 * The direct-deploy plan from the target's composed config: the website repo
 * (`websiteRepo`), the Pages custom domain (the target url's host), the address
 * the deploy will serve at, and the base path its build mounts under.
 *
 * TWO shapes, because GitHub Pages has two ([#361](https://github.com/Omega-JS-Stack/omega/issues/361)):
 * a CUSTOM DOMAIN (brand.url names a domain of the brand's own) publishes a
 * CNAME and serves at that domain's root, and a PROJECT site serves at
 * `https://<owner>.github.io/<name>/` with no CNAME at all — the ordinary
 * gh-pages case, which used to be refused here and was therefore reachable only
 * through the CI dispatch lane. A project site's brand.url names its PAGES
 * address (#355/#366), which keeps the project shape rather than switching it.
 *
 * @param {object} config - Composed omega config (brand + local layers).
 * @param {object} [options]
 * @param {object} [options.env] - Environment to read (defaults to process.env).
 * @param {string} [options.cwd] - Working tree to resolve the repo from (defaults to cwd).
 * @returns {{ owner: string, name: string, repo: string, pushUrl: string, branch: string, cname: string, url: string, pathPrefix: string }} `repo` is the `owner/name` slug; `cname` is '' for a project site.
 */
function buildDirectPlan(config, options) {
  const env = (options && options.env) || process.env;
  const cwd = (options && options.cwd) || process.cwd();
  const website = websiteAddress(config, cwd);

  if (!website) {
    throw new Error(`Direct deploy could not address the website repo. ${repoMissing('website')} A target whose hosting.provider is not github has no repo to push to.`);
  }

  const { owner, slug: repo } = website;
  const brandUrl = brandUrlParts(config);
  const cname = pagesHost(config, targetName(cwd));
  const pathPrefix = deployPathPrefix(config, env, cwd);
  // A project site serves under the SAME base path the build mounts every URL
  // under, so the two can never drift apart (#358 derives both). Its host comes
  // from brand.url when that names the Pages address, else from the Pages
  // address the loader fills an unset brand.url with, never a second spelling.
  const projectHost = brandUrl.host || brandHost(pagesAddress(config, targetName(cwd)));
  const url = cname ? `https://${cname}` : `https://${projectHost}${pathPrefix}`;

  return {
    owner,
    name: website.name,
    repo,
    pushUrl: `https://github.com/${repo}.git`,
    branch: 'gh-pages',
    cname,
    url,
    pathPrefix,
  };
}

/**
 * Build, then push dist to the WEBSITE repo's gh-pages (CNAME + .nojekyll
 * included), then point Pages at that branch and domain. Both lanes run this
 * ONE path (the scaffolded workflow's deploy step calls the same verb), so the
 * first deploy of a fresh `<brand.id>-<name>` repo configures its own Pages
 * instead of waiting for the next manage walk.
 */
function deployDirect({ dryRun }) {
  // Fatal BEFORE anything is planned, printed or pushed — including a dry run,
  // whose whole job is to say what a real run would do (#426).
  const config = loadDeployConfig(process.cwd());

  const plan = buildDirectPlan(config);
  const dist = path.join(process.cwd(), 'dist');

  if (dryRun) {
    logger.log('DRY RUN — direct deploy would:');
    logger.log(`  build, then push ${dist} → ${plan.pushUrl} (${plan.branch}), ${plan.cname ? `CNAME ${plan.cname}` : `project site ${plan.url} (no CNAME)`}`);
    return;
  }

  // Cached-only translation: a deploy must never hang on a live LLM pass
  // (provider limits/outages): cold language pairs ship untranslated with the
  // standard warning, and `omega translate` owns filling the cache.
  // The base path travels with the build (#358): this lane builds LOCALLY, so
  // it is the lane that must hand `omega build` the mount point.
  logger.log('Building (production, cached-only translation)...');
  const env = { ...process.env, OMEGA_PATH_PREFIX: plan.pathPrefix };
  execSync('npm run build -- --cached-only', { stdio: 'inherit', env });

  if (!fs.existsSync(path.join(dist, 'index.html')) && !fs.existsSync(path.join(dist, '404.html'))) {
    throw new Error(`Build produced no site in ${dist} — refusing to push an empty branch`);
  }

  logger.log(`Pushing dist → ${plan.repo}#${plan.branch} (${plan.cname ? `CNAME ${plan.cname}` : 'project site — no CNAME'})...`);
  // A project site has no custom domain to claim, and an empty CNAME file
  // would claim one: the step belongs to the domain shape only.
  if (plan.cname) {
    fs.writeFileSync(path.join(dist, 'CNAME'), plan.cname);
  }
  fs.writeFileSync(path.join(dist, '.nojekyll'), '');
  fs.rmSync(path.join(dist, '.git'), { recursive: true, force: true });

  // Config-derived values (pushUrl/branch/cname) pass as their own argv
  // elements — no shell parses them.
  const git = (...args) => execFileSync('git', args, { cwd: dist, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    git('init', '-q', '-b', plan.branch);
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `Deploy ${plan.cname || plan.url} (omega deploy --direct)`);
    pushDist(plan, { cwd: dist });
  } finally {
    fs.rmSync(path.join(dist, '.git'), { recursive: true, force: true });
  }

  // Pages serves what was just pushed: idempotent, and a no-op on a repo
  // already serving that branch at that domain. The manage walk reconciles the
  // same two facts, so a machine without `gh` warns instead of failing a deploy
  // whose site is already published.
  try {
    require('@omega.js/devkit/github-repo').ensurePages({
      owner: plan.owner,
      name: plan.name,
      branch: plan.branch,
      cname: plan.cname || undefined,
    }, { logger });
  } catch (error) {
    logger.warn(`Could not configure Pages on ${plan.repo} (run \`omega manage\` to reconcile it): ${error.message}`);
  }

  // Records key per target NAME: this target deploys itself, so a
  // targets/admin deploy lands under admin and targets/web stays web
  const { targetNameFromDir } = require('@omega.js/config');
  require('@omega.js/devkit/deploy-record').recordDeploy({ dir: process.cwd(), target: targetNameFromDir(process.cwd()) || 'web', detail: { method: 'direct' } });
  logger.log(`Deployed — ${plan.url} serves once Pages picks up the push.`);
  return purgeAfterPublish(config);
}

/**
 * Push the built branch to the website repo. The repo this lane pushes to is
 * NOT the repo it was run from, so neither lane arrives authenticated for it: a
 * runner's checkout credentials are local to the checkout, and the fresh repo
 * in dist/ carries no config at all.
 *
 * The token reaches git through the config ENV of this one process, and a
 * failure is rethrown scrubbed, both from the ONE devkit rule the snapshot push
 * shares (`@omega.js/devkit/git-auth`): a push url with credentials in it is
 * printed by git's own error output, is visible in the process list of every
 * other user on the machine, and rides the thrown message of a failed
 * `execFileSync` (which carries the whole argv) straight into a CI log, outside
 * Actions' masking.
 *
 * @param {object} plan - The direct-deploy plan (`pushUrl`, `branch`, `repo`).
 * @param {object} [options]
 * @param {string} [options.cwd] - The dist repo to push from.
 * @param {object} [options.env] - Environment to read the token from and extend (defaults to process.env).
 * @param {string|null} [options.token] - The token to authenticate with (defaults to the resolved one).
 * @param {function} [options.execFn] - execFileSync seam (tests).
 * @returns {*} Whatever the exec seam returns.
 * @throws {Error} When the push fails, with the token scrubbed out of the message.
 */
function pushDist(plan, options) {
  const { resolveToken } = require('@omega.js/devkit/deploy');
  const { gitAuthEnv, scrubbedFailure } = require('@omega.js/devkit/git-auth');
  const opts = options || {};
  const execFn = opts.execFn || execFileSync;
  const env = opts.env || process.env;
  const token = opts.token === undefined ? resolveToken({ env }) : opts.token;

  try {
    return execFn('git', ['push', '-q', '-f', plan.pushUrl, plan.branch], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...env, ...gitAuthEnv(token) },
    });
  } catch (error) {
    // Belt and braces: the token is in no argv here, but a future caller's
    // error text is never trusted with it.
    throw scrubbedFailure(`Pushing to ${plan.repo}`, error, token);
  }
}

/**
 * Post-publish Cloudflare purge (the content just changed — clear the
 * zone's edge cache). Skips cleanly without a token; a purge FAILURE is a
 * warning, never a failed deploy — the site is already live.
 * @param {object} config - composed web config
 */
async function purgeAfterPublish(config) {
  const { purgeZoneCache } = require('../purge.js');
  try {
    const result = await purgeZoneCache({ config });
    if (result.status === 'purged') {
      logger.log(`Cloudflare cache purged (zone ${result.zoneName || result.zone}).`);
    } else {
      logger.log(`Cloudflare purge skipped — ${result.reason}.`);
    }
  } catch (error) {
    logger.warn(`Cloudflare purge failed (site is live; run \`omega purge\` to retry): ${error.message}`);
  }
}

module.exports = async function (options) {
  options = options || {};
  const dryRun = options.dryRun || options['dry-run'];

  // The whole verb goes to the target's own deploy log, from its first line
  // ([#873](https://github.com/Omega-JS-Stack/omega/issues/873)): the scaffold,
  // the precheck's refusals and the followed run all land in one file instead
  // of scrollback. Tees STACK, so a brand fan-out's log gets the same lines.
  attachLogFile(path.join(process.cwd(), 'logs', 'deploy.log'));

  // The local half of the retired `omega setup` (#675) — idempotent, offline,
  // and quiet on a converged target. Runs before the manifest is read: it is
  // what writes that manifest on a virgin target.
  ensureTarget({ projectDir: process.cwd(), log: (line) => logger.log(line), warn: (line) => logger.warn(line) });

  // The brand's ONE version ([#869](https://github.com/Omega-JS-Stack/omega/issues/869)):
  // a target whose version drifted from the brand root's is refused here, before
  // the precheck, because a drifted target must not push its secrets and
  // dispatch a build of the wrong number. A read, so every lane reaches it
  // (`--direct` and `--dry-run` included).
  assertBrandVersion({ dir: process.cwd() });

  // Direct deploys build LOCALLY and push only the built output — local
  // file: packages are fine there (the monorepo model). The guard below
  // protects the CI-dispatch path, where CI rebuilds from pushed source.
  if (options.direct) {
    return deployDirect({ dryRun });
  }

  if (options.local) {
    logger.log('Building (local only — no dispatch)...');
    execSync('npm run build', { stdio: 'inherit' });
    return;
  }

  // The NETWORK half of the retired setup, as a precheck before the dispatch:
  // the workflow reads its secrets from the repo, so they are published here
  // rather than by a command someone had to remember (#675). A DRY RUN runs it
  // too ([#895](https://github.com/Omega-JS-Stack/omega/issues/895)): every
  // step is a read or a plan under `dryRun`, so the preview is the real one.
  await deployPrecheck({ projectDir: process.cwd(), options, logger, dryRun });

  // ONE lane for all four targets ([#872](https://github.com/Omega-JS-Stack/omega/issues/872),
  // [#915](https://github.com/Omega-JS-Stack/omega/issues/915)): the executor
  // resolves it from the BRAND (`dir`), refuses a checkout behind the default
  // branch, puts the composed workflows on that branch when they differ, packs
  // any local frameworks and pushes the snapshot to `omega-deploy`. Then it
  // waits for the workflow and dispatches.
  // The ONE dispatch address helper ([#847](https://github.com/Omega-JS-Stack/omega/issues/847)):
  // the repo the brand's CONFIG names (a git remote answers the repo the working
  // tree SITS IN, which inside a brand nested in another repo is the enclosing
  // one), and the workflow the target's scaffold actually composed at the brand
  // root (#265).
  const { owner, repo, workflow: WORKFLOW } = dispatchTarget({
    projectRoot: process.cwd(),
    config: loadDeployConfig(process.cwd()),
    workflow: 'build.yml',
  });
  // Read BEFORE the dispatch: it is what tells the follower which run is this
  // one rather than the run before it (#873).
  const since = new Date();
  const { plan, dispatched, lane, sha } = await deployViaDispatch({
    workflow: WORKFLOW,
    owner,
    repo,
    dir: process.cwd(),
    dryRun,
    // The brand root's one snapshot for the whole fan-out, when a brand-root
    // deploy spawned this verb (#901): the push is done, so this run
    // dispatches against that sha instead of pushing over it. Nobody types it.
    snapshot: options.snapshot,
    logger,
  });

  if (dispatched) {
    const { targetNameFromDir } = require('@omega.js/config');
    require('@omega.js/devkit/deploy-record').recordDeploy({ dir: process.cwd(), target: targetNameFromDir(process.cwd()) || 'web', detail: { method: 'dispatch' } });
    logger.log(`Dispatched ${WORKFLOW} (${laneLabel(lane, sha)}): CI builds and publishes this deploy.`);
    logger.log(`Watch: ${plan.runsUrl}`);

    // Follow the run to its verdict (#873): the jobs' logs stream in here, and
    // a red run throws, so the verb's exit code is the run's conclusion rather
    // than "the dispatch was accepted". The run also has to be building the
    // tree this deploy pushed (#902): a brand with no repo snapshots nothing,
    // so there is no sha and that check is off.
    await require('@omega.js/devkit/deploy-follow').followRun({
      owner,
      repo,
      workflow: WORKFLOW,
      since,
      headSha: sha,
      token: resolveToken(),
      logger,
    });
  } else {
    logger.log(`DRY RUN (${laneLabel(lane)}), would send:`);
    logger.log(`  ${plan.method} ${plan.url}`);
    logger.log(`  body: ${JSON.stringify(plan.body)}`);
    logger.log(`  then watch: ${plan.runsUrl}`);
  }
};

module.exports.buildDirectPlan = buildDirectPlan;

module.exports.pushDist = pushDist;
module.exports.deployPathPrefix = deployPathPrefix;
module.exports.targetPathPrefix = targetPathPrefix;
