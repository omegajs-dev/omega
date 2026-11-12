/**
 * Test: POST /admin/post
 * Tests the admin create post endpoint
 * Creates blog posts via GitHub with image extraction and @post/ body rewriting
 * Requires admin/blogger role, GitHub API key, and a resolvable source repo (repo.owner + brand.id -> <brand.id>-omega)
 */
const { Octokit } = require('@octokit/rest');
const sharp = require('sharp');

const { IMAGE_MAX_DIMENSION } = require('../../../dist/omega/routes/admin/post/images.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

module.exports = defineCases({
  description: 'Admin create post on GitHub',
  type: 'suite',
  timeout: 300000, // 5 minutes total for the suite

  tests: [
    // --- Validation tests (no GitHub needed) ---

    {
      name: 'missing-title-rejected',
      auth: 'admin',
      timeout: 15000,

      async run({ http, expect }) {
        const response = await http.post('omega/admin/post', {
          url: 'test-post',
          description: 'Test description',
          headerImageURL: 'https://example.com/image.jpg',
          body: 'Test content',
        });

        expect(response, 'Missing title should return 400').toBeError(400);
      },
    },

    {
      name: 'missing-url-rejected',
      auth: 'admin',
      timeout: 15000,

      async run({ http, expect }) {
        const response = await http.post('omega/admin/post', {
          title: 'Test Post',
          description: 'Test description',
          headerImageURL: 'https://example.com/image.jpg',
          body: 'Test content',
        });

        expect(response, 'Missing URL should return 400').toBeError(400);
      },
    },

    {
      name: 'missing-description-rejected',
      auth: 'admin',
      timeout: 15000,

      async run({ http, expect }) {
        const response = await http.post('omega/admin/post', {
          title: 'Test Post',
          url: 'test-post',
          headerImageURL: 'https://example.com/image.jpg',
          body: 'Test content',
        });

        expect(response, 'Missing description should return 400').toBeError(400);
      },
    },

    {
      name: 'missing-header-image-rejected',
      auth: 'admin',
      timeout: 15000,

      async run({ http, expect }) {
        const response = await http.post('omega/admin/post', {
          title: 'Test Post',
          url: 'test-post',
          description: 'Test description',
          body: 'Test content',
        });

        expect(response, 'Missing headerImageURL should return 400').toBeError(400);
      },
    },

    {
      name: 'missing-body-rejected',
      auth: 'admin',
      timeout: 15000,

      async run({ http, expect }) {
        const response = await http.post('omega/admin/post', {
          title: 'Test Post',
          url: 'test-post',
          description: 'Test description',
          headerImageURL: 'https://example.com/image.jpg',
        });

        expect(response, 'Missing body should return 400').toBeError(400);
      },
    },

    // --- Integration: create post with inline image, verify @post/ rewriting ---

    {
      name: 'create-post-rewrites-body-images',
      auth: 'admin',
      timeout: 120000,
      skip: !process.env.TEST_EXTENDED_MODE ? 'TEST_EXTENDED_MODE env var not set' : false,

      async run({ http, expect, state, config }) {
        if (!process.env.GH_TOKEN) {
          expect.fail('GH_TOKEN env var not set');
          return;
        }

        const { sourceRepo } = require('../../helpers/_shared-config.js');
        const source = sourceRepo(config);
        if (!source) {
          expect.fail('source repo not resolvable (set repo.owner + brand.id)');
          return;
        }

        // Parse owner/repo for cleanup later
        const repoMatch = [null, source.owner, source.name];

        state.owner = repoMatch[1];
        state.repo = repoMatch[2];

        // Use a real public .jpg for the inline image
        const inlineImageURL = 'https://picsum.photos/id/10/200/200.jpg';
        // Oversized header image (long edge 5000px > IMAGE_MAX_DIMENSION 4096px) to
        // verify the resize step runs end-to-end and the committed file is clamped.
        const headerImageURL = 'https://picsum.photos/id/1/5000/3000.jpg';

        const response = await http.post('omega/admin/post', {
          title: '@omega.js/backend Test Create Post',
          url: 'backend-test-create-post',
          description: 'Test post created by @omega.js/backend test suite to verify @post/ body rewriting.',
          headerImageURL: headerImageURL,
          body: `# @omega.js/backend Test Create Post\n\nSome intro text.\n\n![Test inline image](${inlineImageURL})\n\nMore text after the image.`,
          postPath: 'guest',
        });

        expect(response, 'Create post should succeed').toBeSuccess();
        expect(response, 'Response should have post id').toHaveProperty('data.id');
        expect(response, 'Response should have post file path').toHaveProperty('data.path');

        // Store for cleanup
        state.postId = response.data.id;
        state.postPath = response.data.path;
      },
    },

    {
      name: 'verify-body-has-at-post-prefix',
      auth: 'admin',
      timeout: 30000,
      skip: !process.env.TEST_EXTENDED_MODE ? 'TEST_EXTENDED_MODE env var not set' : false,

      async run({ expect, state }) {
        if (!state.postPath) {
          return; // Previous test didn't run
        }

        const octokit = new Octokit({ auth: process.env.GH_TOKEN });

        // Fetch the committed post from GitHub
        const { data: fileData } = await octokit.rest.repos.getContent({
          owner: state.owner,
          repo: state.repo,
          path: state.postPath,
        });

        const content = Buffer.from(fileData.content, 'base64').toString();
        state.currentSha = fileData.sha;

        // The body should contain @post/ prefix instead of the original external URL
        expect(content.includes('@post/'), 'Post body should contain @post/ prefix for downloaded images').toBeTruthy();

        expect(!content.includes('picsum.photos/id/10'), 'Post body should NOT contain the original external inline image URL').toBeTruthy();
      },
    },

    {
      name: 'verify-oversized-header-image-was-resized',
      auth: 'admin',
      timeout: 30000,
      skip: !process.env.TEST_EXTENDED_MODE ? 'TEST_EXTENDED_MODE env var not set' : false,

      async run({ expect, state }) {
        if (!state.postId) {
          return; // Previous test didn't run
        }

        const octokit = new Octokit({ auth: process.env.GH_TOKEN });
        const imageDir = `src/assets/images/blog/post-${state.postId}/`;

        // List committed images and pick the header (matches the slugified URL "backend-test-create-post")
        const { data: dirData } = await octokit.rest.repos.getContent({
          owner: state.owner,
          repo: state.repo,
          path: imageDir,
        });

        const headerFile = dirData.find((f) => f.name === 'backend-test-create-post.jpg');
        expect(headerFile, 'Header image should be committed at expected slug').toBeTruthy();

        // Fetch the raw bytes and read dimensions
        const { data: blob } = await octokit.rest.git.getBlob({
          owner: state.owner,
          repo: state.repo,
          file_sha: headerFile.sha,
        });

        const buffer = Buffer.from(blob.content, 'base64');
        const meta = await sharp(buffer).metadata();

        // The source we requested was 5000x3000 (over the 4096 limit).
        // After resize, the long edge should be clamped to IMAGE_MAX_DIMENSION.
        const longEdge = Math.max(meta.width, meta.height);
        expect(longEdge <= IMAGE_MAX_DIMENSION, `Committed header image long edge (${meta.width}x${meta.height}) should be <= IMAGE_MAX_DIMENSION (${IMAGE_MAX_DIMENSION})`).toBeTruthy();

        // And the resize should actually have happened (source was 5000x3000 → expect width=4096)
        expect(meta.width, 'Resized width should equal IMAGE_MAX_DIMENSION').toBe(IMAGE_MAX_DIMENSION);
      },
    },

    // --- Auth rejection tests ---

    {
      name: 'unauthenticated-rejected',
      auth: 'none',
      timeout: 15000,

      async run({ http, expect }) {
        const response = await http.post('omega/admin/post', {
          title: 'Test Post',
          url: 'test-post',
          description: 'Test description',
          headerImageURL: 'https://example.com/image.jpg',
          body: 'Test content',
        });

        expect(response, 'Create post should fail without authentication').toBeError(401);
      },
    },

    {
      name: 'non-admin-rejected',
      auth: 'basic',
      timeout: 15000,

      async run({ http, expect }) {
        const response = await http.post('omega/admin/post', {
          title: 'Test Post',
          url: 'test-post',
          description: 'Test description',
          headerImageURL: 'https://example.com/image.jpg',
          body: 'Test content',
        });

        expect(response, 'Create post should fail for non-admin user').toBeError(403);
      },
    },

    // --- Cleanup ---

    {
      name: 'cleanup',
      auth: 'admin',
      timeout: 60000,

      async run({ state }) {
        if (!process.env.GH_TOKEN || !state.postPath) {
          return;
        }

        const octokit = new Octokit({ auth: process.env.GH_TOKEN });

        // Delete the test post
        try {
          const { data: fileData } = await octokit.rest.repos.getContent({
            owner: state.owner,
            repo: state.repo,
            path: state.postPath,
          });

          await octokit.rest.repos.deleteFile({
            owner: state.owner,
            repo: state.repo,
            path: state.postPath,
            message: '🧹 @omega.js/backend test cleanup: delete create-post test',
            sha: fileData.sha,
          });
        } catch (e) {
          // File might not exist, ignore
        }

        // Delete uploaded test images
        const imagePath = `src/assets/images/blog/post-${state.postId}/`;
        try {
          const { data: dirData } = await octokit.rest.repos.getContent({
            owner: state.owner,
            repo: state.repo,
            path: imagePath,
          });

          // Delete each image file
          for (const file of dirData) {
            await octokit.rest.repos.deleteFile({
              owner: state.owner,
              repo: state.repo,
              path: file.path,
              message: `🧹 @omega.js/backend test cleanup: delete test image ${file.name}`,
              sha: file.sha,
            });
          }
        } catch (e) {
          // Directory might not exist, ignore
        }

        // Cancel any running workflows triggered by our test commits
        try {
          const { data: runs } = await octokit.rest.actions.listWorkflowRunsForRepo({
            owner: state.owner,
            repo: state.repo,
            status: 'in_progress',
            per_page: 10,
          });

          for (const run of runs.workflow_runs) {
            if (run.head_commit?.message?.includes('@omega.js/backend test')) {
              try {
                await octokit.rest.actions.cancelWorkflowRun({
                  owner: state.owner,
                  repo: state.repo,
                  run_id: run.id,
                });
              } catch (e) {
                // May already be completed, ignore
              }
            }
          }
        } catch (e) {
          // Workflow cancellation failed, not critical
        }
      },
    },
  ],
});
