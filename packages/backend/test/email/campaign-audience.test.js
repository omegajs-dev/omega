/**
 * A campaign whose audience resolves to nothing never sends.
 *
 * A segment key with no segment behind it, or a segment with no query, must
 * fail the campaign with a coded error naming the key, and neither provider
 * may be handed a send: an empty or unscoped audience is a send to the wrong
 * people. A query written across lines must reach the brand-scoped segment
 * whole, or the audience widens to its first line.
 *
 * Plain-node: the real Marketing library against the fake provider API in
 * _campaign-harness.js, so what is asserted is what each provider was sent.
 */
const expect = require('../../dist/vendor/devkit/test/expect.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');
const { brandConfig, fakeProviderApi, withProviderApi, campaignCtx } = require('./_campaign-harness.js');

// The account's segments as SendGrid lists them, each with a one-line query.
const SENDGRID_SEGMENTS = {
  subscription_free: { id: 'sg_free', query: 'SELECT c.contact_id, c.updated_at FROM contact_data as c WHERE "subscription_status" = \'active\'' },
  engagement_inactive_5m: { id: 'sg_inactive_5m', query: 'SELECT c.contact_id, c.updated_at FROM contact_data as c WHERE "engagement_last" <= timestampadd(day, -150, CURRENT_TIMESTAMP)' },
};

const BEEHIIV_SEGMENTS = { subscription_free: 'bh_free' };

function campaign(extra) {
  return {
    name: '[TEST] Audience',
    subject: 'Audience',
    template: 'card',
    data: { content: { title: 'Audience', message: 'A body for the audience.' } },
    sendAt: 'now',
    ...extra,
  };
}

/** Send once; answer the throw, or the per-role result. */
async function attempt(api, settings, config = brandConfig()) {
  return withProviderApi(api, async (load) => {
    const ctx = campaignCtx(load, { config });

    try {
      return { result: await ctx.email.sendCampaign(settings) };
    } catch (error) {
      return { thrown: error };
    }
  }, config);
}

/**
 * The campaign failed: a throw, or every requested role (every answered one
 * when `roles` is null) answered a failure. Answers the failures to read.
 */
function failures({ thrown, result }, roles) {
  if (thrown) {
    return [{ error: thrown.message, code: thrown.code }];
  }

  const answered = (roles || Object.keys(result || {})).map((role) => result?.[role]);

  expect(answered.length > 0 && answered.every((entry) => entry && entry.success === false), `every requested role must fail, got ${JSON.stringify(result)}`).toBeTruthy();

  return answered;
}

function expectFailureNames(outcome, roles, key) {
  for (const failure of failures(outcome, roles)) {
    expect(String(failure.error), `the failure names the key ${key}`).toContain(key);
    expect(failure.code, `a permanent fault is a coded 400, got ${failure.code}`).toBe(400);
  }
}

