/**
 * Campaign config-fault finalization — a permanent brand-config hole fails the
 * campaign in ONE cron pass instead of retrying forever.
 *
 * A send that throws leaves the campaign at 'processing' for the stale-lease
 * reclaim — right for a crash or a provider blip, wrong for a config hole
 * (missing `brand.url` on the push path, missing `brand.contact.*` on the email
 * path), which no amount of retrying can heal. The cron now finalizes a CODED
 * 400 — the framework's config-fault convention — as 'failed', and leaves
 * everything else on its existing path.
 *
 * A permanent fault reaches the cron three ways, all covered here:
 *   - thrown by the send (the push path throws its brand.url 400 directly)
 *   - CARRIED in a provider result: sendCampaign() converts each provider's
 *     throw to { success: false, error, code }, so the email path's config-hole
 *     400s never surface as throws
 *   - thrown by the generator pipeline (the AI library's invalid-request 400s),
 *     which the empty-generation attempts ladder never counts
 *
 * Plain-node control-flow test (no emulator, no network): the real cron module
 * and the real notification library throw the real coded error. Only Firestore
 * is a minimal in-memory stand-in — the fixture project's brand IS fully
 * configured, so the emulator suite (campaign-cron-pipeline) cannot produce a
 * config hole at all; it stays the integration surface for the happy paths.
 */
const expect = require('../../dist/vendor/devkit/test/expect.js');
const cron = require('../../dist/omega/events/cron/frequent/marketing-campaigns.js');
const newsletter = require('../../dist/omega/libraries/email/generators/newsletter.js');
const Marketing = require('../../dist/omega/libraries/email/marketing/index.js');
const { getNextFutureOccurrence } = require('../../dist/omega/libraries/email/constants.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');
const { memoryAdmin } = require('./_campaign-harness.js');

// The config-hole message the email library actually throws (prepare.js).
const EMAIL_CONFIG_HOLE = 'Missing brand.contact.email in config/omega.json5';

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// No `url` — the push path's coded-400 config hole (notification.js throws it).
const BRAND_WITHOUT_URL = { id: 'acme', name: 'Acme' };

function stamp(now) {
  return { timestamp: new Date(now * 1000).toISOString(), timestampUNIX: now };
}

const COLLECTION = 'marketing-campaigns';

/**
 * Run one cron pass over the seeded campaigns (keyed by id, in the harness's
 * in-memory Firestore) and return the resulting docs as a Map of id to doc.
 *
 * `sendCampaign` defaults to a throw so an accidental email dispatch on the
 * push cases is loud rather than silently passing; the email cases pass their
 * own. `generate` swaps the newsletter generator's export for the run (the
 * cron requires the module by path, so the require cache IS the seam) and is
 * always restored.
 */
async function runCron(seed, { sendCampaign, generate } = {}) {
  const { admin, docs } = memoryAdmin(Object.fromEntries(Object.entries(seed).map(([id, doc]) => [`${COLLECTION}/${id}`, doc])));
  const logs = [];
  const errors = [];

  const omega = {
    config: { brand: BRAND_WITHOUT_URL },
    firebase: { admin },
    isProduction: () => false,
  };

  // notification.send() reads the brand off ctx.omega, as it does in the
  // real framework ctx.
  const ctx = {
    omega,
    email: {
      sendCampaign: sendCampaign
        || (async () => { throw new Error('sendCampaign() should not be reached'); }),
    },
    log: (...args) => logs.push(args.join(' ')),
    error: (...args) => errors.push(args.join(' ')),
  };

  const original = newsletter.generate;

  if (generate) {
    newsletter.generate = generate;
  }

  try {
    await cron({ ctx, omega });
  } finally {
    newsletter.generate = original;
  }

  const store = new Map([...docs.entries()]
    .filter(([docPath]) => docPath.startsWith(`${COLLECTION}/`))
    .map(([docPath, doc]) => [docPath.slice(COLLECTION.length + 1), doc]));

  return { store, logs, errors };
}

/** A due push campaign whose title/body are set — the send reaches buildPayload. */
function pushCampaign(now, extra = {}) {
  return {
    status: 'pending',
    type: 'push',
    sendAt: now - 600,
    settings: { name: '[TEST] Config fault', subject: 'Body copy' },
    metadata: { created: stamp(now), updated: stamp(now) },
    ...extra,
  };
}

