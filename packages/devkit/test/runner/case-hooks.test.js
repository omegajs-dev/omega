/**
 * `ctx.after`, suite `setup` and `cleanup`, and each one's time limit, driven through
 * `cli.js` on a fixture under both isolation modes, so the one-process run and the
 * per-file child agree.
 */
const defineCases = require('../../src/test/define-cases.js');
const { runCli, tempPath, removeAll, takeFile } = require('./_fixtures/helpers.js');

const MODES = ['none', 'process'];

const byName = (json, name) => json.tests.find((t) => t.name === name);

// Run a fixture under one isolation mode; resolve to the run and the lines its cases recorded.
function runRecorded(fixture, isolation) {
  const out = tempPath(`${fixture}-${isolation}.txt`);
  const run = runCli(fixture, [`--isolation=${isolation}`], { env: { FIXTURE_OUT: out } });
  removeAll(run.log);
  return { run, lines: (takeFile(out) || '').split('\n').filter(Boolean) };
}

module.exports = defineCases({
  type: 'group',
  description: 'ctx.after and suite setup',
  tests: [
    {
      name: 'case-97 ctx.after functions run in reverse once the case ends, and after a failure the case error stands',
      run(ctx) {
        for (const isolation of MODES) {
          const { run, lines } = runRecorded('after-hooks', isolation);

          ctx.expect(run.json, `${isolation}:\n${run.output}`).not.toBeNull();
          ctx.expect(lines.filter((l) => l.startsWith('pass:')), isolation).toEqual(['pass:body', 'pass:b', 'pass:a']);
          ctx.expect(lines.filter((l) => l.startsWith('fail:')), isolation).toEqual(['fail:b', 'fail:a']);
          const failed = byName(run.json, 'after runs on a failure');
          ctx.expect(failed, isolation).toHaveProperty('status', 'fail');
          ctx.expect(failed.error.message, isolation).toContain('own failure');
        }
      },
    },
    {
      name: 'case-98 a passing case whose after throws reports fail with that error',
      run(ctx) {
        for (const isolation of MODES) {
          const { run } = runRecorded('after-hooks', isolation);

          ctx.expect(run.json, `${isolation}:\n${run.output}`).not.toBeNull();
          ctx.expect(byName(run.json, 'after runs in reverse on a pass'), isolation).toHaveProperty('status', 'pass');
          const thrown = byName(run.json, 'after throws on a pass');
          ctx.expect(thrown, isolation).toHaveProperty('status', 'fail');
          ctx.expect(thrown.error.message, isolation).toContain('after boom');
        }
      },
    },
    {
      name: 'case-99 suite setup runs once before the first case and its state reaches it',
      run(ctx) {
        for (const isolation of MODES) {
          const { run, lines } = runRecorded('suite-setup', isolation);

          ctx.expect(run.json, `${isolation}:\n${run.output}`).not.toBeNull();
          ctx.expect(lines, isolation).toEqual(['setup', 'first:true', 'second', 'third']);
          ctx.expect(run.json.passed, isolation).toBe(3);
          ctx.expect(run.status, isolation).toBe(0);
        }
      },
    },
    {
      name: 'case-100 a setup that throws fails every case with its error, runs no body, and still runs cleanup',
      run(ctx) {
        for (const isolation of MODES) {
          const { run, lines } = runRecorded('setup-fail', isolation);

          ctx.expect(run.json, `${isolation}:\n${run.output}`).not.toBeNull();
          ctx.expect(run.json.tests.length, isolation).toBe(3);
          for (const test of run.json.tests) {
            ctx.expect(test.status, `${isolation} ${test.name}`).toBe('fail');
            ctx.expect(test.error.message, `${isolation} ${test.name}`).toContain('setup boom');
          }
          ctx.expect(lines, `${isolation}: no case body ran, cleanup did`).toEqual(['cleanup']);
          ctx.expect(run.status, isolation).toBe(1);
        }
      },
    },
    {
      name: 'case-9 an after that never settles fails its case at the case timeout, the older after still runs, and so does the next case',
      run(ctx) {
        for (const isolation of MODES) {
          const { run, lines } = runRecorded('after-hang', isolation);

          ctx.expect(run.json, `${isolation}:\n${run.output}`).not.toBeNull();
          const hung = byName(run.json, 'an after that never settles');
          ctx.expect(hung, isolation).toHaveProperty('status', 'fail');
          ctx.expect(hung.error.message, isolation).toContain('after hook timed out after 300ms');
          ctx.expect(byName(run.json, 'the next case'), isolation).toHaveProperty('status', 'pass');
          ctx.expect(lines, isolation).toEqual(['body', 'older after', 'next case']);
        }
      },
    },
    {
      name: 'case-10 a setup that never settles fails every case of its suite at the suite timeout, runs no body, and the next suite runs',
      run(ctx) {
        for (const isolation of MODES) {
          const { run, lines } = runRecorded('setup-hang', isolation);

          ctx.expect(run.json, `${isolation}:\n${run.output}`).not.toBeNull();
          for (const name of ['one', 'two']) {
            const test = byName(run.json, name);
            ctx.expect(test, `${isolation} ${name}`).toHaveProperty('status', 'fail');
            ctx.expect(test.error.message, `${isolation} ${name}`).toContain('setup timed out after 300ms');
          }
          ctx.expect(byName(run.json, 'the next suite runs'), isolation).toHaveProperty('status', 'pass');
          ctx.expect([...lines].sort(), `${isolation}: no body ran, cleanup did`).toEqual(['cleanup', 'next suite']);
          ctx.expect(run.status, isolation).toBe(1);
        }
      },
    },
    {
      name: 'case-11 a cleanup that never settles records one failure at the suite timeout and the run ends with its report',
      run(ctx) {
        for (const isolation of MODES) {
          const { run } = runRecorded('cleanup-hang', isolation);

          ctx.expect(run.json, `${isolation}:\n${run.output}`).not.toBeNull();
          ctx.expect(run.json.failed, `${isolation}: ${JSON.stringify(run.json.tests)}`).toBe(1);
          const failure = run.json.tests.find((t) => t.status === 'fail');
          ctx.expect(failure.error.message, isolation).toContain('cleanup timed out after 300ms');
          ctx.expect(run.status, isolation).toBe(1);
        }
      },
    },
    {
      name: 'case-12 a setup, cleanup and after that settle inside their limit leave the report as it was',
      run(ctx) {
        for (const isolation of MODES) {
          const { run, lines } = runRecorded('hooks-settle', isolation);

          ctx.expect(run.json, `${isolation}:\n${run.output}`).not.toBeNull();
          ctx.expect(run.json.tests.map((t) => `${t.name}:${t.status}`), isolation).toEqual(['first:pass', 'second:pass']);
          ctx.expect(lines, isolation).toEqual(['setup', 'first', 'after', 'second', 'cleanup']);
          ctx.expect(run.status, isolation).toBe(0);
        }
      },
    },
  ],
});
