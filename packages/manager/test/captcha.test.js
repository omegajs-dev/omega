/**
 * Captcha service tests — shared-key validation against a recording fake
 * of the siteverify endpoint. Proves skip semantics, the valid-secret probe
 * (exactly one read, never a mutation — the service has none), the
 * invalid-secret failure, the de-ITW'd console URL, and dry-run parity.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

const { OPERATIONS, DEFAULTS } = require('../src/config.js');
const service = require('../src/services/captcha/index.js');
const { makeBrandRoot, readConfigSource } = require('./lib/config-fixture.js');

// Tests must never see real credentials from the shell environment; non-skip
// tests set fixture values explicitly. The SITE key is config now (#893), so
// only the secret half is ever read from the environment.
delete process.env.RECAPTCHA_SITE_KEY;
delete process.env.RECAPTCHA_SECRET_KEY;

const DOMAIN = 'fixture-brand.test';
const SITE_KEY = '6LfixtureFixtureFixtureFixture';

// ─── Fixtures ────────────────────────────────────────────────────────────────

// A fully-keyed brand by default: the public half in config (what the client
// renders), the secret half in the .env runService sets. `siteKey: null` is
// the unkeyed brand — the sanctioned green state (#17, #507).
function brandConfig({ url = `https://${DOMAIN}`, siteKey = SITE_KEY } = {}) {
  const recaptcha = structuredClone(DEFAULTS.captcha.providers.recaptcha);
  if (siteKey) recaptcha.siteKey = siteKey;

  return {
    brand: { id: 'fixture-brand', name: 'Fixture Brand', url },
    captcha: { providers: { recaptcha } },
    // The secret half is the backend's: a brand with no backend is never asked for it
    targets: { web: { type: 'web' }, backend: { type: 'backend' } },
  };
}

// The domain confirm writes into omega.json5 (#434), so confirm-path runs get
// a real brand root; a stamped fixture carries the confirmed list on disk too
function fixtureConfigSource({ domainsConfirmed } = {}) {
  const stamp = domainsConfirmed ? `, domainsConfirmed: ${JSON.stringify(domainsConfirmed)}` : '';
  return `{
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://${DOMAIN}' },
  captcha: { providers: { recaptcha: { enabled: true${stamp} } } },
}
`;
}

/** Recording fake RecaptchaAPI — siteverify answers with the given error codes. */
function fakeRecaptcha({ errorCodes = ['invalid-input-response'] } = {}) {
  const api = { calls: [] };

  api.verify = async (response) => {
    api.calls.push({ method: 'verify', response });
    return { success: false, 'error-codes': [...errorCodes] };
  };

  return api;
}

function runService(config, { recaptcha, options = {}, env = true, brandRoot } = {}) {
  if (env) {
    process.env.RECAPTCHA_SECRET_KEY = 'fixture-secret-key';
  } else {
    delete process.env.RECAPTCHA_SECRET_KEY;
  }

  return service.run({
    brandId: 'fixture-brand',
    // Only the confirm path writes to disk; other tests never touch the root
    brandRoot: brandRoot || '/tmp/omega-manager-recaptcha-unused',
    brandConfig: config,
    brand: { id: 'fixture-brand', config, enabledTargets: Object.keys(config.targets || {}), targets: [] },
    targets: [],
    operations: OPERATIONS.captcha,
    options,
    serviceData: {},
    recaptchaApi: recaptcha,
  });
}

// ─── Interactive add-domain confirm (manual-only poll + state stamp) ─────────

const { setBrowserOpener } = require('@omega.js/devkit/flows');
const { openTtyPrompt } = require('./lib/interactive.js');

// ─── De-ITW pins (cp257): the ask is the ONLY path to a key ──────────────────

const fs = require('node:fs');
const path = require('node:path');
const { REQUIRES, serviceInputs, serviceInputSpec } = require('../src/config.js');

