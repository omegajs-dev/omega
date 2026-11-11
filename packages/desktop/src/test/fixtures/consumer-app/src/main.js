// Minimal main entry for @omega.js/desktop's boot-layer self-test fixture. Mirrors a real consumer:
// one-line bootstrap, then create the main window once initialize() resolves. The boot
// harness (src/test/harness/boot-entry.js) inspects the live instance after this runs.
const { app } = require('electron');

// A brand that ends on a forwarded launch: its own listener, registered before the
// framework loads, quits through omega.quit(). Only boot/second-instance-quit.test.js
// asks for it: every other user of this fixture keeps running after a second launch.
if (process.env.OMEGA_TEST_FIXTURE_QUIT_ON_FORWARD === '1') app.on('second-instance', () => omega.quit());

const omega = require('@omega.js/desktop/main');

omega.initialize()
  .then(() => {
    const { windows, logger } = omega;

    // Force show:false: the boot harness runs headless and only asserts the window
    // EXISTS + loaded the built view, never that it's visible on screen.
    // A windowless launch (the two-launch suite's) quits at once, as a tray-only brand does.
    if (process.env.OMEGA_TEST_FIXTURE_WINDOWLESS !== '1') windows.create('main', { show: false });

    logger.log('@omega.js/desktop fixture consumer main initialized!');
  });
