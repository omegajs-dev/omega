/**
 * deploy-snapshot: push a brand folder to its repo as a MIRROR, then wait for
 * GitHub to see the workflow there
 * ([#872](https://github.com/Omega-JS-Stack/omega/issues/872)).
 *
 * A workflow only ever runs from code GitHub already has. A brand that is not
 * its own repo's toplevel (a brand inside this monorepo) and a brand carrying
 * `file:` links (whose packed tarballs must never enter its real history) both
 * hit the same wall: there is nothing to dispatch against. So the deploy pushes
 * what it has, as it is (Ian, 2026-09-10: "we just push the contents of the
 * repository whenever we need to use it"), and dispatches that.
 *
 * The commit is built OUT OF THE WAY: a temporary index, no branch, no stash,
 * no checkout, nothing a `git status` or a `git branch` can see, and the working
 * tree the developer is looking at is never touched. Its ROOT is the BRAND
 * FOLDER, never the enclosing repo's, so the mirror is a brand checkout and not
 * a copy of whatever tree the brand happens to live in. Its PARENT is the deploy
 * ref's current tip on the mirror, fetched by ref name into FETCH_HEAD alone, so
 * the ref's history is snapshots only and the push carries just what the mirror
 * lacks; the first snapshot on a mirror is parentless. The brand's own history
 * never rides, which is what keeps a public brand repo from receiving the
 * private tree it was cut from, and nothing here commits anything a developer
 * did not. The push is a fast-forward, never forced, so a ref another deploy
 * moved meanwhile fails the push loudly.
 *
 * ONE write ever reaches a repo's DEFAULT branch, and it is `pushWorkflowFiles`
 * below: GitHub registers a workflow from the default branch (the listing and
 * the dispatch both read the file from there, and the `ref` only picks the
 * checkout the run uses), so the composed `.github/workflows/*.yml` have to BE
 * there for the deploy branch to be buildable at all. It compares bytes first
 * and pushes only what is missing or changed, through the git data API, so no
 * working tree, index or local branch is involved in that either.
 *
 * What rides is what the brand's own ignore rules allow: tracked files plus
 * untracked-not-ignored ones. What MUST ride is force-added past any ignore rule
 * (the brand's own or one inherited from an enclosing repo) when it exists: the
 * minted set the web build bridges (@omega.js/config's MINT_BRIDGE, the only
 * part of `.omega/` that travels), the staged `omega_modules/` tarballs and
 * lockfile the caller names, and the company layer's resolved file.
 *
 * The COMPANY layer rides the same way, resolved here and generated as one file
 * ([#677](https://github.com/Omega-JS-Stack/omega/issues/677)): the machine that
 * dispatches has the machine registry and the company tree, and the runner has
 * neither, so what the runner gets is the ANSWER. No runner ever reads
 * `company/`. The env half needs nothing: the deploy precheck publishes the COMPOSED
 * target env (company then brand then target), so the company's `.env` values
 * are already repo secrets by the time a workflow runs.
 *
 * The token travels in the environment (`http.extraheader` through
 * GIT_CONFIG_*), never in argv, where every `ps` on the machine would read it.
 * That delivery, and the scrub a failure is rethrown through, are
 * `@omega.js/devkit/git-auth`'s: the web deploy's gh-pages push is the other
 * lane pushing to a repo its checkout is not authenticated for, and one
 * spelling of the rule is what keeps a token out of BOTH
 * ([#883](https://github.com/Omega-JS-Stack/omega/issues/883)).
 */

// Libraries
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const jetpack = require('fs-jetpack');
const { resolveCompany, COMPANY_RESOLVED_FILE, mintBridgeSources } = require('@omega.js/config');
const { gitAuthEnv, scrubbedFailure } = require('./git-auth.js');
const { composedWorkflowOwner } = require('./ci-workflows.js');
const { formatJson } = require('./write-json.js');

// Constants
const API_BASE = 'https://api.github.com';
const SNAPSHOT_MESSAGE = 'chore(deploy): snapshot the brand for this run';
// Where GitHub reads a workflow from, in the repo and on disk alike.
const WORKFLOWS_DIR = '.github/workflows';
// GitHub indexes a freshly pushed workflow a few seconds after the push, and a
// dispatch before that 404s: about a minute of polling, then a loud failure.
const POLL_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 3000;

