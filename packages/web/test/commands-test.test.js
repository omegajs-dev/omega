/**
 * `omega test` on a web target: one runner run holding the smoke suite and the
 * project suites, after one production build. Each run is the real verb
 * (`dist/cli-run.js test`) in a staged temp target, as its own process.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const defineCases = require('@omega.js/devkit/test/define-cases');

// Every staged target's config load records its brand: keep that off the real ~/.omega
require('@omega.js/devkit/test/temp-home');

const WEB = path.resolve(__dirname, '..');
const CLI_RUN = path.join(WEB, 'dist', 'cli-run.js');
const VERB_TIMEOUT = 240000;
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);

const SMOKE = [
  'the build wrote pages',
  '404.html renders through the theme root layout',
  "the manifest's js.main bundle exists",
  'every internal link resolves',
  'the built output audits clean',
];
const HOME_CASE = 'the home page was built';

const BASE_FILES = {
  'config/omega.json5': `{
  brand: { id: 'fixture', name: 'Fixture', url: 'https://fixture.example.com', description: 'A fixture brand.' },
  targets: { web: { type: 'web' } },
}`,
  'package.json': JSON.stringify({ name: 'fixture-website', private: true, dependencies: { '@omega.js/web': '*' } }),
};

const staged = [];

// A project suite, through the door a brand's suite uses; its case records the environment it saw.
function homeSuite() {
  return `const fs = require('node:fs');
const path = require('node:path');
const { defineCases } = require(${JSON.stringify(require.resolve('@omega.js/web/test'))});

const ROOT = path.join(__dirname, '..', '..');

module.exports = defineCases({
  type: 'group',
  description: 'home',
  tests: [
    {
      name: ${JSON.stringify(HOME_CASE)},
      run(ctx) {
        fs.appendFileSync(path.join(ROOT, 'env-seen.txt'), \`\${process.env.OMEGA_ENVIRONMENT}\\n\`);
        ctx.expect(fs.existsSync(path.join(ROOT, 'dist', 'index.html'))).toBe(true);
      },
    },
  ],
});
`;
}

// A temp web target: the base files plus `extra`, removed by the suite cleanup.
function stage(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-web-test-verb-'));
  staged.push(dir);
  for (const [relative, contents] of Object.entries({ ...BASE_FILES, ...extra })) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), contents);
  }
  return dir;
}

// The parent's node:test context would hijack the child, and the tee is skipped under CI.
function childEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST')));
  for (const key of ['TEST_EXTENDED_MODE', 'OMEGA_TEST_FANOUT', 'OMEGA_ENVIRONMENT', 'ENVIRONMENT', 'CI', 'GITHUB_ACTIONS']) delete env[key];
  return { ...env, ...extra };
}

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function runVerb(dir, args, env = {}) {
  const result = spawnSync(process.execPath, [CLI_RUN, 'test', ...args], {
    cwd: dir,
    env: childEnv(env),
    encoding: 'utf8',
    timeout: VERB_TIMEOUT,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = stripAnsi(result.stdout || '');
  const output = `${stdout}${stripAnsi(result.stderr || '')}`;
  return { status: result.status, stdout, output, json: parseJson(stdout) };
}

function readText(file) {
  return fs.existsSync(file) ? stripAnsi(fs.readFileSync(file, 'utf8')) : null;
}

const byName = (json, name) => json.tests.find((t) => t.name === name);
const resultsBlocks = (text) => (text.match(/^\s*Results\s*$/gm) || []).length;

module.exports = defineCases({
  type: 'group',
  description: 'commands-test',
  timeout: VERB_TIMEOUT * 2,

  // One green target, run once per reporter; the pretty run goes last so its log stays.
  setup(ctx) {
    const dir = stage({ 'test/build/home.test.js': homeSuite() });
    const json = runVerb(dir, ['--reporter=json']);
    const pretty = runVerb(dir, []);
    ctx.state.green = {
      dir,
      json,
      pretty,
      log: readText(path.join(dir, 'logs', 'test.log')),
      envSeen: readText(path.join(dir, 'env-seen.txt')),
    };
  },

  cleanup() {
    for (const dir of staged.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  },

  tests: [
    {
      name: 'case-135 a green target builds, then reports the five smoke cases and the project case in one Results block',
      run(ctx) {
        const { dir, pretty, log } = ctx.state.green;
        ctx.expect(pretty.status, pretty.output).toBe(0);
        ctx.expect(fs.existsSync(path.join(dir, 'dist', 'index.html')), 'the build ran').toBe(true);
        for (const name of [...SMOKE, HOME_CASE]) ctx.expect(pretty.stdout, pretty.output).toContain(name);
        ctx.expect(resultsBlocks(pretty.output), pretty.output).toBe(1);
        ctx.expect(pretty.output).toMatch(/^\s*6 passing\s*$/m);

        ctx.expect(log, 'logs/test.log exists').not.toBeNull();
        ctx.expect(resultsBlocks(log), log).toBe(1);
        ctx.expect(log).toMatch(/^\s*6 passing\s*$/m);
      },
    },
    {
      name: 'case-136 a dead internal link fails the link case by name while the other cases still report',
      run(ctx) {
        const dir = stage({
          'test/build/home.test.js': homeSuite(),
          'src/pages/dead-link.html': `---
layout: frontend/core/base
permalink: /dead-link
meta:
  title: Dead link
  description: A page that links to a page the build never wrote.
---
<p><a href="/no-such-page">Nowhere</a></p>
`,
        });
        const run = runVerb(dir, ['--reporter=json']);
        ctx.expect(run.json, run.output).not.toBeNull();

        const link = byName(run.json, 'every internal link resolves');
        ctx.expect(link, JSON.stringify(run.json.tests)).toHaveProperty('status', 'fail');
        ctx.expect(link.error.message).toContain('/no-such-page');
        for (const name of [...SMOKE.filter((n) => n !== link.name), HOME_CASE]) {
          ctx.expect(byName(run.json, name), name).toHaveProperty('status', 'pass');
        }
        ctx.expect(run.status).toBe(1);
      },
    },
    {
      name: 'case-137 a project suite reads OMEGA_ENVIRONMENT as testing',
      run(ctx) {
        const { envSeen, pretty } = ctx.state.green;
        ctx.expect(envSeen, pretty.output).not.toBeNull();
        // One line per run: the json run, then the pretty one.
        ctx.expect(envSeen.trim().split('\n')).toEqual(['testing', 'testing']);
      },
    },
    {
      name: 'case-138 framework:<suite> runs that framework suite with no build, and a bare run runs no framework suite',
      skip: NODE_MAJOR < 23 && 'a framework: run from a target needs Node 23',
      run(ctx) {
        const dir = stage();
        const run = runVerb(dir, ['framework:scaffold-em-dash', '--reporter=json']);
        ctx.expect(run.json, run.output).not.toBeNull();
        ctx.expect(run.json.tests.map((t) => t.name)).toEqual(['no scaffold file carries an em dash']);
        ctx.expect(run.json.tests[0]).toHaveProperty('source', 'framework');
        ctx.expect(run.json.tests[0].file.endsWith(path.join('test', 'scaffold-em-dash.test.js')), run.json.tests[0].file).toBe(true);
        ctx.expect(fs.existsSync(path.join(dir, 'dist')), 'no build ran').toBe(false);
        ctx.expect(run.status).toBe(0);

        const { json } = ctx.state.green;
        ctx.expect(json.json, json.output).not.toBeNull();
        ctx.expect(json.json.tests.filter((t) => t.source === 'framework').map((t) => t.name)).toEqual([]);
      },
    },
    {
      name: 'case-139 a path target that matches no file ends before the build with the no-match message and code',
      run(ctx) {
        const dir = stage();
        const alone = runVerb(dir, ['no-such-suite-anywhere']);
        ctx.expect(alone.output).toContain('No test file matches "no-such-suite-anywhere"');
        ctx.expect(alone.status, alone.output).toBe(1);
        ctx.expect(fs.existsSync(path.join(dir, 'dist')), 'no build ran').toBe(false);

        // Inside a brand-root fan-out the same miss answers with the no-match code.
        const fanned = runVerb(dir, ['no-such-suite-anywhere'], { OMEGA_TEST_FANOUT: '1' });
        ctx.expect(fanned.status, fanned.output).toBe(3);
      },
    },
    {
      name: 'case-140 --reporter=json writes one JSON document on stdout holding the smoke cases',
      run(ctx) {
        const { json } = ctx.state.green;
        ctx.expect(json.json, `stdout is not one JSON document:\n${json.stdout}`).not.toBeNull();
        const names = json.json.tests.map((t) => t.name);
        for (const name of SMOKE) ctx.expect(names, name).toContain(name);
        ctx.expect(json.status, json.output).toBe(0);
      },
    },
    {
      name: 'case-141 a path target naming one project suite builds, then runs only that suite',
      run(ctx) {
        const dir = stage({
          'test/build/home.test.js': homeSuite(),
          'test/pages/other.test.js': `const { defineCases } = require(${JSON.stringify(require.resolve('@omega.js/web/test'))});

module.exports = defineCases({
  type: 'group',
  description: 'other',
  tests: [{ name: 'the other suite runs', run: (ctx) => ctx.expect(1).toBe(1) }],
});
`,
        });
        const run = runVerb(dir, ['build/home', '--reporter=json']);
        ctx.expect(run.json, run.output).not.toBeNull();
        ctx.expect(run.json.tests.map((t) => t.name)).toEqual([HOME_CASE]);
        ctx.expect(byName(run.json, HOME_CASE)).toHaveProperty('status', 'pass');
        ctx.expect(fs.existsSync(path.join(dir, 'dist', 'index.html')), 'the build ran').toBe(true);
        ctx.expect(run.status).toBe(0);
      },
    },
    {
      name: 'case-142 a project _init.js that throws runs no case, names the file, and exits 1',
      run(ctx) {
        const dir = stage({
          'test/_init.js': "throw new Error('the init hook exploded');\n",
          'test/build/home.test.js': homeSuite(),
        });
        const run = runVerb(dir, ['--reporter=json']);
        ctx.expect(run.output).toContain(path.join('test', '_init.js'));
        ctx.expect(fs.existsSync(path.join(dir, 'env-seen.txt')), 'the project case never ran').toBe(false);
        ctx.expect(run.json, run.output).not.toBeNull();
        const ran = run.json.tests.filter((t) => [...SMOKE, HOME_CASE].includes(t.name) && t.status !== 'skip');
        ctx.expect(ran.map((t) => `${t.name}: ${t.status}`), 'no case ran').toEqual([]);
        ctx.expect(run.status, run.output).toBe(1);
      },
    },
    {
      name: 'case-150 a target whose build fails exits 1 without the early-exit line',
      run(ctx) {
        const dir = stage({
          'config/omega.json5': `{
  brand: { id: 'fixture', name: 'Fixture', url: 'https://fixture.example.com', description: 'A fixture brand.' },
  notAConfigKey: true,
  targets: { web: { type: 'web' } },
}`,
        });
        const run = runVerb(dir, []);
        ctx.expect(run.output).toContain('notAConfigKey');
        ctx.expect(run.output).not.toContain('ended before its report');
        ctx.expect(run.status, run.output).toBe(1);
      },
    },
    {
      name: 'case-143 the self-test runner config isolates files, serializes watch/, and has one framework root at the web package',
      run(ctx) {
        const { runnerConfig } = require('../src/commands/test.js');
        const config = runnerConfig({ projectRoot: WEB, selfTest: true });

        ctx.expect(config).toHaveProperty('isolation', 'process');
        ctx.expect(config.serial).toEqual(['watch']);
        ctx.expect(config).toHaveProperty('defaultTimeout', 120000);
        ctx.expect(config.roots).toEqual([{ source: 'framework', dir: path.join(WEB, 'test'), cwd: WEB }]);
      },
    },
  ],
});
