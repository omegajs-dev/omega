// The harness app of the `main` and `renderer` rows: runners/electron.js spawns
// Electron on this directory with OMEGA_TEST_SPEC naming `{ layer, suites }`.
// It boots the real main-process `omega`, then runs the row's suites through
// devkit's run-case.js and writes one envelope line per case (devkit's test/events.js).
// `main` requires each suite file here; `renderer` runs the serialized suites in a
// hidden window through the page engine (renderer-entry.js). A fatal goes to stderr.

const path = require('path');
const jetpack = require('fs-jetpack');
const { app, BrowserWindow, ipcMain } = require('electron');
const { eventLine, reportEvery } = require('@omega.js/devkit/test/events');
const { engineSources } = require('./engine-sources.js');
const { awaitRendererRun } = require('./renderer-run.js');

// macOS: suppress app activation BEFORE ready — launching a regular-policy app
// steals keyboard focus app-wide even when no window is ever focused. This file
// only initializes its instance after whenReady (too late: activation fires when
// the app finishes launching), so flip the accessory policy here at require time.
// This process is always a test run (runners/electron.js spawns it naming
// OMEGA_ENVIRONMENT=testing, the one environment input), so
// the shared predicate needs no instance. OMEGA_TEST_SHOW=1 opts back into normal
// activation along with visible windows.
if (process.platform === 'darwin' && require('../../utils/test-stealth.js')()) {
  app.dock.hide();
}

// A loopback CDP port for suites that drive the harness (playwright connectOverCDP).
// Chromium writes it to DevToolsActivePort in the userData dir CURRENT at startup,
// captured here since omega.initialize() re-paths userData; bootOmega() publishes
// it as process.env.OMEGA_CDP_PORT.
if (!app.commandLine.hasSwitch('remote-debugging-port')) {
  app.commandLine.appendSwitch('remote-debugging-port', '0');
}
const devtoolsPortDir = app.getPath('userData');

// A brand's own `second-instance` listener, registered before the framework module loads,
// as a brand's main.js registers it: suites/main/deep-link.test.js reads the order it ran in.
global.__omegaTestSecondInstanceOrder = [];
app.on('second-instance', () => { global.__omegaTestSecondInstanceOrder.push('brand'); });

