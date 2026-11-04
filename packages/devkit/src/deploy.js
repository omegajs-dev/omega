/**
 * Deploy executor — the ONE dispatch path for deliberate deploys (D13/D9).
 *
 * Commits never auto-publish: scaffolded workflows carry no push triggers, so
 * publishing is an explicit dispatch of the SAME CI build — from the local
 * CLI (`omega deploy`), a server-side action (the admin post route's
 * content-publish), or any plain HTTP caller. All three converge here: a
 * GitHub REST `workflow_dispatch` call (native fetch, no gh-CLI dependency —
 * Cloud Functions and laptops share the code path; locally the token can
 * still come from `gh auth token`).
 */
const path = require('node:path');
const { execSync, execFileSync } = require('node:child_process');

const { findBrandRoot, discoverTargets, frameworkPackagesOf } = require('./local.js');
const { stageLocalPackages, STAGING_DIR } = require('./pack-local.js');
const { assertBrandLockfile } = require('./brand-version.js');
const {
  pushSnapshot,
  pushWorkflowFiles,
  composedWorkflowFiles,
  defaultBranchOf,
  healDefaultBranch,
  waitForWorkflow,
  waitForRef,
  ghHeaders,
  shortSha,
} = require('./deploy-snapshot.js');
// The remote-url parse this module published before the boot prelude needed it
// too (#890): it lives in the remote boundary now, re-exported here unchanged.
// The origin gate (#934) lives there too, beside the one origin read.
const { parseRemoteUrl, assertOriginMatches } = require('./git-remote.js');

const API_BASE = 'https://api.github.com';

// The ONE branch a deploy ever builds from
// ([#915](https://github.com/Omega-JS-Stack/omega/issues/915)): every brand's
// snapshot lands here, nested or not, linked or not, and CI only ever runs what
// this branch holds. A brand's real history never carries packed tarballs, and
// whoever starts a deploy (a laptop, the admin publish) puts the files it needs
// on the same branch. Exported, so the backend's admin publish never types it.
const SNAPSHOT_REF = 'omega-deploy';

/**
 * The repo a CI dispatch addresses: the brand's SOURCE monorepo, from its
 * config ([#799](https://github.com/Omega-JS-Stack/omega/issues/799),
 * [#883](https://github.com/Omega-JS-Stack/omega/issues/883)). Every framework's
 * deploy verb asks this instead of `resolveRepo` above, because a git remote
 * answers the repo the working tree sits in: inside a brand monorepo nested in
 * another repo (a brand inside the framework monorepo, a target checked out
 * under someone else's tree) that is the ENCLOSING repo, so the dispatch went to
 * a workflow that was never there. The workflows live on the SOURCE repo in
 * every case, whatever a target publishes to.
 *
 * Half an address addresses nothing, so it throws rather than POST to
 * `undefined/<name>`.
 *
 * @param {object} config - Composed omega config for the target being deployed.
 * @returns {{ owner: string, repo: string }} the source repo's owner and bare name
 * @throws {Error} when the config names no repo
 */
function dispatchRepo(config) {
  const { sourceRepo, repoMissing } = require('@omega.js/config');
  const source = sourceRepo(config);

  if (!source) {
    throw new Error(`Could not determine the brand repo to dispatch on. ${repoMissing('source')}`);
  }

  return { owner: source.owner, repo: source.name };
}

/**
 * The whole CI dispatch ADDRESS for a target: the repo above, plus the workflow
 * file the target's scaffold actually wrote
 * ([#847](https://github.com/Omega-JS-Stack/omega/issues/847)). Inside a brand
 * monorepo the target's CI lives in the BRAND ROOT's workflows dir under a
 * per-target name (`desktop-build.yml`, #265), and standalone it keeps the
 * framework's own name, so every deploy verb composed `dispatchRepo` with
 * `composedWorkflowName` by hand and desktop kept a local helper its siblings
 * lacked. One helper now, called by all four.
 *
 * @param {object} options
 * @param {string} options.projectRoot - The target dir being deployed.
 * @param {object} options.config - Composed omega config for that target.
 * @param {string} options.workflow - The framework's workflow file name (e.g. publish.yml).
 * @returns {{ owner: string, repo: string, workflow: string }} the repo and the workflow to dispatch
 * @throws {Error} when the config names no repo
 */
