/**
 * Marketing prune test — the default-on gate on the cron entry
 * ([#551](https://github.com/Omega-JS-Stack/omega/issues/551)), then the
 * per-provider lanes: each provider's OWN engagement decides that provider's
 * removals ([#365](https://github.com/Omega-JS-Stack/omega/issues/365)).
 *
 * The bug this pins: stage 2 measured engagement in SendGrid and then deleted
 * the same emails from Beehiiv, so a reader who opens every newsletter but
 * ignores offer mail was removed from the NEWSLETTER on a signal from the other
 * channel. Stage 2 is now SendGrid-only and stage 3 is the Beehiiv lane, keyed
 * to Beehiiv's own per-subscriber stats with its own received floor.
 *
 * Plain-node control-flow test (no emulator, no network): the real cron stages
 * run against provider modules swapped in the require cache — the cron requires
 * them by path, so the require cache IS the seam (same idiom as
 * campaign-config-fault.test.js). Firestore is a minimal in-memory stand-in.
 *
 * Removal method: both lanes call the providers' DELETE paths
 * (sendgrid.bulkDeleteContacts, beehiiv.removeContact → removeSubscriber's
 * DELETE), never an unsubscribe — an unsubscribe would revoke marketing consent
 * in Firestore permanently. The live provider surface is covered by the
 * extended-mode marketing-lifecycle suite.
 */
const expect = require('../../../dist/vendor/devkit/test/expect.js');
const { loadHandler } = require('../../../dist/omega/libraries/load-handler.js');
const cron = loadHandler(require.resolve('../../../dist/omega/events/cron/daily/marketing-prune.js'));
const pruneHelpers = require('../../../dist/omega/events/cron/helpers/marketing-prune.js');
const omega = require('../../../dist/omega/index.js');
const sendgridProvider = require('../../../dist/omega/libraries/email/providers/sendgrid.js');
const beehiivProvider = require('../../../dist/omega/libraries/email/providers/beehiiv.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');
const { onPruneDay, fakeProviderApi, withProviderApi, campaignCtx } = require('../_campaign-harness.js');

const {
  stagePrune,
  stageNewsletterPrune,
  isNewsletterInactive,
  NEWSLETTER_RECEIVED_FLOOR,
  NEWSLETTER_MIN_AGE_DAYS,
} = pruneHelpers;

const DAY = 24 * 60 * 60 * 1000;
const BRAND = { id: 'acme', name: 'Acme' };

