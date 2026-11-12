/**
 * Test: admin post/repo routes never take the target repo from the caller (wave-2 B4)
 *
 * The GitHub owner/repo is always derived from brand config. Caller-supplied
 * `githubUser`/`githubRepo` were removed from the schemas, so they cannot reach
 * a handler even if a client still sends them — a blogger-role account must not
 * be able to redirect a commit at another repo the shared token can write.
 *
 * Schemas are pure functions with no I/O, so they are asserted directly: a
 * declaration's keys are the fields it accepts.
 */
const { loadHandler } = require('../../dist/omega/libraries/load-handler.js');

const SCHEMAS = {
  'admin/post (create)': loadHandler(require.resolve('../../dist/omega/schemas/admin/post/post.js')),
  'admin/post (edit)': loadHandler(require.resolve('../../dist/omega/schemas/admin/post/put.js')),
  'admin/repo/content': loadHandler(require.resolve('../../dist/omega/schemas/admin/repo/content/post.js')),
};
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

module.exports = defineCases({
  description: 'Admin repo targets come from brand config, never the caller',
  type: 'group',
  timeout: 10000,

  tests: [
    {
      name: 'repo-keys-absent-from-schemas',
      auth: 'none',

      async run({ expect }) {
        for (const [name, factory] of Object.entries(SCHEMAS)) {
          const keys = Object.keys(factory());

          if (keys.includes('githubUser') || keys.includes('githubRepo')) {
            expect.fail(`${name} still accepts a caller-supplied repo target (keys: ${keys.join(',')})`);
          }
        }
      },
    },

    {
      name: 'caller-supplied-repo-is-ignored-not-honored',
      auth: 'admin',
      timeout: 30000,

      async run({ http, expect }) {
        // Sending the retired keys must not change the outcome: the request is
        // resolved against brand config exactly as if they were never sent. A
        // unique URL is never-created, so both calls fetch-404 before any push.
        const url = `https://example.com/blog/never-created-${Date.now()}`;

        const withKeys = await http.put('omega/admin/post', {
          url,
          body: 'Test content',
          githubUser: 'nonexistent-user-12345',
          githubRepo: 'nonexistent-repo-12345',
        });
        const withoutKeys = await http.put('omega/admin/post', {
          url,
          body: 'Test content',
        });

        // The invariant is equality, not a particular code: whether the fetch
        // 404s or the environment cannot reach GitHub at all, the retired keys
        // must make no difference. Asserting a fixed status would couple this
        // to GH_TOKEN and the network.
        if (withKeys.status !== withoutKeys.status) {
          expect.fail(`Caller-supplied repo changed the outcome: with=${withKeys.status} (${withKeys.error}) vs without=${withoutKeys.status} (${withoutKeys.error})`);
        }

        if (withKeys.success) {
          expect.fail('Expected the never-created post to fail resolution, not succeed');
        }
      },
    },
  ],
});
