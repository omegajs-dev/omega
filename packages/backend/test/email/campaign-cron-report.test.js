/**
 * The frequent cron's newsletter run sends the internal report email after the
 * send: on success it names the Beehiiv post the send created, and on a coded
 * 400 it names the failure before the campaign is marked failed. The report's
 * inputs ride the generator's result but never reach the stored campaign.
 *
 * Plain-node: the real cron, generator and Marketing library against the fake
 * provider API and an in-memory store. Stubbed edges: the source resolver
 * answers one source, the AI and the asset upload are the harness's.
 */
const expect = require('../../dist/vendor/devkit/test/expect.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');
const sourceResolver = require('../../dist/omega/libraries/content/source-resolver.js');
const {
  fakeProviderApi,
  withProviderApi,
  campaignCtx,
  memoryAdmin,
  NEWSLETTER_FIXTURE,
  NEWSLETTER_SOURCES,
  newsletterAi,
  stubAssetUpload,
} = require('./_campaign-harness.js');

const CAMPAIGN_ID = '_newsletter-run';

/** A due one-off newsletter campaign, the seed's settings plus `extra`. */
function newsletterCampaign(extra = {}) {
  const now = Math.round(Date.now() / 1000);
  const stamp = { timestamp: new Date(now * 1000).toISOString(), timestampUNIX: now };

  return {
    status: 'pending',
    type: 'email',
    generator: 'newsletter',
    sendAt: now - 600,
    settings: { name: 'Acme Newsletter', subject: '', preheader: '', sender: 'newsletter', providers: ['newsletter'], ...extra },
    metadata: { created: stamp, updated: stamp },
  };
}

/** One cron pass over the seeded campaign; answers the store, the reports and the provider calls. */
async function runCron(campaign) {
  const api = fakeProviderApi();
  const store = memoryAdmin({ [`marketing-campaigns/${CAMPAIGN_ID}`]: campaign });
  const reports = [];
  let logs = [];
  const original = { resolveSources: sourceResolver.resolveSources, trackContentSource: sourceResolver.trackContentSource };
  const savedToken = process.env.GH_TOKEN;

  // The generator captures these at load, so they are swapped before the cron loads it
  sourceResolver.resolveSources = async () => structuredClone(NEWSLETTER_SOURCES);
  sourceResolver.trackContentSource = async () => {};
  process.env.GH_TOKEN = 'gh-test-token';

  try {
    await withProviderApi(api, async (load) => {
      stubAssetUpload(load);

      const cron = load('events/cron/frequent/marketing-campaigns.js');
      const ctx = campaignCtx(load, {
        admin: store.admin,
        ai: { request: newsletterAi },
        email: { send: async (settings) => { reports.push(settings); return { status: 'sent' }; } },
      });

      logs = ctx.logs;
      await cron({ ctx, omega: ctx.omega });
    });
  } finally {
    Object.assign(sourceResolver, original);

    if (savedToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = savedToken;
    }
  }

  const campaigns = [...store.docs.entries()].filter(([docPath]) => docPath.startsWith('marketing-campaigns/'));

  return { api, store, reports, campaigns, logged: logs.join(' | ').slice(0, 2000) };
}

module.exports = defineCases({
  description: 'The newsletter run reports after the send, and keeps the report out of the stored campaign',
  type: 'group',

  tests: [
    {
      name: 'the report names the post the send created, and no stored campaign carries the report',

      async run() {
        const { api, reports, campaigns, logged } = await runCron(newsletterCampaign());
        const posts = api.beehiivPosts();

        expect(posts.length, `the run creates its one post; the cron logged: ${logged}`).toBe(1);

        const postId = posts[0].response.data.id;

        expect(reports.length, `one report email is sent, got ${reports.length}`).toBe(1);
        expect(JSON.stringify(reports[0]), `the report names the post ${postId}`).toContain(postId);

        expect(campaigns.some(([, doc]) => doc.settings?.subject === NEWSLETTER_FIXTURE.subject), 'the generated settings are stored').toBe(true);

        for (const [docPath, doc] of campaigns) {
          expect(Boolean(doc.settings && 'report' in doc.settings), `${docPath} stores no report`).toBe(false);
        }
      },
    },

    {
      name: 'a coded 400 from the send is reported, naming the failure, and the campaign fails',

      async run() {
        // A segment key with no segment behind it: the send's permanent fault
        const { api, reports, store, logged } = await runCron(newsletterCampaign({ segments: ['subscription_freee'] }));

        expect(api.beehiivPosts().length, 'nothing is posted').toBe(0);
        expect(reports.length, `one report email is sent; the cron logged: ${logged}`).toBe(1);
        expect(JSON.stringify(reports[0]), 'the report names the failure').toContain('subscription_freee');
        expect(store.docs.get(`marketing-campaigns/${CAMPAIGN_ID}`).status, 'the campaign is marked failed').toBe('failed');
      },
    },
  ],
});
