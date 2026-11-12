/**
 * Pipeline command tests — the assertion engine (evaluatePipeline) and the
 * run-record discovery, both pure/local. The live spawn path is exercised
 * on demand against the playground (`omega-manager pipeline`), never here.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { evaluatePipeline, findRunRecord, resolveVerifyTargets, buildChildArgs, CORE_SERVICES, deployLeg } = require('../src/commands/pipeline.js');
const { runVerifyLegs } = require('../src/lib/verify-live.js');
const { TARGET_TYPE_ROWS } = require('@omega.js/config/target-types');

/** Full-run record where every core service is green. */
function greenRecord(extra = []) {
  return {
    timestamp: 'fixture',
    brandId: 'fixture-brand',
    services: [
      ...CORE_SERVICES.map((service) => ({ service, status: 'success', output: null, error: null })),
      ...extra,
    ],
  };
}

module.exports = defineCases({
  type: 'group',
  description: 'pipeline',
  tests: [
    {
      name: 'pipeline: all-green full run passes',
      run: (ctx) => {
        const verdict = evaluatePipeline(greenRecord());
        ctx.expect(verdict.pass).toBe(true);
        ctx.expect(verdict.failures).toEqual([]);
      },
    },

    {
      name: 'pipeline: any service error fails, naming the service and error',
      run: (ctx) => {
        const record = greenRecord([{ service: 'campaigns', status: 'error', output: null, error: 'SendGrid API error (429): Too Many Requests' }]);
        const verdict = evaluatePipeline(record);
        ctx.expect(verdict.pass).toBe(false);
        ctx.expect(verdict.failures[0]).toMatch(/campaigns: error — SendGrid API error \(429\)/);
      },
    },

    {
      name: 'pipeline: core service skipped = seed missing = fail; non-core skip is listed, not failed',
      run: (ctx) => {
        const record = greenRecord([{ service: 'advertising', status: 'skipped', output: null, error: null, reason: 'no advertising.providers.adsense.client configured' }]);
        record.services.find((s) => s.service === 'edge').status = 'skipped';
        record.services.find((s) => s.service === 'edge').reason = 'missing CLOUDFLARE_TOKEN — add to the brand .env';

        const verdict = evaluatePipeline(record);
        ctx.expect(verdict.pass).toBe(false);
        ctx.expect(verdict.failures[0]).toMatch(/edge: CORE service skipped — missing CLOUDFLARE_TOKEN/);
        ctx.expect(verdict.skips.length).toBe(1);
        ctx.expect(verdict.skips[0]).toMatch(/advertising — no advertising\.providers\.adsense\.client/);
      },
    },

    {
      name: 'pipeline: full run missing a core service fails; --service scoping waives presence',
      run: (ctx) => {
        const record = { services: [{ service: 'repo', status: 'success', output: null, error: null }] };

        const full = evaluatePipeline(record);
        ctx.expect(full.pass).toBe(false);
        ctx.expect(full.failures.some((f) => /cloud: CORE service missing/.test(f))).toBeTruthy();

        const scoped = evaluatePipeline(record, { scoped: true });
        ctx.expect(scoped.pass).toBe(true);
      },
    },

    {
      name: 'pipeline: --require promotes a service into the core set',
      run: (ctx) => {
        const record = greenRecord([{ service: 'seo', status: 'skipped', output: null, error: null, reason: 'awaiting the public-repo go' }]);

        ctx.expect(evaluatePipeline(record).pass, 'skip tolerated by default').toBe(true);
        const strict = evaluatePipeline(record, { require: ['seo'] });
        ctx.expect(strict.pass).toBe(false);
        ctx.expect(strict.failures[0]).toMatch(/seo: CORE service skipped/);
      },
    },

    {
      name: 'pipeline: the graduated seeds are core now — a campaigns/search skip fails a full run',
      run: (ctx) => {
        for (const service of ['campaigns', 'search', 'account', 'captcha']) {
          ctx.expect(CORE_SERVICES.includes(service), `${service} graduated into the core spine`).toBeTruthy();
        }

        const record = greenRecord();
        record.services.find((s) => s.service === 'campaigns').status = 'skipped';
        record.services.find((s) => s.service === 'campaigns').reason = 'missing SENDGRID_API_KEY';

        const verdict = evaluatePipeline(record);
        ctx.expect(verdict.pass).toBe(false);
        ctx.expect(verdict.failures[0]).toMatch(/campaigns: CORE service skipped/);
      },
    },

    {
      name: 'pipeline: a gated publish leg records a tolerated (non-core) skip',
      run: (ctx) => {
        const record = greenRecord([{
          service: 'deploy:desktop',
          status: 'skipped',
          output: null,
          error: null,
          reason: 'publish leg gated — pass --publish (releases/dispatches are gated)',
        }]);

        const verdict = evaluatePipeline(record);
        ctx.expect(verdict.pass, 'gated publish skip never fails the run').toBe(true);
        ctx.expect(verdict.skips[0]).toMatch(/deploy:desktop — publish leg gated/);
      },
    },

    {
      name: 'pipeline: deploy legs ride the same rules — an error leg fails, a green leg passes as non-core',
      run: (ctx) => {
        const ok = greenRecord([{ service: 'deploy:web', status: 'success', output: null, error: null }]);
        ctx.expect(evaluatePipeline(ok).pass).toBe(true);

        const bad = greenRecord([{ service: 'deploy:backend', status: 'error', output: null, error: 'exit 1' }]);
        const verdict = evaluatePipeline(bad);
        ctx.expect(verdict.pass).toBe(false);
        ctx.expect(verdict.failures[0]).toMatch(/deploy:backend: error — exit 1/);
      },
    },

    // Every target's bare `omega deploy` is a CI dispatch. The pipeline is the
    // LOCAL lane, so the rows it can deploy from this machine say `direct`.
    {
      name: 'pipeline: web and backend deploy direct from this machine, desktop and extension through the verb',
      run: (ctx) => {
        const direct = ['npm', 'run', 'deploy', '--', '--direct'];
        const verb = ['npx', 'omega', 'deploy'];
        ctx.expect(deployLeg('web')).toEqual(direct);
        ctx.expect(deployLeg('backend'), 'the backend leg deploys from this machine, not through CI').toEqual(direct);
        ctx.expect(deployLeg('desktop'), 'a gated publish leg, never a local one').toEqual(verb);
        ctx.expect(deployLeg('extension'), 'a gated publish leg, never a local one').toEqual(verb);
      },
    },

    {
      name: 'pipeline: the publish legs, and so the ship list, are exactly desktop and extension',
      run: (ctx) => {
        ctx.expect(TARGET_TYPE_ROWS.filter((row) => row.publishes).map((row) => row.id)).toEqual(['desktop', 'extension']);
      },
    },

    {
      name: 'pipeline: verify targets follow the deploy legs; --verify alone sweeps every verifiable target',
      run: (ctx) => {
        ctx.expect(resolveVerifyTargets({ deploy: 'web,backend' }, ['web', 'backend']), 'deploying verifies what was deployed').toEqual(['web', 'backend']);
        ctx.expect(resolveVerifyTargets({ verify: true }, []), '--verify alone is the post-hoc sweep').toEqual(['web']);
        ctx.expect(resolveVerifyTargets({}, []), 'no deploy, no --verify → no sweep').toEqual([]);
      },
    },

    {
      name: 'pipeline: the manage child names the verb — a bare CLI walks nothing now (#229)',
      run: (ctx) => {
        ctx.expect(buildChildArgs({}), 'the child IS the walk — without the verb it would print help and the pipeline would find no run record').toEqual(['manage', '--continue-on-error']);
        ctx.expect(buildChildArgs({ service: 'payment', dryRun: true }), 'the verb leads; the run flags follow unchanged').toEqual(['manage', '--continue-on-error', '--service=payment', '--dry-run']);
      },
    },

    {
      name: 'pipeline: the value-less flags are declared, and its value flags keep their values undeclared',
      run: (ctx) => {
        const { BOOLEAN_FLAGS } = require('../src/cli-run.js');
        const { parseArgv } = require('@omega.js/devkit/argv');

        for (const flag of ['dry-run', 'verify', 'publish']) {
          ctx.expect(BOOLEAN_FLAGS.includes(flag), `--${flag} takes no value, so it must be declared boolean`).toBeTruthy();
        }

        // The value flags need no list: the parse's rule carries them, in the space
        // form and the `=` form alike.
        const argv = parseArgv(['pipeline', '--service', 'payment', '--require=sendgrid,captcha', '--verify'], { booleans: BOOLEAN_FLAGS });
        ctx.expect(argv.service).toBe('payment');
        ctx.expect(argv.require).toBe('sendgrid,captcha');
        ctx.expect(argv.verify).toBe(true);
        ctx.expect(argv._).toEqual(['pipeline']);
      },
    },

    {
      name: 'pipeline: verify rows land AFTER the deploy legs and ride the same judging rules',
      run: async (ctx) => {
        const record = greenRecord();
        const brandConfig = { brand: { url: 'https://playground.omegajs.dev' }, cloud: { config: { projectId: 'omegajs-playground' } } };
        const fetchImpl = async () => ({ status: 500, headers: { get: () => 'text/html' }, text: async () => '' });
        const resolve = async () => ['203.0.113.7'];

        record.services.push({ service: 'deploy:web', status: 'success', output: null, error: null });
        record.services.push(...await runVerifyLegs(['web'], brandConfig, { fetch: fetchImpl, resolve }));

        const services = record.services.map((entry) => entry.service);
        ctx.expect(services.indexOf('deploy:web') < services.indexOf('verify:site'), 'the sweep runs after the deploy leg').toBeTruthy();

        const verdict = evaluatePipeline(record);
        ctx.expect(verdict.pass, 'a failed check fails the pipeline like a failed deploy leg').toBe(false);
        ctx.expect(verdict.failures.some((failure) => /verify:site: error — .*500/.test(failure))).toBeTruthy();
      },
    },

    {
      name: 'pipeline: a demo-only brand records verify:* as tolerated gated skips',
      run: async (ctx) => {
        const record = greenRecord();
        const demoConfig = { brand: { url: 'https://sandbox-brand.example.com' }, cloud: { config: { projectId: 'demo-sandbox-brand' } } };

        record.services.push(...await runVerifyLegs(['web'], demoConfig, {}));

        const verdict = evaluatePipeline(record);
        ctx.expect(verdict.pass, 'gated verify skips never fail the run').toBe(true);
        ctx.expect(verdict.skips.filter((skip) => skip.startsWith('verify:')).length).toBe(3);
      },
    },

    {
      name: 'pipeline: headless Google consent fails FAST with the seeding instruction (no server, no 5-min wait)',
      run: async (ctx) => {
        const { GoogleOAuth2Client } = require('../src/lib/google-auth.js');
        const client = new GoogleOAuth2Client({
          clientId: 'x',
          clientSecret: 'y',
          scopes: ['https://www.googleapis.com/auth/webmasters'],
          tokenStorePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-auth-')), 'tokens.json'),
        });

        process.env.OMEGA_NON_INTERACTIVE = '1';
        try {
          const started = Date.now();
          await ctx.expect(client.getAccessToken()).rejects.toThrow(/Google consent required \(scopes: .*webmasters\) — run the service once interactively/);
          ctx.expect(Date.now() - started < 2000, 'must fail fast, not camp on the callback server').toBeTruthy();
        } finally {
          delete process.env.OMEGA_NON_INTERACTIVE;
        }
      },
    },

    {
      name: 'pipeline: findRunRecord returns the newest record at/after `since`, null otherwise',
      run: (ctx) => {
        const brandRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-pipeline-'));
        const runsDir = path.join(brandRoot, '.omega', 'runs');
        fs.mkdirSync(runsDir, { recursive: true });

        ctx.expect(findRunRecord(brandRoot, 0), 'empty dir → null').toBe(null);

        fs.writeFileSync(path.join(runsDir, 'old.json'), JSON.stringify({ services: [{ service: 'old' }] }));
        const oldTime = Date.now() - 60_000;
        fs.utimesSync(path.join(runsDir, 'old.json'), oldTime / 1000, oldTime / 1000);

        fs.writeFileSync(path.join(runsDir, 'new.json'), JSON.stringify({ services: [{ service: 'new' }] }));

        const found = findRunRecord(brandRoot, Date.now() - 5_000);
        ctx.expect(found).toBeTruthy();
        ctx.expect(found.record.services[0].service).toBe('new');
        ctx.expect(findRunRecord(brandRoot, Date.now() + 60_000), 'nothing after future cutoff').toBe(null);
      },
    },
  ],
});
