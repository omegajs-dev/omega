/**
 * Testing service tests — per-target local checks and live checks against
 * recording fetch/exec fakes (injected via options, the same seam runManage
 * exposes), with the check pipeline, retry loop, and version comparison
 * real. Proves the all-green pass set, retry pins on network errors and
 * non-2xx statuses, the framework-version states (up to date / outdated /
 * unpublished / not installed), the shared-Firebase and no-URL gates,
 * working-tree and GitHub Actions outcomes, the dry-run zero-network
 * guarantee, and the honest error on missing build output.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const { join } = require('node:path');
const jetpack = require('fs-jetpack');

// The machine registry is per-machine state: this file's fixtures write into a
// temp home, never the developer's ~/.omega (#677).
require('@omega.js/devkit/test/temp-home');

const { SERVICE_ORDER, OPERATIONS, TARGET_FRAMEWORKS } = require('../src/config.js');
const { compareVersions, installedVersion, parseWorkingTree } = require('../src/services/testing/lib/checks.js');
const {
  HOMEPAGE, GIT_CMD, stageBrand, seedDeployRecord, brandConfig, stageWebTarget, stageBackendTarget, fakeFetch, fakeExec, runService,
} = require('./lib/testing-fixtures.js');

const API_URL = 'https://api.fixture-brand.test/omega/health';
// A brand with no domain of its own: brand.url is its GitHub Pages address
const PAGES_URL = 'https://dreamr-design.github.io/dreamr-web';
const PAGES_REASON = 'brand.url is the hosting provider\'s default address (dreamr-design.github.io): no domain to manage';
const GH_CMD = 'gh run list --repo sandbox-org/fixture-brand-omega --limit 1 --json status,conclusion,name';

module.exports = defineCases({
  type: 'group',
  description: 'testing',
  tests: [
    // ─── Registry / lib units ────────────────────────────────────────────────────

    {
      name: 'testing: last in SERVICE_ORDER, with the target-checks operation',
      run: (ctx) => {
        ctx.expect(SERVICE_ORDER[SERVICE_ORDER.length - 1]).toBe('testing');
        ctx.expect(OPERATIONS.testing).toEqual([{ name: 'target-checks', ensure: true }]);
      },
    },

    {
      name: 'testing: TARGET_FRAMEWORKS maps every checkable target, mobile reserved',
      run: (ctx) => {
        ctx.expect(TARGET_FRAMEWORKS).toEqual({
          web: '@omega.js/web',
          backend: '@omega.js/backend',
          extension: '@omega.js/extension',
          desktop: '@omega.js/desktop',
        });
      },
    },

    {
      name: 'compareVersions: numeric x.y.z ordering',
      run: (ctx) => {
        ctx.expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
        ctx.expect(compareVersions('1.2.3', '1.10.0')).toBe(-1);
        ctx.expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
      },
    },

    {
      name: 'installedVersion: resolves through the node_modules climb, null when absent',
      run: (ctx) => {
        const root = stageBrand();
        const entry = stageWebTarget(root, { installed: '1.4.2' });

        // From a nested dir inside the target, the climb still finds it
        ctx.expect(installedVersion(join(entry.path, 'dist'), '@omega.js/web')).toBe('1.4.2');
        ctx.expect(installedVersion(entry.path, 'no-such-package')).toBe(null);
      },
    },

    // ─── Full stack all-green ────────────────────────────────────────────────────

    {
      name: 'testing: web + backend all green — exact pass set, single npm view per package, one fetch per URL',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [
          stageWebTarget(root, { declared: '^1.0.0', installed: '1.0.0' }),
          stageBackendTarget(root, { installed: '5.9.0' }),
        ];
        const fetch = fakeFetch({
          [HOMEPAGE]: { status: 200 },
          [API_URL]: { status: 200, body: { status: 'healthy', backendVersion: '5.9.0' } },
        });
        const exec = fakeExec({
          'npm view @omega.js/web version': '1.0.0\n',
          'npm view @omega.js/backend version': '5.9.0\n',
          [GIT_CMD]: '',
        });

        const report = await runService(brandConfig(), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('success');
        ctx.expect(report.output).toEqual({
          results: {
            passed: [
              'web: package.json',
              'web: build output',
              'web: @omega.js/web',
              'web: homepage',
              'backend: package.json',
              'backend: firebase.json',
              'backend: staged dist/',
              'backend: @omega.js/backend',
              'backend: API health',
              'backend: deployed backend',
              'working tree',
            ],
            warned: [],
            failed: [],
          },
          counts: { passed: 11, warned: 0, failed: 0 },
        });

        // One fetch per URL, one npm view per package (deployed check hits the
        // cache), git scoped to the brand root
        ctx.expect(fetch.calls).toEqual([HOMEPAGE, API_URL]);
        ctx.expect(exec.calls).toEqual([
          ['npm view @omega.js/web version', null],
          ['npm view @omega.js/backend version', null],
          [GIT_CMD, root],
        ]);
      },
    },

    // ─── Framework version states ────────────────────────────────────────────────

    {
      name: 'testing: outdated framework → warned with the version delta',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root, { declared: '^1.0.0', installed: '1.0.0' })];
        const fetch = fakeFetch({ [HOMEPAGE]: { status: 200 } });
        const exec = fakeExec({ 'npm view @omega.js/web version': '1.2.0\n', [GIT_CMD]: '' });

        const report = await runService(brandConfig(), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('warned');
        ctx.expect(report.output.results.warned).toEqual([
          { name: 'web: @omega.js/web', warning: 'outdated (1.0.0 → 1.2.0)' },
        ]);
      },
    },

    {
      name: 'testing: unpublished framework (npm view fails) dims out — no warning, no pass entry',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root, { declared: '^1.0.0', installed: '1.0.0' })];
        const fetch = fakeFetch({ [HOMEPAGE]: { status: 200 } });
        const exec = fakeExec({
          'npm view @omega.js/web version': new Error('404 Not Found - @omega.js/web'),
          [GIT_CMD]: '',
        });

        const report = await runService(brandConfig(), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('success');
        ctx.expect(!report.output.results.passed.includes('web: @omega.js/web')).toBeTruthy();
        ctx.expect(report.output.results.warned).toEqual([]);
      },
    },

    {
      name: 'testing: framework declared via file: but not installed → dim note, npm never consulted',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root, { declared: 'file:../../packages/web' })];
        const fetch = fakeFetch({ [HOMEPAGE]: { status: 200 } });
        const exec = fakeExec({ [GIT_CMD]: '' });

        const report = await runService(brandConfig(), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('success');
        ctx.expect(exec.calls).toEqual([[GIT_CMD, root]]);
      },
    },

    // ─── Homepage ────────────────────────────────────────────────────────────────

    {
      name: 'testing: homepage network error on a DEPLOYED brand retries 3× then fails the service',
      run: async (ctx) => {
        const root = stageBrand();
        seedDeployRecord(root, 'web');
        const targets = [stageWebTarget(root)];
        const fetch = fakeFetch({ [HOMEPAGE]: new Error('getaddrinfo ENOTFOUND fixture-brand.test') });
        const exec = fakeExec({ [GIT_CMD]: '' });

        const report = await runService(brandConfig(), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('error');
        ctx.expect(fetch.calls).toEqual([HOMEPAGE, HOMEPAGE, HOMEPAGE]);
        ctx.expect(report.output.results.failed).toEqual([
          { name: 'web: homepage', error: `${HOMEPAGE} → getaddrinfo ENOTFOUND fixture-brand.test` },
        ]);
        ctx.expect(report.error).toMatch(/web: homepage/);
      },
    },

    {
      name: 'testing: homepage 500 then 200 — non-2xx retries and recovers',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root)];
        const fetch = fakeFetch({ [HOMEPAGE]: [{ status: 500 }, { status: 200 }] });
        const exec = fakeExec({ [GIT_CMD]: '' });

        const report = await runService(brandConfig(), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('success');
        ctx.expect(fetch.calls).toEqual([HOMEPAGE, HOMEPAGE]);
        ctx.expect(report.output.results.passed.includes('web: homepage')).toBeTruthy();
      },
    },

    // ─── API health ──────────────────────────────────────────────────────────────

    {
      name: 'testing: shared Firebase project → API health dims out, zero fetches',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageBackendTarget(root)];
        const fetch = fakeFetch({});
        const exec = fakeExec({ 'npm view @omega.js/backend version': '5.9.0\n', [GIT_CMD]: '' });

        const report = await runService(brandConfig({ cloud: { shared: true }, targets: { backend: { type: 'backend' } } }), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('success');
        ctx.expect(fetch.calls).toEqual([]);
      },
    },

    {
      name: 'testing: a brand on a default Pages host probes its API at the project\'s Cloud Functions address',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageBackendTarget(root, { installed: '5.9.0' })];
        const healthUrl = 'https://us-central1-dreamr-app.cloudfunctions.net/omega_api/omega/health';
        const fetch = fakeFetch({ [healthUrl]: { status: 200, body: { status: 'healthy', backendVersion: '5.9.0' } } });
        const exec = fakeExec({ 'npm view @omega.js/backend version': '5.9.0\n', [GIT_CMD]: '' });
        const config = brandConfig({
          brand: { id: 'fixture-brand', name: 'Fixture Brand', url: PAGES_URL },
          cloud: { config: { projectId: 'dreamr-app' } },
          targets: { backend: { type: 'backend' } },
        });

        const report = await runService(config, { root, targets, fetch, exec });

        ctx.expect(fetch.calls).toEqual([healthUrl]);
        ctx.expect(report.output.results.passed).toContain('backend: API health');
      },
    },

    {
      name: 'testing: a brand on a default Pages host with no project id skips the API health with the one reason, zero fetches',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageBackendTarget(root, { installed: '5.9.0' })];
        const fetch = fakeFetch({});
        const exec = fakeExec({ 'npm view @omega.js/backend version': '5.9.0\n', [GIT_CMD]: '' });
        const config = brandConfig({
          brand: { id: 'fixture-brand', name: 'Fixture Brand', url: PAGES_URL },
          targets: { backend: { type: 'backend' } },
        });

        // The dimmed checks are the report's console lines, not its result object
        const lines = [];
        const original = console.log;
        console.log = (...args) => { lines.push(args.join(' ')); };
        try {
          await runService(config, { root, targets, fetch, exec });
        } finally {
          console.log = original;
        }

        ctx.expect(fetch.calls).toEqual([]);
        ctx.expect(lines.some((line) => line.includes(PAGES_REASON)), 'the skip names the default-address reason').toBe(true);
      },
    },

    {
      name: 'testing: deployed backend older than npm latest → warned',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageBackendTarget(root, { installed: '5.9.0' })];
        const fetch = fakeFetch({ [API_URL]: { status: 200, body: { backendVersion: '5.0.0' } } });
        const exec = fakeExec({ 'npm view @omega.js/backend version': '5.9.0\n', [GIT_CMD]: '' });

        const report = await runService(brandConfig({ targets: { backend: { type: 'backend' } } }), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('warned');
        ctx.expect(report.output.results.warned).toEqual([
          { name: 'backend: deployed backend', warning: 'outdated (5.0.0 → 5.9.0)' },
        ]);
      },
    },

    {
      name: 'testing: API returning 503 on a DEPLOYED brand retries 3× then fails',
      run: async (ctx) => {
        const root = stageBrand();
        seedDeployRecord(root, 'backend');
        const targets = [stageBackendTarget(root, { installed: null })];
        const fetch = fakeFetch({ [API_URL]: { status: 503 } });
        const exec = fakeExec({ 'npm view @omega.js/backend version': '5.9.0\n', [GIT_CMD]: '' });

        const report = await runService(brandConfig({ targets: { backend: { type: 'backend' } } }), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('error');
        ctx.expect(fetch.calls).toEqual([API_URL, API_URL, API_URL]);
        ctx.expect(report.output.results.failed).toEqual([
          { name: 'backend: API health', error: `${API_URL} → 503` },
        ]);
      },
    },

    // ─── Never-deployed vs deployed-but-down (cp196, Ian's call) ─────────────────

    {
      name: 'testing: never-deployed brand — live misses NUDGE (warned), never error',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root), stageBackendTarget(root)];
        const fetch = fakeFetch({
          [HOMEPAGE]: new Error('getaddrinfo ENOTFOUND fixture-brand.test'),
          [API_URL]: new Error('getaddrinfo ENOTFOUND api.fixture-brand.test'),
        });
        const exec = fakeExec({ 'npm view @omega.js/backend version': '5.9.0\n', [GIT_CMD]: '' });

        const report = await runService(brandConfig(), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('warned');
        ctx.expect(report.output.results.failed).toEqual([]);
        const nudges = report.output.results.warned.filter((w) => /not deployed yet/.test(w.warning));
        ctx.expect(nudges.map((w) => w.name)).toEqual(['web: homepage', 'backend: API health']);
        ctx.expect(nudges[0].warning).toMatch(/omega deploy/);
      },
    },

    {
      name: 'testing: record-less brand with a LIVE site passes and ADOPTS the deploy record',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root)];
        const fetch = fakeFetch({ [HOMEPAGE]: { status: 200 } });
        const exec = fakeExec({ [GIT_CMD]: '' });

        const report = await runService(brandConfig(), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('success');
        const records = jetpack.read(join(root, '.omega', 'state.json'), 'json').deploy;
        ctx.expect(records.web.adopted, 'live hit on a record-less brand writes the record (fresh clones self-heal)').toBe(true);
      },
    },

    {
      name: 'testing: no brand.url → homepage and API health warn, zero fetches',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root), stageBackendTarget(root)];
        const fetch = fakeFetch({});
        const exec = fakeExec({ 'npm view @omega.js/backend version': '5.9.0\n', [GIT_CMD]: '' });

        const config = brandConfig();
        delete config.brand.url;
        const report = await runService(config, { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('warned');
        ctx.expect(fetch.calls).toEqual([]);
        ctx.expect(report.output.results.warned.map((w) => w.name)).toEqual([
          'web: homepage',
          'backend: API health',
        ]);
      },
    },

    // ─── Repo-level checks ───────────────────────────────────────────────────────

    {
      name: 'testing: dirty working tree → warned with the file count',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root)];
        const fetch = fakeFetch({ [HOMEPAGE]: { status: 200 } });
        const exec = fakeExec({ [GIT_CMD]: ' M src/a.js\n?? notes.txt\n' });

        const report = await runService(brandConfig(), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('warned');
        ctx.expect(report.output.results.warned).toEqual([
          { name: 'working tree', warning: '2 uncommitted files' },
        ]);
      },
    },

    {
      name: 'testing: porcelain paths parse intact — first line keeps its leading status space',
      run: (ctx) => {
        // cp100 live-run regression: ` M targets/omega-brand/config/omega.json5`
        // displayed as `pps/omega-brand/...` because a whole-stdout trim stripped
        // the first line's leading status column before the fixed-offset slice.
        const files = parseWorkingTree(' M targets/omega-brand/config/omega.json5\n?? notes.txt\nA  src/new.js\n');

        ctx.expect(files).toEqual([
          { status: 'M', file: 'targets/omega-brand/config/omega.json5' },
          { status: '??', file: 'notes.txt' },
          { status: 'A', file: 'src/new.js' },
        ]);
      },
    },

    {
      name: 'testing: not a git repository → working tree check silently absent',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root)];
        const fetch = fakeFetch({ [HOMEPAGE]: { status: 200 } });
        const exec = fakeExec({ [GIT_CMD]: new Error('fatal: not a git repository') });

        const report = await runService(brandConfig(), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('success');
        const names = [
          ...report.output.results.passed,
          ...report.output.results.warned.map((w) => w.name),
          ...report.output.results.failed.map((f) => f.name),
        ];
        ctx.expect(!names.includes('working tree')).toBeTruthy();
      },
    },

    {
      name: 'testing: GitHub Actions success, the exact gh command on `<brand.id>-omega`',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root)];
        const fetch = fakeFetch({ [HOMEPAGE]: { status: 200 } });
        const exec = fakeExec({
          [GIT_CMD]: '',
          [GH_CMD]: '[{"status":"completed","conclusion":"success","name":"Build"}]',
        });

        const report = await runService(brandConfig({ repo: { provider: 'github', owner: 'sandbox-org' } }), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('success');
        ctx.expect(report.output.results.passed.includes('GitHub Actions')).toBeTruthy();
        ctx.expect(exec.calls.some(([cmd]) => cmd === GH_CMD)).toBeTruthy();
      },
    },

    {
      name: 'testing: the run list reads the brand\'s OWN owner, whichever it is (#883)',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root)];
        const fetch = fakeFetch({ [HOMEPAGE]: { status: 200 } });
        const cmd = 'gh run list --repo Acme-Org/fixture-brand-omega --limit 1 --json status,conclusion,name';
        const exec = fakeExec({
          [GIT_CMD]: '',
          [cmd]: '[{"status":"completed","conclusion":"success","name":"Build"}]',
        });

        const report = await runService(
          brandConfig({ repo: { provider: 'github', owner: 'Acme-Org' } }),
          { root, targets, fetch, exec },
        );

        ctx.expect(report.status).toBe('success');
        ctx.expect(exec.calls.some(([c]) => c === cmd)).toBeTruthy();
      },
    },

    {
      name: 'testing: failed GitHub Actions run → error',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root)];
        const fetch = fakeFetch({ [HOMEPAGE]: { status: 200 } });
        const exec = fakeExec({
          [GIT_CMD]: '',
          [GH_CMD]: '[{"status":"completed","conclusion":"failure","name":"Build"}]',
        });

        const report = await runService(brandConfig({ repo: { provider: 'github', owner: 'sandbox-org' } }), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('error');
        ctx.expect(report.output.results.failed).toEqual([
          { name: 'GitHub Actions', error: 'Build → failure' },
        ]);
      },
    },

    {
      name: 'testing: in-progress GitHub Actions run → warned; gh unavailable → dim, still success',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root)];

        const inProgress = await runService(brandConfig({ repo: { provider: 'github', owner: 'sandbox-org' } }), {
          root,
          targets,
          fetch: fakeFetch({ [HOMEPAGE]: { status: 200 } }),
          exec: fakeExec({ [GIT_CMD]: '', [GH_CMD]: '[{"status":"in_progress","conclusion":null,"name":"Build"}]' }),
        });
        ctx.expect(inProgress.status).toBe('warned');
        ctx.expect(inProgress.output.results.warned).toEqual([
          { name: 'GitHub Actions', warning: 'Build → in progress' },
        ]);

        const unavailable = await runService(brandConfig({ repo: { provider: 'github', owner: 'sandbox-org' } }), {
          root,
          targets,
          fetch: fakeFetch({ [HOMEPAGE]: { status: 200 } }),
          exec: fakeExec({ [GIT_CMD]: '', [GH_CMD]: new Error('gh: command not found') }),
        });
        ctx.expect(unavailable.status).toBe('success');
      },
    },

    // ─── Dry run / local failures ────────────────────────────────────────────────

    {
      name: 'testing: dry-run — zero network, local checks still run',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [
          stageWebTarget(root, { declared: '^1.0.0', installed: '1.0.0' }),
          stageBackendTarget(root),
        ];
        const fetch = fakeFetch({});
        const exec = fakeExec({ [GIT_CMD]: '' });

        const report = await runService(
          brandConfig({ repo: { provider: 'github', owner: 'sandbox-org' } }),
          { root, targets, fetch, exec, options: { dryRun: true } },
        );

        ctx.expect(report.status).toBe('success');
        // No fetches; the only subprocess is the local git status
        ctx.expect(fetch.calls).toEqual([]);
        ctx.expect(exec.calls).toEqual([[GIT_CMD, root]]);
        ctx.expect(report.output.results.passed).toEqual([
          'web: package.json',
          'web: build output',
          'backend: package.json',
          'backend: firebase.json',
          'backend: staged dist/',
          'working tree',
        ]);
      },
    },

    {
      name: 'testing: missing build output → honest error naming the update service',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root, { dist: false })];
        const fetch = fakeFetch({ [HOMEPAGE]: { status: 200 } });
        const exec = fakeExec({ [GIT_CMD]: '' });

        const report = await runService(brandConfig(), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('error');
        ctx.expect(report.output.results.failed).toEqual([
          { name: 'web: build output', error: 'dist/index.html missing — run the update service' },
        ]);
      },
    },

    // ─── Recorded reason ────────────────────────────────────────────────────────

    {
      name: 'testing: the recorded reason carries every warned check\'s name AND its warning',
      run: async (ctx) => {
        const root = stageBrand();
        const targets = [stageWebTarget(root, { declared: '^1.0.0', installed: '1.0.0' })];
        const fetch = fakeFetch({ [HOMEPAGE]: { status: 200 } });
        const exec = fakeExec({
          'npm view @omega.js/web version': '1.2.0\n',
          [GIT_CMD]: ' M src/a.js\n?? notes.txt\n',
        });

        const report = await runService(brandConfig(), { root, targets, fetch, exec });

        ctx.expect(report.status).toBe('warned');
        ctx.expect(report.warned).toEqual([
          {
            operation: 'target-checks',
            reason: 'web: @omega.js/web: outdated (1.0.0 → 1.2.0); working tree: 2 uncommitted files',
          },
        ]);
      },
    },
  ],
});
