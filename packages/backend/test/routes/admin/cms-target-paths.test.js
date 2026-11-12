/**
 * Test: the CMS write routes commit INSIDE the web target's folder
 * ([#887](https://github.com/Omega-JS-Stack/omega/issues/887)).
 *
 * The bug: `src/_posts/<year>/...` was composed relative to the repo ROOT, so
 * in a brand monorepo (where the website lives at `targets/<name>/`) every post
 * landed outside the site and never built. And with two websites sharing one
 * backend, nothing said WHICH one a write belonged to.
 *
 * These run the real handlers and read the request Octokit would have sent: the
 * tree the create route commits, the file the repo-content route writes, and
 * the workflow the D13 publish dispatches. The last case runs a sandbox brand
 * shaped like the monorepo's own (built in a temp dir, so the suite resolves
 * inside a published install too) through the route, which is the fixture an
 * e2e would publish to.
 *
 * Run: npx omega test backend:routes/admin/cms-target-paths
 */
const path = require('node:path');
const jetpack = require('fs-jetpack');

const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const createPost = loadHandler(require.resolve('../../../dist/omega/routes/admin/post/post.js'));
const writeContent = loadHandler(require.resolve('../../../dist/omega/routes/admin/repo/content/post.js'));
const { loadConfig } = require('../../helpers/_shared-config.js');
const {
  ADMIN_USER,
  brandConfig,
  fakeOmega,
  recordingCtx,
  githubDouble,
  withGithub,
  imageDownloader,
} = require('../../helpers/_cms-target-harness.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const ONE_WEBSITE = { web: { type: 'web' }, backend: { type: 'backend' } };
const TWO_WEBSITES = { web: { type: 'web' }, community: { type: 'web' }, backend: { type: 'backend' } };

// Fixed, so the composed year is the same everywhere the case runs
const NOW = '2026-01-15T12:00:00.000Z';

const POST_SETTINGS = {
  title: 'A Post',
  url: 'a-post',
  description: 'A post about posting',
  headerImageURL: 'https://images.unsplash.com/photo-1',
  body: 'The body of the post.',
  postPath: 'guest',
  id: 1234,
};

/** Run the create route against a config, returning what it sent and what GitHub saw. */
async function createAgainst(config, overrides) {
  const github = githubDouble();
  const omega = fakeOmega(config, {
    require: (name) => (name === 'wonderful-fetch' ? imageDownloader() : require(name)),
  });
  const ctx = recordingCtx(omega, { now: NOW });
  const settings = { ...POST_SETTINGS, ...overrides };

  await withGithub(github, () => createPost({ ctx, omega, user: ADMIN_USER, data: settings, analytics: { event() {} } }));

  return { sent: ctx.sent, calls: github.calls, settings: settings };
}

/** The tree the create route committed: `[{ path }]`. */
function committedTree(calls) {
  const tree = calls.find((call) => call.url.endsWith('/git/trees'));

  return tree ? tree.body.tree : [];
}

/** Run the repo-content route against a config, returning what it sent and what GitHub saw. */
async function writeAgainst(config, settings) {
  const github = githubDouble();
  const omega = fakeOmega(config);
  const ctx = recordingCtx(omega);

  await withGithub(github, () => writeContent({ ctx, omega, user: ADMIN_USER, data: settings, analytics: { event() {} } }));

  return { sent: ctx.sent, calls: github.calls, settings: settings };
}

/** The path the repo-content route wrote to. */
function writtenPath(calls) {
  const put = calls.find((call) => call.method === 'PUT' && call.url.includes('/contents/'));

  return put ? decodeURIComponent(put.url.split('/contents/')[1]) : null;
}

module.exports = defineCases({
  description: 'CMS routes: every commit lands inside the web target',
  type: 'group',
  timeout: 30000,

  tests: [
    {
      name: 'create-commits-the-post-and-its-images-under-the-target',
      auth: 'none',

      async run({ expect }) {
        const run = await createAgainst(brandConfig(ONE_WEBSITE));

        expect(run.sent.code, `the create should succeed, got ${run.sent.code}: ${JSON.stringify(run.sent.body)}`).toBe(200);

        const paths = committedTree(run.calls).map((item) => item.path);
        expect(paths.length, `one header image and one post, got ${JSON.stringify(paths)}`).toBe(2);
        // The date in the filename is the post's own (yesterday, local), so the
        // FOLDER is what this pins: the target, then the site-relative path.
        expect(paths[1], `the post lands in the target's own _posts folder, got ${paths[1]}`).toMatch(/^targets\/web\/src\/_posts\/2026\/guest\/\d{4}-\d{2}-\d{2}-a-post\.md$/);
        expect(paths[0], 'the header image lands in the target\'s own assets folder').toMatch(/^targets\/web\/src\/assets\/images\/blog\/post-1234\//);
        expect(run.settings.target, 'the response records which website the post belongs to').toBe('web');
      },
    },

    {
      name: 'create-publishes-the-target-own-workflow',
      auth: 'none',

      async run({ expect }) {
        // D13: the dispatch has to name the target too, because a brand
        // monorepo composes one workflow per target (#265).
        const run = await createAgainst(brandConfig(ONE_WEBSITE));
        const dispatch = run.calls.find((call) => call.url.includes('/actions/workflows/'));

        expect(dispatch, 'a create dispatches the site build unless deploy: false').toBeTruthy();
        expect(dispatch.url, `the web target's composed workflow is the one dispatched, got ${dispatch && dispatch.url}`).toMatch(/\/actions\/workflows\/web-build\.yml\/dispatches$/);
        expect(run.settings.deployDispatched).toBe(true);
      },
    },

    {
      name: 'create-writes-into-the-named-target-when-the-brand-runs-several',
      auth: 'none',

      async run({ expect }) {
        const run = await createAgainst(brandConfig(TWO_WEBSITES), { target: 'community' });

        expect(run.sent.code, `the create should succeed, got ${run.sent.code}: ${JSON.stringify(run.sent.body)}`).toBe(200);

        const paths = committedTree(run.calls).map((item) => item.path);
        expect(paths[1]).toMatch(/^targets\/community\/src\/_posts\/2026\/guest\/\d{4}-\d{2}-\d{2}-a-post\.md$/);
        expect(paths[0]).toMatch(/^targets\/community\/src\/assets\/images\/blog\/post-1234\//);

        const dispatch = run.calls.find((call) => call.url.includes('/actions/workflows/'));
        expect(dispatch.url, 'the second website publishes through its own workflow').toMatch(/\/actions\/workflows\/community-build\.yml\/dispatches$/);
      },
    },

    {
      name: 'create-refuses-an-unnamed-target-when-the-brand-runs-several',
      auth: 'none',

      async run({ expect }) {
        const run = await createAgainst(brandConfig(TWO_WEBSITES));

        expect(run.sent.code, 'two websites and no name is the caller\'s error').toBe(400);
        expect(run.sent.body).toMatch(/Missing required parameter: target/);
        expect(run.sent.body, 'the refusal names the websites to choose from').toMatch(/\[web, community\]/);
        expect(run.calls.length, 'nothing may reach GitHub before the target is known').toBe(0);
      },
    },

    {
      name: 'repo-content-writes-the-site-relative-path-inside-the-target',
      auth: 'none',

      async run({ expect }) {
        const run = await writeAgainst(brandConfig(ONE_WEBSITE), { path: 'src/assets/data/authors.json', content: '{}' });

        expect(run.sent.code, `the write should succeed, got ${run.sent.code}: ${JSON.stringify(run.sent.body)}`).toBe(200);
        expect(writtenPath(run.calls)).toBe('targets/web/src/assets/data/authors.json');
        expect(run.settings.path, 'the caller\'s path stays site-relative').toBe('src/assets/data/authors.json');
        expect(run.settings.repoPath, 'the response says where it landed').toBe('targets/web/src/assets/data/authors.json');
        expect(run.settings.target).toBe('web');
      },
    },

    {
      name: 'repo-content-refuses-an-unnamed-target-when-the-brand-runs-several',
      auth: 'none',

      async run({ expect }) {
        const run = await writeAgainst(brandConfig(TWO_WEBSITES), { path: 'src/assets/data/authors.json', content: '{}' });

        expect(run.sent.code).toBe(400);
        expect(run.sent.body).toMatch(/\[web, community\]/);
        expect(run.calls.length, 'nothing may reach GitHub before the target is known').toBe(0);
      },
    },

    {
      name: 'the-sandbox-brand-config-lands-under-targets-web',
      auth: 'none',

      async run({ expect }) {
        // The offline stand-in for the e2e the spec asks for: a sandbox brand
        // shaped like the monorepo's own (a brand layer naming both targets, a
        // backend LOCAL layer under targets/backend), resolved by the real
        // loader from the target dir and run through the real route. The
        // fixture is BUILT here rather than read out of brands/, because a
        // published install ships no such tree ([#924](https://github.com/Omega-JS-Stack/omega/issues/924)).
        const root = jetpack.tmpDir({ prefix: 'cms-sandbox-brand-' }).path();
        const sandbox = path.join(root, 'targets', 'backend');

        jetpack.write(path.join(root, 'config', 'omega.json5'), `{
          brand: { id: 'sandbox-brand', name: 'Sandbox Brand' },
          targets: { web: { type: 'web' }, backend: { type: 'backend' } },
        }`);
        jetpack.write(path.join(sandbox, 'config', 'omega.json5'), `{
          targets: { backend: { blog: { enabled: false } } },
        }`);

        // The fixture is an offline demo brand and declares no `repo` block, so
        // the owner is supplied here: the TARGETS half, which is what decides the
        // path, is the fixture's own.
        let resolved;
        try {
          resolved = loadConfig(sandbox, 'backend').config;
        } finally {
          jetpack.remove(root);
        }

        const config = { ...resolved, repo: { provider: 'github', owner: 'Demo-Org' } };
        const run = await writeAgainst(config, { path: 'src/_posts/2026/guest/2026-01-14-a-post.md', content: 'post' });

        expect(run.sent.code, `the write should succeed, got ${run.sent.code}: ${JSON.stringify(run.sent.body)}`).toBe(200);
        expect(writtenPath(run.calls), `the sandbox brand's post must land inside its web target, got ${writtenPath(run.calls)}`).toMatch(/^targets\/web\//);
      },
    },
  ],
});
