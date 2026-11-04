// release: trigger the GitHub Actions Build & Release workflow, then follow the
// run it started.
//
// Replaces the old "do it from my laptop" release flow with "let CI do it, but make it
// feel local." User runs `npx omega release` and gets:
//   1. The ONE deploy lane every target takes (`@omega.js/devkit/deploy`'s
//      deployViaDispatch, #872, #915): the composed workflow files reach the
//      default branch when they differ there (GitHub registers a workflow from
//      that branch), the brand folder is pushed to `omega-deploy` (packed
//      when it is linked), and the workflow is dispatched on that ref (the
//      brand's own repo and the composed workflow name: devkit's
//      dispatchTarget, #847).
//   2. The ONE run follower every dispatched deploy uses
//      (`@omega.js/devkit/deploy-follow`, [#873](https://github.com/Omega-JS-Stack/omega/issues/873)):
//      it finds the run, polls it, prints each job's log with the job's name in
//      front, and exits 1 on any conclusion but success. This file owned that
//      follower alone until #873 gave the other three targets the same one.
//   3. Everything teed to <root>/logs/deploy.log, the one name every target's
//      deploy writes (docs/shared/logging.md), ANSI stripped from the file.

const path     = require('path');

const attachLogFile = require('../utils/attach-log-file.js');
const { deployViaDispatch, dispatchTarget, laneLabel, resolveToken } = require('@omega.js/devkit/deploy');
const { followRun } = require('@omega.js/devkit/deploy-follow');
const { targetNameFromDir } = require('@omega.js/config');
const build = require('../build.js');

const logger = build.logger('release');

module.exports = async function release(options = {}) {
  const projectRoot = process.cwd();
  // The DRY RUN arrives here too ([#895](https://github.com/Omega-JS-Stack/omega/issues/895)):
  // this verb is desktop's one dispatch call site, so the plan a preview prints
  // is built by the very call a real run sends, threading the ref and the
  // snapshot sha the same way.
  const dryRun = !!(options.dryRun || options['dry-run']);

  // The whole verb in one file, from its first line (#873), the token refusal
  // below included: a caller that hands the writers back afterwards then pops
  // THIS layer, never the one under it. A no-op when `omega deploy` delegated
  // here and already attached this exact path.
  const logPath = path.join(projectRoot, 'logs', 'deploy.log');
  attachLogFile(logPath);

  // The ONE token chain devkit resolves for every target, `GH_TOKEN` →
  // `GITHUB_TOKEN` → `gh auth token`, and the very one the follower below is
  // handed: testing the bare variable refused a machine signed in with `gh`
  // and holding no variable at all, which is most of them. A dry run needs
  // none: every step under it is a read or a plan.
  if (!dryRun && !resolveToken()) {
    throw new Error('No GitHub token: set GH_TOKEN in .env (or GITHUB_TOKEN in the shell), or sign in with `gh auth login`, so we can dispatch the workflow.');
  }

  // The CI dispatch address, from the config and the scaffold: the brand's own
  // repo and the workflow file the target's ensure-target pass actually wrote
  // (composed as `desktop-build.yml` at the brand root inside a monorepo, plain
  // `build.yml` standalone). ONE helper for all four targets
  // ([#847](https://github.com/Omega-JS-Stack/omega/issues/847)), where this
  // file used to keep desktop's own copy of it.
  const { owner, repo, workflow: WORKFLOW_FILE } = dispatchTarget({ projectRoot, config: build.getConfig(), workflow: 'build.yml' });

  // Optional --platforms / --platform flag forwarded as a workflow input. Accepts a
  // single value ('windows') or comma-separated list ('mac,linux'). Special value
  // 'all' or undefined builds every platform — same as the workflow's default. We
  // only attach `inputs` when the user explicitly passed a flag, so older consumer
  // workflows (without a `platforms` input declared) keep working unchanged.
  const platforms = options.platforms || options.platform || null;

  const platformsLabel = platforms ? ` (platforms=${platforms})` : '';
  if (!dryRun) {
    logger.log(`Triggering ${owner}/${repo} workflow ${WORKFLOW_FILE}${platformsLabel}...`);
  }

  // 1. Mark a "before" timestamp so the follower identifies the run we just
  // dispatched rather than the one before it.
  const since = new Date();

  // 2. Deliver the brand and dispatch, through the ONE lane (#872, #915): the
  // composed workflows to the repo's default branch when they differ, the brand
  // folder to `omega-deploy`, which is the ref this dispatches. An explicit
  // `--ref` still wins.
  const { plan, lane, sha } = await deployViaDispatch({
    workflow: WORKFLOW_FILE,
    owner,
    repo,
    dir: projectRoot,
    ref: options.ref,
    inputs: platforms ? { platforms: String(platforms) } : undefined,
    // The brand root's one snapshot for the whole fan-out, when a brand-root
    // deploy spawned this verb (#901): the push is done, so this run
    // dispatches against that sha instead of pushing over it. Nobody types it.
    snapshot: options.snapshot,
    dryRun,
    logger,
  });

  // The plan IS the dry run: what would be sent, and nothing sent.
  if (dryRun) {
    logger.log(`DRY RUN (${laneLabel(lane)}), would send:`);
    logger.log(`  ${plan.method} ${plan.url}`);
    logger.log(`  body: ${JSON.stringify(plan.body)}`);
    logger.log(`  then watch: ${plan.runsUrl}`);
    return;
  }

  logger.log(`Dispatched ${WORKFLOW_FILE} (${laneLabel(lane, sha)}): CI builds, signs, and publishes the release artifacts.`);
  // The ONE runs-url formula is the plan's (`buildDispatch`), the same line
  // backend, web and the extension print: rebuilt by hand here, it was a second
  // copy of an address the dispatch already answered.
  logger.log(`Watch: ${plan.runsUrl}`);

  require('@omega.js/devkit/deploy-record').recordDeploy({ dir: projectRoot, target: targetNameFromDir(projectRoot) || 'desktop', detail: { method: 'release-dispatch' } });

  // 3. Follow the run to its verdict: the jobs' logs stream in here, and a red
  // run throws, so this verb exits 1 on anything but success (#873). The run
  // also has to be building the tree this deploy pushed (#902): on the push
  // lane there is no sha and the check is off, because that lane's run head is
  // the developer's own commit.
  const { conclusion } = await followRun({
    owner,
    repo,
    workflow: WORKFLOW_FILE,
    since,
    headSha: sha,
    token: resolveToken(),
    logger,
  });

  logger.log(`Logs: ${path.relative(projectRoot, logPath)}`);

  return conclusion;
};