module.exports = defineCases({
  description: 'A campaign audience that resolves to nothing fails before anything is sent',
  type: 'group',

  tests: [
    {
      name: 'no segments, no lists and no brand list is no audience: nothing is sent, as a coded 400',

      async run() {
        const config = brandConfig();
        delete config.marketing.campaigns.providers.sendgrid.listId;

        const api = fakeProviderApi({ sendgridSegments: SENDGRID_SEGMENTS });
        const outcome = await attempt(api, campaign({ providers: ['campaigns'] }), config);

        expect(api.singleSends().map((call) => call.body.send_to), 'a send with no audience at all never reaches SendGrid').toEqual([]);
        failures(outcome, ['campaigns']).forEach((failure) => expect(failure.code, `no audience is a permanent fault, got ${JSON.stringify(failure)}`).toBe(400));
      },
    },

    {
      name: 'a listing outage with no code fails its own role, and the other role still sends',

      async run() {
        const api = fakeProviderApi({ sendgridSegments: SENDGRID_SEGMENTS, beehiivSegments: null });
        const { thrown, result } = await attempt(api, campaign({ providers: ['campaigns', 'newsletter'], segments: ['subscription_free'] }));

        expect(thrown, `a transient outage never throws the whole campaign, got ${thrown?.message}`).toBe(undefined);
        expect(api.singleSends().length, `the campaigns role still sends, got ${JSON.stringify(result)}`).toBe(1);
        expect(result?.campaigns?.success, 'the campaigns role answers its send').toBe(true);
        expect(result?.newsletter?.success, `the newsletter role answers its own failure, got ${JSON.stringify(result?.newsletter)}`).toBe(false);
        expect(result?.newsletter?.code, 'an outage is not a permanent fault').toBe(undefined);
        expect(api.beehiivPosts().length, 'the failed role posts nothing').toBe(0);
      },
    },

    {
      name: 'a campaign naming no segments lists no segments on either provider',

      async run() {
        const api = fakeProviderApi({ sendgridSegments: SENDGRID_SEGMENTS, beehiivSegments: BEEHIIV_SEGMENTS });

        await attempt(api, campaign({ providers: ['campaigns', 'newsletter'] }));

        expect(api.segmentListings().map((call) => call.url), 'no segment key, so no segment listing').toEqual([]);
      },
    },

    {
      name: 'a coded 400 on one role\'s audience holds the other role\'s send',

      async run() {
        // SendGrid has this segment; the publication does not, a permanent fault
        const api = fakeProviderApi({ sendgridSegments: SENDGRID_SEGMENTS, beehiivSegments: BEEHIIV_SEGMENTS });
        const { thrown, result } = await attempt(api, campaign({ providers: ['campaigns', 'newsletter'], segments: ['engagement_inactive_5m'] }));
        const failed = thrown ? [{ error: thrown.message, code: thrown.code }] : Object.values(result || {}).filter((entry) => entry?.success === false);

        expect(api.beehiivPosts().map((call) => call.body.recipients), 'the faulted role sends nothing').toEqual([]);
        expect(api.singleSends().map((call) => call.body.send_to), 'the healthy role is held too, so the campaign never half-sends').toEqual([]);
        expect(failed.some((failure) => String(failure.error).includes('engagement_inactive_5m') && failure.code === 400), `the fault names the key as a coded 400, got ${JSON.stringify(thrown?.message || result)}`).toBeTruthy();
      },
    },

    {
      name: 'a providers word that is no role sends nothing on any role and the failure names it',

      async run() {
        const api = fakeProviderApi({ sendgridSegments: SENDGRID_SEGMENTS, beehiivSegments: BEEHIIV_SEGMENTS });
        const outcome = await attempt(api, campaign({ providers: ['sendgrid'], segments: ['subscription_free'] }));

        expect(api.singleSends().map((call) => call.body.send_to), 'no Single Send goes out for a provider id in place of a role').toEqual([]);
        expect(api.beehiivPosts().map((call) => call.body.recipients), 'no Beehiiv post goes out for a provider id in place of a role').toEqual([]);
        expectFailureNames(outcome, null, 'sendgrid');
      },
    },

    {
      name: 'an unknown segment key sends nothing and the failure names it',

      async run() {
        const api = fakeProviderApi({ sendgridSegments: SENDGRID_SEGMENTS, beehiivSegments: BEEHIIV_SEGMENTS });
        const roles = ['campaigns', 'newsletter'];
        const outcome = await attempt(api, campaign({ providers: roles, segments: ['subscription_freee'] }));

        expect(api.singleSends().map((call) => call.body.send_to), 'no Single Send is created for an unknown key').toEqual([]);
        expect(api.beehiivPosts().map((call) => call.body.recipients), 'no Beehiiv post is created for an unknown key').toEqual([]);
        expectFailureNames(outcome, roles, 'subscription_freee');
      },
    },

    {
      name: 'a requested segment with no query sends nothing and the failure names it',

      async run() {
        const api = fakeProviderApi({
          sendgridSegments: { ...SENDGRID_SEGMENTS, subscription_paid: { id: 'sg_paid', query: null } },
        });
        const outcome = await attempt(api, campaign({ providers: ['campaigns'], segments: ['subscription_paid'] }));

        expect(api.singleSends().map((call) => call.body.send_to), 'a segment with no query is no audience, so no Single Send').toEqual([]);
        expectFailureNames(outcome, ['campaigns'], 'subscription_paid');
      },
    },

    {
      name: 'a segment query written across lines reaches the brand-scoped segment whole',

      async run() {
        const api = fakeProviderApi({
          sendgridSegments: {
            subscription_paid: {
              id: 'sg_paid',
              query: [
                'SELECT c.contact_id, c.updated_at FROM contact_data as c',
                'WHERE "subscription_status" = \'active\'',
                '  AND "subscription_plan" != \'basic\'',
              ].join('\n'),
            },
          },
        });

        await attempt(api, campaign({ providers: ['campaigns'], segments: ['subscription_paid'] }));

        const scoped = api.tempSegments().map((call) => call.body.query_dsl);

        expect(scoped.length, `one brand-scoped segment is created, got ${JSON.stringify(scoped)}`).toBe(1);
        expect(scoped[0], 'the first line\'s condition is kept').toContain('"subscription_status" = \'active\'');
        expect(scoped[0], 'the condition on the next line is kept, so the audience is not widened').toContain('"subscription_plan" != \'basic\'');
        expect(scoped[0], 'the audience is still scoped to the brand').toContain('"brand_id" = \'acme\'');
      },
    },

    {
      name: 'a key Beehiiv cannot resolve sends no post and the failure names it',

      async run() {
        // A real segment key that the publication has no segment for: Beehiiv
        // segments cannot be created by API, so this is a live shape.
        const api = fakeProviderApi({ sendgridSegments: SENDGRID_SEGMENTS, beehiivSegments: BEEHIIV_SEGMENTS });
        const outcome = await attempt(api, campaign({ providers: ['newsletter'], segments: ['engagement_inactive_5m'] }));

        expect(api.beehiivPosts().map((call) => call.body.recipients), 'no post goes out to a raw, unresolved key').toEqual([]);
        expectFailureNames(outcome, ['newsletter'], 'engagement_inactive_5m');
      },
    },
  ],
});