/** The run doc id stage logs land under (year-month of the run). */
function logKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Minimal in-memory Firestore stand-in — the stages only ever write one
 * prune-log doc per lane, and stage 3's paid exclusion reads users by email
 * (the marketing library's canonical lookup). An email absent from
 * `usersByEmail` is a pure newsletter contact with no account.
 */
function buildAdmin(usersByEmail = {}) {
  const writes = [];

  const admin = {
    firestore: () => ({
      collection: () => ({
        where: (field, op, value) => ({
          limit: () => ({
            get: async () => {
              const userDoc = usersByEmail[value];

              return userDoc
                ? { empty: false, docs: [{ data: () => userDoc }] }
                : { empty: true, docs: [] };
            },
          }),
        }),
      }),
      doc: (path) => ({
        set: async (data) => { writes.push({ path, data }); },
      }),
    }),
  };

  return { admin, writes };
}

function buildAssistant() {
  const calls = { logs: [], errors: [] };

  const ctx = {
    log: (...args) => calls.logs.push(args.join(' ')),
    error: (...args) => calls.errors.push(args.join(' ')),
  };

  return { ctx, calls };
}

/**
 * An Omega instance stub. The cron ENTRY runs stage 1, which sends the re-engagement
 * campaign through ctx.email — stages 2 and 3 never touch the mailer,
 * so the recorder stays optional.
 */
function buildOmega(marketing, admin = null) {
  return {
    config: { brand: BRAND, marketing },
    firebase: { admin },
  };
}

/** The ctx with its email door recording every campaign the re-engage stage sends. */
function withEmail(ctx, sentCampaigns) {
  ctx.email = {
    sendCampaign: async (campaign) => { sentCampaigns.push(campaign); return { success: true }; },
  };

  return ctx;
}

/**
 * Run a stage with the provider modules (and provider API keys) swapped for
 * the call, always restoring them — an ambient key must never let a stage
 * reach a real provider.
 */
async function withProviders({ sendgrid = {}, beehiiv = {}, env = {} }, run) {
  const originals = { sendgrid: {}, beehiiv: {}, env: {} };

  for (const [name, fn] of Object.entries(sendgrid)) {
    originals.sendgrid[name] = sendgridProvider[name];
    sendgridProvider[name] = fn;
  }

  for (const [name, fn] of Object.entries(beehiiv)) {
    originals.beehiiv[name] = beehiivProvider[name];
    beehiivProvider[name] = fn;
  }

  for (const [name, value] of Object.entries(env)) {
    originals.env[name] = process.env[name];
    process.env[name] = value;
  }

  try {
    return await run();
  } finally {
    for (const [name, fn] of Object.entries(originals.sendgrid)) {
      sendgridProvider[name] = fn;
    }

    for (const [name, fn] of Object.entries(originals.beehiiv)) {
      beehiivProvider[name] = fn;
    }

    for (const [name, value] of Object.entries(originals.env)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/**
 * Run with a Beehiiv publication configured. getPublicationId() reads the
 * static config off the Omega instance constructor, so the tests that exercise the
 * real listSubscriptions have to put one there, and always put back what they
 * found.
 */
async function withPublication(run) {
  const original = omega.config;

  omega.config = { marketing: { newsletter: { providers: { beehiiv: { publicationId: 'pub_test' } } } } };

  try {
    return await run();
  } finally {
    omega.config = original;
  }
}

/** A SendGrid segment export contact (the shape getSegmentContacts returns). */
function contact(email, id) {
  return { email, id };
}

/** Stage 2's SendGrid seam: one inactive contact, no paying customers. */
function sendgridSeam(contacts, deleted) {
  return {
    resolveSegmentIds: async () => ({ engagement_inactive_6m: 'seg_inactive' }),
    createBrandScopedSegment: async () => ({ segmentId: 'seg_temp', cleanup: async () => {} }),
    getSegmentContacts: async () => ({ success: true, contacts }),
    bulkDeleteContacts: async (ids) => { deleted.push(...ids); return { success: true }; },
  };
}

/**
 * A Beehiiv subscription with `stats` expanded. Defaults describe a subscriber
 * old enough and mailed enough to qualify — each case overrides the one field
 * it is about.
 */
function subscription({ email, received = NEWSLETTER_RECEIVED_FLOOR, openRate = 0, clickRate = 0, ageDays = NEWSLETTER_MIN_AGE_DAYS + 30 }) {
  return {
    id: `sub_${email}`,
    email,
    status: 'active',
    created: Math.round((Date.now() - (ageDays * DAY)) / 1000),
    stats: {
      emails_received: received,
      open_rate: openRate,
      click_through_rate: clickRate,
    },
  };
}

const NEWSLETTER_ENABLED = { campaigns: { enabled: true }, newsletter: { enabled: true } };

// Both providers live, and the prune switched on explicitly — the same shape the
// schema materializes into every brand config (`marketing.prune.enabled`,
// default true since Ian 2026-08-22).
const PRUNE_ENABLED = { ...NEWSLETTER_ENABLED, prune: { enabled: true } };

// The per-brand off switch: the ONE value that stops the monthly run.
const PRUNE_DISABLED = { ...NEWSLETTER_ENABLED, prune: { enabled: false } };

// Paid-ness is whatever the User calls active — the subscription_paid
// segment's two conditions (plan not basic AND status active), not a local rule.
const PAYING_USER = {
  auth: { email: 'payer@gmail.com' },
  subscription: { product: { id: 'premium' }, status: 'active' },
};

const FREE_USER = {
  auth: { email: 'free@gmail.com' },
  subscription: { product: { id: 'basic' }, status: 'active' },
};

const CANCELLED_USER = {
  auth: { email: 'cancelled@gmail.com' },
  subscription: { product: { id: 'premium' }, status: 'cancelled' },
};

// ─── isNewsletterInactive(): the Beehiiv lane's own rule ───
const INACTIVE_CASES = [
  {
    name: 'never opened or clicked across the received floor',
    subscription: { email: 'cold@gmail.com' },
    expected: true,
  },
  {
    name: 'opened at least once (a rate survives forever)',
    subscription: { email: 'opener@gmail.com', openRate: 12.5 },
    expected: false,
  },
  {
    name: 'clicked at least once',
    subscription: { email: 'clicker@gmail.com', clickRate: 4 },
    expected: false,
  },
  {
    name: 'under the received floor (a quiet channel prunes nobody)',
    subscription: { email: 'unmailed@gmail.com', received: NEWSLETTER_RECEIVED_FLOOR - 1 },
    expected: false,
  },
  {
    name: 'exactly at the received floor',
    subscription: { email: 'floor@gmail.com', received: NEWSLETTER_RECEIVED_FLOOR },
    expected: true,
  },
  {
    name: 'too new to judge (inside the grace period)',
    subscription: { email: 'fresh@gmail.com', ageDays: NEWSLETTER_MIN_AGE_DAYS - 1 },
    expected: false,
  },
];

module.exports = defineCases({
  description: 'Marketing prune is strictly per-provider (SendGrid lane + Beehiiv lane)',
  type: 'group',

  tests: [
    // ─── 1. The bug: SendGrid-inactive emails must NOT leave Beehiiv ───
    {
      name: 'stage 2: a SendGrid-inactive contact is deleted from SendGrid and left in Beehiiv',

      async run() {
        const { admin, writes } = buildAdmin();
        const { ctx } = buildAssistant();
        const deleted = [];
        const beehiivRemovals = [];

        await withProviders({
          sendgrid: sendgridSeam([contact('newsletter.reader@gmail.com', 'sg_1')], deleted),
          beehiiv: {
            removeContact: async (email) => { beehiivRemovals.push(email); return { success: true, deleted: true }; },
          },
          env: { SENDGRID_API_KEY: 'test-key', BEEHIIV_API_KEY: 'test-key' },
        }, () => stagePrune(buildOmega(NEWSLETTER_ENABLED, admin), ctx));

        expect(beehiivRemovals, `SendGrid engagement must never delete a Beehiiv subscriber, removed: ${JSON.stringify(beehiivRemovals)}`).toEqual([]);
        expect(deleted, `The SendGrid delete still runs, got ${JSON.stringify(deleted)}`).toEqual(['sg_1']);
        expect(writes.length, `Stage 2 writes one prune log, got ${writes.length}`).toBe(1);
        expect(writes[0].path, `The SendGrid lane keeps its run doc path, got ${writes[0].path}`).toBe(`marketing-prune-logs/${BRAND.id}/runs/${logKey()}`);
        expect(writes[0].data.emails, 'The log keeps the deleted emails for recoverability').toEqual(['newsletter.reader@gmail.com']);
      },
    },

    {
      name: 'stage 2: a paid segment whose query cannot be scoped deletes nobody and logs one error',

      async run() {
        const inactive = 'SELECT c.contact_id, c.updated_at FROM contact_data as c WHERE "engagement_last" <= timestampadd(day, -180, CURRENT_TIMESTAMP)';

        // An empty query, then one with no WHERE: neither can exclude a paying customer
        for (const paidQuery of [null, 'SELECT c.contact_id, c.updated_at FROM contact_data as c']) {
          const api = fakeProviderApi({
            sendgridSegments: {
              engagement_inactive_6m: { id: 'sg_inactive_6m', query: inactive },
              subscription_paid: { id: 'sg_paid', query: paidQuery },
            },
          });
          const deleted = [];
          const errors = [];

          await withProviderApi(api, async (load) => {
            const sendgrid = load('libraries/email/providers/sendgrid.js');

            // Every export answers both; only the missing paid exclusion would let them be deleted
            sendgrid.getSegmentContacts = async () => ({ success: true, contacts: [contact('cold@gmail.com', 'sg_cold'), contact('payer@gmail.com', 'sg_payer')] });
            sendgrid.bulkDeleteContacts = async (ids) => { deleted.push(...ids); return { success: true }; };

            const { stagePrune: stage } = load('events/cron/helpers/marketing-prune.js');
            const ctx = campaignCtx(load, { error: (...args) => errors.push(args.join(' ')) });

            await stage(ctx.omega, ctx);
          });

          expect(deleted, `paid query ${JSON.stringify(paidQuery)}: nobody is deleted`).toEqual([]);
          expect(errors.length, `paid query ${JSON.stringify(paidQuery)}: one error line, got ${JSON.stringify(errors)}`).toBe(1);
        }
      },
    },

    {
      name: 'stage 2: a failed paid export deletes nobody and logs one error; an empty one still prunes',

      async run() {
        // Each temp segment is named for what it scopes, so each export answers its own
        const exports = (paidExport) => ({
          temp_seg_inactive: { success: true, contacts: [contact('cold@gmail.com', 'sg_cold')] },
          temp_seg_paid: paidExport,
        });

        const prune = async (paidExport) => {
          const { admin } = buildAdmin();
          const { ctx, calls } = buildAssistant();
          const deleted = [];
          const answers = exports(paidExport);

          await withProviders({
            sendgrid: {
              resolveSegmentIds: async () => ({ engagement_inactive_6m: 'seg_inactive', subscription_paid: 'seg_paid' }),
              createBrandScopedSegment: async (segmentIds) => ({ segmentId: `temp_${segmentIds[0]}`, cleanup: async () => {} }),
              getSegmentContacts: async (segmentId) => {
                expect(segmentId in answers, `an export of an unknown segment: ${segmentId}`).toBe(true);
                return answers[segmentId];
              },
              bulkDeleteContacts: async (ids) => { deleted.push(...ids); return { success: true }; },
            },
            env: { SENDGRID_API_KEY: 'test-key' },
          }, () => stagePrune(buildOmega(NEWSLETTER_ENABLED, admin), ctx));

          return { deleted, errors: calls.errors };
        };

        const failed = await prune({ success: false, error: 'Export job failed' });

        expect(failed.deleted, 'without the paid list nobody can be spared, so nobody is deleted').toEqual([]);
        expect(failed.errors.length, `one error line, got ${JSON.stringify(failed.errors)}`).toBe(1);

        const empty = await prune({ success: true, contacts: [] });

        expect(empty.deleted, 'an export that answers no payer still prunes the cold contact').toEqual(['sg_cold']);
      },
    },

    // ─── 2. The Beehiiv lane's rule ───
    ...INACTIVE_CASES.map(({ name, subscription: options, expected }) => ({
      name: `isNewsletterInactive: ${name}`,

      run() {
        const actual = isNewsletterInactive(subscription(options), Date.now());

        expect(actual, `Expected ${expected}, got ${actual}`).toBe(expected);
      },
    })),

    {
      name: 'isNewsletterInactive: unjudgeable without stats (never delete on data we do not have)',

      run() {
        const bare = { id: 'sub_1', email: 'nostats@gmail.com', created: Math.round((Date.now() - (400 * DAY)) / 1000) };

        expect(isNewsletterInactive(bare, Date.now()), 'A subscription with no stats is never prunable').toBe(false);
        expect(isNewsletterInactive({ ...bare, stats: { emails_received: 40 } }, Date.now()), 'A stats block missing the rates is never prunable').toBe(false);
      },
    },

    // ─── 3. Stage 3 deletes exactly the Beehiiv-inactive subscribers ───
    {
      name: 'stage 3: deletes the Beehiiv-inactive subscribers and nobody else',

      async run() {
        const { admin, writes } = buildAdmin();
        const { ctx } = buildAssistant();
        const removals = [];
        const listArgs = [];

        await withProviders({
          beehiiv: {
            listSubscriptions: async (options) => {
              listArgs.push(options);
              return {
                success: true,
                subscriptions: [
                  subscription({ email: 'cold@gmail.com' }),
                  subscription({ email: 'opener@gmail.com', openRate: 22 }),
                  subscription({ email: 'clicker@gmail.com', clickRate: 3 }),
                  subscription({ email: 'unmailed@gmail.com', received: NEWSLETTER_RECEIVED_FLOOR - 1 }),
                  subscription({ email: 'fresh@gmail.com', ageDays: 3 }),
                ],
              };
            },
            removeContact: async (email) => { removals.push(email); return { success: true, deleted: true }; },
          },
          env: { BEEHIIV_API_KEY: 'test-key' },
        }, () => stageNewsletterPrune(buildOmega(NEWSLETTER_ENABLED, admin), ctx));

        expect(removals, `Only the Beehiiv-inactive subscriber is deleted, got ${JSON.stringify(removals)}`).toEqual(['cold@gmail.com']);
        expect(listArgs, `The lane reads Beehiiv's own per-subscriber stats, got ${JSON.stringify(listArgs)}`).toEqual([{ status: 'active', expand: ['stats'] }]);
        expect(writes[0]?.path, `The Beehiiv lane logs under its own run doc, got ${writes[0]?.path}`).toBe(`marketing-prune-logs/${BRAND.id}/runs/${logKey()}-newsletter`);
        expect(writes[0].data.emails, 'The log keeps the deleted emails for recoverability').toEqual(['cold@gmail.com']);
      },
    },

    // ─── 4. A quiet channel prunes nobody (the received-floor dormancy) ───
    {
      name: 'stage 3: a channel that has barely sent prunes nobody',

      async run() {
        const { admin, writes } = buildAdmin();
        const { ctx } = buildAssistant();
        const removals = [];

        await withProviders({
          beehiiv: {
            listSubscriptions: async () => ({
              success: true,
              subscriptions: [
                subscription({ email: 'a@gmail.com', received: 0 }),
                subscription({ email: 'b@gmail.com', received: NEWSLETTER_RECEIVED_FLOOR - 1 }),
              ],
            }),
            removeContact: async (email) => { removals.push(email); return { success: true }; },
          },
          env: { BEEHIIV_API_KEY: 'test-key' },
        }, () => stageNewsletterPrune(buildOmega(NEWSLETTER_ENABLED, admin), ctx));

        expect(removals, `Dormancy is the guard working, got ${JSON.stringify(removals)}`).toEqual([]);
        expect(writes.length, 'Nothing deleted means nothing logged').toBe(0);
      },
    },

    // ─── 5. A failed listing deletes nothing ───
    {
      name: 'stage 3: a failed listing deletes nobody',

      async run() {
        const { admin } = buildAdmin();
        const { ctx, calls } = buildAssistant();
        const removals = [];

        await withProviders({
          beehiiv: {
            listSubscriptions: async () => ({ success: false, error: 'Publication not found' }),
            removeContact: async (email) => { removals.push(email); return { success: true }; },
          },
          env: { BEEHIIV_API_KEY: 'test-key' },
        }, () => stageNewsletterPrune(buildOmega(NEWSLETTER_ENABLED, admin), ctx));

        expect(removals, `A partial or failed read must never drive deletes, got ${JSON.stringify(removals)}`).toEqual([]);
        expect(calls.errors.length, `The failed listing is logged loudly, got ${JSON.stringify(calls.errors)}`).toBe(1);
      },
    },

    // ─── 6. A subscriber who vanished mid-run is not counted as pruned ───
    {
      name: 'stage 3: a subscriber already gone at delete time is not logged as pruned',

      async run() {
        const { admin, writes } = buildAdmin();
        const { ctx } = buildAssistant();

        await withProviders({
          beehiiv: {
            listSubscriptions: async () => ({
              success: true,
              subscriptions: [
                subscription({ email: 'cold@gmail.com' }),
                subscription({ email: 'vanished@gmail.com' }),
              ],
            }),
            // Beehiiv answers { success: true, skipped: true } when the
            // subscription is already gone — a skip is not a prune.
            removeContact: async (email) => (email === 'vanished@gmail.com'
              ? { success: true, skipped: true, reason: 'Subscriber not found' }
              : { success: true, deleted: true }),
          },
          env: { BEEHIIV_API_KEY: 'test-key' },
        }, () => stageNewsletterPrune(buildOmega(NEWSLETTER_ENABLED, admin), ctx));

        expect(writes[0]?.data.emails, `Only the subscribers this run actually deleted are logged, got ${JSON.stringify(writes[0]?.data.emails)}`).toEqual(['cold@gmail.com']);
        expect(writes[0]?.data.count, `The recoverability count matches the deletes, got ${writes[0]?.data.count}`).toBe(1);
      },
    },

    // ─── 7. Paying customers are never pruned (stage 2's exclusion, stage 3's data) ───
    {
      name: 'stage 3: a paying account is skipped and the free ones still go',

      async run() {
        const { admin, writes } = buildAdmin({
          'payer@gmail.com': PAYING_USER,
          'free@gmail.com': FREE_USER,
          'cancelled@gmail.com': CANCELLED_USER,
        });
        const { ctx } = buildAssistant();
        const removals = [];

        await withProviders({
          beehiiv: {
            listSubscriptions: async () => ({
              success: true,
              subscriptions: [
                subscription({ email: 'payer@gmail.com' }),
                subscription({ email: 'free@gmail.com' }),
                subscription({ email: 'cancelled@gmail.com' }),
                subscription({ email: 'noaccount@gmail.com' }),
              ],
            }),
            removeContact: async (email) => { removals.push(email); return { success: true, deleted: true }; },
          },
          env: { BEEHIIV_API_KEY: 'test-key' },
        }, () => stageNewsletterPrune(buildOmega(NEWSLETTER_ENABLED, admin), ctx));

        expect(removals, `A paying account is never pruned, and nobody else is spared, got ${JSON.stringify(removals)}`).toEqual(['free@gmail.com', 'cancelled@gmail.com', 'noaccount@gmail.com']);
        expect(writes[0]?.data.skippedPaid, `The run log counts the skipped payer, got ${writes[0]?.data.skippedPaid}`).toBe(1);
        expect(writes[0]?.data.emails, `The run log holds only the deleted emails, got ${JSON.stringify(writes[0]?.data.emails)}`).toEqual(['free@gmail.com', 'cancelled@gmail.com', 'noaccount@gmail.com']);
      },
    },

    {
      name: 'stage 3: a legacy account with a top-level plan skips that one and the run finishes',

      async run() {
        // A pre-account-model user document carries `plan` at the top level,
        // which the User refuses to construct. That one document is skipped;
        // the batch around it is still judged and the run completes.
        const { admin, writes } = buildAdmin({
          'legacy@gmail.com': { auth: { email: 'legacy@gmail.com' }, plan: { id: 'premium' } },
          'free@gmail.com': FREE_USER,
        });
        const { ctx } = buildAssistant();
        const removals = [];

        await withProviders({
          beehiiv: {
            listSubscriptions: async () => ({
              success: true,
              subscriptions: [
                subscription({ email: 'legacy@gmail.com' }),
                subscription({ email: 'free@gmail.com' }),
                subscription({ email: 'noaccount@gmail.com' }),
              ],
            }),
            removeContact: async (email) => { removals.push(email); return { success: true, deleted: true }; },
          },
          env: { BEEHIIV_API_KEY: 'test-key' },
        }, () => stageNewsletterPrune(buildOmega(NEWSLETTER_ENABLED, admin), ctx));

        expect(removals, `The free account is still pruned, got ${JSON.stringify(removals)}`).toContain('free@gmail.com');
        expect(removals, `The contact with no account is still pruned, got ${JSON.stringify(removals)}`).toContain('noaccount@gmail.com');
        expect(writes.length, 'The run finished and logged its deletions').toBe(1);
      },
    },

    {
      name: 'stage 3: an all-paying candidate set deletes nobody',

      async run() {
        const { admin, writes } = buildAdmin({ 'payer@gmail.com': PAYING_USER });
        const { ctx } = buildAssistant();
        const removals = [];

        await withProviders({
          beehiiv: {
            listSubscriptions: async () => ({
              success: true,
              subscriptions: [subscription({ email: 'payer@gmail.com' })],
            }),
            removeContact: async (email) => { removals.push(email); return { success: true, deleted: true }; },
          },
          env: { BEEHIIV_API_KEY: 'test-key' },
        }, () => stageNewsletterPrune(buildOmega(NEWSLETTER_ENABLED, admin), ctx));

        expect(removals, `Nothing left to prune means no deletes, got ${JSON.stringify(removals)}`).toEqual([]);
        expect(writes.length, 'Nothing deleted means nothing logged').toBe(0);
      },
    },

    // ─── 8. The lane is gated on Beehiiv being configured ───
    {
      name: 'stage 3: skips when the newsletter is disabled',

      async run() {
        const { admin } = buildAdmin();
        const { ctx } = buildAssistant();
        let listed = false;

        await withProviders({
          beehiiv: {
            listSubscriptions: async () => { listed = true; return { success: true, subscriptions: [] }; },
          },
          env: { BEEHIIV_API_KEY: 'test-key' },
        }, () => stageNewsletterPrune(
          buildOmega({ campaigns: { enabled: true }, newsletter: { enabled: false } }, admin),
          ctx,
        ));

        expect(listed, 'A disabled newsletter never reaches the provider').toBe(false);
      },
    },

    // ─── 9. listSubscriptions: the pagination contract ───
    {
      name: 'listSubscriptions: follows the cursor to the end',

      async run() {
        const calls = [];
        const pages = [
          { data: [{ id: 'sub_1' }, { id: 'sub_2' }], has_more: true, next_cursor: 'cursor_2' },
          { data: [{ id: 'sub_3' }], has_more: false, next_cursor: null },
        ];

        const request = async (url) => {
          calls.push(url);
          return pages[calls.length - 1];
        };

        const result = await withPublication(() => beehiivProvider.listSubscriptions(
          { status: 'active', expand: ['stats'] },
          request,
        ));

        expect(result.success, `Expected a successful walk, got ${JSON.stringify(result)}`).toBe(true);
        expect(result.subscriptions.length, `Every page's subscribers are collected, got ${result.subscriptions.length}`).toBe(3);
        expect(calls.length, `The walk stops on has_more: false, got ${calls.length} calls`).toBe(2);
        expect(calls[0], `The first page asks for a full page, got ${calls[0]}`).toMatch(/limit=100/);
        expect(calls[0], `The status filter rides the query, got ${calls[0]}`).toMatch(/status=active/);
        expect(calls[0], `The stats expand rides the query unencoded, got ${calls[0]}`).toMatch(/expand\[\]=stats/);
        expect(!calls[0].includes('cursor='), `The first page carries no cursor, got ${calls[0]}`).toBeTruthy();
        expect(calls[1], `The next page carries the returned cursor, got ${calls[1]}`).toMatch(/cursor=cursor_2/);
      },
    },

    {
      name: 'listSubscriptions: an offset-paginated response fails instead of truncating',

      async run() {
        const full = { data: Array.from({ length: 100 }, (_, i) => ({ id: `sub_${i}` })), limit: 100, page: 1, total_pages: 3 };
        let calls = 0;

        const result = await withPublication(() => beehiivProvider.listSubscriptions({}, async () => {
          calls++;
          return full;
        }));

        expect(result.success, `A response with no has_more and more pages behind it must fail, got ${JSON.stringify(result).slice(0, 120)}`).toBe(false);
        expect(result.error, `The error names the shape, got ${result.error}`).toMatch(/offset/i);
        expect(calls, `The walk stops at the unexpected shape, got ${calls} calls`).toBe(1);

        // The carve-out: one short page with nothing behind it is complete, not truncated.
        const short = await withPublication(() => beehiivProvider.listSubscriptions({}, async () => ({
          data: [{ id: 'sub_1' }, { id: 'sub_2' }],
          limit: 100,
        })));

        expect(short.success, `A single short page is a complete list, got ${JSON.stringify(short).slice(0, 120)}`).toBe(true);
        expect(short.subscriptions.length, `Got ${short.subscriptions.length}`).toBe(2);
      },
    },

    {
      name: 'listSubscriptions: the page cap fails instead of truncating',

      async run() {
        let calls = 0;

        const result = await withPublication(() => beehiivProvider.listSubscriptions({}, async () => {
          calls++;
          return { data: [{ id: `sub_${calls}` }], has_more: true, next_cursor: `cursor_${calls}` };
        }));

        expect(result.success, `A never-ending walk must fail, got ${JSON.stringify(result).slice(0, 120)}`).toBe(false);
        expect(result.error, `The error names the cap, got ${result.error}`).toMatch(/500 pages/);
        expect(calls, `The cap stops the walk at 500 pages, got ${calls}`).toBe(500);
        expect(result.subscriptions, 'A capped walk reports no list at all, so nobody can prune from it').toBe(undefined);
      },
    },

    // ─── 10. The cron entry reads a DEFAULT-ON switch (#551) ───
    // `marketing.prune.enabled` carries the schema default `true` (Ian
    // 2026-08-22), and the entry read it `!== true` — the opt-in polarity of
    // [#422](https://github.com/Omega-JS-Stack/omega/issues/422), left behind
    // when the default flipped. Any omega.config assembled outside
    // loadConfig()'s materialization then silently skipped the monthly run
    // ([#551](https://github.com/Omega-JS-Stack/omega/issues/551)).
    {
      name: 'entry: a marketing block with no prune key still runs every lane',

      async run() {
        const { admin, writes } = buildAdmin();
        const { ctx } = buildAssistant();
        const deleted = [];
        const removals = [];
        const sent = [];

        await onPruneDay(() => withProviders({
          sendgrid: sendgridSeam([contact('cold@gmail.com', 'sg_1')], deleted),
          beehiiv: {
            listSubscriptions: async () => ({
              success: true,
              subscriptions: [subscription({ email: 'cold@gmail.com' })],
            }),
            removeContact: async (email) => { removals.push(email); return { success: true, deleted: true }; },
          },
          env: { SENDGRID_API_KEY: 'test-key', BEEHIIV_API_KEY: 'test-key' },
        }, () => cron({ ctx: withEmail(ctx, sent), omega: buildOmega(NEWSLETTER_ENABLED, admin) })));

        expect(deleted, `An unmentioned prune is ON, so the SendGrid lane deletes, got ${JSON.stringify(deleted)}`).toEqual(['sg_1']);
        expect(removals, `An unmentioned prune is ON, so the Beehiiv lane deletes, got ${JSON.stringify(removals)}`).toEqual(['cold@gmail.com']);
        expect(sent.length, `The re-engagement campaign sends, got ${sent.length}`).toBe(1);
        expect(writes.length, `Both lanes log their run doc, got ${JSON.stringify(writes.map((write) => write.path))}`).toBe(2);
      },
    },

    {
      name: 'entry: prune.enabled = false books zero deletions',

      async run() {
        const { admin, writes } = buildAdmin();
        const { ctx, calls } = buildAssistant();
        const deleted = [];
        const removals = [];
        const sent = [];

        await onPruneDay(() => withProviders({
          sendgrid: sendgridSeam([contact('cold@gmail.com', 'sg_1')], deleted),
          beehiiv: {
            listSubscriptions: async () => ({
              success: true,
              subscriptions: [subscription({ email: 'cold@gmail.com' })],
            }),
            removeContact: async (email) => { removals.push(email); return { success: true, deleted: true }; },
          },
          env: { SENDGRID_API_KEY: 'test-key', BEEHIIV_API_KEY: 'test-key' },
        }, () => cron({ ctx: withEmail(ctx, sent), omega: buildOmega(PRUNE_DISABLED, admin) })));

        expect(deleted, `A brand that opted out deletes no SendGrid contact, got ${JSON.stringify(deleted)}`).toEqual([]);
        expect(removals, `A brand that opted out deletes no Beehiiv subscriber, got ${JSON.stringify(removals)}`).toEqual([]);
        expect(sent, `A brand that opted out sends no re-engagement campaign, got ${JSON.stringify(sent)}`).toEqual([]);
        expect(writes.length, `Nothing ran, so nothing is logged, got ${JSON.stringify(writes)}`).toBe(0);
        expect(calls.logs.some((line) => line.includes('Marketing prune: disabled')), `The skip is logged, got ${JSON.stringify(calls.logs)}`).toBeTruthy();
      },
    },

    {
      name: 'entry: prune.enabled = true runs every lane',

      async run() {
        const { admin, writes } = buildAdmin();
        const { ctx } = buildAssistant();
        const deleted = [];
        const removals = [];
        const sent = [];

        await onPruneDay(() => withProviders({
          sendgrid: sendgridSeam([contact('cold@gmail.com', 'sg_1')], deleted),
          beehiiv: {
            listSubscriptions: async () => ({
              success: true,
              subscriptions: [subscription({ email: 'cold@gmail.com' })],
            }),
            removeContact: async (email) => { removals.push(email); return { success: true, deleted: true }; },
          },
          env: { SENDGRID_API_KEY: 'test-key', BEEHIIV_API_KEY: 'test-key' },
        }, () => cron({ ctx: withEmail(ctx, sent), omega: buildOmega(PRUNE_ENABLED, admin) })));

        expect(deleted, `The SendGrid lane still deletes, got ${JSON.stringify(deleted)}`).toEqual(['sg_1']);
        expect(removals, `The Beehiiv lane still deletes, got ${JSON.stringify(removals)}`).toEqual(['cold@gmail.com']);
        expect(sent.length, `The re-engagement campaign still sends, got ${sent.length}`).toBe(1);
        expect(writes.map((write) => write.path), `Both lanes log their run doc, got ${JSON.stringify(writes.map((write) => write.path))}`).toEqual([
            `marketing-prune-logs/${BRAND.id}/runs/${logKey()}`,
            `marketing-prune-logs/${BRAND.id}/runs/${logKey()}-newsletter`,
          ]);
      },
    },
  ],
});