function dispatchTarget({ projectRoot, config, workflow }) {
  const { composedWorkflowName } = require('./ci-workflows.js');
  const { resolveSeedMode } = require('@omega.js/config');
  const { owner, repo } = dispatchRepo(config);

  return {
    owner,
    repo,
    workflow: composedWorkflowName({
      targetDir: projectRoot,
      brandRoot: resolveSeedMode(projectRoot).brandRoot,
      workflow,
    }),
  };
}

/**
 * Resolve the GitHub repo for a working directory from its origin remote.
 * @param {object} [options]
 * @param {string} [options.cwd] - repo directory (default: process.cwd())
 * @param {string} [options.remote] - remote name (default: origin)
 * @param {function} [options.execFn] - injectable exec (tests)
 * @returns {{ owner: string, repo: string }}
 */
function resolveRepo(options = {}) {
  const execFn = options.execFn || ((cmd, opts) => execSync(cmd, opts).toString());
  const url = execFn(`git config --get remote.${options.remote || 'origin'}.url`, {
    cwd: options.cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = parseRemoteUrl(url);
  if (!parsed) {
    throw new Error(`Cannot parse a GitHub repo from remote url: ${String(url).trim() || '(none)'}`);
  }
  return parsed;
}

/**
 * Resolve a GitHub token: GH_TOKEN → GITHUB_TOKEN → `gh auth token`.
 * @param {object} [options]
 * @param {object} [options.env] - env map (default: process.env)
 * @param {function} [options.execFn] - injectable exec (tests)
 * @returns {string|null}
 */
function resolveToken(options = {}) {
  const env = options.env || process.env;
  if (env.GH_TOKEN) return env.GH_TOKEN;
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;

  const execFn = options.execFn || ((cmd, opts) => execSync(cmd, opts).toString());
  try {
    const token = execFn('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return token || null;
  } catch (e) {
    return null;
  }
}

/**
 * Build a workflow_dispatch plan — the exact REST call a deploy will make.
 * This IS the dry-run output: everything except the send.
 * @param {object} options
 * @param {string} options.owner - repo owner
 * @param {string} options.repo - repo name
 * @param {string} options.workflow - workflow file name (e.g. build.yml)
 * @param {string} [options.ref] - branch/tag to run on (default: main)
 * @param {object} [options.inputs] - workflow_dispatch inputs
 * @returns {{ method: string, url: string, body: object, runsUrl: string }}
 */
function buildDispatch(options) {
  for (const key of ['owner', 'repo', 'workflow']) {
    if (!options[key]) throw new Error(`buildDispatch: missing ${key}`);
  }
  const body = { ref: options.ref || 'main' };
  if (options.inputs && Object.keys(options.inputs).length > 0) body.inputs = options.inputs;

  return {
    method: 'POST',
    url: `${API_BASE}/repos/${options.owner}/${options.repo}/actions/workflows/${options.workflow}/dispatches`,
    body: body,
    runsUrl: `https://github.com/${options.owner}/${options.repo}/actions/workflows/${options.workflow}`,
  };
}

/**
 * Send a dispatch plan to GitHub (204 = accepted).
 * @param {object} plan - buildDispatch() result
 * @param {object} options
 * @param {string} options.token - GitHub token
 * @param {function} [options.fetchFn] - injectable fetch (tests)
 * @returns {Promise<object>} the plan, on success
 */
async function dispatchWorkflow(plan, options = {}) {
  if (!options.token) {
    throw new Error('No GitHub token — set GH_TOKEN in .env or sign in with `gh auth login`');
  }
  const fetchFn = options.fetchFn || fetch;
  const response = await fetchFn(plan.url, {
    method: plan.method,
    headers: ghHeaders(options.token),
    body: JSON.stringify(plan.body),
  });

  if (response.status !== 204) {
    const text = await response.text().catch(() => '');
    throw new Error(`workflow_dispatch failed (${response.status}): ${text || response.statusText || 'unknown error'}`);
  }
  return plan;
}

/**
 * The LANE half of the two lines a dispatch prints, one spelling for all four
 * verbs: `<mode> lane, ref <ref>`, plus the snapshot sha when the brand root
 * pushed one for this run ([#901](https://github.com/Omega-JS-Stack/omega/issues/901)),
 * so a fan-out's log shows every target dispatching the SAME snapshot.
 *
 * @param {{ mode: string, ref: string }} lane - The resolved lane.
 * @param {string} [snapshot] - The sha the run's snapshot sits at.
 * @returns {string} the parenthesised label, without its parentheses
 */
function laneLabel(lane, snapshot) {
  return `${lane.mode} lane, ref ${lane.ref}${snapshot ? ` @ ${shortSha(snapshot)}` : ''}`;
}

// The things a lane DOES, in one injectable seam (the `steps` shape
// `deploy-precheck` uses): the tests drive the order without a push, a pack or
// a network call, and the defaults are the real modules.
const LANE_STEPS = {
  origin: (options) => assertOriginMatches({ dir: options.root }),
  lockfile: assertBrandLockfile,
  defaultBranch: defaultBranchOf,
  heal: healDefaultBranch,
  behind: assertNotBehind,
  workflows: pushWorkflowFiles,
  stage: stageLocalPackages,
  push: pushSnapshot,
  waitRef: waitForRef,
  wait: waitForWorkflow,
};

/**
 * The origin gate ([#934](https://github.com/Omega-JS-Stack/omega/issues/934)):
 * a brand whose `origin` names another repo than the source repo its config
 * derives refuses, because every lane acts on the DERIVED repo (the snapshot
 * push, the workflow compose, the dispatch). It runs on every lane, the
 * dispatch-only one included: a brand outside git has no origin to disagree,
 * which the gate answers as nothing to compare. Read-only, so the dry run runs
 * it too.
 *
 * @param {object} lane - The resolved lane.
 * @param {object} steps - The lane steps (`origin` is the gate).
 * @returns {void}
 * @throws {Error} The drift line, naming `repo.owner`.
 */
function checkLaneOrigin(lane, steps) {
  steps.origin({ root: lane.brandRoot });
}

/**
 * The lockfile gate, where the lane ships the brand's OWN lock
 * ([#938](https://github.com/Omega-JS-Stack/omega/issues/938)): a registry
 * (unlinked) snapshot. A linked lane regenerates its lock in the pack step, and
 * a lane with no snapshot ships nothing, so neither has a lock of its own to
 * check. Read-only, so the dry run runs it too.
 *
 * @param {object} lane - The resolved lane.
 * @param {object} steps - The lane steps (`lockfile` is the gate).
 * @returns {void}
 * @throws {Error} The gate's refusal, naming `omega i live`.
 */
function checkLaneLockfile(lane, steps) {
  if (lane.mode === 'snapshot' && !lane.linked) {
    steps.lockfile({ root: lane.brandRoot });
  }
}

/**
 * The DELIVERY half of a lane: how this brand's code reaches GitHub before the
 * dispatch that runs it. ONE implementation for its two callers
 * ([#901](https://github.com/Omega-JS-Stack/omega/issues/901)): a target's own
 * `deployViaDispatch` below, and the brand-root fan-out, which runs it once for
 * the whole run rather than letting every target of a concurrent group perform
 * it at the same brand root at the same moment.
 *
 * What the lane delivers, in order
 * ([#915](https://github.com/Omega-JS-Stack/omega/issues/915)):
 * 0. on EVERY lane, the ORIGIN gate
 *    ([#934](https://github.com/Omega-JS-Stack/omega/issues/934)): a checkout
 *    whose `origin` is not the derived source repo refuses before this lane
 *    writes to that repo; then, on a registry (unlinked) lane, the LOCKFILE gate
 *    ([#938](https://github.com/Omega-JS-Stack/omega/issues/938)): the runner's
 *    `npm ci` installs the brand's lock as pushed, so one that disagrees with
 *    the manifests refuses here, before a branch is healed or a file written;
 * 1. the DEFAULT branch read once, and healed when published output has taken
 *    it over ([#922](https://github.com/Omega-JS-Stack/omega/issues/922)): a
 *    `gh-pages` default moves back to `main` here, before step 2 writes a
 *    workflow file to a branch the next web deploy force-pushes over;
 * 2. the BEHIND check, for a brand that is its own repo's toplevel: a checkout
 *    behind the remote default branch refuses, because the snapshot push below
 *    would overwrite the deploy branch with a tree that lacks what the admin
 *    publish committed there;
 * 3. the composed WORKFLOW FILES to the default branch, and only when they
 *    differ, because GitHub registers a workflow from that branch alone. This
 *    is the one write a deploy makes outside the deploy branch: the local tree
 *    is never committed, and what the developer has not committed stays theirs;
 * 4. the linked packages PACKED (tarballs are files in the tree, so they ride
 *    the snapshot like anything else untracked and not ignored), the brand
 *    folder pushed to the deploy branch as this run's snapshot, and the tree
 *    put back.
 *
 * A brand outside git (`repo: false`) delivers nothing at all: there is no
 * index to snapshot from, so the dispatch runs on whatever the branch holds.
 *
 * @param {object} options - Options.
 * @param {object} options.lane - The lane `resolveDeployLane` returned.
 * @param {string} [options.owner] - The snapshot's repo owner (snapshot lane).
 * @param {string} [options.repo] - The snapshot's repo name (snapshot lane).
 * @param {string} [options.ref] - The ref the snapshot lands on (default: the lane's).
 * @param {string} [options.token] - GitHub token for the snapshot push.
 * @param {string} [options.message] - Snapshot commit message.
 * @param {object} [options.logger] - Logger with `log` (silent when omitted).
 * @param {function} [options.fetchFn] - Injectable fetch (the ref wait, tests).
 * @param {object} [options.steps] - Lane step overrides (tests).
 * @returns {Promise<{ sha: string|null }>} the sha the snapshot landed at, and
 *   null on a lane that pushes none
 */
async function deliverLane(options) {
  const lane = options.lane;
  const logger = options.logger;
  const steps = { ...LANE_STEPS, ...(options.steps || {}) };
  const ref = options.ref || lane.ref;

  checkLaneOrigin(lane, steps);

  if (lane.mode !== 'snapshot') {
    return { sha: null };
  }

  checkLaneLockfile(lane, steps);

  // Read ONCE, used twice: the branch a behind checkout is measured against,
  // and the branch the composed workflows are pushed to. Null is a repo GitHub
  // does not have yet, and the snapshot push below is where that says itself.
  // A dry run returns before this whole function, so it reads nothing here and
  // heals nothing below ([#922](https://github.com/Omega-JS-Stack/omega/issues/922)).
  const current = await steps.defaultBranch({
    owner: options.owner,
    repo: options.repo,
    token: options.token,
    fetchFn: options.fetchFn,
  });

  // The gh-pages HEAL, on the name just read and before anything is written to
  // it (#922): published output is where the next web deploy's force-push wipes
  // whatever the compose step put there, so the default branch moves back to
  // main first and the rest of the lane uses the healed name.
  const branch = await steps.heal({
    owner: options.owner,
    repo: options.repo,
    current,
    token: options.token,
    fetchFn: options.fetchFn,
    logger,
  });

  if (branch) {
    // A NESTED brand's git toplevel is somebody else's repo (this monorepo, for
    // the playground), so there is no checkout of the brand's own repo to be
    // behind: nothing to compare, and nothing to refuse.
    if (!lane.nested) {
      steps.behind({ cwd: lane.brandRoot, branch, logger });
    }

    await steps.workflows({
      brandRoot: lane.brandRoot,
      owner: options.owner,
      repo: options.repo,
      branch,
      token: options.token,
      fetchFn: options.fetchFn,
      logger,
    });
  } else if (logger) {
    logger.log(`${options.owner}/${options.repo} answered no default branch (a repo nobody has created yet): no workflow compare, and the snapshot push speaks for itself.`);
  }

  if (logger) {
    logger.log(`Snapshotting ${lane.brandRoot} to ${options.owner}/${options.repo}#${ref}${lane.linked ? ' (packing its linked packages)' : ''}`);
  }

  const staging = lane.linked
    ? await steps.stage({ dir: lane.brandRoot, log: logger ? (line) => logger.log(line) : undefined })
    : null;

  let sha;

  try {
    sha = steps.push({
      brandRoot: lane.brandRoot,
      owner: options.owner,
      repo: options.repo,
      ref,
      token: options.token,
      message: options.message,
      // What the stage just wrote has to reach the runner, so the push
      // force-adds it past any ignore rule.
      require: staging ? [STAGING_DIR, 'package-lock.json'] : [],
    });
  } finally {
    // ALWAYS, and as early as possible: the push carried the staged shape, so
    // the developer's tree goes back before anything else can fail.
    if (staging) {
      await staging.restore();
    }
  }

  // Then the ref itself (#902): GitHub resolves the branch on its side, so a
  // dispatch sent in the same second as the push can still resolve to the
  // PREVIOUS commit and build a tree this deploy never pushed. Both callers get
  // the wait from here, so every target of a run dispatches a settled ref.
  await steps.waitRef({
    owner: options.owner,
    repo: options.repo,
    ref,
    sha,
    token: options.token,
    fetchFn: options.fetchFn,
    logger,
  });

  return { sha };
}

/**
 * The one deploy path: resolve repo + token, resolve the LANE, carry the code
 * to GitHub the way that lane says, then dispatch. A dryRun returns the plan
 * untouched instead.
 *
 * The lane runs only when the caller names a `dir` (a local tree). A
 * server-side dispatch (the admin post route) has no working tree at all and
 * addresses code GitHub already has, so it dispatches and nothing else.
 *
 * @param {object} options
 * @param {string} options.workflow - workflow file name
 * @param {string} [options.dir] - any dir inside the brand (turns the lane on)
 * @param {string} [options.cwd] - repo dir for remote resolution
 * @param {string} [options.owner] - explicit owner (skips git resolution)
 * @param {string} [options.repo] - explicit repo (skips git resolution)
 * @param {string} [options.ref] - branch (default: the lane's, else main)
 * @param {object} [options.inputs] - workflow inputs
 * @param {boolean} [options.dryRun] - build the plan but never send
 * @param {string} [options.message] - snapshot commit message
 * @param {string} [options.snapshot] - the sha a snapshot the CALLER already
 *   pushed to this lane's ref sits at (the brand-root fan-out's one push,
 *   [#901](https://github.com/Omega-JS-Stack/omega/issues/901)): the lane's
 *   delivery is done, so this run waits and dispatches against it
 * @param {object} [options.logger] - logger with `log` (silent when omitted)
 * @param {object} [options.env] - env map for token resolution
 * @param {function} [options.fetchFn] - injectable fetch
 * @param {function} [options.execFn] - injectable exec
 * @param {object} [options.steps] - lane step overrides (tests)
 * @returns {Promise<{ plan: object, dispatched: boolean, lane: object|null, sha: string|null }>}
 *   the plan, whether it was sent, the lane, and the sha this deploy dispatched
 *   against (the caller's `snapshot`, else the one the lane pushed, else null on
 *   a lane that pushes none, [#902](https://github.com/Omega-JS-Stack/omega/issues/902))
 */
async function deployViaDispatch(options) {
  const target = options.owner && options.repo
    ? { owner: options.owner, repo: options.repo }
    : resolveRepo({ cwd: options.cwd, execFn: options.execFn });

  const lane = options.dir ? resolveDeployLane({ dir: options.dir, execFn: options.execFn }) : null;
  const logger = options.logger;
  // What this deploy dispatches against, for the line it prints and for the
  // follower's head check (#902): the caller's snapshot when it has one, else
  // whatever the lane's own delivery pushed below.
  let sha = options.snapshot || null;

  // A sha only means something on the lane that pushes one (#901). A brand
  // with no repo snapshots nothing, so a sha claiming to be on its ref is a
  // ref this run never wrote: loud, at the boundary, before a step has run.
  if (options.snapshot && !(lane && lane.mode === 'snapshot')) {
    throw new Error(`--snapshot=${options.snapshot} is the snapshot lane's alone: this deploy takes the ${lane ? `${lane.mode} lane` : 'dispatch-only lane'}, which pushes no snapshot to skip.`);
  }

  const plan = buildDispatch({
    owner: target.owner,
    repo: target.repo,
    workflow: options.workflow,
    ref: options.ref || (lane ? lane.ref : null),
    inputs: options.inputs,
  });

  const steps = { ...LANE_STEPS, ...(options.steps || {}) };

  if (options.dryRun) {
    // The origin and lockfile gates only read, so a dry run refuses what the
    // real run would (#934, #938), as the version gate already does.
    if (lane) {
      checkLaneOrigin(lane, steps);
      checkLaneLockfile(lane, steps);
    }

    // The plan IS the dry run, the lane included: what would happen, with
    // nothing written to git and the network untouched (the gates above only
    // read). The workflow half of it is read off
    // DISK (the scaffold has already composed this run's files), so the preview
    // names them and the branch they would go to without asking GitHub which of
    // them differ (#915).
    if (logger && lane && lane.mode === 'snapshot') {
      const names = composedWorkflowFiles(lane.brandRoot).map((file) => file.name);

      logger.log(names.length
        ? `Would compare ${names.join(', ')} with ${target.owner}/${target.repo}'s default branch and push the ones missing or changed there in one \`chore(ci): compose\` commit (a dry run reads nothing, so which differ is unknown here); the brand folder itself goes to ${plan.body.ref}.`
        : `No composed workflow in ${lane.brandRoot}/.github/workflows: the default branch would receive nothing, and the brand folder goes to ${plan.body.ref}.`);
    }

    return { plan, dispatched: false, lane, sha };
  }

  const token = options.token || resolveToken({ env: options.env, execFn: options.execFn });

  if (lane && lane.mode === 'snapshot' && options.snapshot) {
    // The brand root pushed this run's snapshot ONCE, before it spawned a
    // target (#901), so every step of the delivery is already done: the
    // workflow compare, the packing and the push would only overwrite the very
    // ref the other targets of this run are dispatching against. The wait and
    // the dispatch below are the whole lane from here.
    if (logger) {
      logger.log(`Dispatching against the run's snapshot ${shortSha(options.snapshot)} on ${target.owner}/${target.repo}#${plan.body.ref} (the brand root pushed it once for every target)`);
    }
  } else if (lane) {
    // Whatever this lane delivers, it is delivered in ONE place (#901), so a
    // brand-root fan-out can run the very same delivery once for every target
    // of a run instead of once per target.
    const delivered = await deliverLane({
      lane,
      owner: target.owner,
      repo: target.repo,
      ref: plan.body.ref,
      token,
      message: options.message,
      logger,
      fetchFn: options.fetchFn,
      steps,
    });

    sha = delivered.sha;
  }

  if (lane) {
    // Both lanes wait the same way: GitHub indexes a workflow it has just
    // received a few seconds late, and a brand's FIRST deploy is exactly the
    // push that carries the composed file. The wait reads the default branch,
    // which is where a dispatch reads the workflow from.
    await steps.wait({
      owner: target.owner,
      repo: target.repo,
      workflow: options.workflow,
      ref: plan.body.ref,
      token,
      fetchFn: options.fetchFn,
      logger,
    });
  }

  await dispatchWorkflow(plan, { token, fetchFn: options.fetchFn });
  return { plan, dispatched: true, lane, sha };
}

/**
 * Find every `file:` @omega.js spec in the brand tree. npm resolves the
 * WHOLE workspace tree on any install, so one linked sibling target breaks a
 * CI install even when the deploying target is clean (the cp194 lesson —
 * linking is tree-wide, so detection is too). `resolveDeployLane` reads it
 * to pick the SNAPSHOT lane, which packs the linked frameworks so the runner
 * installs the same code this tree runs
 * ([#872](https://github.com/Omega-JS-Stack/omega/issues/872); this replaces
 * the 2026-07-20 rule that a linked brand built and shipped the artifact from
 * this machine, which is `--direct` now).
 * @param {object} [options]
 * @param {string} [options.dir] - Any directory inside the brand (default cwd).
 * @returns {string[]} One line per offender: `<manifest> → <name>: <spec>`.
 */
function findLocalSpecs(options = {}) {
  const brandRoot = findBrandRoot(options.dir || process.cwd());
  const offenders = [];

  for (const targetDir of discoverTargets(brandRoot)) {
    for (const entry of frameworkPackagesOf(targetDir)) {
      if (entry.spec.startsWith('file:')) {
        const manifest = path.relative(brandRoot, path.join(targetDir, 'package.json')) || 'package.json';
        offenders.push(`${manifest} → ${entry.name}: ${entry.spec}`);
      }
    }
  }

  return offenders;
}

/**
 * The LANE a deploy takes, derived once for every target
 * ([#872](https://github.com/Omega-JS-Stack/omega/issues/872)), and since
 * [#915](https://github.com/Omega-JS-Stack/omega/issues/915) there is ONE of
 * them: every brand with a git repo SNAPSHOTS its folder to `omega-deploy`, and
 * CI only ever builds that branch, whoever started the deploy. The push lane
 * (commit the developer's branch, push it, dispatch it) is gone, with the
 * `git add -A` commit that swept work nobody meant to ship.
 *
 * Two facts still ride ON the lane, because the steps read them:
 * - NESTED: the brand root is not the toplevel of the git repo it sits in (a
 *   brand inside this monorepo), so its git toplevel is somebody else's repo:
 *   the behind check has nothing to compare, and the secrets publisher skips
 *   its origin gate.
 * - LINKED: the brand tree carries a `file:` @omega.js spec anywhere. A runner
 *   can install none of those, so the packed tarballs have to travel with the
 *   snapshot.
 *
 * A brand outside git altogether (`repo` false) can snapshot nothing: its lane
 * is the wait and the dispatch alone, on whatever the deploy branch holds.
 *
 * @param {object} [options] - Options.
 * @param {string} [options.dir] - Any directory inside the brand (default cwd).
 * @param {function} [options.execFn] - Injectable exec (tests).
 * @returns {{ mode: string, ref: string, nested: boolean, linked: boolean, repo: boolean, brandRoot: string }}
 *   The lane, plus the brand root every step of it works from.
 */
function resolveDeployLane(options = {}) {
  const brandRoot = findBrandRoot(options.dir || process.cwd());
  const execFn = options.execFn || ((cmd, opts) => execSync(cmd, opts).toString());
  const git = (command) => {
    try {
      return String(execFn(command, { cwd: brandRoot, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    } catch (e) {
      // A brand outside git at all: there is nothing to snapshot and nothing to
      // push, so the lane is the plain one and the deploy speaks for itself.
      return '';
    }
  };

  const toplevel = git('git rev-parse --show-toplevel');
  const repo = Boolean(toplevel);
  const nested = repo && path.resolve(toplevel) !== path.resolve(brandRoot);
  const linked = findLocalSpecs({ dir: brandRoot }).length > 0;

  if (linked && !repo) {
    // A linked brand has to SNAPSHOT (the packed tarballs travel no other way),
    // and a snapshot is built out of a git index, so no repo is no lane. Said
    // by name HERE, because the push would otherwise die a step later on a raw
    // `fatal: not a git repository`.
    throw new Error(`${brandRoot} is not inside a git repo, and a linked brand needs a git repo to snapshot from: \`git init\` the brand, or restore registry versions with \`omega i live\`.`);
  }
  if (!repo) {
    // Nothing to snapshot FROM, and nothing linked that would need to: the
    // deploy is the wait and the dispatch, on whatever the branch already holds.
    return { mode: 'dispatch', ref: SNAPSHOT_REF, nested, linked, repo, brandRoot };
  }

  return { mode: 'snapshot', ref: SNAPSHOT_REF, nested, linked, repo, brandRoot };
}

/**
 * Refuse a deploy from a checkout that is BEHIND the repo's default branch
 * ([#915](https://github.com/Omega-JS-Stack/omega/issues/915)).
 *
 * The delivery pushes this folder over `omega-deploy` as this run's snapshot.
 * A checkout missing commits the default branch already carries would
 * therefore publish a site without them, and the admin publish is exactly
 * that case: it commits a post to the default branch and to the deploy branch,
 * and a stale laptop would push it back off both. So the deploy stops here, with the fix in the line.
 *
 * Plain git via argument arrays, like every other git call in this lane. No
 * `origin` remote, or a remote that has no such branch yet, is nothing to be
 * behind: both proceed.
 *
 * @param {object} options - Options.
 * @param {string} options.cwd - The brand root (its own repo's toplevel).
 * @param {string} options.branch - The repo's default branch.
 * @param {object} [options.logger] - Logger with `log` (silent when omitted).
 * @param {function} [options.execFn] - Injectable exec (tests).
 * @throws {Error} When `origin/<branch>` is not an ancestor of HEAD.
 */
function assertNotBehind(options) {
  const { cwd, branch, logger } = options;
  const execFn = options.execFn || ((args, opts) => execFileSync('git', args, opts));
  const git = (args) => execFn(args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    git(['fetch', 'origin', branch]);
  } catch (e) {
    // ONLY the two answers that really mean there is nothing to compare
    // against. A fetch that failed on the network, the token or the remote's
    // permissions says nothing about this checkout, and proceeding on it would
    // push a stale folder over everything the branch carries.
    const said = `${e.stderr || ''}${e.message || ''}`;

    if (!/couldn't find remote ref|does not appear to be a git repository|No such remote/i.test(said)) {
      throw new Error(`Could not fetch origin/${branch} in ${cwd}, so there is no telling whether this checkout is behind it, and the deploy pushes this checkout as its snapshot over ${SNAPSHOT_REF}. git said: ${said.trim() || 'nothing at all'}`);
    }

    if (logger) logger.log(`No origin/${branch} to compare against yet: nothing to be behind.`);
    return;
  }

  try {
    // Exits 0 exactly when the remote branch is already in this history.
    git(['merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD']);
  } catch (e) {
    throw new Error(`This checkout is behind origin/${branch}, and the deploy pushes it as its snapshot over ${SNAPSHOT_REF}: anything ${branch} carries that you do not (a post the admin published, a sibling's commit) would be deployed away. Run \`git pull\` in ${cwd}, then deploy again.`);
  }
}

module.exports = {
  parseRemoteUrl,
  dispatchRepo,
  dispatchTarget,
  resolveRepo,
  resolveToken,
  buildDispatch,
  dispatchWorkflow,
  deployViaDispatch,
  deliverLane,
  laneLabel,
  findLocalSpecs,
  resolveDeployLane,
  assertNotBehind,
  SNAPSHOT_REF,
};
