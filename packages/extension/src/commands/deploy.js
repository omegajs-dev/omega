/**
 * `omega deploy` — the explicit publish verb (D13: commits never
 * auto-publish). Delivers the brand to its repo and dispatches the scaffolded
 * publish workflow: CI builds, uploads to the stores when credentials are
 * present, and attaches the package zip to a GitHub release (the durable
 * artifact channel).
 *
 * ONE lane, the same one every target takes
 * ([#872](https://github.com/Omega-JS-Stack/omega/issues/872),
 * [#915](https://github.com/Omega-JS-Stack/omega/issues/915)): the executor
 * resolves it from the brand, packs any local frameworks and pushes a
 * SNAPSHOT of the brand folder to `omega-deploy`, the one branch CI ever
 * builds, and then it waits for the workflow and dispatches. A
 * linked tree no longer switches itself to the direct lane; `--direct` is how a
 * human asks for that.
 *
 * Every run starts with the local scaffold the retired `omega setup` used to
 * own (ensureTarget, #675); a DISPATCH then runs setup's NETWORK half as a
 * precheck before it sends. `--no-secrets` skips that precheck, and `--direct`
 * never reaches it at all.
 *
 * Flags: --dry-run (print the exact dispatch, send nothing; skips the push),
 * --direct (build + store-publish from this machine: the ONE command CI runs).
 */
const path = require('node:path');
const { execSync } = require('node:child_process');
const build = require('../build.js');
const logger = build.logger('deploy');
const { deployViaDispatch, dispatchTarget, laneLabel, resolveToken } = require('@omega.js/devkit/deploy');
const attachLogFile = require('@omega.js/devkit/attach-log-file');
const { assertBrandVersion } = require('@omega.js/devkit/brand-version');
const { runConsumerHook } = require('@omega.js/devkit/run-consumer-hook');
const { targetNameFromDir } = require('@omega.js/config');
const { ensureTarget } = require('./lib/ensure-target.js');
const { deployPrecheck } = require('./lib/deploy-precheck.js');

// The build+publish command, ONE spelling for both lanes
// ([#865](https://github.com/Omega-JS-Stack/omega/issues/865)): the scaffolded
// `publish.yml` runs exactly this with `OMEGA_IS_PUBLISH` in its env, and so
// does `--direct` below.
const PUBLISH_COMMAND = 'npm run build';

