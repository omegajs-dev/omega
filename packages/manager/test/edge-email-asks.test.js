/**
 * The edge service's email asks: the mailbox provider when none is picked,
 * asked in the service's setup before any operation, then the forwarding
 * addresses in the email-routing op when the list is empty and the picked
 * provider routes mail. Driven through real prompts on a fake terminal;
 * every answer lands in a real config/omega.json5.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const { stripVTControlCharacters } = require('node:util');
const JSON5 = require('json5');

// The machine registry is per-machine state: fixtures write into a temp home
require('@omega.js/devkit/test/temp-home');

const { setPromptStreams } = require('@omega.js/devkit/prompt');
const { makeStreams } = require('@omega.js/devkit/test/prompt-streams');
const ensureEmailRouting = require('../src/services/edge/ensure/email-routing.js');
const ensureDns = require('../src/services/edge/ensure/dns-records.js');
const { makeBrandRoot, readConfigSource } = require('./lib/config-fixture.js');
const {
  DOMAIN, ZONE, brandConfig, fakeApi, handlerContext, runService, convergedResponses,
} = require('./lib/edge-fixture.js');
const { openTtyPrompt } = require('./lib/interactive.js');

// Tests must never see a real token from the shell environment
delete process.env.CLOUDFLARE_TOKEN;
delete process.env.SENDGRID_API_KEY;

const DOWN = '\x1B[B'; // arrow-down escape for select() answers
const YES = '\r';
const SKIP = `${DOWN}\r`;
const DISABLE = `${DOWN}${DOWN}\r`;

const EMAIL_ASK_CONFIG = `{
  // Fixture Brand: the email answers land here
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://${DOMAIN}' },
}
`;

// Apex MX records of two registry mailbox providers (squarespace, privateemail)
const MAILGUN_MX = { id: 'mx-mailgun', type: 'MX', name: DOMAIN, content: 'mxa.mailgun.org', priority: 10, comment: 'Squarespace email forwarding' };
const PRIVATEEMAIL_MX = { id: 'mx-private', type: 'MX', name: DOMAIN, content: 'mx1.privateemail.com', priority: 10, comment: 'Private email forwarding (Namecheap)' };

// A live prompt's idle render opens on a bare `? `; its answered render on a tick
const LIVE_PROMPT = /(?:^|\n|\x1b\[G|\x1b\[\?25h)\? /;
// The tick the prompt library draws: the heavy check on a unicode terminal, the
// root sign under a plain one (TERM=linux)
const ANSWER_MARK = /[\u2714\u221A]/;

/**
 * A fake terminal that answers its prompts in order, whatever their wording:
 * each answer waits for the next live prompt, types, then waits for its tick.
 */