/** Run a command and capture its stdout (a file and an argument array, never a shell string). */
function execCommand(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', ...options });
}

/**
 * A sha as every GitHub surface shows it: the first seven characters. Spelled
 * ONCE here, in the leaf every deploy module already imports, so a snapshot sha
 * reads the same in a dispatch line, a follow line and a brand root's log.
 *
 * @param {string} sha - The full commit sha.
 * @returns {string} its short form
 */
function shortSha(sha) {
  return String(sha).slice(0, 7);
}

/**
 * Push the brand folder to `<owner>/<repo>` at `ref` as a mirror snapshot,
 * parented on that ref's current remote tip.
 *
 * @param {object} options - Options.
 * @param {string} options.brandRoot - The brand folder to snapshot.
 * @param {string} options.owner - The mirror repo's owner.
 * @param {string} options.repo - The mirror repo's bare name.
 * @param {string} options.ref - The deploy ref the snapshot chain lands on (`omega-deploy`).
 * @param {string} options.token - The GitHub token, carried in the env.
 * @param {string} [options.message] - The snapshot commit's message.
 * @param {string[]} [options.require] - Brand-relative paths force-added when
 *   present (a linked brand's staged `omega_modules/` and lockfile).
 * @param {Function} [options.execFn] - The command runner (tests).
 * @param {string} [options.indexFile] - The temporary index to build in.
 * @returns {string} The pushed commit sha.
 */
function pushSnapshot(options) {
  const {
    brandRoot,
    owner,
    repo,
    ref,
    token,
    message = SNAPSHOT_MESSAGE,
    execFn = execCommand,
    indexFile = path.join(os.tmpdir(), `omega-snapshot-index-${process.pid}`),
  } = options;

  for (const key of ['brandRoot', 'owner', 'repo', 'ref', 'token']) {
    if (!options[key]) {
      throw new Error(`pushSnapshot: missing ${key}`);
    }
  }

  const git = (...args) => execFn('git', args, { cwd: brandRoot, env: { ...process.env, GIT_INDEX_FILE: indexFile } });
  // The network calls run on the real index: a fetch can start git's auto
  // maintenance, which must never see the temporary one.
  const remote = (...args) => execFn('git', args, { cwd: brandRoot, env: { ...process.env, ...gitAuthEnv(token) } });
  const url = `https://github.com/${owner}/${repo}.git`;

  // Resolved HERE, received THERE (#677): generated before the tree is staged,
  // removed the moment the push is done.
  const companyLayer = writeCompanyLayer(brandRoot);

  try {
    const toplevel = git('rev-parse', '--show-toplevel').trim();
    // Index paths are always repo-root relative, so the prefix is what turns
    // the enclosing repo's tree into the brand's own.
    const prefix = path.relative(toplevel, path.resolve(brandRoot)).split(path.sep).join('/');

    // Seed the temporary index from HEAD, then stage the brand folder into it:
    // `git add` writes only the index GIT_INDEX_FILE names, and seeding is what
    // keeps a tracked-but-ignored file (there ON PURPOSE) in the snapshot.
    // A brand whose repo has no commit yet has nothing to seed from.
    if (hasCommit(git)) {
      git('read-tree', 'HEAD');
    }
    git('add', '-A', '--', '.');

    // What the runner cannot make rides by force past any ignore rule: the minted
    // set (no image tooling there), the staged install and the company answer.
    const required = (options.require || []).filter((entry) => jetpack.exists(path.join(brandRoot, entry)));
    const forced = [...mintBridgeSources(brandRoot), ...required, ...(companyLayer ? [COMPANY_RESOLVED_FILE] : [])];
    if (forced.length) {
      git('add', '-f', '--', ...forced);
    }

    const tree = git('write-tree').trim();
    const brandTree = prefix ? subtreeOf(git, tree, prefix) : tree;
    // Chained on the previous snapshot, never on HEAD: the ref's history is
    // snapshots only, and the tree it was cut from stays off the brand's repo.
    const parent = remoteTip({ git, remote, url, owner, repo, ref, token });
    const sha = git('commit-tree', brandTree, ...(parent ? ['-p', parent] : []), '-m', message).trim();

    // Pushed BY SHA, so no local branch is ever created here. Not forced: a
    // chained snapshot fast-forwards, and a ref moved since the read refuses.
    try {
      remote('push', url, `${sha}:refs/heads/${ref}`);
    } catch (error) {
      throw scrubbedFailure(`Pushing the snapshot to ${owner}/${repo}`, error, token);
    }

    return sha;
  } finally {
    if (companyLayer) jetpack.remove(companyLayer);
    jetpack.remove(indexFile);
  }
}

