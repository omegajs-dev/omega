/**
 * Beehiiv service tests — all 4 operations against a method-level recording
 * fake. Proves skip semantics, the converged zero-mutation no-op,
 * publication resolution (config/state verify, auto-match by name, the
 * manual-creation warn — publications have no create API), SSOT-driven
 * custom-field reconciliation diffed by display, the segments operation
 * (Beehiiv has no segment-create API — the API side never mutates; the
 * interactive extension-automation path is driven end-to-end over a fake
 * TTY + a REAL ws client standing in for the extension, with the
 * post-automation re-verify pinned to what the API reports), the
 * min-diff webhook patch, and the dry-run zero-mutation guarantee.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const net = require('node:net');
const WebSocket = require('ws');

const { OPERATIONS, DEFAULTS } = require('../src/config.js');
const { fieldsFor, segmentsFor } = require('../src/lib/backend-marketing.js');
const { openTtyPrompt } = require('./lib/interactive.js');
const service = require('../src/services/newsletter/index.js');
const { emailProviderForRole } = require('@omega.js/config');

// Tests must never see real credentials from the shell environment
delete process.env.BEEHIIV_API_KEY;
delete process.env.OMEGA_WEBHOOK_KEY;

const DOMAIN = 'fixture-brand.test';
const BRAND_NAME = 'Fixture Brand';
const PUB_ID = 'pub_fixture123';
const WEBHOOK_KEY = 'fixture-webhook-key';
const WEBHOOK_URL = `https://api.${DOMAIN}/omega/marketing/webhook/forward?provider=beehiiv&key=${WEBHOOK_KEY}`;
const WEBHOOK_DESCRIPTION = '@omega.js/backend consent pipeline (managed by OMEGA — do not edit manually)';
const EVENT_TYPES = ['subscription.unsubscribed', 'subscription.deleted', 'subscription.paused'];

const BEEHIIV_FIELDS = fieldsFor('beehiiv');
const BEEHIIV_SEGMENTS = segmentsFor('beehiiv');
const KIND_MAP = { text: 'string', number: 'integer', date: 'datetime' };

// ─── Fixtures ────────────────────────────────────────────────────────────────

// `company` is the RESOLVED section (#677): a brand with no company of its own
// resolves to its OWN url, which is what the retired `parent: 'self'` said.
function brandConfig({ url = `https://${DOMAIN}`, company = { id: null, url, images: {} }, webhooks = true, publicationId = null, newsletter = {} } = {}) {
  return {
    brand: { id: 'fixture-brand', name: BRAND_NAME, url, description: 'A fixture brand' },
    company: { ...company, webhooks },
    marketing: {
      newsletter: {
        ...structuredClone(DEFAULTS.marketing.newsletter),
        providers: { beehiiv: { publicationId } },
        ...newsletter,
      },
    },
    targets: { web: { type: 'web' } },
  };
}

const READ_METHODS = ['getPublication', 'listPublications', 'getCustomFields', 'getSegments', 'listWebhooks'];
const MUTATING_METHODS = ['createCustomField', 'deleteCustomField', 'createWebhook', 'updateWebhook'];

/** Method-level recording fake — a call with no configured response throws LOUDLY. */
function fakeBeehiiv(responses = {}) {
  const api = { calls: [] };

  for (const method of [...READ_METHODS, ...MUTATING_METHODS]) {
    api[method] = async (...args) => {
      api.calls.push({ method, args });
      if (!(method in responses)) {
        throw new Error(`fakeBeehiiv: unexpected call ${method}(${JSON.stringify(args)})`);
      }
      const responder = responses[method];
      return typeof responder === 'function' ? responder(...args) : structuredClone(responder);
    };
  }

  api.mutations = () => api.calls.filter((c) => MUTATING_METHODS.includes(c.method));
  api.callsTo = (method) => api.calls.filter((c) => c.method === method);
  return api;
}

/** Everything already matches — the whole service should be reads only. */
function convergedResponses() {
  return {
    getPublication: { id: PUB_ID, name: BRAND_NAME },
    getCustomFields: BEEHIIV_FIELDS.map((f, i) => ({ id: `bf${i}`, name: f.name, display: f.display, kind: KIND_MAP[f.type] })),
    getSegments: BEEHIIV_SEGMENTS.map((s, i) => ({ id: `bs${i}`, name: s.name })),
    listWebhooks: [{ id: 'wh_1', url: WEBHOOK_URL, event_types: [...EVENT_TYPES], description: WEBHOOK_DESCRIPTION, enabled: true }],
  };
}

