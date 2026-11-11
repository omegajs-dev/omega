/**
 * One newsletter run creates one Beehiiv post.
 *
 * A run is the generator, then the frequent cron's `sendCampaign` with what
 * the generator returned. `sendCampaign` owns the publish, so the post is
 * counted at the provider: a second one is the same issue twice in every
 * subscriber's inbox.
 *
 * Plain-node: the real generator and Marketing library against the fake
 * provider API. Stubbed paid edges: the AI answers a fit score and the clean
 * fixture, the upload answers URLs, the report email is a no-op.
 */
const expect = require('../../dist/vendor/devkit/test/expect.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');
const {
  fakeProviderApi,
  withProviderApi,
  campaignCtx,
  NEWSLETTER_FIXTURE: FIXTURE,
  NEWSLETTER_SOURCES: SOURCES,
  newsletterAi,
  stubAssetUpload,
} = require('./_campaign-harness.js');

// The seed newsletter campaign's settings (setup-tests' seed-campaigns).
const SEED_SETTINGS = { name: 'Acme Newsletter', subject: '', preheader: '', sender: 'newsletter', providers: ['newsletter'] };

/**
 * One run: the generator, then the cron's send. A testing run is the extended
 * lane, the one where the generator runs at all under `isTesting()`.
 */
async function runNewsletter({ testing = false, sendAt = 'now' } = {}) {
  const api = fakeProviderApi();
  const savedExtended = process.env.TEST_EXTENDED_MODE;
  let generated = null;

  if (testing) {
    process.env.TEST_EXTENDED_MODE = '1';
  } else {
    delete process.env.TEST_EXTENDED_MODE;
  }

  try {
    await withProviderApi(api, async (load) => {
      stubAssetUpload(load);

      const generator = load('libraries/email/generators/newsletter.js');
      const ctx = campaignCtx(load, {
        isTesting: () => testing,
        ai: { request: newsletterAi },
        email: { send: async () => ({ status: 'sent' }) },
      });

      generated = await generator.generate(ctx.omega, ctx, structuredClone(SEED_SETTINGS), {
        sources: SOURCES,
        skipImages: true,
        imageHost: 'github',
        campaignId: 'campaign_1',
      });

      if (generated) {
        await ctx.email.sendCampaign({ ...generated, sendAt });
      }
    });
  } finally {
    if (savedExtended === undefined) {
      delete process.env.TEST_EXTENDED_MODE;
    } else {
      process.env.TEST_EXTENDED_MODE = savedExtended;
    }
  }

  return { api, generated };
}

const titles = (api) => JSON.stringify(api.beehiivPosts().map((call) => call.body.title));

module.exports = defineCases({
  description: 'One newsletter run creates exactly one Beehiiv post',
  type: 'group',

  tests: [
    {
      name: 'the generator then the cron send create one post between them',

      async run() {
        const { api, generated } = await runNewsletter();

        expect(generated, 'the generator produced a newsletter').toBeTruthy();
        expect(api.beehiivPosts().length, `one run, one Beehiiv post, got ${titles(api)}`).toBe(1);
      },
    },

    {
      name: 'the one post is titled with the subject, carries the content tags and holds the rendered newsletter',

      async run() {
        const { api } = await runNewsletter();
        const posts = api.beehiivPosts();

        expect(posts.length, `one post to read, got ${titles(api)}`).toBe(1);
        expect(posts[0].body.title, 'the post title is the campaign subject').toBe(FIXTURE.subject);
        expect(posts[0].body.content_tags, 'the post carries the generator\'s content tags').toEqual(FIXTURE.tags);
        expect(String(posts[0].body.body_content), 'the post holds the rendered newsletter').toContain(FIXTURE.sections[0].title);
      },
    },

    {
      name: 'a testing run\'s one post is a draft, whatever sendAt says',

      async run() {
        const tomorrow = Math.round(Date.now() / 1000) + 86400;

        for (const sendAt of ['now', tomorrow]) {
          const { api } = await runNewsletter({ testing: true, sendAt });
          const posts = api.beehiivPosts();

          expect(posts.length, `sendAt ${sendAt}: one post, got ${titles(api)}`).toBe(1);
          expect(posts[0].body.status, `sendAt ${sendAt}: a testing run never publishes`).toBe('draft');
        }
      },
    },
  ],
});