/**
 * The deploy ref's tip on the mirror, fetched by ref name so its commit and
 * objects exist locally: FETCH_HEAD only, no local ref and no branch.
 *
 * @param {object} options - Options.
 * @param {Function} options.git - The bound git runner for local calls.
 * @param {Function} options.remote - The bound git runner carrying the auth env.
 * @param {string} options.url - The mirror's url.
 * @param {string} options.owner - The mirror repo's owner.
 * @param {string} options.repo - The mirror repo's bare name.
 * @param {string} options.ref - The deploy branch.
 * @param {string} options.token - The GitHub token, scrubbed from a failure.
 * @returns {string|null} The tip's sha, or null when the mirror has no such ref.
 */
function remoteTip({ git, remote, url, owner, repo, ref, token }) {
  const what = `Reading ${owner}/${repo}#${ref}`;

  try {
    remote('ls-remote', '--exit-code', url, `refs/heads/${ref}`);
  } catch (error) {
    // `--exit-code` answers 2 for a ref the mirror does not have: a first snapshot.
    if (error && error.status === 2) return null;
    throw scrubbedFailure(what, error, token);
  }

  try {
    remote('fetch', url, `refs/heads/${ref}`);
  } catch (error) {
    throw scrubbedFailure(what, error, token);
  }

  return git('rev-parse', 'FETCH_HEAD').trim();
}

/**
 * Generate the resolved company layer beside the brand config, for a brand that
 * HAS a company somewhere else ([#677](https://github.com/Omega-JS-Stack/omega/issues/677)).
 *
 * A brand with no company, and the company brand itself (`company: { id: 'self' }`,
 * whose `company/` folder is part of its own repo), both resolve off-laptop with
 * no help and get no file.
 *
 * @param {string} brandRoot - The brand folder being snapshotted.
 * @returns {string|null} The generated file, or null when there was nothing to carry.
 */
function writeCompanyLayer(brandRoot) {
  const { id, name, url, images, webhooks, config } = resolveCompany(brandRoot);
  if (!id || id === 'self') return null;

  const file = path.join(brandRoot, COMPANY_RESOLVED_FILE);
  const layer = { config: config || {}, company: { id, name, url, images, webhooks } };

  jetpack.write(file, `// GENERATED by omega deploy (#677): the company layer this run resolved.\n// Never edit, never commit: the snapshot carries it and then removes it.\n${formatJson(layer)}`);

  return file;
}

/** Does this repo have a commit to seed the index from? */
function hasCommit(git) {
  try {
    git('rev-parse', '--verify', 'HEAD');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * The tree object of one directory inside a tree: the brand folder, promoted to
 * the root of what gets committed.
 * @param {Function} git - The bound git runner.
 * @param {string} tree - The enclosing tree's id.
 * @param {string} prefix - The brand folder, repo-root relative.
 * @returns {string} The subtree's id.
 */
function subtreeOf(git, tree, prefix) {
  // `--full-tree`: a path is read from the REPO ROOT, and this runs inside the
  // brand folder, where the prefix names nothing.
  const entry = git('ls-tree', '--full-tree', tree, '--', prefix).trim();
  const match = entry.match(/^\d+ tree ([0-9a-f]+)\t/);

  if (!match) {
    throw new Error(`Could not read the brand folder ${prefix} out of the snapshot tree (got: ${entry || 'nothing'})`);
  }

  return match[1];
}

/** The headers every GitHub REST call here carries. */
function ghHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'omega-deploy',
  };
}

/**
 * A failed GitHub call's status and response body, the body being where GitHub
 * says why (a token without admin scope explains itself there).
 *
 * @param {Response} response - The failed response.
 * @returns {Promise<string>} `(<status>): <body>`.
 */
async function failureDetail(response) {
  const body = await response.text().catch(() => '');
  return `(${response.status}): ${body || response.statusText || 'unknown error'}`;
}

