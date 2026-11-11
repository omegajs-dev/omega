// Boot-layer two-launch test: the fixture app quits through omega.quit() inside its
// `second-instance` listener, and the boot driver launches it twice (`secondLaunch`).
// These bodies run in the driver, never in the app: ctx.exits lists each process that
// exited on its own, in exit order; one the driver had to end is absent.

const defineCases = require('@omega.js/devkit/test/define-cases');

module.exports = defineCases({
  type: 'group',
  layer: 'boot',
  description: 'second-instance quit: a forwarded launch exits as a duplicate',
  // The fixture main.js logs this line once initialize() resolved. Windowless, its quit
  // lands within a millisecond, the race a hidden window's close would hide.
  secondLaunch: {
    afterLine: 'fixture consumer main initialized',
    env: { OMEGA_TEST_FIXTURE_WINDOWLESS: '1', OMEGA_TEST_FIXTURE_QUIT_ON_FORWARD: '1' },
  },
  tests: [
    {
      name: 'the second launch exits before the primary, and the primary exits on its own',
      run: (ctx) => {
        ctx.expect(ctx.exits.map((exit) => exit.role)).toEqual(['duplicate', 'primary']);
      },
    },
    {
      name: 'the duplicate launch exits 0',
      run: (ctx) => {
        const duplicate = ctx.exits.find((exit) => exit.role === 'duplicate');
        ctx.expect(duplicate).toEqual({ role: 'duplicate', code: 0, signal: null });
      },
    },
  ],
});