const { makeBrandRoot, readConfigSource } = require('./lib/config-fixture.js');

// Writeback target — the publication op edits config/omega.json5 in the
// brand root; these comments must survive every service write.
const WRITEBACK_CONFIG = `// Fixture Brand — hand-edited writeback target
{
  brand: { id: 'fixture-brand', name: "Fixture Brand" },
  marketing: {
    newsletter: {
      enabled: true, // the resolved id lands next to this
    },
  },
}
`;

function runService(config, { beehiiv, options = {}, serviceData = {}, webhookKey = true, brandRoot, companyConfig } = {}) {
  if (webhookKey) {
    process.env.OMEGA_WEBHOOK_KEY = WEBHOOK_KEY;
  } else {
    delete process.env.OMEGA_WEBHOOK_KEY;
  }

  return service.run({
    brandId: 'fixture-brand',
    brandRoot: brandRoot || makeBrandRoot(WRITEBACK_CONFIG), // the publication op writes into config/omega.json5 here
    brandConfig: config,
    brand: { id: 'fixture-brand', config, enabledTargets: Object.keys(config.targets || {}), targets: [] },
    targets: [],
    operations: OPERATIONS.newsletter,
    options,
    serviceData,
    beehiivApi: beehiiv,
    companyConfig,
  });
}

/** Ephemeral port for the automation server (parallel-safe). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * A fake extension: retries until the AutomationClient's server is up,
 * then answers every OMEGA_AUTOMATE with a success whose value satisfies
 * all the automation's clicked/typed gates. Records the command stream.
 */
function startFakeExtension(port) {
  const commands = [];
  let ws = null;
  let stopped = false;

  const tryConnect = () => {
    if (stopped) return;
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('error', () => setTimeout(tryConnect, 25));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      commands.push(msg);
      ws.send(JSON.stringify({
        type: 'OMEGA_AUTOMATE_RESULT',
        id: msg.id,
        success: true,
        result: { value: { clicked: true, typed: true, focused: true } },
      }));
    });
  };
  tryConnect();

  return { commands, stop: () => { stopped = true; ws?.terminate(); } };
}

// ─── Interactive create-publication flow (browser open + poll) ────────────────

const { setBrowserOpener } = require('@omega.js/devkit/flows');