/**
 * The composed workflow files a brand carries, the ones GitHub has to have on
 * its DEFAULT branch before any dispatch of them resolves
 * ([#915](https://github.com/Omega-JS-Stack/omega/issues/915)).
 *
 * Read from disk, never from git: every verb's scaffold composes these into
 * `<brandRoot>/.github/workflows/` before the delivery runs, so what is on disk
 * IS this run's CI.
 *
 * @param {string} brandRoot - The brand folder being deployed.
 * @returns {Array<{ name: string, path: string, content: string }>} One entry
 *   per composed workflow, its `path` repo-root relative.
 */
function composedWorkflowFiles(brandRoot) {
  const dir = path.join(brandRoot, ...WORKFLOWS_DIR.split('/'));

  return (jetpack.list(dir) || [])
    .filter((name) => name.endsWith('.yml'))
    .sort()
    .map((name) => ({
      name,
      path: `${WORKFLOWS_DIR}/${name}`,
      content: jetpack.read(path.join(dir, name)),
    }))
    .filter((file) => typeof file.content === 'string');
}

/**
 * A repo's DEFAULT branch: the ONE read of it, shared by every step that needs
 * the name ([#915](https://github.com/Omega-JS-Stack/omega/issues/915)).
 *
 * @param {object} options - Options.
 * @param {string} options.owner - The repo's owner.
 * @param {string} options.repo - The repo's bare name.
 * @param {string} options.token - The GitHub token.
 * @param {Function} [options.fetchFn] - Injectable fetch (tests).
 * @returns {Promise<string|null>} The branch name, and null for a repo GitHub
 *   does not have yet (the snapshot push that follows says so loudly enough).
 * @throws {Error} On any answer but 200 or 404: a reachable repo that will not
 *   report its default branch is not something to guess at.
 */
async function defaultBranchOf({ owner, repo, token, fetchFn = fetch }) {
  const response = await fetchFn(`${API_BASE}/repos/${owner}/${repo}`, { headers: ghHeaders(token) });

  if (response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new Error(`Could not read ${owner}/${repo}'s default branch ${await failureDetail(response)}. The deploy needs it to know where the composed workflows go.`);
  }

  return (await response.json()).default_branch || null;
}

/**
 * Push the composed workflow files to the repo's DEFAULT branch, and ONLY them
 * ([#915](https://github.com/Omega-JS-Stack/omega/issues/915)).
 *
 * GitHub registers a workflow from the default branch, so a deploy branch
 * nobody can dispatch is a deploy that cannot run. That is the whole reason
 * this write exists, and it is the only write a deploy ever makes to a default
 * branch (Ian, 2026-09-14: "if all we are pushing to main is the gh workflow
 * files that's fine"). Each file's bytes are compared with what the branch
 * holds; when every one matches, nothing is written at all. A branch file
 * that carries the GENERATED header and is no longer composed (a renamed or
 * dropped target) is RETIRED in the same commit; a hand-written one never is.
 *
 * Through the git DATA api, never a working-tree commit: blobs, a tree on top
 * of the branch's own, a commit whose parent is its head. An EMPTY repo (no
 * head yet) gets a parentless commit and a created ref.
 *
 * @param {object} options - Options.
 * @param {string} options.brandRoot - The brand folder whose workflows these are.
 * @param {string} options.owner - The repo's owner.
 * @param {string} options.repo - The repo's bare name.
 * @param {string} options.branch - The repo's default branch.
 * @param {string} options.token - The GitHub token.
 * @param {Function} [options.fetchFn] - Injectable fetch (tests).
 * @param {object} [options.logger] - Logger with `log` (silent when omitted).
 * @returns {Promise<{ pushed: string[], removed: string[], sha: string|null }>} What was written.
 */