function promptSequence() {
  const streams = makeStreams({ tty: true });
  setPromptStreams(streams);
  let cursor = 0;

  async function until(check, what) {
    const start = Date.now();
    while (!check(streams.getRendered())) {
      if (Date.now() - start > 2000) {
        throw new Error(`Timed out waiting for ${what}. Rendered: ${JSON.stringify(streams.getRendered())}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const promptShown = (rendered) => LIVE_PROMPT.test(rendered.slice(cursor));

  return {
    async waitForPrompt() {
      await until(promptShown, 'the next prompt');
    },
    async answerNext(keys) {
      await until(promptShown, 'the next prompt');
      const typedAt = streams.getRendered().length;
      streams.input.write(keys);
      await until((rendered) => ANSWER_MARK.test(rendered.slice(typedAt)), 'the answer to land');
      cursor = typedAt + streams.getRendered().slice(typedAt).search(ANSWER_MARK) + 1;
    },
    /** Await `run`, failing the moment it opens a prompt instead of finishing. */
    async noPromptDuring(run) {
      let settled = false;
      const done = run.finally(() => { settled = true; });
      while (!settled) {
        if (promptShown(streams.getRendered())) {
          throw new Error(`Unexpected prompt. Rendered: ${JSON.stringify(streams.getRendered().slice(cursor))}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return done;
    },
    close() {
      setPromptStreams(null);
    },
  };
}

/** The reads (and the one rule write) a fresh Email Routing setup makes. */
function routingApi() {
  return fakeApi({
    responses: {
      'GET /zones/zone-1/email/routing': { enabled: true },
      'GET /zones/zone-1/email/routing/rules': [],
      'POST /zones/zone-1/email/routing/rules': {},
      'GET /zones/zone-1/email/routing/rules/catch_all': { enabled: false },
    },
  });
}

/** A handler context whose writeback lands in `brandRoot`. */
function askContext(config, api, brandRoot) {
  return handlerContext(config, api, { brandId: 'fixture-brand', brandRoot });
}

/** A converged zone for the whole walk, plus `mx` at the apex and the record writes. */
function walkApi(config, mx) {
  const responses = convergedResponses(config);
  responses['GET /zones/zone-1/dns_records'] = [...responses['GET /zones/zone-1/dns_records'], ...mx];
  responses['POST /zones/zone-1/dns_records'] = { id: 'new' };
  responses['PATCH /zones/zone-1/dns_records/r4'] = {}; // the SPF include of a picked provider
  for (const record of mx) {
    responses[`DELETE /zones/zone-1/dns_records/${record.id}`] = {};
  }
  return fakeApi({ zones: [ZONE], responses });
}

function deletedRecordIds(api) {
  return api.calls
    .filter((c) => c.method === 'DELETE' && c.endpoint.startsWith('/zones/zone-1/dns_records/'))
    .map((c) => c.endpoint.split('/').pop());
}

function createdMx(api) {
  return api.calls
    .filter((c) => c.method === 'POST' && c.endpoint === '/zones/zone-1/dns_records' && c.body.type === 'MX')
    .map((c) => c.body.content)
    .sort();
}

/** Run fn with console.log captured; returns the joined lines, colour stripped. */
async function captureLogAsync(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return stripVTControlCharacters(lines.join('\n'));
}

const PROVIDER_LINE = /→ Set domain\.email\.providers in config\/omega\.json5/g;

module.exports = defineCases({
  type: 'group',
  description: 'edge-email-asks',
  tests: [
    // ─── The provider ask, in the edge setup ─────────────────────────────────────

    {
      name: 'edge setup: the provider ask runs before the dns-records op issues any call',
      run: async (ctx) => {
        const config = brandConfig();
        const api = walkApi(config, [MAILGUN_MX]);
        const terminal = promptSequence();

        try {
          const run = runService(config, api, {}, makeBrandRoot(EMAIL_ASK_CONFIG));
          await terminal.waitForPrompt();

          ctx.expect(api.calls.filter((c) => c.endpoint.includes('/dns_records')), 'the ask came before any record call').toEqual([]);

          await terminal.answerNext(SKIP);
          await run;
          ctx.expect(api.call('GET', '/zones/zone-1/dns_records'), 'the dns-records op ran after the ask').toBeTruthy();
        } finally {
          terminal.close();
        }
      },
    },

    {
      name: 'edge setup: picking the provider the apex MX belongs to deletes no MX record on that walk',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(EMAIL_ASK_CONFIG);
        const config = brandConfig();
        const api = walkApi(config, [MAILGUN_MX]);
        const terminal = promptSequence();

        try {
          const run = runService(config, api, {}, brandRoot);
          await terminal.answerNext(YES);
          await terminal.answerNext('squa\r'); // squarespace, the mailgun.org provider
          await run;

          ctx.expect(JSON5.parse(readConfigSource(brandRoot)).domain.email.providers).toEqual({ squarespace: {} });
          ctx.expect(deletedRecordIds(api)).toEqual([]);
        } finally {
          terminal.close();
        }
      },
    },

    {
      name: 'edge setup: picking a different provider deletes the old MX on that walk, and the next walk creates the picked one\'s',
      timeout: 20000,
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(EMAIL_ASK_CONFIG);
        const config = brandConfig();
        const api = walkApi(config, [PRIVATEEMAIL_MX]);
        let terminal = promptSequence();

        try {
          const run = runService(config, api, {}, brandRoot);
          await terminal.answerNext(YES);
          await terminal.answerNext('squa\r'); // squarespace, not the privateemail MX at the apex
          await run;

          ctx.expect(deletedRecordIds(api)).toEqual(['mx-private']);
          ctx.expect(createdMx(api), 'the old MX blocks creation until its delete has cleared it').toEqual([]);
        } finally {
          terminal.close();
        }

        // The next walk loads the landed pick, over a zone the delete cleared
        const again = brandConfig();
        again.domain.email.providers = { squarespace: {} };
        const nextApi = walkApi(again, []);
        terminal = promptSequence();
        try {
          await terminal.noPromptDuring(runService(again, nextApi, {}, brandRoot));
        } finally {
          terminal.close();
        }

        ctx.expect(createdMx(nextApi)).toEqual(['mxa.mailgun.org', 'mxb.mailgun.org']);
      },
    },

    {
      name: 'edge setup: with no MX at the apex, the picked provider\'s MX records land on that walk',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(EMAIL_ASK_CONFIG);
        const config = brandConfig();
        const api = walkApi(config, []);
        const terminal = promptSequence();

        try {
          const run = runService(config, api, {}, brandRoot);
          await terminal.answerNext(YES);
          await terminal.answerNext('squa\r'); // squarespace
          await run;

          ctx.expect(createdMx(api)).toEqual(['mxa.mailgun.org', 'mxb.mailgun.org']);
        } finally {
          terminal.close();
        }
      },
    },

    {
      name: 'edge setup: Skip at the provider ask deletes and creates no MX record and leaves config unchanged',
      run: async (ctx) => {
        // The zone id is already landed, so the zone op has nothing to write either
        const brandRoot = makeBrandRoot(`{
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://${DOMAIN}' },
  edge: { providers: { cloudflare: { zone: 'zone-1' } } },
}
`);
        const before = readConfigSource(brandRoot);
        const config = brandConfig();
        config.edge.providers.cloudflare.zone = 'zone-1';
        const api = walkApi(config, [MAILGUN_MX]);
        const terminal = promptSequence();

        try {
          const run = runService(config, api, {}, brandRoot);
          await terminal.answerNext(SKIP);
          await run;

          ctx.expect(deletedRecordIds(api)).toEqual([]);
          ctx.expect(createdMx(api)).toEqual([]);
          ctx.expect(readConfigSource(brandRoot)).toBe(before);
        } finally {
          terminal.close();
        }
      },
    },

    {
      name: 'edge setup: Disable at the provider ask lands domain.email.providers: false, deletes no MX, and the next walk does not ask',
      timeout: 20000,
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(EMAIL_ASK_CONFIG);
        const config = brandConfig();
        const api = walkApi(config, [MAILGUN_MX]);
        let terminal = promptSequence();

        try {
          const run = runService(config, api, {}, brandRoot);
          await terminal.answerNext(DISABLE);
          await run;

          ctx.expect(JSON5.parse(readConfigSource(brandRoot)).domain.email.providers).toBe(false);
          ctx.expect(deletedRecordIds(api)).toEqual([]);
        } finally {
          terminal.close();
        }

        // The next walk loads the landed false
        const again = brandConfig();
        again.domain.email.providers = false;
        terminal = promptSequence();
        try {
          await terminal.noPromptDuring(runService(again, walkApi(again, [MAILGUN_MX]), {}, brandRoot));
        } finally {
          terminal.close();
        }
      },
    },

    {
      name: 'edge setup: a headless or dry run never asks, prints the line naming the key, and deletes no MX',
      timeout: 20000,
      run: async (ctx) => {
        // Headless: no terminal to ask in
        process.env.OMEGA_NON_INTERACTIVE = '1';
        const headlessApi = walkApi(brandConfig(), [MAILGUN_MX]);
        try {
          const printed = await captureLogAsync(() => runService(brandConfig(), headlessApi, {}, makeBrandRoot(EMAIL_ASK_CONFIG)));
          ctx.expect(printed.match(PROVIDER_LINE)?.length, `one provider line in: ${printed}`).toBe(1);
          ctx.expect(deletedRecordIds(headlessApi)).toEqual([]);
        } finally {
          delete process.env.OMEGA_NON_INTERACTIVE;
        }

        // Dry run: a terminal is there, and still nothing is asked
        const dryApi = walkApi(brandConfig(), [MAILGUN_MX]);
        const terminal = promptSequence();
        try {
          const printed = await captureLogAsync(() => terminal.noPromptDuring(
            runService(brandConfig(), dryApi, { dryRun: true }, makeBrandRoot(EMAIL_ASK_CONFIG)),
          ));
          ctx.expect(printed.match(PROVIDER_LINE)?.length, `one provider line in: ${printed}`).toBe(1);
          ctx.expect(deletedRecordIds(dryApi)).toEqual([]);
        } finally {
          terminal.close();
        }
      },
    },

    {
      name: 'edge setup: a subdomain project is never asked for a mail provider',
      timeout: 20000,
      run: async (ctx) => {
        const sub = `app.${DOMAIN}`;
        const config = brandConfig(`https://${sub}`);
        const api = fakeApi({
          zones: [ZONE],
          responses: {
            'GET /accounts': [{ id: 'acct-1' }],
            'GET /zones/zone-1/dns_records': [
              { id: 's1', type: 'A', name: sub, content: '185.199.108.153', proxied: true, comment: 'GitHub Pages IP' },
              { id: 's2', type: 'AAAA', name: sub, content: '2606:50c0:8000::153', proxied: true, comment: 'GitHub Pages IP' },
              MAILGUN_MX,
            ],
          },
        });
        const terminal = promptSequence();

        try {
          await terminal.noPromptDuring(runService(config, api, {}, makeBrandRoot(EMAIL_ASK_CONFIG)));
        } finally {
          terminal.close();
        }
      },
    },

    // ─── The forwarding ask, in the email-routing op ─────────────────────────────

    {
      name: 'email-routing: a routing provider with an empty forwarding list asks, and the two entries land one rule',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(EMAIL_ASK_CONFIG);
        const config = brandConfig();
        config.domain.email.providers = { cloudflare: {} };
        config.domain.email.forwarding = [];
        const api = routingApi();
        const terminal = promptSequence();

        try {
          const run = ensureEmailRouting(askContext(config, api, brandRoot));
          await terminal.answerNext('\r'); // Set up now? Yes
          await terminal.answerNext('support\r'); // the address to forward
          await terminal.answerNext('inbox@example.com\r'); // the inbox it goes to
          await run;

          ctx.expect(JSON5.parse(readConfigSource(brandRoot)).domain.email.forwarding).toEqual([{ from: 'support', to: 'inbox@example.com' }]);
          ctx.expect(api.call('POST', '/zones/zone-1/email/routing/rules'), 'the pass went on to write the rule it just landed').toBeTruthy();
        } finally {
          terminal.close();
        }
      },
    },

    {
      name: 'email-routing: Disable at the forwarding ask lands domain.email.forwarding: false; a second run writes no rule and never asks',
      run: async (ctx) => {
        const brandRoot = makeBrandRoot(EMAIL_ASK_CONFIG);
        const config = brandConfig();
        config.domain.email.providers = { cloudflare: {} };
        config.domain.email.forwarding = [];
        const tty = openTtyPrompt(); // interactive: a second-run prompt here would hang

        try {
          const run = ensureEmailRouting(askContext(config, routingApi(), brandRoot));
          await tty.answer('Set up now?', `${DOWN}${DOWN}\r`); // Disable (stop prompting)
          await run;

          ctx.expect(JSON5.parse(readConfigSource(brandRoot)).domain.email.forwarding).toBe(false);

          const again = brandConfig();
          again.domain.email.providers = { cloudflare: {} };
          again.domain.email.forwarding = false;
          const api = routingApi();
          const result = await ensureEmailRouting(askContext(again, api, brandRoot));

          ctx.expect(result?.status).not.toBe('failed');
          ctx.expect(api.call('POST', '/zones/zone-1/email/routing/rules'), 'false is "no forwarding rules"').toBe(undefined);
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'dns-records: domain.email.providers: false is "none", so no MX record is required',
      run: async (ctx) => {
        const config = brandConfig();
        config.domain.email.providers = false;

        const api = fakeApi({
          responses: {
            'GET /zones/zone-1/dns_records': [],
            'POST /zones/zone-1/dns_records': { id: 'new' },
          },
        });

        const result = await ensureDns(handlerContext(config, api));

        ctx.expect(result.status).toBe('success');
        ctx.expect(api.calls.filter((c) => c.method === 'POST' && c.body.type === 'MX')).toEqual([]);
      },
    },
  ],
});
