/**
 * The monthly re-engagement email carries its text, and goes only to the
 * provider that holds the engagement segments.
 *
 * Stage 1 of the daily prune mails the contacts about to be pruned. Its body
 * must reach the rendered email, and it must go out through the `campaigns`
 * role alone: Beehiiv cannot create the engagement segments by API, so a post
 * there would go to a raw, unresolved key. It sends as `hello@`, which needs
 * a verified sender; an address with none fails by name and sends nothing.
 * Plain-node: the real stage 1 and Marketing library, fake provider API.
 */
const expect = require('../../dist/vendor/devkit/test/expect.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');
const { fakeProviderApi, withProviderApi, campaignCtx, visibleText, rowSenders } = require('./_campaign-harness.js');

const HELLO = 'hello@acme.test';

const segment = (id, where) => ({ id, query: `SELECT c.contact_id, c.updated_at FROM contact_data as c WHERE ${where}` });

const SENDGRID_SEGMENTS = {
  engagement_inactive_5m: segment('sg_inactive_5m', '"engagement_last" <= timestampadd(day, -150, CURRENT_TIMESTAMP)'),
  engagement_inactive_6m: segment('sg_inactive_6m', '"engagement_last" <= timestampadd(day, -180, CURRENT_TIMESTAMP)'),
  subscription_paid: segment('sg_paid', '"subscription_status" = \'active\''),
};

/** The longest string a settings object holds: the message, whatever key carries it. */
function longestText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  return Object.values(value).map(longestText).reduce((longest, text) => (text.length > longest.length ? text : longest), '');
}

/**
 * Run stage 1 once and answer what it handed over, plus the provider calls.
 * `verifiedSenders` replaces the account's row-built sender list.
 */
async function runPrune({ verifiedSenders } = {}) {
  const api = fakeProviderApi({ sendgridSegments: SENDGRID_SEGMENTS, ...(verifiedSenders ? { verifiedSenders } : {}) });
  const handed = [];
  const answered = [];

  await withProviderApi(api, async (load) => {
    const { stageReengage } = load('events/cron/daily/marketing-prune.js');
    const ctx = campaignCtx(load);
    const send = ctx.email.sendCampaign;

    ctx.email.sendCampaign = async (settings) => {
      handed.push(structuredClone(settings));
      const result = await send(settings);
      answered.push(result);
      return result;
    };

    await stageReengage(ctx.omega, ctx);
  });

  return { api, handed, answered };
}

module.exports = defineCases({
  description: 'The re-engagement email carries its text and goes through the campaigns role only',
  type: 'group',

  tests: [
    {
      name: 'the rendered re-engagement email holds the text stage 1 wrote',

      async run() {
        const { api, handed, answered } = await runPrune();

        expect(handed.length, 'stage 1 sends one re-engagement campaign').toBe(1);
        expect(api.singleSends().length, `one Single Send is created, the send answered ${JSON.stringify(answered)}`).toBe(1);

        const body = visibleText(api.singleSends()[0].body.email_config.html_content);
        const words = visibleText(longestText(handed[0])).match(/[A-Za-z]{6,}/g) || [];
        const missing = words.filter((word) => !body.includes(word));

        expect(words.length > 5, `stage 1 hands over a message, got ${JSON.stringify(handed[0])}`).toBeTruthy();
        expect(missing, `every word of the message reaches the inbox, missing: ${missing.join(', ')}`).toEqual([]);
      },
    },

    {
      name: 'the re-engagement email never becomes a Beehiiv post',

      async run() {
        const { api } = await runPrune();

        expect(api.beehiivPosts().map((call) => call.body.recipients), 'no Beehiiv post is created for the engagement segments').toEqual([]);
      },
    },

    {
      name: 'the re-engagement email sends as the hello@ sender the rows verified',

      async run() {
        const hello = rowSenders().find((sender) => sender.from_email === HELLO);
        const { api, answered } = await runPrune();

        expect(hello, `the rows verify a ${HELLO} sender`).toBeTruthy();
        expect(api.singleSends().map((call) => call.body.email_config.sender_id), `the Single Send carries the ${HELLO} sender's id, the send answered ${JSON.stringify(answered)}`).toEqual([hello.id]);
      },
    },

    {
      name: 'a sender address with no verified sender fails its SendGrid leg by name and sends nothing',

      async run() {
        const { api, answered } = await runPrune({ verifiedSenders: rowSenders().filter((sender) => sender.from_email !== HELLO) });
        const leg = answered[0]?.campaigns;

        expect(api.singleSends().length, 'no Single Send is created').toBe(0);
        expect(api.beehiivPosts().length, 'no Beehiiv post is created').toBe(0);
        expect(leg?.success, `the SendGrid leg fails, got ${JSON.stringify(answered)}`).toBe(false);
        expect(String(leg?.error), 'the failure names the address').toContain(HELLO);
      },
    },
  ],
});