module.exports = defineCases({
  type: 'group',
  description: 'newsletter',
  tests: [
    // ─── Setup / skip semantics ──────────────────────────────────────────────────

    {
      name: 'newsletter: marketing.newsletter.enabled = false skips the service',
      run: async (ctx) => {
        const result = await runService(brandConfig({ newsletter: { enabled: false } }), { beehiiv: fakeBeehiiv() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/marketing\.newsletter\.enabled/);
      },
    },

    {
      name: 'newsletter: a different newsletter provider skips the service',
      run: async (ctx) => {
        const result = await runService(brandConfig({ newsletter: { providers: { other: {} } } }), { beehiiv: fakeBeehiiv() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/marketing\.newsletter\.providers\.other/);
      },
    },

    {
      name: 'newsletter: an empty providers block means none chosen — the service skips (#425)',
      run: async (ctx) => {
        const result = await runService(brandConfig({ newsletter: { providers: {} } }), { beehiiv: fakeBeehiiv() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/no marketing\.newsletter\.providers entry/);
      },
    },

    {
      name: 'newsletter: the service answers to the provider row of the newsletter role',
      run: async (ctx) => {
        const row = emailProviderForRole('newsletter');
        const otherRole = emailProviderForRole('campaigns');

        const unkeyed = await runService(brandConfig()); // no injected api, so the credential check applies
        ctx.expect(unkeyed.status).toBe('skipped');
        ctx.expect(unkeyed.reason, 'the missing credential is the row\'s env key').toContain(row.envKey);

        // The campaigns role's provider chosen under newsletter is not this service's
        const misrouted = await runService(brandConfig({ newsletter: { providers: { [otherRole.id]: {} } } }), { beehiiv: fakeBeehiiv() });
        ctx.expect(misrouted.status).toBe('skipped');
        ctx.expect(misrouted.reason).toContain(`marketing.newsletter.providers.${otherRole.id}`);
      },
    },

    {
      name: 'newsletter: skips without brand.url',
      run: async (ctx) => {
        const result = await runService(brandConfig({ url: '' }), { beehiiv: fakeBeehiiv() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/brand\.url/);
      },
    },

    {
      name: 'newsletter: the newsletter defaults carry no company values',
      run: (ctx) => {
        ctx.expect(DEFAULTS.marketing.newsletter.providers.beehiiv.publicationId).toBe(null);
      },
    },

    // ─── Converged no-op ─────────────────────────────────────────────────────────

    {
      name: 'newsletter: fully converged brand is a zero-mutation no-op across all 4 operations',
      run: async (ctx) => {
        const api = fakeBeehiiv(convergedResponses());

        const result = await runService(brandConfig({ publicationId: PUB_ID }), { beehiiv: api });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.mutations()).toEqual([]);
        ctx.expect(result.state.publicationId).toBe(PUB_ID);
        ctx.expect(result.output.customFields.created).toBe(0);
        ctx.expect(result.output.segments.missing).toEqual([]);
        ctx.expect(result.output.webhook.url).toBe('converged');
      },
    },

    // ─── publication ─────────────────────────────────────────────────────────────

    {
      name: 'newsletter: an inaccessible configured publication warns and gates the downstream operations',
      run: async (ctx) => {
        const api = fakeBeehiiv({
          ...convergedResponses(),
          getPublication: () => null,
        });

        const result = await runService(brandConfig({ publicationId: 'pub_gone' }), { beehiiv: api });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.publication.accessible).toBe(false);
        // No publication resolved → fields/segments/webhook have nothing to work on
        ctx.expect(api.callsTo('getCustomFields').length).toBe(0);
        ctx.expect(api.callsTo('getSegments').length).toBe(0);
        ctx.expect(api.callsTo('listWebhooks').length).toBe(0);
      },
    },

    {
      name: 'newsletter: no configured id auto-matches a publication by brand name into config',
      run: async (ctx) => {
        const api = fakeBeehiiv({
          ...convergedResponses(),
          listPublications: [{ id: 'pub_other', name: 'Unrelated' }, { id: PUB_ID, name: 'Fixture Brand News' }],
        });

        const brandRoot = makeBrandRoot(WRITEBACK_CONFIG);
        const result = await runService(brandConfig(), { beehiiv: api, brandRoot });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.state.publicationId).toBe(PUB_ID);
        ctx.expect(api.callsTo('getPublication').length).toBe(0); // nothing known to verify
        ctx.expect(api.mutations()).toEqual([]);

        const written = readConfigSource(brandRoot);
        ctx.expect(written.includes(`publicationId: "${PUB_ID}",`)).toBeTruthy();
        ctx.expect(written.includes('enabled: true, // the resolved id lands next to this')).toBeTruthy();
      },
    },

    {
      name: 'newsletter: no matching publication warns with the values to copy into the dashboard',
      run: async (ctx) => {
        const api = fakeBeehiiv({
          ...convergedResponses(),
          listPublications: [{ id: 'pub_other', name: 'Unrelated' }],
        });

        const result = await runService(brandConfig(), { beehiiv: api });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.publication.missing).toBe(true);
        ctx.expect(result.output.publication.suggestedName).toBe(BRAND_NAME);
      },
    },

    // ─── custom-fields ───────────────────────────────────────────────────────────

    {
      name: 'newsletter: missing and kind-mismatched fields are created/recreated, diffed by display',
      run: async (ctx) => {
        const converged = convergedResponses().getCustomFields;
        const initial = converged.slice(1); // first field missing
        initial[0] = { ...initial[0], kind: initial[0].kind === 'string' ? 'integer' : 'string' }; // second mismatched

        let reads = 0;
        const api = fakeBeehiiv({
          ...convergedResponses(),
          getCustomFields: () => (reads += 1) === 1 ? structuredClone(initial) : structuredClone(converged),
          deleteCustomField: null,
          createCustomField: { id: 'bf_new' },
        });

        const result = await runService(brandConfig({ publicationId: PUB_ID }), { beehiiv: api });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('deleteCustomField')[0].args).toEqual([PUB_ID, initial[0].id]);
        ctx.expect(api.callsTo('createCustomField').length).toBe(2);
        // Exact creation payload: (publicationId, name, display, kind)
        const missingField = BEEHIIV_FIELDS[0];
        ctx.expect(api.callsTo('createCustomField')[0].args).toEqual([PUB_ID, missingField.name, missingField.display, KIND_MAP[missingField.type]]);
        ctx.expect(result.output.customFields.created).toBe(1);
        ctx.expect(result.output.customFields.recreated).toBe(1);
      },
    },

    // ─── segments (verify-only — no create API) ──────────────────────────────────

    {
      name: 'newsletter: missing segments warn with instructions and NEVER mutate',
      run: async (ctx) => {
        const list = convergedResponses().getSegments;
        const api = fakeBeehiiv({
          ...convergedResponses(),
          getSegments: list.slice(2), // first two missing
        });

        const result = await runService(brandConfig({ publicationId: PUB_ID }), { beehiiv: api });

        ctx.expect(result.status).toBe('warned');
        ctx.expect(result.output.segments.missing).toEqual([BEEHIIV_SEGMENTS[0].name, BEEHIIV_SEGMENTS[1].name]);
        // The Beehiiv API has no segment writes — nothing to call even when drifted
        ctx.expect(api.mutations()).toEqual([]);
      },
    },

    {
      name: 'newsletter: interactive Skip choice leaves the segments warned',
      run: async (ctx) => {
        const list = convergedResponses().getSegments;
        const api = fakeBeehiiv({ ...convergedResponses(), getSegments: list.slice(1) });

        const tty = openTtyPrompt();
        try {
          const running = runService(brandConfig({ publicationId: PUB_ID }), { beehiiv: api });
          await tty.answer('Create missing segments?', '[B[B\r'); // ↓↓ to "Skip"
          const result = await running;

          ctx.expect(result.status).toBe('warned');
          ctx.expect(result.output.segments.missing).toEqual([BEEHIIV_SEGMENTS[0].name]);
          ctx.expect(api.mutations()).toEqual([]);
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'newsletter: extension automation creates the missing segment and the re-verify confirms it',
      run: async (ctx) => {
        const full = convergedResponses().getSegments;
        let segmentsCalls = 0;
        const api = fakeBeehiiv({
          ...convergedResponses(),
          // First list: one missing. After the automation "created" it in the
          // dashboard, Beehiiv reports the full set.
          getSegments: () => (segmentsCalls++ === 0 ? full.slice(1) : full),
        });

        const port = await freePort();
        process.env.OMEGA_EXTENSION_PORT = String(port);
        const ext = startFakeExtension(port);

        setBrowserOpener(async () => true); // the Enter gate always opens — never a real browser in tests
        const tty = openTtyPrompt();
        try {
          const running = runService(brandConfig({ publicationId: PUB_ID }), { beehiiv: api });
          await tty.answer('Create missing segments?', '\r');   // default: Automate via extension
          await tty.answer('Press Enter to open the Beehiiv segments page', '\r');
          await tty.answer('(enter)=done', '\r');               // publication selected — start the automation
          const result = await running;

          ctx.expect(result.status).toBe('success');
          ctx.expect(result.output.segments.missing).toEqual([]);
          ctx.expect(result.output.segments.created).toEqual([BEEHIIV_SEGMENTS[0].name]);

          // The automation drove the real protocol: navigation to the segment
          // builder, the trusted-typed name, and the save click
          ctx.expect(ext.commands[0].command).toBe('navigate');
          ctx.expect(ext.commands[0].params.url).toBe('https://app.beehiiv.com/segments/new');
          const typed = ext.commands.find((c) => c.command === 'type');
          ctx.expect(typed.params.text).toBe(BEEHIIV_SEGMENTS[0].name);
          ctx.expect(ext.commands.some((c) => c.command === 'evaluate' && c.params.expression.includes('save segment'))).toBeTruthy();

          // Still zero Beehiiv API writes — creation happened in the browser
          ctx.expect(api.mutations()).toEqual([]);
        } finally {
          tty.close();
          ext.stop();
          setBrowserOpener(null);
          delete process.env.OMEGA_EXTENSION_PORT;
        }
      },
    },

    {
      name: 'newsletter: manual choice re-verifies — still-missing segments stay warned',
      run: async (ctx) => {
        const list = convergedResponses().getSegments;
        const api = fakeBeehiiv({ ...convergedResponses(), getSegments: list.slice(1) }); // never created

        setBrowserOpener(async () => true);
        const tty = openTtyPrompt();
        try {
          const running = runService(brandConfig({ publicationId: PUB_ID }), { beehiiv: api });
          await tty.answer('Create missing segments?', '[B\r'); // ↓ to "Open dashboard (manual)"
          await tty.answer('Press Enter to open the Beehiiv segments page', '\r');
          await tty.answer('(enter)=done', '\r');               // done (nothing actually created)
          const result = await running;

          ctx.expect(result.status).toBe('warned');
          ctx.expect(result.output.segments.missing).toEqual([BEEHIIV_SEGMENTS[0].name]);
          ctx.expect(result.output.segments.created).toBe(undefined);
          ctx.expect(api.callsTo('getSegments').length).toBe(2); // verified again after the manual window
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    // ─── webhook ─────────────────────────────────────────────────────────────────

    {
      name: 'newsletter: webhook drift is patched with the minimum diff (matched by managed description)',
      run: async (ctx) => {
        const api = fakeBeehiiv({
          ...convergedResponses(),
          listWebhooks: [{ id: 'wh_1', url: 'https://api.old-parent.test/hook', event_types: ['subscription.unsubscribed'], description: WEBHOOK_DESCRIPTION, enabled: true }],
          updateWebhook: {},
        });

        const result = await runService(brandConfig({ publicationId: PUB_ID }), { beehiiv: api });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('updateWebhook')[0].args).toEqual([PUB_ID, 'wh_1', { url: WEBHOOK_URL, event_types: EVENT_TYPES }]);
      },
    },

    {
      name: 'newsletter: no webhook yet → created with the exact consent-pipeline payload',
      run: async (ctx) => {
        const api = fakeBeehiiv({
          ...convergedResponses(),
          listWebhooks: [],
          createWebhook: { data: { id: 'wh_new' } },
        });

        const result = await runService(brandConfig({ publicationId: PUB_ID, company: { id: 'parent-brand', url: 'https://parent-brand.test', images: {} } }), { beehiiv: api });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('createWebhook')[0].args).toEqual([PUB_ID, {
          url: `https://api.parent-brand.test/omega/marketing/webhook/forward?provider=beehiiv&key=${WEBHOOK_KEY}`,
          event_types: EVENT_TYPES,
          description: WEBHOOK_DESCRIPTION,
        }]);
        ctx.expect(result.output.webhook.created).toBe(true);
      },
    },

    {
      name: 'newsletter: a missing OMEGA_WEBHOOK_KEY is MINTED in place — the webhook is managed, never skipped (#635)',
      run: async (ctx) => {
        const api = fakeBeehiiv({ ...convergedResponses(), updateWebhook: {} });

        await runService(brandConfig({ publicationId: PUB_ID }), { beehiiv: api, webhookKey: false });

        // OMEGA mints its own key, so the run never steps aside for it
        const minted = process.env.OMEGA_WEBHOOK_KEY;
        ctx.expect(minted).toMatch(/^[A-Za-z0-9_-]{43}$/);
        // ...and the freshly minted key is what the forwarder URL is built from
        ctx.expect(api.callsTo('listWebhooks').length).toBe(1);
        ctx.expect(api.callsTo('updateWebhook')[0].args).toEqual([
          PUB_ID, 'wh_1', { url: `https://api.${DOMAIN}/omega/marketing/webhook/forward?provider=beehiiv&key=${minted}` },
        ]);
      },
    },

    {
      name: 'newsletter: a company that resolved no url → nothing to point the webhook at',
      run: async (ctx) => {
        const api = fakeBeehiiv(convergedResponses());

        const result = await runService(brandConfig({ publicationId: PUB_ID, company: { id: 'parent-brand', url: null, images: {} } }), { beehiiv: api });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('listWebhooks').length).toBe(0);
        ctx.expect(result.output.webhook).toBe(undefined);
      },
    },

    {
      name: 'newsletter: a company on a default Pages host points the webhook at its project\'s Cloud Functions forwarder',
      run: async (ctx) => {
        const api = fakeBeehiiv({
          ...convergedResponses(),
          listWebhooks: [],
          createWebhook: { data: { id: 'wh_new' } },
        });

        const result = await runService(
          brandConfig({ publicationId: PUB_ID, company: { id: 'parent-brand', url: 'https://parent-org.github.io/parent-brand-web', images: {} } }),
          { beehiiv: api, companyConfig: { cloud: { config: { projectId: 'parent-app' } } } },
        );

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('createWebhook')[0].args[1].url)
          .toBe(`https://us-central1-parent-app.cloudfunctions.net/omega_api/omega/marketing/webhook/forward?provider=beehiiv&key=${WEBHOOK_KEY}`);
      },
    },

    {
      name: 'newsletter: a company on a default Pages host with no project id is no forwarder to point the webhook at',
      run: async (ctx) => {
        const api = fakeBeehiiv(convergedResponses());

        const result = await runService(brandConfig({ publicationId: PUB_ID, company: { id: 'parent-brand', url: 'https://parent-org.github.io/parent-brand-web', images: {} } }), { beehiiv: api });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('listWebhooks').length, 'never api.parent-org.github.io, a host nobody serves').toBe(0);
        ctx.expect(result.output.webhook).toBe(undefined);
      },
    },

    {
      name: 'newsletter: company.webhooks = false is the deliberate account opt-out (#677)',
      run: async (ctx) => {
        const api = fakeBeehiiv(convergedResponses());

        const result = await runService(brandConfig({ publicationId: PUB_ID, webhooks: false }), { beehiiv: api });

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.callsTo('listWebhooks').length).toBe(0);
        ctx.expect(result.output.webhook).toBe(undefined);
      },
    },

    // ─── Dry-run ─────────────────────────────────────────────────────────────────

    {
      name: 'newsletter: dry-run on a fully drifted brand performs zero mutations',
      run: async (ctx) => {
        const api = fakeBeehiiv({
          ...convergedResponses(),
          getCustomFields: [],
          getSegments: [],
          listWebhooks: [],
        });

        const result = await runService(brandConfig({ publicationId: PUB_ID }), { beehiiv: api, options: { dryRun: true } });

        ctx.expect(api.mutations()).toEqual([]);
        ctx.expect(result.output.customFields.planned.create.length).toBe(BEEHIIV_FIELDS.length);
        ctx.expect(result.output.segments.missing.length).toBe(BEEHIIV_SEGMENTS.length); // verify-only op: dry-run ≡ normal run
        ctx.expect(result.output.webhook.planned).toEqual(['create']);
      },
    },

    {
      name: 'publication: interactive run opens the create page and polls until the new publication auto-matches',
      run: async (ctx) => {
        const api = fakeBeehiiv(convergedResponses());
        // First list: nothing matches; after the user "creates" it in the browser,
        // the poll's re-list finds it
        let listCalls = 0;
        api.listPublications = async () => {
          api.calls.push({ method: 'listPublications', args: [] });
          listCalls++;
          return listCalls === 1
            ? [{ id: 'pub_other', name: 'Unrelated' }]
            : [{ id: 'pub_other', name: 'Unrelated' }, { id: PUB_ID, name: 'Fixture Brand News' }];
        };
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });
        const brandRoot = makeBrandRoot(WRITEBACK_CONFIG);
        const tty = openTtyPrompt();

        try {
          const run = runService(brandConfig(), { beehiiv: api, brandRoot });
          await tty.answer('Press Enter to open the Beehiiv workspace settings', '\r');
          const result = await run;

          ctx.expect(result.state.publicationId).toBe(PUB_ID);
          ctx.expect(opened).toEqual(['https://app.beehiiv.com/settings/workspace/overview?create_publication=true']);
          ctx.expect(listCalls).toBe(2); // initial match attempt + one poll check
          const written = readConfigSource(brandRoot);
          ctx.expect(written.includes(`publicationId: "${PUB_ID}",`)).toBeTruthy();
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },
  ],
});
