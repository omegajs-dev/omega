// Main-process tests for lib/_boot-guard.js: one timer from the first boot line until
// just before auth. Each guard gets a short limit and its own write and exit seams,
// so a run ends nothing real and no case waits out the 60 s the app uses.

const defineCases = require('@omega.js/devkit/test/define-cases');
const { createBootGuard } = require('../../../lib/_boot-guard.js');

// A guard whose line and exit land in `record`, for the case to read back.
function recordedGuard(limitMs) {
  const record = { lines: [], exits: [] };
  const guard = createBootGuard({
    limitMs,
    write: (line) => { record.lines.push(line); },
    exit: (code) => { record.exits.push(code); },
  });
  return { guard, record };
}

module.exports = defineCases({
  type: 'group',
  layer: 'main',
  description: 'boot guard (main)',
  tests: [
    {
      name: 'a boot that stops before auth writes one line naming its last step and exits non-zero',
      run: async (ctx) => {
        const { guard, record } = recordedGuard(20);
        guard.start();
        guard.step('protocol');
        guard.step('usage');

        await ctx.waitFor(() => record.exits.length > 0);

        ctx.expect(record.lines.length).toBe(1);
        ctx.expect(record.lines[0]).toContain('last step: usage');
        ctx.expect(record.exits.length).toBe(1);
        ctx.expect(typeof record.exits[0]).toBe('number');
        ctx.expect(record.exits[0]).not.toBe(0);
      },
    },
    {
      // Order, not time: a second guard armed later with the same limit runs out
      // after the stopped one would have, so its exit is the point to read at.
      name: 'a boot that reaches auth stops the timer, so a slow keychain prompt ends nothing',
      run: async (ctx) => {
        const stopped = recordedGuard(20);
        stopped.guard.start();
        stopped.guard.step('usage');
        stopped.guard.stop();

        const later = recordedGuard(20);
        later.guard.start();
        await ctx.waitFor(() => later.record.exits.length > 0);

        ctx.expect(stopped.record.lines).toEqual([]);
        ctx.expect(stopped.record.exits).toEqual([]);
      },
    },
  ],
});
