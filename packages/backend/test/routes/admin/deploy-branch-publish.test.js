/**
 * Test: the admin publish writes to the DEPLOY branch and dispatches there
 * ([#919](https://github.com/Omega-JS-Stack/omega/issues/919)).
 *
 * CI only ever builds `omega-deploy` ([#915](https://github.com/Omega-JS-Stack/omega/issues/915)),
 * where the last local deploy left the framework tarballs, the rewritten
 * manifests and the lockfile. So an admin publish that committed the post to
 * the default branch and dispatched THAT branch built nothing on a brand
 * running local (unpublished) framework packages: the runner's install hit a
 * `file:` spec naming a folder on the developer's machine. Both halves move
 * here: the write goes to both branches, and the dispatch names the deploy one.
 *
 * All THREE writers are pinned, because the admin routes write repo content
 * three ways: the post CREATE (a Git Trees commit carrying the article and its
 * images), the post EDIT and the content route (contents-API file writes).
 *
 * Offline by construction: Octokit is a recorder, `fetch` is stubbed for the
 * dispatch, and the branch name is read from devkit rather than typed.
 *
 * Run: npx omega test backend:routes/admin/deploy-branch-publish
 */
const dispatchDeploy = require('../../../dist/omega/routes/admin/post/dispatch-deploy.js');
const { commitAll } = require('../../../dist/omega/routes/admin/post/commit-all.js');
const { uploadPost } = require('../../../dist/omega/routes/admin/post/upload-post.js');
const { uploadContent } = require('../../../dist/omega/routes/admin/repo/content/upload-content.js');
const { SNAPSHOT_REF } = require('../../../dist/vendor/devkit/deploy.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

/** A ctx that records what the route said. */
const recordingCtx = (said) => ({ log: (line) => said.push(String(line)), warn: (line) => said.push(String(line)) });

/**
 * An Octokit double: every write recorded, the ONE branch-exists read
 * (`git.getRef`) answering whether the deploy branch is there, `getContent`
 * answering per branch, and the git-data routes the CREATE route commits
 * through (blobs, trees, commits, refs).
 *
 * @param {object} [options] - `deployBranch: false` is a brand nobody has
 *   deployed locally yet; `refStatus` is the status THAT read fails with (404 =
 *   no branch, 401 = a token that cannot read it); `held` names the paths each
 *   branch already carries.
 * @returns {{ octokit: object, writes: object[], git: object }} The double.
 */
function octokitDouble({ deployBranch = true, held = {}, refStatus = 404 } = {}) {
  const writes = [];
  // Every git-data call the trees lane makes, in order, so a test can assert
  // WHICH ref moved to WHAT and how many blobs were uploaded for it.
  const git = { blobs: [], trees: [], commits: [], refs: [] };
  const notFound = (message) => Object.assign(new Error(message), { status: 404 });
  const refFailure = (message) => Object.assign(new Error(message), { status: refStatus });
  const heads = { 'heads/main': 'head-main', 'heads/master': null, [`heads/${SNAPSHOT_REF}`]: deployBranch ? 'head-deploy' : null };

  return {
    writes,
    git,
    octokit: {
      rest: {
        repos: {
          getContent: async ({ path, ref }) => {
            const key = `${ref || 'default'}:${path}`;
            if (!held[key]) throw notFound('Not Found');
            return { data: { sha: held[key] } };
          },
          createOrUpdateFileContents: async (args) => {
            writes.push({ branch: args.branch || 'default', path: args.path, sha: args.sha, message: args.message, content: Buffer.from(args.content, 'base64').toString('utf8') });
            return { data: { commit: { sha: `commit-${writes.length}` } } };
          },
        },
        git: {
          getRef: async ({ ref }) => {
            if (!heads[ref]) throw (ref === `heads/${SNAPSHOT_REF}` ? refFailure(`${ref} unreadable`) : notFound(`${ref} not found`));
            return { data: { ref: `refs/${ref}`, object: { sha: heads[ref] } } };
          },
          getCommit: async ({ commit_sha: sha }) => ({ data: { tree: { sha: `tree-of-${sha}` } } }),
          createBlob: async ({ content }) => {
            git.blobs.push(content);
            return { data: { sha: `blob-${git.blobs.length}` } };
          },
          createTree: async ({ base_tree: base, tree }) => {
            git.trees.push({ base, paths: tree.map((entry) => entry.path), shas: tree.map((entry) => entry.sha) });
            return { data: { sha: `tree-${git.trees.length}` } };
          },
          createCommit: async ({ message, tree, parents }) => {
            git.commits.push({ message, tree, parents });
            return { data: { sha: `newcommit-${git.commits.length}` } };
          },
          updateRef: async ({ ref, sha }) => {
            git.refs.push({ ref, sha });
            return { data: { object: { sha } } };
          },
        },
      },
    },
  };
}

/** Run `body` with a stubbed global fetch and a GH_TOKEN, then put both back. */
async function offline(body, fetchFn) {
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.GH_TOKEN;
  globalThis.fetch = fetchFn || (async () => ({ status: 204, text: async () => '' }));
  process.env.GH_TOKEN = 'fixture-dispatch-token';

  try {
    return await body();
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedToken;
  }
}

module.exports = defineCases({
  description: 'admin publish: both branches written, the deploy branch dispatched (#919)',
  type: 'group',

  tests: [
    {
      name: 'dispatch: the ref is the DEPLOY branch, never the default one',
      async run({ expect }) {
        const requests = [];
        const said = [];
        const { octokit } = octokitDouble();

        const settings = await offline(
          () => dispatchDeploy(recordingCtx(said), octokit, {
            deploy: true, target: 'web', githubUser: 'acme', githubRepo: 'acme-omega',
          }),
          async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return { status: 204, text: async () => '' }; },
        );

        expect(settings.deployDispatched, `the dispatch should have been sent: ${said.join(' | ')}`).toBe(true);
        expect(requests.length, 'exactly one dispatch').toBe(1);
        expect(requests[0].body.ref, `the dispatch runs the branch CI builds, got ${requests[0].body.ref}`).toBe(SNAPSHOT_REF);
      },
    },

    {
      name: 'dispatch: no deploy branch yet is a LOUD failure, never a build of main',
      async run({ expect }) {
        const requests = [];
        const said = [];
        const { octokit } = octokitDouble({ deployBranch: false });

        const settings = await offline(
          () => dispatchDeploy(recordingCtx(said), octokit, {
            deploy: true, target: 'web', githubUser: 'acme', githubRepo: 'acme-omega',
          }),
          async (url) => { requests.push(url); return { status: 204, text: async () => '' }; },
        );

        expect(settings.deployDispatched, 'the publish says the deploy did not happen').toBe(false);
        expect(requests.length, 'and nothing was dispatched: no fallback to building the default branch').toBe(0);
        expect(said.join(' | ').includes('no deploy branch yet: run omega deploy once from the brand'), `the message names the fix, got: ${said.join(' | ')}`).toBeTruthy();
      },
    },

    {
      name: 'the POST write lands on the default branch AND the deploy branch',
      async run({ expect }) {
        const said = [];
        const { octokit, writes } = octokitDouble({ held: { [`${SNAPSHOT_REF}:web/src/_posts/2026/post.md`]: 'sha-on-deploy' } });
        const settings = { githubUser: 'acme', githubRepo: 'acme-omega', body: 'The body.' };

        await uploadPost(recordingCtx(said), octokit, settings, {
          path: 'web/src/_posts/2026/post.md',
          sha: 'sha-on-default',
          frontmatter: 'title: Post',
        });

        expect(writes.length, `both branches were written, got ${writes.length}`).toBe(2);
        expect(writes[0].branch, 'the record first').toBe('default');
        expect(writes[0].sha).toBe('sha-on-default');
        expect(writes[1].branch, 'then the branch CI builds').toBe(SNAPSHOT_REF);
        // The two branches hold different commits, so the file's sha is read
        // from the branch being written, never carried over from the other.
        expect(writes[1].sha, 'with THAT branch\'s own sha').toBe('sha-on-deploy');
        expect(writes[1].content, 'and the same bytes').toBe(writes[0].content);
        expect(settings.deployBranch, 'the response says the deploy branch has it').toBe(true);
      },
    },

    {
      name: 'the CONTENT write lands on the default branch AND the deploy branch',
      async run({ expect }) {
        const said = [];
        const { octokit, writes } = octokitDouble();
        const settings = {
          githubUser: 'acme', githubRepo: 'acme-omega', repoPath: 'web/src/_data/x.json', content: '{"a":1}',
        };

        await uploadContent(recordingCtx(said), octokit, settings);

        expect(writes.length, `both branches were written, got ${writes.length}`).toBe(2);
        expect(writes[0].branch).toBe('default');
        expect(writes[1].branch).toBe(SNAPSHOT_REF);
        expect(writes[1].sha, 'a file neither branch holds yet is created on both').toBe(undefined);
        expect(settings.deployBranch).toBe(true);
      },
    },

    {
      // The CREATE route commits the article AND its images in ONE Git Trees
      // commit, so it reaches the deploy branch as a tree, not a file write.
      name: 'the CREATE commit lands on the default branch AND the deploy branch, reusing its blobs',
      async run({ expect }) {
        const said = [];
        const { octokit, git } = octokitDouble();
        const settings = { githubUser: 'acme', githubRepo: 'acme-omega' };
        const files = [
          { path: 'web/src/assets/images/blog/post-1/header.jpg', content: 'aW1n', encoding: 'base64' },
          { path: 'web/src/_posts/2026/2026-09-14-post.md', content: 'cG9zdA==', encoding: 'base64' },
        ];

        await commitAll(recordingCtx(said), octokit, settings, files);

        expect(git.blobs.length, `one blob per file, uploaded ONCE for both branches, got ${git.blobs.length}`).toBe(2);
        expect(git.refs.length, 'two refs moved').toBe(2);
        expect(git.refs[0].ref, 'the record first').toBe('heads/main');
        expect(git.refs[1].ref, 'then the branch CI builds').toBe(`heads/${SNAPSHOT_REF}`);

        // The deploy branch's commit is built on ITS head, never on the default
        // branch's: the two hold different history, and a tree off the wrong
        // base would deploy the other branch's files away.
        expect(git.trees[1].base, `the deploy tree sits on the deploy branch's own tree, got ${git.trees[1].base}`).toBe('tree-of-head-deploy');
        expect(git.commits[1].parents, 'and its commit is parented on that head').toEqual(['head-deploy']);
        expect(git.trees[1].shas, 'the same blobs ride both trees').toEqual(git.trees[0].shas);
        expect(git.commits[1].message, 'and the same commit message').toBe(git.commits[0].message);
        expect(settings.deployBranch, 'the response says the deploy branch has it').toBe(true);
      },
    },

    {
      name: 'no deploy branch: the CREATE commit stays on the default branch and says so',
      async run({ expect }) {
        const said = [];
        const { octokit, git } = octokitDouble({ deployBranch: false });
        const settings = { githubUser: 'acme', githubRepo: 'acme-omega' };

        await commitAll(recordingCtx(said), octokit, settings, [
          { path: 'web/src/_posts/2026/2026-09-14-post.md', content: 'cG9zdA==', encoding: 'base64' },
        ]);

        expect(git.refs.length, 'the post is still committed: the record never depends on the deploy branch').toBe(1);
        expect(git.refs[0].ref).toBe('heads/main');
        expect(git.commits.length, 'and nothing was built for a branch that is not there').toBe(1);
        expect(settings.deployBranch).toBe(false);
        expect(said.join(' | ').includes('omega deploy'), `the warning names the fix, got: ${said.join(' | ')}`).toBeTruthy();
      },
    },

    {
      // Only a 404 means "no deploy branch". A token that cannot READ the ref
      // answers 401, and swallowing that would land the post on the default
      // branch alone with a warning naming the wrong fix.
      name: 'a 401 on the deploy-branch read PROPAGATES, never reads as no branch',
      async run({ expect }) {
        const said = [];
        const { octokit, writes } = octokitDouble({ deployBranch: false, refStatus: 401 });
        const settings = { githubUser: 'acme', githubRepo: 'acme-omega', body: 'The body.' };
        let thrown = null;

        try {
          await uploadPost(recordingCtx(said), octokit, settings, {
            path: 'web/src/_posts/2026/post.md', sha: 'sha-on-default', frontmatter: 'title: Post',
          });
        } catch (error) {
          thrown = error;
        }

        expect(thrown, `the publish should have failed loudly, said: ${said.join(' | ')}`).toBeTruthy();
        expect(thrown.status, 'with the octokit failure itself').toBe(401);
        expect(writes.length, 'the default branch still has the record').toBe(1);
        expect('deployBranch' in settings, 'and nothing claimed the deploy branch simply is not there').toBe(false);
      },
    },

    {
      name: 'no deploy branch: the write lands on the default branch alone and says so',
      async run({ expect }) {
        const said = [];
        const { octokit, writes } = octokitDouble({ deployBranch: false });
        const settings = { githubUser: 'acme', githubRepo: 'acme-omega', body: 'The body.' };

        await uploadPost(recordingCtx(said), octokit, settings, {
          path: 'web/src/_posts/2026/post.md', sha: 'sha-on-default', frontmatter: 'title: Post',
        });

        expect(writes.length, 'the post is still committed: the record never depends on the deploy branch').toBe(1);
        expect(writes[0].branch).toBe('default');
        expect(settings.deployBranch, 'and the response says the deploy branch missed it').toBe(false);
        expect(said.join(' | ').includes('omega deploy'), `the warning names the fix, got: ${said.join(' | ')}`).toBeTruthy();
      },
    },
  ],
});
