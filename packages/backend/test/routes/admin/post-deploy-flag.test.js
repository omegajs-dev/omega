/**
 * Test: admin/post schemas carry the D13 deploy flag
 *
 * Regression: the schemas didn't declare `deploy`, and unknown keys are
 * stripped at validation (the pipeline's includeUnknown defaults false), so
 * `deploy: false` could NEVER reach dispatch-deploy and the documented
 * opt-out was dead on arrival. These validate against the REAL schema
 * modules' declarations through helpers/schema.js and pin the contract:
 * absent → true, explicit false → false.
 *
 * Run: npx omega test backend:routes/admin/post-deploy-flag
 */
const { validate } = require('../../../dist/omega/helpers/schema.js');
const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const createSchema = loadHandler(require.resolve('../../../dist/omega/schemas/admin/post/post.js'));
const editSchema = loadHandler(require.resolve('../../../dist/omega/schemas/admin/post/put.js'));
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

// The validated data, or the refusal thrown so a case fails naming it
const resolve = (declaration, input) => {
  const { data, error } = validate(declaration, input);

  if (error) {
    throw new Error(error);
  }

  return data;
};

const CREATE_INPUT = {
  title: 'Post',
  url: 'post',
  description: 'A post',
  headerImageURL: 'https://example.com/image.jpg',
  body: 'Body',
};

const EDIT_INPUT = {
  url: 'https://example.com/blog/post',
  body: 'Body',
};

module.exports = defineCases({
  description: 'admin/post schemas: D13 deploy flag survives validation',
  type: 'group',

  tests: [
    {
      name: 'create: deploy defaults true when absent',
      async run({ expect }) {
        const settings = resolve(createSchema(), { ...CREATE_INPUT });
        expect(settings.deploy, `deploy should default true, got ${settings.deploy}`).toBe(true);
      },
    },

    {
      name: 'create: deploy false survives to the route',
      async run({ expect }) {
        const settings = resolve(createSchema(), { ...CREATE_INPUT, deploy: false });
        expect(settings.deploy, `deploy: false should survive validation, got ${settings.deploy}`).toBe(false);
      },
    },

    {
      name: 'edit: deploy defaults true when absent',
      async run({ expect }) {
        const settings = resolve(editSchema(), { ...EDIT_INPUT });
        expect(settings.deploy, `deploy should default true, got ${settings.deploy}`).toBe(true);
      },
    },

    {
      name: 'edit: deploy false survives to the route',
      async run({ expect }) {
        const settings = resolve(editSchema(), { ...EDIT_INPUT, deploy: false });
        expect(settings.deploy, `deploy: false should survive validation, got ${settings.deploy}`).toBe(false);
      },
    },

    // The dispatch used to hand devkit's PATH-taking helper a bare target name
    // and a fake brand root ('.'), and relied on `path.basename` of a bare
    // string to come back out. The backend holds a NAME, so it asks the
    // name-taking form of the same rule.
    {
      name: 'dispatch: the composed workflow is <target>-build.yml, named by devkit',
      async run({ expect }) {
        const dispatchDeploy = require('../../../dist/omega/routes/admin/post/dispatch-deploy.js');

        const requests = [];
        const savedFetch = globalThis.fetch;
        const savedToken = process.env.GH_TOKEN;
        globalThis.fetch = async (url) => {
          requests.push(url);
          return { status: 204, text: async () => '' };
        };
        process.env.GH_TOKEN = 'fixture-dispatch-token';

        const said = [];
        const ctx = { log: (line) => said.push(line), warn: (line) => said.push(line) };
        // The dispatch asks for the DEPLOY branch now (#919), never the repo's
        // default one, through the publish lib's one branch-exists read: the
        // ref and its refusal are pinned in
        // routes/admin/deploy-branch-publish.test.js.
        const octokit = { rest: { git: { getRef: async ({ ref }) => ({ data: { ref: `refs/${ref}`, object: { sha: 'head-deploy' } } }) } } };

        try {
          const settings = await dispatchDeploy(ctx, octokit, {
            deploy: true,
            target: 'admin',
            githubUser: 'acme',
            githubRepo: 'acme-omega',
          });

          expect(settings.deployDispatched, `the dispatch should have been sent: ${said.join(' | ')}`).toBe(true);
          expect(requests.length, 'exactly one dispatch').toBe(1);
          expect(requests[0].endsWith('/repos/acme/acme-omega/actions/workflows/admin-build.yml/dispatches'), `the second web target dispatches its OWN workflow, got ${requests[0]}`).toBeTruthy();
        } finally {
          globalThis.fetch = savedFetch;
          if (savedToken === undefined) delete process.env.GH_TOKEN;
          else process.env.GH_TOKEN = savedToken;
        }
      },
    },
  ],
});