async function pushWorkflowFiles({ brandRoot, owner, repo, branch, token, fetchFn = fetch, logger }) {
  const files = composedWorkflowFiles(brandRoot);

  if (files.length === 0) {
    if (logger) logger.log(`No composed workflow in ${brandRoot}/${WORKFLOWS_DIR}: ${branch} is untouched.`);
    return { pushed: [], removed: [], sha: null };
  }

  const call = async (route, init) => {
    const response = await fetchFn(`${API_BASE}/repos/${owner}/${repo}${route}`, { headers: ghHeaders(token), ...init });
    return response;
  };
  const read = async (response, expected, what) => {
    if (!expected.includes(response.status)) {
      throw new Error(`${what} on ${owner}/${repo} failed ${await failureDetail(response)}`);
    }
    // Every ACCEPTED non-2xx reads as "not there": a 404 for a file the branch
    // does not hold, a 409 for a repo with no commits at all.
    return response.status < 300 ? response.json() : null;
  };

  // What the branch is missing or holds differently. The contents API answers
  // per file, which is also how a 404 tells the two apart from a whole branch
  // that is not there yet.
  const changed = [];

  for (const file of files) {
    const current = await read(
      await call(`/contents/${file.path}?ref=${encodeURIComponent(branch)}`),
      [200, 404],
      `Reading ${file.name}`,
    );

    if (!current) {
      changed.push({ ...file, reason: 'missing' });
    } else if (Buffer.from(current.content || '', 'base64').toString('utf8') !== file.content) {
      changed.push({ ...file, reason: 'changed' });
    }
  }

  // What the branch holds that this brand no longer composes. The same double
  // lock as the local prune: the GENERATED header and the composed naming, so
  // a hand-written workflow is never a candidate. No listing means no files.
  const composed = new Set(files.map((file) => file.name));
  const listing = await read(
    await call(`/contents/${WORKFLOWS_DIR}?ref=${encodeURIComponent(branch)}`),
    [200, 404],
    `Listing ${WORKFLOWS_DIR}`,
  );
  const retired = [];

  for (const entry of listing || []) {
    if (entry.type !== 'file' || !entry.name.endsWith('.yml') || composed.has(entry.name)) {
      continue;
    }

    const held = await read(await call(`/contents/${entry.path}?ref=${encodeURIComponent(branch)}`), [200], `Reading ${entry.name}`);
    if (composedWorkflowOwner(entry.name, Buffer.from(held.content || '', 'base64').toString('utf8'))) {
      retired.push({ name: entry.name, path: entry.path });
    }
  }

  if (changed.length === 0 && retired.length === 0) {
    if (logger) logger.log(`${owner}/${repo}#${branch} already carries ${files.map((file) => file.name).join(', ')}: nothing pushed to ${branch}.`);
    return { pushed: [], removed: [], sha: null };
  }

  // The head this commit sits on. A repo with no commit at all answers 404, and
  // a freshly created one answers 409 `Git Repository is empty.`; both mean no
  // head, so the first commit is parentless with no base tree to build on.
  const head = await read(await call(`/git/ref/heads/${encodeURIComponent(branch)}`), [200, 404, 409], `Reading ${branch}`);
  const parents = head ? [head.object.sha] : [];
  const baseTree = head
    ? (await read(await call(`/git/commits/${head.object.sha}`), [200], 'Reading the head commit')).tree.sha
    : null;

  const tree = [];
  for (const file of changed) {
    const blob = await read(
      await call('/git/blobs', { method: 'POST', body: JSON.stringify({ content: Buffer.from(file.content).toString('base64'), encoding: 'base64' }) }),
      [201],
      `Writing ${file.name}`,
    );
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (const file of retired) {
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: null });
  }

  const names = [
    ...(changed.length ? [`compose ${changed.map((file) => file.name).join(', ')}`] : []),
    ...(retired.length ? [`retire ${retired.map((file) => file.name).join(', ')}`] : []),
  ].join(', ');
  const written = await read(
    await call('/git/trees', { method: 'POST', body: JSON.stringify({ ...(baseTree ? { base_tree: baseTree } : {}), tree }) }),
    [201],
    'Writing the tree',
  );
  const commit = await read(
    await call('/git/commits', { method: 'POST', body: JSON.stringify({ message: `chore(ci): ${names}`, tree: written.sha, parents }) }),
    [201],
    'Writing the commit',
  );

  await read(
    head
      ? await call(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) })
      : await call('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) }),
    head ? [200] : [201],
    `Updating ${branch}`,
  );

  if (logger) {
    const touched = [
      ...changed.map((file) => `${file.name} (${file.reason})`),
      ...retired.map((file) => `${file.name} (retired)`),
    ];
    logger.log(`Pushed ${touched.join(', ')} to ${owner}/${repo}#${branch} as ${shortSha(commit.sha)}: GitHub registers a workflow from the default branch.`);
  }

  return { pushed: changed.map((file) => file.name), removed: retired.map((file) => file.name), sha: commit.sha };
}