module.exports = async function (options) {
  options = options || {};
  const dryRun = options.dryRun || options['dry-run'];
  const projectDir = process.cwd();

  // The whole verb goes to the target's own deploy log, from its first line
  // ([#873](https://github.com/Omega-JS-Stack/omega/issues/873)): the scaffold,
  // the precheck's refusals and the followed run all land in one file instead
  // of scrollback. Tees STACK, so a brand fan-out's log gets the same lines.
  attachLogFile(path.join(projectDir, 'logs', 'deploy.log'));

  // The local half of the retired `omega setup` (#675) — idempotent, offline,
  // and quiet on a converged target.
  await ensureTarget({ projectDir, log: (line) => logger.log(line), warn: (line) => logger.warn(line) });

  // The brand's ONE version ([#869](https://github.com/Omega-JS-Stack/omega/issues/869)):
  // a target whose version drifted from the brand root's is refused here, before
  // the precheck, because a drifted target must not push its secrets and
  // dispatch a build of the wrong number. A read, so every lane reaches it
  // (`--direct` and `--dry-run` included).
  assertBrandVersion({ dir: projectDir });

  // The consumer's pre-deploy hook, on BOTH lanes and before anything is
  // published, through devkit's one hook runner. A dry run skips it, because
  // a hook may act on the world and a dry run promises to send nothing.
  if (dryRun) {
    logger.log('DRY RUN, skipping hook "deploy/pre"');
  } else {
    // The one ctx shape every OMEGA hook takes, `{ build, projectRoot, mode }`,
    // and a deploy's mode is PRODUCTION: what it is about to publish is a release.
    await runConsumerHook('deploy/pre', { build, projectRoot: projectDir, mode: 'production' });
  }

  // The direct lane, on request: build + store-publish from THIS machine.
  // BEFORE the precheck, which belongs to the CI lane (web and backend already
  // order it this way): a local deploy publishes nothing to the repo and needs
  // no `gh` session, so pushing this target's store credentials into Actions
  // secrets on the way past is exactly what it must not do (#872).
  if (options.direct) {
    return deployDirect({ dryRun, exec: options.exec });
  }

  // The NETWORK half, as a precheck: the CI lane needs the remote side right
  // (its secrets). A DRY RUN runs it too
  // ([#895](https://github.com/Omega-JS-Stack/omega/issues/895)): every step is
  // a read or a plan under `dryRun`, so the preview is the real one.
  await deployPrecheck({ projectDir, options, logger, dryRun });

  // The ONE dispatch address helper ([#847](https://github.com/Omega-JS-Stack/omega/issues/847)):
  // the repo the brand's CONFIG names (never the git remote, which inside a
  // brand nested in another repo is the enclosing one), and the workflow the
  // target's scaffold actually composed at the brand root (#265).
  const { owner, repo, workflow: WORKFLOW } = dispatchTarget({
    projectRoot: process.cwd(),
    config: build.getConfig(),
    workflow: 'publish.yml',
  });

  // ONE lane for all four targets (#872, #915): the executor resolves it from
  // the BRAND (`dir`), refuses a checkout behind the default branch, puts the
  // composed workflows on that branch when they differ, packs any local
  // frameworks and pushes the snapshot to `omega-deploy`, and then it waits for
  // the workflow and dispatches.
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
    require('@omega.js/devkit/deploy-record').recordDeploy({ dir: process.cwd(), target: targetNameFromDir(process.cwd()) || 'extension', detail: { method: 'dispatch' } });
    logger.log(`Dispatched ${WORKFLOW} (${laneLabel(lane, sha)}): CI builds, publishes to stores, and attaches the zip to a GitHub release.`);
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

/**
 * The direct lane, asked for by a human (`--direct`,
 * [#872](https://github.com/Omega-JS-Stack/omega/issues/872)): build +
 * store-publish from THIS machine, with whatever frameworks are linked here
 * bundled in. It used to select itself whenever the tree carried a `file:`
 * spec, which took the CI lane away from the brands that need it most; a
 * linked brand now packs its frameworks into the snapshot the runner installs.
 *
 * ONE command, the one CI runs ([#865](https://github.com/Omega-JS-Stack/omega/issues/865)):
 * the build already ENDS in the publish task (`gulp/main.js`'s `exports.build`),
 * so the `npm run build && npm run publish` script this used to run entered
 * that task twice and published the same version to every store twice over.
 * The publish flag rides the env the way the workflow sets it, so the local
 * lane and the CI lane are the same one process.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun] - Print what would run, run nothing.
 * @param {function} [options.exec] - Injectable shell (tests).
 * @returns {void}
 */
function deployDirect(options) {
  options = options || {};
  const exec = options.exec || execSync;

  if (options.dryRun) {
    return logger.log(`DRY RUN, would run: ${PUBLISH_COMMAND} with OMEGA_IS_PUBLISH=true (local build + store publish)`);
  }

  logger.log('Building + publishing LOCALLY (store credentials must be available in this shell)...');
  exec(PUBLISH_COMMAND, { stdio: 'inherit', env: { ...process.env, OMEGA_IS_PUBLISH: 'true' } });
  require('@omega.js/devkit/deploy-record').recordDeploy({ dir: process.cwd(), target: targetNameFromDir(process.cwd()) || 'extension', detail: { method: 'direct' } });

  return logger.log('Deployed from the LOCAL build.');
}

module.exports.deployDirect = deployDirect;