module.exports = defineCases({
  type: 'group',
  description: 'captcha',
  tests: [
    // ─── Setup / skip semantics ──────────────────────────────────────────────────

    {
      name: 'captcha: skips without the secret key in .env',
      run: async (ctx) => {
        const result = await runService(brandConfig({ siteKey: null }), { env: false });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/RECAPTCHA_SECRET_KEY/);
        // cp114: the skip is machine-readable (the 🔑 summary aggregates it). The
        // site key is never in that list: it is config, not a credential (#893)
        ctx.expect(result.missingEnv).toEqual(['RECAPTCHA_SECRET_KEY']);
      },
    },

    {
      name: 'captcha: skip reason names only the missing key',
      run: async (ctx) => {
        delete process.env.RECAPTCHA_SECRET_KEY;

        const result = await service.run({
          brandId: 'fixture-brand',
          brandRoot: '/tmp/omega-manager-recaptcha-unused',
          brandConfig: brandConfig({ siteKey: null }),
          targets: [],
          operations: OPERATIONS.captcha,
          options: {},
          serviceData: {},
        });

        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/missing RECAPTCHA_SECRET_KEY/);
        ctx.expect(result.reason).not.toMatch(/RECAPTCHA_SITE_KEY/);
        ctx.expect(result.missingEnv).toEqual(['RECAPTCHA_SECRET_KEY']);
      },
    },

    {
      name: 'captcha: captcha.providers.recaptcha.enabled = false skips the service',
      run: async (ctx) => {
        const config = brandConfig();
        config.captcha.providers.recaptcha.enabled = false;

        const result = await runService(config, { recaptcha: fakeRecaptcha() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/captcha\.providers\.recaptcha\.enabled/);
      },
    },

    {
      name: 'captcha: skips without brand.url',
      run: async (ctx) => {
        const result = await runService(brandConfig({ url: '' }), { recaptcha: fakeRecaptcha() });
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/brand\.url/);
      },
    },

    {
      name: 'captcha: a default Pages brand.url is no domain, so setup skips with the one reason before any client call',
      run: async (ctx) => {
        const recaptcha = fakeRecaptcha();

        const result = await runService(brandConfig({ url: 'https://dreamr-design.github.io/dreamr-web' }), { recaptcha });

        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toBe('brand.url is the hosting provider\'s default address (dreamr-design.github.io): no domain to manage');
        ctx.expect(recaptcha.calls).toEqual([]);
      },
    },

    // ─── Half-keyed brand (#507) ─────────────────────────────────────────────────

    // A setup-time throw is how a service fails the walk: manage.js's runService
    // catches it into { status: 'error', error } for the run summary
    {
      name: 'captcha: the secret without the config site key WARNS — the orphan half nothing else sees',
      run: async (ctx) => {
        // The playground's live-checkout 403 state: the backend enforces token
        // verification, the client has no key to mint a token with. The reverse
        // direction (secret required by the site key) is the schema's rule; THIS
        // direction is config-side, so this service — the one place that sees both
        // halves — is still the one that says it.
        const lines = [];
        const originalLog = console.log;
        console.log = (...args) => lines.push(args.join(' '));

        let result;
        try {
          result = await runService(brandConfig({ siteKey: null }), { recaptcha: fakeRecaptcha() });
        } finally {
          console.log = originalLog;
        }

        const said = lines.join('\n');
        ctx.expect(said).toMatch(/RECAPTCHA_SECRET_KEY is set but captcha\.providers\.recaptcha\.siteKey is missing/);
        ctx.expect(said).toMatch(/https:\/\/www\.google\.com\/recaptcha\/admin/);
        // A warning, not a failure: the service still proves the secret it has.
        ctx.expect(result.status).toBe('success');
      },
    },

    {
      name: 'captcha: the config site key without the secret is the SHARED rule now — this service skips (#626)',
      run: async (ctx) => {
        // The secret-required-when-siteKey direction is the env schema's
        // `requiredWhen` rule, warned brand-wide by the workspace env-rules op. This
        // service just has no secret to prove, so it skips with the missing key named
        // — one rule, one home, one message.
        const config = brandConfig();
        config.cloud = { provider: 'firebase', config: { projectId: 'fixture-brand-cloud' } };

        delete process.env.RECAPTCHA_SECRET_KEY;

        const result = await service.run({
          brandId: 'fixture-brand',
          brandRoot: '/tmp/omega-manager-recaptcha-unused',
          brandConfig: config,
          targets: [],
          operations: OPERATIONS.captcha,
          options: {},
          serviceData: {},
          recaptchaApi: fakeRecaptcha(),
        });

        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.missingEnv).toEqual(['RECAPTCHA_SECRET_KEY']);
      },
    },

    {
      name: 'captcha: neither half is the sanctioned unkeyed brand — it skips, never fails (#17)',
      run: async (ctx) => {
        const result = await runService(brandConfig({ siteKey: null }), { env: false });

        ctx.expect(result.status).toBe('skipped');
      },
    },

    // ─── Secret validation ───────────────────────────────────────────────────────

    {
      name: 'captcha: valid secret is a success with exactly one read probe',
      run: async (ctx) => {
        const api = fakeRecaptcha(); // invalid-input-response = the probe token was rejected, the secret was not

        const result = await runService(brandConfig(), { recaptcha: api });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.siteKey.secretValid).toBe(true);
        // #444: the bare domain only — the www twin is never recommended
        ctx.expect(result.output.siteKey.domains).toEqual([DOMAIN]);
        ctx.expect(api.calls.length).toBe(1);
        ctx.expect(api.calls[0].method).toBe('verify');
      },
    },

    {
      name: 'captcha: invalid secret fails the service with .env guidance',
      run: async (ctx) => {
        const api = fakeRecaptcha({ errorCodes: ['invalid-input-secret'] });

        const result = await runService(brandConfig(), { recaptcha: api });

        ctx.expect(result.status).toBe('error');
        ctx.expect(result.error).toMatch(/RECAPTCHA_SECRET_KEY is invalid/);
      },
    },

    // ─── The site key is CONFIG (#893) ───────────────────────────────────────────

    {
      name: 'captcha: the site key comes from config, and a stale env var is not read',
      run: async (ctx) => {
        // The env key is retired: a brand that still exports the old name gets the
        // config value anyway, because there is no dual-read anywhere in OMEGA.
        process.env.RECAPTCHA_SITE_KEY = 'stale-env-value';

        // The deep link is built FROM the site key, so the console URL is where the
        // value the service resolved is visible
        const config = brandConfig();
        config.cloud = { provider: 'firebase', config: { projectId: 'fixture-brand-cloud' } };

        try {
          const result = await runService(config, { recaptcha: fakeRecaptcha() });

          ctx.expect(result.status).toBe('success');
          ctx.expect(result.output.siteKey.consoleUrl).toMatch(new RegExp(SITE_KEY));
          ctx.expect(result.output.siteKey.consoleUrl).not.toMatch(/stale-env-value/);
        } finally {
          delete process.env.RECAPTCHA_SITE_KEY;
        }
      },
    },

    // ─── Console URL (de-ITW'd) ──────────────────────────────────────────────────

    {
      name: 'captcha: no project at any layer → generic classic admin console URL',
      run: async (ctx) => {
        const result = await runService(brandConfig(), { recaptcha: fakeRecaptcha() });

        // omega-manager hardcoded ?project=itw-creative-works — the default must
        // carry no company value at all
        ctx.expect(result.output.siteKey.consoleUrl).toBe('https://www.google.com/recaptcha/admin');
      },
    },

    {
      name: 'captcha: captcha.providers.recaptcha.project deep-links the cloud console key page',
      run: async (ctx) => {
        const config = brandConfig();
        config.captcha.providers.recaptcha.project = 'my-shared-project';

        const result = await runService(config, { recaptcha: fakeRecaptcha() });

        ctx.expect(result.output.siteKey.consoleUrl).toBe(`https://console.cloud.google.com/security/recaptcha/${SITE_KEY}/overview?from=keysList&project=my-shared-project`);
      },
    },

    {
      name: 'captcha: cloud.config.projectId deep-links by default, with no captcha project set',
      run: async (ctx) => {
        // #444: the key lives in the brand's own cloud project — the deep link must
        // build without anyone setting a second copy of the project id
        const config = brandConfig();
        config.cloud = { provider: 'firebase', config: { projectId: 'fixture-brand-cloud' } };

        const result = await runService(config, { recaptcha: fakeRecaptcha() });

        ctx.expect(config.captcha.providers.recaptcha.project).toBe(null);
        ctx.expect(result.output.siteKey.consoleUrl).toBe(`https://console.cloud.google.com/security/recaptcha/${SITE_KEY}/overview?from=keysList&project=fixture-brand-cloud`);
      },
    },

    {
      name: 'captcha: captcha.providers.recaptcha.project wins over cloud.config.projectId',
      run: async (ctx) => {
        // The per-provider key exists for a key minted OUTSIDE the brand's project
        const config = brandConfig();
        config.cloud = { provider: 'firebase', config: { projectId: 'fixture-brand-cloud' } };
        config.captcha.providers.recaptcha.project = 'my-shared-project';

        const result = await runService(config, { recaptcha: fakeRecaptcha() });

        ctx.expect(result.output.siteKey.consoleUrl).toMatch(/project=my-shared-project$/);
      },
    },

    // ─── Dry-run ─────────────────────────────────────────────────────────────────

    {
      name: 'captcha: dry-run behaves identically — the probe is a pure read',
      run: async (ctx) => {
        const api = fakeRecaptcha();

        const result = await runService(brandConfig(), { recaptcha: api, options: { dryRun: true } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.siteKey.secretValid).toBe(true);
        ctx.expect(api.calls.length).toBe(1);
      },
    },

    {
      name: 'site-key: an interactive run ASKS for the site key and lands it in omega.json5 (#893)',
      run: async (ctx) => {
        // "nothing like this should be left for the consumer to remember" (#867):
        // the value has a config home, so the service asks for it there and writes
        // it, rather than printing a key name and skipping.
        const api = fakeRecaptcha();
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });
        const tty = openTtyPrompt();
        const brandRoot = makeBrandRoot(fixtureConfigSource({ domainsConfirmed: [DOMAIN] }));

        try {
          // The domain list is already confirmed, so the ONLY prompt this run opens
          // is the site-key ask
          const config = brandConfig({ siteKey: null });
          config.captcha.providers.recaptcha.domainsConfirmed = [DOMAIN];
          const run = runService(config, { recaptcha: api, brandRoot });

          await tty.answer('Set up now?', '\r');
          await tty.answer('reCAPTCHA site key (the public half):', `${SITE_KEY}\r`);

          const result = await run;

          ctx.expect(result.status).toBe('success');
          ctx.expect(readConfigSource(brandRoot)).toMatch(new RegExp(`siteKey:\\s*['"]${SITE_KEY}['"]`));
          // The ask opens the console the key is minted at, and nothing else does
          ctx.expect(opened).toEqual(['https://www.google.com/recaptcha/admin']);
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    {
      name: 'site-key: interactive run opens the console and stamps the confirmed domain list',
      run: async (ctx) => {
        const api = fakeRecaptcha(); // invalid-input-response = valid secret
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });
        const tty = openTtyPrompt();
        const brandRoot = makeBrandRoot(fixtureConfigSource());

        try {
          const run = runService(brandConfig(), { recaptcha: api, brandRoot });
          await tty.answer('Press Enter to open the reCAPTCHA console', '\r');
          // ENTER = "domains saved" — nudge until the manual-only poll picks it up
          await tty.answer('(enter)=done', '\r');
          const nudge = setInterval(() => { tty.answer('(enter)=done', '\r').catch(() => {}); }, 80);
          let result;
          try {
            result = await run;
          } finally {
            clearInterval(nudge);
          }

          ctx.expect(result.status).toBe('success');
          // The confirm's ONE home is omega.json5 (#434)
          ctx.expect(readConfigSource(brandRoot)).toMatch(new RegExp(`domainsConfirmed:\\s*\\[\\s*['"]${DOMAIN}['"],?\\s*\\]`));
          ctx.expect(opened).toEqual(['https://www.google.com/recaptcha/admin']);
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    {
      name: "requires: RECAPTCHA_* walkthrough mints at the GCP reCAPTCHA console (the brand's own project)",
      run: (ctx) => {
        const env = serviceInputs('captcha');
        // The SITE key left the env registry with #893: it is config now, asked for
        // through the config flow, so the only credential here is the secret half
        ctx.expect(env.map((e) => e.name)).toEqual(['RECAPTCHA_SECRET_KEY']);
        for (const entry of env) {
          ctx.expect(entry.prompted).toBe(true);
        }

        // The mint page is the env SCHEMA's, its one home (#867): the registry keeps
        // the manager's own fields and the spec is where the two halves meet
        for (const input of serviceInputSpec('captcha').inputs) {
          ctx.expect(input.url).toBe('https://console.cloud.google.com/security/recaptcha');
        }
      },
    },

    {
      name: 'requires/defaults: no ITW or hardcoded key value anywhere in the recaptcha registry',
      run: (ctx) => {
        // The paste flow must be the only path to a key — no default value exists
        ctx.expect(DEFAULTS.captcha.providers.recaptcha.project).toBe(null);
        const serialized = JSON.stringify({ defaults: DEFAULTS.captcha.providers.recaptcha, requires: { why: REQUIRES.captcha.why, env: serviceInputs('captcha') } });
        ctx.expect(serialized).not.toMatch(/itw/i);
        ctx.expect(serialized).not.toMatch(/6L[0-9A-Za-z_-]{38}/); // a real site-key literal
      },
    },

    {
      name: 'recaptcha service source carries no hardcoded key or company value',
      run: (ctx) => {
        const serviceDir = path.join(__dirname, '../src/services/captcha');
        const files = [];
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) files.push(full);
          }
        };
        walk(serviceDir);

        ctx.expect(files.length >= 3).toBeTruthy(); // index + ensure + lib
        for (const file of files) {
          const source = fs.readFileSync(file, 'utf8');
          ctx.expect(source, `${file} carries a site-key literal`).not.toMatch(/6L[0-9A-Za-z_-]{38}/);
          ctx.expect(source, `${file} carries the company project`).not.toMatch(/itw-creative-works/i);
        }
      },
    },

    {
      name: 'site-key: a stamped domain list never re-prompts, even interactively',
      run: async (ctx) => {
        const api = fakeRecaptcha();
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });
        const tty = openTtyPrompt(); // interactive — without the stamp the flow WOULD prompt

        try {
          const config = brandConfig();
          config.captcha.providers.recaptcha.domainsConfirmed = [DOMAIN];
          const result = await runService(config, { recaptcha: api });

          ctx.expect(result.status).toBe('success');
          ctx.expect(opened).toEqual([]); // no browser, no prompt — the run resolved unattended
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    {
      name: 'site-key: a stamp carrying the old www twin confirms without churn and narrows to bare',
      run: async (ctx) => {
        // #444: dropping the www recommendation must not re-prompt every brand that
        // already confirmed [domain, www.domain] — the bare domain is already listed
        const api = fakeRecaptcha();
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });
        const tty = openTtyPrompt(); // interactive — a stale stamp WOULD prompt

        try {
          const stamped = [DOMAIN, `www.${DOMAIN}`];
          const config = brandConfig();
          config.captcha.providers.recaptcha.domainsConfirmed = stamped;
          const brandRoot = makeBrandRoot(fixtureConfigSource({ domainsConfirmed: stamped }));
          const result = await runService(config, { recaptcha: api, brandRoot });

          ctx.expect(result.status).toBe('success');
          ctx.expect(opened).toEqual([]);
          // The on-disk stamp narrowed to the bare domain
          const source = readConfigSource(brandRoot);
          ctx.expect(source).toMatch(new RegExp(`domainsConfirmed:\\s*\\[\\s*['"]${DOMAIN}['"],?\\s*\\]`));
          ctx.expect(source).not.toMatch(/www\./);
        } finally {
          tty.close();
          setBrowserOpener(null);
        }
      },
    },

    {
      name: 'site-key: a stamp for a different domain still re-prompts',
      run: async (ctx) => {
        // The narrowing must not swallow a genuinely changed brand.url
        const api = fakeRecaptcha();
        const opened = [];
        setBrowserOpener(async (url) => { opened.push(url); return true; });

        // No tty here — the unconfirmed path falls through to the printed guidance
        const config = brandConfig();
        config.captcha.providers.recaptcha.domainsConfirmed = ['old-brand.test'];
        const brandRoot = makeBrandRoot(fixtureConfigSource({ domainsConfirmed: ['old-brand.test'] }));
        const result = await runService(config, { recaptcha: api, brandRoot });

        setBrowserOpener(null);

        ctx.expect(result.status).toBe('success');
        // The stale stamp is left exactly as it was — nothing was confirmed, so
        // nothing narrowed to the new bare domain
        ctx.expect(readConfigSource(brandRoot)).toMatch(/domainsConfirmed:\s*\[\s*['"]old-brand\.test['"],?\s*\]/);
        ctx.expect(opened).toEqual([]);
      },
    },
  ],
});