/**
 * Point a repo's DEFAULT branch back at `main` when published output has taken
 * it over ([#872](https://github.com/Omega-JS-Stack/omega/issues/872),
 * [#922](https://github.com/Omega-JS-Stack/omega/issues/922)).
 *
 * GitHub registers a workflow from the DEFAULT branch: the listing the wait
 * polls and the dispatch that follows both read the file from there, and the
 * `ref` only picks which checkout the run uses. A brand whose first web deploy
 * created `gh-pages` on an empty repo has GitHub pointing at the published
 * site, where `pushWorkflowFiles` would compose the workflows only for the next
 * web deploy's force-push to wipe them. Built output is never the default
 * branch (the same rule the manager's repo ensure applies), and a deploy is
 * often what CREATES that state, so the fix belongs here too.
 *
 * It runs from the LANE's first step, where the default branch is read, before
 * a single workflow file is written, and on the name that read returned: never
 * a second read (the one-read rule from
 * [#915](https://github.com/Omega-JS-Stack/omega/issues/915)). Once per repo,
 * because after the flip the default IS `main`, and a dry run never reaches it.
 *
 * @param {object} options - Options.
 * @param {string} options.owner - The repo's owner.
 * @param {string} options.repo - The repo's bare name.
 * @param {string|null} options.current - The default branch already read.
 * @param {string} options.token - The GitHub token.
 * @param {Function} [options.fetchFn] - Injectable fetch (tests).
 * @param {object} [options.logger] - Logger with `log` (silent when omitted).
 * @returns {Promise<string|null>} The branch the rest of the lane uses:
 *   `current` untouched, and `main` once a gh-pages default has been healed.
 * @throws {Error} When the heal fails: composing onto gh-pages is the broken
 *   outcome it exists to prevent, so the deploy never continues past it.
 */
async function healDefaultBranch({ owner, repo, current, token, fetchFn = fetch, logger }) {
  if (current !== 'gh-pages') {
    return current;
  }

  const url = `${API_BASE}/repos/${owner}/${repo}`;
  const headers = ghHeaders(token);
  const byHand = 'Set the default branch by hand and re-run the deploy.';

  // The branch the default moves TO may not exist at all: a repo whose first
  // web deploy created gh-pages on an empty repo carries that one branch, so
  // `main` is created from the head it holds.
  const existing = await fetchFn(`${url}/git/ref/heads/main`, { headers });

  if (existing.status === 404) {
    const source = await fetchFn(`${url}/git/ref/heads/gh-pages`, { headers });

    if (source.status !== 200) {
      throw new Error(`${owner}/${repo} has no main branch and reading gh-pages to create one from failed ${await failureDetail(source)}. ${byHand}`);
    }

    const created = await fetchFn(`${url}/git/refs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ref: 'refs/heads/main', sha: (await source.json()).object.sha }),
    });

    if (created.status !== 201) {
      throw new Error(`${owner}/${repo} has no main branch and creating one from gh-pages failed ${await failureDetail(created)}. ${byHand}`);
    }
  } else if (existing.status !== 200) {
    throw new Error(`Could not read ${owner}/${repo}'s main branch ${await failureDetail(existing)}, so the deploy cannot tell whether the default branch can move there. ${byHand}`);
  }

  const patch = await fetchFn(url, { method: 'PATCH', headers, body: JSON.stringify({ default_branch: 'main' }) });

  if (patch.status !== 200) {
    throw new Error(`${owner}/${repo}'s default branch is gh-pages, where no workflow lives, and moving it back to main failed ${await failureDetail(patch)}. ${byHand}`);
  }

  if (logger) {
    logger.log(`${owner}/${repo}'s default branch was gh-pages (published output), and GitHub registers workflows from the default branch: moved it back to main.`);
  }

  return 'main';
}

/**
 * Wait for GitHub to REGISTER a workflow on the repo the snapshot just reached.
 *
 * GitHub takes a few seconds to index a workflow it has just received, and a
 * dispatch before that answers `404: workflow not found`. So the push is
 * followed by a bounded wait rather than by a hand-run second attempt.
 *
 * @param {object} options - Options.
 * @param {string} options.owner - The repo's owner.
 * @param {string} options.repo - The repo's bare name.
 * @param {string} options.workflow - The workflow file name.
 * @param {string} options.ref - The ref the snapshot went to (for the failure).
 * @param {string} options.token - The GitHub token.
 * @param {Function} [options.fetchFn] - Injectable fetch (tests).
 * @param {number} [options.attempts] - The poll budget.
 * @param {number} [options.delayMs] - The wait between polls.
 * @param {object} [options.logger] - Logger with `log` (silent when omitted).
 * @returns {Promise<void>} Resolves once GitHub answers for the workflow.
 */
async function waitForWorkflow(options) {
  const {
    owner, repo, workflow, ref, token, logger,
    fetchFn = fetch,
    attempts = POLL_ATTEMPTS,
    delayMs = POLL_INTERVAL_MS,
  } = options;

  const url = `${API_BASE}/repos/${owner}/${repo}/actions/workflows/${workflow}`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetchFn(url, { headers: ghHeaders(token) });

    if (response.status === 200) {
      return;
    }

    if (logger) {
      logger.log(`[${attempt}/${attempts}] ${workflow} is not registered on ${owner}/${repo} yet...`);
    }

    // The last attempt has nothing left to wait for.
    if (attempt < attempts) {
      await delay(delayMs);
    }
  }

  throw new Error(`${workflow} is still not registered on ${owner}/${repo} (pushed to ${ref}) ${Math.round((attempts * delayMs) / 1000)}s after the push. GitHub indexes a pushed workflow within seconds, so this is a push that did not carry the file, or a repo whose default branch is not where the workflow landed. Check https://github.com/${owner}/${repo}/actions`);
}

