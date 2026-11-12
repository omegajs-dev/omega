// Protocol — single-instance lock + custom URL scheme registration.
//
// Two responsibilities:
//   1. Acquire the OS-level single-instance lock so only one copy of the app runs at a time.
//      If the lock is lost, the user already had the app open — the OS forwarded our argv
//      to that instance via the second-instance event (handled by lib/deep-link.js).
//   2. Register `<brand.id>://` URLs with the OS so the system routes them to this app.
//      On macOS this also enables the open-url event. The scheme is always brand.id —
//      no config knob.

const path = require('path');
const jetpack = require('fs-jetpack');
const LoggerLite = require('./logger-lite.js');
const { pidAlive } = require('./restart-manager/install.js');

const logger = new LoggerLite('protocol');

// The lock holder's pid, in userData: a launch that finds a live holder there was
// launched to forward, so taking the lock instead is a takeover worth a line.
const HOLDER_FILE = 'single-instance-holder.pid';

// How often a held quit looks again for the forwarded launch's exit, and the
// longest it waits before it quits anyway
const FORWARD_POLL_MS = 50;
const FORWARD_HOLD_LIMIT_MS = 5000;

const protocol = {
  _initialized: false,
  _omega:       null,
  _electron:    null,
  _hasLock:     true,
  _schemes:     [],
  _forwarding:  new Set(),      // pids of duplicates a second-instance event named, until they exit

  initialize(omega) {
    if (protocol._initialized) {
      return;
    }

    protocol._omega = omega;
    protocol._electron = require('electron');

    // `app` is only defined in the main process. In renderer/preload (and in
    // plain Node where `electron` is a binary-path string), it's undefined —
    // protocol becomes a no-op there.
    const { app } = protocol._electron;
    if (!app) {
      protocol._initialized = true;
      return;
    }

    // Single-instance lock. A duplicate's argv goes to the holder via second-instance,
    // and main.js quits the duplicate before the rest of the boot runs: two live
    // instances would fight over storage, servers and shared runtime files.

    // The object arrives untouched as second-instance's `additionalData`: the real
    // argv (the event's own is Chromium-processed, values detached), the cwd, and the
    // pid a holder's quit waits on (afterForwardedExit).
    const lockOff = protocol.singleInstanceOff(omega.config);
    const holderFile = path.join(app.getPath('userData'), HOLDER_FILE);
    const holderAtLaunch = lockOff ? null : protocol._liveHolder(holderFile);
    protocol._hasLock = lockOff || app.requestSingleInstanceLock({ argv: process.argv, cwd: process.cwd(), pid: process.pid });
    if (lockOff) {
      logger.log('single-instance lock off by config');
    } else if (!protocol._hasLock) {
      logger.warn('single-instance lock lost — another copy of the app is running.');
    } else {
      logger.log('single-instance lock acquired.');
      // A holder alive at launch means this launch came to forward; it may still be exiting
      if (holderAtLaunch) {
        logger.warn(`single-instance lock taken over from a holder that exited (pid ${holderAtLaunch})`);
      }
      jetpack.write(holderFile, String(process.pid));
    }

    // Register custom URL scheme. Always derived from brand.id — `<brand.id>://...` is
    // the one and only scheme. No config knob; if you need multiple schemes for the same app,
    // call `app.setAsDefaultProtocolClient(extra)` yourself in main.js.
    const schemes = [omega.config.brand.id];
    protocol._schemes = schemes;
    if (omega.isProduction()) {
      schemes.forEach((scheme) => {
        if (process.platform === 'win32' || process.platform === 'linux') {
          app.setAsDefaultProtocolClient(scheme, process.execPath, [process.cwd()]);
        } else {
          app.setAsDefaultProtocolClient(scheme);
        }
      });
    }
    logger.log(`registered schemes=${JSON.stringify(schemes)}`);

    protocol._initialized = true;
  },

  // The one reader of the lock switch: the boot's runtime.log rule asks it too.
  // `protocol.singleInstance: false` is for a CLI-shaped app whose every launch is
  // its own short process: no lock is requested, so no launch is ever a duplicate.
  singleInstanceOff(config) {
    return config.protocol?.singleInstance === false;
  },

  hasSingleInstanceLock() {
    return protocol._hasLock;
  },

  // The pid the holder file names, when that process is alive and is not this one
  _liveHolder(holderFile) {
    const pid = Number(jetpack.read(holderFile));
    return pid !== process.pid && pidAlive(pid) ? pid : null;
  },

  // deep-link's second-instance listener, which runs ahead of every brand
  // listener, names the duplicate here; it stays named while it is alive.
  markForwarding(pid) {
    if (!pidAlive(pid)) return;
    protocol._forwarding.add(pid);
  },

  // The named duplicates still alive; the exited ones are dropped
  _aliveForwarding() {
    for (const pid of protocol._forwarding) {
      if (!pidAlive(pid)) protocol._forwarding.delete(pid);
    }
    return [...protocol._forwarding];
  },

  // Run fn now, or once every named duplicate has exited: a holder that quits
  // first breaks the lock handshake, and the duplicate takes the lock instead of
  // exiting. The wait ends at FORWARD_HOLD_LIMIT_MS whatever happens; `schedule`
  // (setTimeout's shape) is the seam a test swaps, so its wait counts no real time.
  afterForwardedExit(fn, options) {
    const schedule = options?.schedule || setTimeout;
    if (protocol._aliveForwarding().length === 0) {
      fn();
      return;
    }

    logger.log(`quit held until the forwarded launch exits (pid ${protocol._aliveForwarding().join(', ')})`);
    let waited = 0;
    const look = () => {
      waited += FORWARD_POLL_MS;
      const alive = protocol._aliveForwarding();
      if (alive.length === 0) return fn();
      if (waited >= FORWARD_HOLD_LIMIT_MS) {
        logger.warn(`quit held ${FORWARD_HOLD_LIMIT_MS / 1000} s and the forwarded launch has not exited (pid ${alive.join(', ')}); quitting anyway`);
        return fn();
      }
      schedule(look, FORWARD_POLL_MS);
    };
    schedule(look, FORWARD_POLL_MS);
  },

  getSchemes() {
    return protocol._schemes.slice();
  },

  // Returns true if the given URL begins with one of our registered schemes.
  isOurScheme(url) {
    if (typeof url !== 'string') return false;
    return protocol._schemes.some((scheme) => url.startsWith(`${scheme}://`));
  },
};

module.exports = protocol;