/** A due email campaign. */
function emailCampaign(now, extra = {}) {
  return {
    status: 'pending',
    type: 'email',
    sendAt: now - 600,
    settings: { name: '[TEST] Config fault', subject: 'Subject' },
    metadata: { created: stamp(now), updated: stamp(now) },
    ...extra,
  };
}

/** A due newsletter-generator campaign. */
function generatorCampaign(now, extra = {}) {
  return emailCampaign(now, { generator: 'newsletter', ...extra });
}

const WEEKLY = { pattern: 'weekly', hour: 10, minute: 0, day: 1 };

module.exports = defineCases({
  description: 'Campaign config faults finalize as failed (no forever-retry)',
  type: 'group',
  timeout: 30000,

  tests: [
    {
      name: 'a coded-400 config fault fails the campaign in one pass',

      async run() {
        const now = Math.round(Date.now() / 1000);
        const { store } = await runCron({ '_fault-oneoff': pushCampaign(now) });
        const doc = store.get('_fault-oneoff');

        expect(doc.status, 'a config hole must be finalized, not left for the lease reclaim').toBe('failed');
        expect(doc.error, 'the error names the missing config key').toMatch(/brand\.url/);
        expect(doc.metadata?.updated, 'the finalize stamps metadata.updated').toBeTruthy();
      },
    },

    {
      name: 'a recurring campaign fails outright too (a recurrence cannot heal it)',

      async run() {
        const now = Math.round(Date.now() / 1000);
        const sendAt = now - 600;
        const { store } = await runCron({
          '_fault-recurring': pushCampaign(now, { recurrence: WEEKLY }),
        });
        const doc = store.get('_fault-recurring');

        expect(doc.status, 'the recurring doc fails rather than returning to pending').toBe('failed');
        expect(doc.sendAt, 'sendAt is NOT advanced — the next occurrence meets the same hole').toBe(sendAt);
        expect(doc.error, 'the error names the missing config key').toMatch(/brand\.url/);
      },
    },

    {
      name: 'an uncoded (transient) throw still stays processing for the lease reclaim',

      async run() {
        const now = Math.round(Date.now() / 1000);
        // No subject/body — notification.send() throws a CODE-LESS error, the
        // transient shape. Unchanged behavior: the doc keeps its lease.
        const { store, errors } = await runCron({
          '_transient': pushCampaign(now, { settings: { name: '[TEST] Transient' } }),
        });
        const doc = store.get('_transient');

        expect(doc.status, 'a code-less failure keeps the stale-lease retry path').toBe('processing');
        expect(!doc.error, 'no terminal error field is written').toBeTruthy();
        expect(errors.length, 'the rejection is still reported once').toBe(1);
        expect(errors[0], 'the reported reason is the real throw').toMatch(/title and body are required/);
      },
    },

    {
      name: 'a stale lease is still reclaimed and re-processed',

      async run() {
        const now = Math.round(Date.now() / 1000);
        const { store } = await runCron({
          '_stale': pushCampaign(now, {
            status: 'processing',
            processingStartedAt: now - cron.PROCESSING_LEASE_SECONDS - 600,
          }),
        });
        const doc = store.get('_stale');

        // Reclaimed → pending, then picked up by the same pass's due query and
        // finalized by the config fault. The reclaim itself is untouched.
        expect(doc.status, 'the reclaimed campaign is processed in the same pass').toBe('failed');
      },
    },

    // ---------- Email path: the fault is CARRIED, not thrown ----------

    {
      name: 'sendCampaign keeps a provider throw\'s code (and omits it when absent)',

      run() {
        const coded = Marketing.providerFailure(codedError(EMAIL_CONFIG_HOLE, 400));

        expect(coded.success, 'still the failure shape callers read').toBe(false);
        expect(coded.error, 'still carries the message').toBe(EMAIL_CONFIG_HOLE);
        expect(coded.code, 'the config-fault code survives the conversion').toBe(400);

        const plain = Marketing.providerFailure(new Error('SendGrid 503'));

        expect(!('code' in plain), 'no code key at all — Firestore rejects undefined field values').toBeTruthy();
      },
    },

    {
      name: 'a carried coded-400 fails a one-off email campaign',

      async run() {
        const now = Math.round(Date.now() / 1000);
        const { store } = await runCron(
          { '_email-oneoff': emailCampaign(now) },
          { sendCampaign: async () => ({ campaigns: { success: false, error: EMAIL_CONFIG_HOLE, code: 400 } }) },
        );
        const doc = store.get('_email-oneoff');

        expect(doc.status, 'a carried config fault finalizes the campaign').toBe('failed');
        expect(doc.error, 'the provider message lands in error').toBe(EMAIL_CONFIG_HOLE);
      },
    },

    {
      name: 'a carried coded-400 fails a recurring email campaign without advancing sendAt',

      async run() {
        const now = Math.round(Date.now() / 1000);
        const sendAt = now - 600;
        const { store } = await runCron(
          { '_email-recurring': emailCampaign(now, { recurrence: WEEKLY }) },
          { sendCampaign: async () => ({ campaigns: { success: false, error: EMAIL_CONFIG_HOLE, code: 400 } }) },
        );
        const doc = store.get('_email-recurring');

        expect(doc.status, 'the recurring doc must not return to pending').toBe('failed');
        expect(doc.sendAt, 'sendAt is NOT advanced into the identical failure').toBe(sendAt);
        expect(store.size, 'no history doc for a campaign that never sent').toBe(1);
      },
    },

    {
      name: 'a code-less provider failure keeps today\'s success:false bookkeeping',

      async run() {
        const now = Math.round(Date.now() / 1000);
        const sendAt = now - 600;
        const { store } = await runCron(
          { '_email-transient': emailCampaign(now, { recurrence: WEEKLY }) },
          { sendCampaign: async () => ({ campaigns: { success: false, error: 'SendGrid 503' } }) },
        );
        const doc = store.get('_email-transient');

        // Pinned as found: a transient provider failure still writes a 'failed'
        // history doc and re-pends the recurring template at its next occurrence.
        expect(doc.status, 'the recurring template returns to pending').toBe('pending');
        expect(doc.sendAt, 'sendAt advances').toBe(getNextFutureOccurrence(sendAt, WEEKLY, now));
        expect(store.size, 'the history doc is still written').toBe(2);

        const history = [...store.values()].find(d => d.recurringId === '_email-transient');
        expect(history.status, 'the history doc records the failed send').toBe('failed');
      },
    },

    {
      name: 'a thrown coded-400 fails an email campaign too',

      async run() {
        const now = Math.round(Date.now() / 1000);
        const { store } = await runCron(
          { '_email-thrown': emailCampaign(now) },
          { sendCampaign: async () => { throw codedError(EMAIL_CONFIG_HOLE, 400); } },
        );
        const doc = store.get('_email-thrown');

        expect(doc.status, 'the dispatch catch covers the email path, not just push').toBe('failed');
        expect(doc.error, 'the thrown message lands in error').toBe(EMAIL_CONFIG_HOLE);
      },
    },

    // ---------- Generator path: a THROW never reaches the attempts ladder ----------

    {
      name: 'a coded-400 out of generate() fails the campaign in one pass',

      async run() {
        const now = Math.round(Date.now() / 1000);
        const { store } = await runCron(
          { '_gen-fault': generatorCampaign(now, { recurrence: WEEKLY }) },
          { generate: async () => { throw codedError('Error loading prompt[system]: missing', 400); } },
        );
        const doc = store.get('_gen-fault');

        expect(doc.status, 'a permanent AI fault is finalized, not reclaimed forever').toBe('failed');
        expect(doc.error, 'the pipeline message lands in error').toMatch(/Error loading prompt/);
        expect(!doc.generatorAttempts, 'the empty-generation ladder never counted a throw').toBeTruthy();
      },
    },

    {
      name: 'an uncoded generate() rejection still stays processing',

      async run() {
        const now = Math.round(Date.now() / 1000);
        const { store, errors } = await runCron(
          { '_gen-transient': generatorCampaign(now) },
          { generate: async () => { throw new Error('OpenAI rate limit'); } },
        );
        const doc = store.get('_gen-transient');

        expect(doc.status, 'a transient AI fault keeps the stale-lease retry path').toBe('processing');
        expect(!doc.error, 'no terminal error field is written').toBeTruthy();
        expect(errors[0], 'the reported reason is the real throw').toMatch(/rate limit/);
      },
    },
  ],
});