/**
 * Wait for a ref to RESOLVE to the sha this run just pushed
 * ([#902](https://github.com/Omega-JS-Stack/omega/issues/902)).
 *
 * A push returns as soon as GitHub accepts it, but GitHub resolves the
 * branch on its own side: a dispatch sent in the same second can still resolve
 * `main` to the PREVIOUS commit, and the run then builds a tree this deploy
 * never pushed, green, with nothing in its log saying so. So the push is
 * followed by a bounded wait on the ref itself, exactly as the workflow
 * listing is waited for above.
 *
 * @param {object} options - Options.
 * @param {string} options.owner - The repo's owner.
 * @param {string} options.repo - The repo's bare name.
 * @param {string} options.ref - The branch the snapshot went to.
 * @param {string} options.sha - The sha the push returned.
 * @param {string} options.token - The GitHub token.
 * @param {Function} [options.fetchFn] - Injectable fetch (tests).
 * @param {number} [options.attempts] - The poll budget.
 * @param {number} [options.delayMs] - The wait between polls.
 * @param {object} [options.logger] - Logger with `log` (silent when omitted).
 * @returns {Promise<void>} Resolves once the ref carries the pushed sha.
 * @throws {Error} When the budget runs out on another sha.
 */
async function waitForRef(options) {
  const {
    owner, repo, ref, sha, token, logger,
    fetchFn = fetch,
    attempts = POLL_ATTEMPTS,
    delayMs = POLL_INTERVAL_MS,
  } = options;

  const url = `${API_BASE}/repos/${owner}/${repo}/git/ref/heads/${ref}`;
  let last = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetchFn(url, { headers: ghHeaders(token) });

    // A ref GitHub has not created yet (a first push) answers 404, which is a
    // miss like any other resolution that is not this run's.
    if (response.status === 200) {
      const seen = ((await response.json()).object || {}).sha;

      if (seen === sha) {
        return;
      }

      last = seen ? `sha ${seen}` : 'no sha at all';

      if (logger) {
        logger.log(`[${attempt}/${attempts}] ${owner}/${repo}#${ref} still resolves to ${shortSha(seen)}, waiting for ${shortSha(sha)}...`);
      }
    } else {
      last = `status ${response.status}`;

      if (logger) {
        logger.log(`[${attempt}/${attempts}] ${owner}/${repo}#${ref} answered ${response.status}, waiting for ${shortSha(sha)}...`);
      }
    }

    // The last attempt has nothing left to wait for.
    if (attempt < attempts) {
      await delay(delayMs);
    }
  }

  throw new Error(`${owner}/${repo}#${ref} still does not carry the snapshot this deploy pushed (${sha}) ${Math.round((attempts * delayMs) / 1000)}s after the push: GitHub last reported ${last}. Dispatching now would build a tree this deploy did not push. Check https://github.com/${owner}/${repo}/commits/${ref}`);
}

module.exports = {
  pushSnapshot,
  pushWorkflowFiles,
  composedWorkflowFiles,
  defaultBranchOf,
  healDefaultBranch,
  waitForWorkflow,
  waitForRef,
  ghHeaders,
  shortSha,
  SNAPSHOT_MESSAGE,
};