async function bootOmega() {
  // Publish the harness's resolved DevTools port (see the appendSwitch block at
  // the top of this file) for suites to consume. OVERWRITES any inherited
  // OMEGA_CDP_PORT — a value from the developer's shell points at their dev app,
  // not at this harness. Best-effort short poll: the file is written when
  // Chromium starts the DevTools server during app startup, normally well
  // before whenReady resolves.
  for (let i = 0; i < 20; i += 1) {
    try {
      const port = Number(require('fs').readFileSync(path.join(devtoolsPortDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      if (port > 0) {
        process.env.OMEGA_CDP_PORT = String(port);
        break;
      }
    } catch (_e) { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // The ONE main-process instance, the same object a consumer's main.js requires
  const omega = require('../../main.js');

  // Test mode: load default config from @omega.js/desktop defaults (since the harness CWD won't have
  // one), resolved for the desktop target via @omega.js/config, and skip window creation
  // so we don't pop a UI during tests.
  const fs = require('fs');
  const JSON5 = require('json5');
  const { loadConfig } = require('@omega.js/config');
  const defaultConfig = loadConfig(path.join(__dirname, '..', '..', 'defaults'), 'desktop').config;

  await omega.initialize(defaultConfig, { skipWindowCreation: true });

  // Consumer-scheme containment. Main-layer suites exercise consumer code that
  // loads `<brand.id>://` URLs (tab managers, internal pages), but the consumer's
  // main.js — where the real protocol handler is registered — never runs in this
  // harness. Chromium treats a load on an UNHANDLED scheme as an external
  // protocol and hands it to the OS; if an installed copy of the app owns the
  // scheme (e.g. /Applications/Brand.app on macOS), Launch Services LAUNCHES it
  // mid-test-run. Two test-scoped layers:
  //   1. A stub handler for the consumer's brand scheme on the default session —
  //      brand:// loads commit in-process (blank page) instead of escaping.
  //   2. Deny the 'openExternal' permission on every session (partitions
  //      included) — no navigation can hand ANY scheme to the OS during tests.
  try {
    const { session, protocol } = require('electron');

    const denyOpenExternal = (ses) => {
      ses.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(permission !== 'openExternal');
      });
    };
    denyOpenExternal(session.defaultSession);
    app.on('session-created', denyOpenExternal);

    // Raw JSON5 read is fine here — `brand` is a shared section, top-level in the raw file.
    const consumerConfigPath = path.join(process.cwd(), 'config', 'omega.json5');
    if (fs.existsSync(consumerConfigPath)) {
      const brandId = (JSON5.parse(fs.readFileSync(consumerConfigPath, 'utf8')).brand || {}).id;
      if (brandId && !protocol.isProtocolHandled(brandId)) {
        protocol.handle(brandId, () => new Response('<!doctype html><html><body></body></html>', {
          headers: { 'Content-Type': 'text/html' },
        }));
      }
    }
  } catch (e) {
    console.log(`test harness: consumer-scheme containment failed — ${e.message}`);
  }

  return omega;
}

// One case event as an envelope line on stdout, for the driver to read back.
function emit(event) {
  process.stdout.write(`${eventLine(event)}\n`);
}

// Each suite file is required and normalized here as the host normalized it, so the ids match.
async function runMainSuites(spec, omega) {
  const { normalizeSpec, runSuite } = require('@omega.js/devkit/test/run-case');
  const expect = require('@omega.js/devkit/test/expect');
  for (const { file, cases: wanted } of spec.suites) {
    let suite;
    try {
      delete require.cache[require.resolve(file)];
      suite = normalizeSpec(require(file), { file });
    } catch (e) {
      reportEvery(wanted, emit, { status: 'fail', error: e });
      continue;
    }
    const ids = wanted.map((caseDef) => caseDef.id);
    const cases = suite.cases.filter((caseDef) => ids.includes(caseDef.id));
    await runSuite({ ...suite, layer: 'main', cases }, { expect, extras: { omega }, report: emit });
  }
}

// The serialized suites run in a hidden window, through the page engine (renderer-entry.js).
async function runRendererSuites(spec, omega) {
  const harnessDir = __dirname;
  // Tell the renderer-preload (running in the BrowserWindow's preload) where to
  // require() the renderer instance from. We resolve by absolute path because the
  // preload runs with the renderer's module resolution scope, not main's.
  process.env.OMEGA_TEST_RENDERER_PATH = path.resolve(__dirname, '..', '..', 'renderer.js');

  // Register test-only IPC channels so renderer-layer tests can verify round-trip
  // behavior end-to-end (renderer.invoke → main handler → response). Idempotent:
  // unregister first in case a previous renderer suite registered the same channel.
  try { ipcMain.removeHandler('desktop:__test:echo'); } catch (_) { /* ignore */ }
  ipcMain.handle('desktop:__test:echo', (_evt, payload) => ({ echoed: payload, ts: Date.now() }));
  // Forwarded log capture — renderer logger.log(...) sends 'desktop:log:forward'; we
  // accumulate the most recent payload so the renderer test can verify it landed.
  global.__omegaTestLastForwardedLog = null;
  ipcMain.removeAllListeners('desktop:__test:forwarded-log-tap');
  ipcMain.on('desktop:log:forward', (_evt, payload) => {
    global.__omegaTestLastForwardedLog = payload;
  });
  // Test-only handler the renderer can call to read back the most recently
  // forwarded log payload. Returns null if none yet.
  try { ipcMain.removeHandler('desktop:__test:read-last-log'); } catch (_) { /* ignore */ }
  ipcMain.handle('desktop:__test:read-last-log', () => global.__omegaTestLastForwardedLog);
  // Analytics sender tap ([#411](https://github.com/Omega-JS-Stack/omega/issues/411)):
  // renderer-originated omega.analytics() calls forward over IPC and must fire
  // through main's ONE sender, so a renderer suite needs to read back what that
  // sender was handed. The harness boots with no GA credentials (the sender is
  // disabled), so enable it with harness ones — and replace the Measurement
  // Protocol POST with a recorder FIRST, because a test run must never reach a
  // real GA property. Everything upstream of that one transport call is the real
  // path: the catalog resolution, main's client id, main's session enrichment.
  //
  // The recorder builds the WIRE payload the way the transport does (the same
  // shared `core.buildPayload` the real `_send` calls, with the sender's own
  // identity fields), so a suite asserts on `client_id` as GA would receive it
  // rather than on a field the tap made up.
  const analyticsCore = require('@omega.js/analytics/core');
  global.__omegaTestAnalyticsSends = [];
  omega.analytics.shutdown();
  omega.analytics._send = (descriptor) => {
    global.__omegaTestAnalyticsSends.push({
      provider: descriptor.provider,
      name:     descriptor.name,
      payload:  descriptor.payload,
      body:     analyticsCore.buildPayload({
        clientId:       omega.analytics._clientId,
        userId:         omega.analytics._userId,
        userProperties: omega.analytics._userProperties,
        eventName:      descriptor.name,
        params:         descriptor.payload,
      }),
    });
    return true;
  };
  process.env.GOOGLE_ANALYTICS_SECRET = 'harness-secret';
  omega.config.analytics = { providers: { google: { id: 'G-HARNESS1' } } };
  omega.analytics.initialize(omega);
  try { ipcMain.removeHandler('desktop:__test:read-analytics-sends'); } catch (_) { /* ignore */ }
  ipcMain.handle('desktop:__test:read-analytics-sends', () => global.__omegaTestAnalyticsSends);
  const win = new BrowserWindow({
    show:           false,
    width:          800,
    height:         600,
    webPreferences: {
      preload:           path.join(harnessDir, 'renderer-preload.js'),
      contextIsolation:  true,
      nodeIntegration:   false,
      sandbox:           false,
    },
  });

  try {
    ipcMain.on('__omegaTest:ready', () => {
      win.webContents.send('__omegaTest:suites', { sources: engineSources(), suites: spec.suites, layer: 'renderer' });
    });
    await awaitRendererRun({
      ipc: ipcMain,
      contents: win.webContents,
      load: () => win.loadFile(path.join(harnessDir, 'renderer.html')),
      cases: spec.suites.flatMap((suite) => suite.cases),
      report: emit,
    });
  } finally {
    win.destroy();
  }
}

app.whenReady()
  .then(async () => {
    const spec = jetpack.read(process.env.OMEGA_TEST_SPEC, 'json');
    const omega = await bootOmega();
    if (spec.layer === 'main') await runMainSuites(spec, omega);
    else await runRendererSuites(spec, omega);
    app.exit(0);
  })
  .catch((e) => {
    process.stderr.write(`${e.stack || e}\n`);
    app.exit(1);
  });
