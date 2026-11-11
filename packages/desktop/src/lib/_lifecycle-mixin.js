// The main process's quit/relaunch pair: methods mixed into the `Omega` class
// (src/main.js) with `Object.assign(Omega.prototype, ...)`, so they stay
// `omega.quit()` and `omega.relaunch()` on the instance.

module.exports = {
  // The app's quit (a brand's own exit, the app/quit route, window-all-closed).
  // `{ force: true }` bypasses per-window `hideOnClose`. While a duplicate a
  // second-instance event named is alive, it waits (5 s at most) for that one to
  // exit first, so it exits as a duplicate (protocol.afterForwardedExit).
  quit(options) {
    options = options || {};

    if (options.force) {
      this._allowQuit = true;
    }

    this.protocol.afterForwardedExit(() => {
      try {
        require('electron').app.quit();
      } catch (e) { /* electron not available: no-op in test/headless */ }
    });
  },

  // Force a relaunch: same gating and the same hold as quit, but tells electron to
  // start back up after exit. If an update has been downloaded, prefers
  // `quitAndInstall()` so the user lands on the new version instead of the old one.
  relaunch(options) {
    options = options || {};

    if (options.force) {
      this._allowQuit = true;
    }

    const electron = require('electron');

    this.protocol.afterForwardedExit(() => {
      // If updater downloaded a fresh build, install + relaunch via electron-updater
      // (which calls `app.quit()` internally with the right post-quit script). Falls
      // back to plain relaunch if updater hasn't downloaded anything.
      const updaterStatus = this.autoUpdater.getStatus();
      if (updaterStatus.code === 'downloaded') {
        this.autoUpdater.installNow();
        return;
      }

      electron.app.relaunch();
      electron.app.quit();
    });
  },
};
