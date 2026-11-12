# Logging

@omega.js/desktop ships a runtime logger that writes to **both the console and a file on disk**, so production issues are inspectable without remoting into the user's machine.

## What you get

- **One log file**, `runtime.log`, populated by all three Electron processes (main / preload / renderer)
- **Live console output** during development (DevTools console for renderer, terminal stdout for main)
- **Cleared per boot, or kept, by the single-instance lock**: with the lock on (the default) the launch that holds the lock empties `runtime.log` of earlier launches' lines once it wins the lock, keeping its own lines from boot on, while a duplicate launch (one that loses the lock and quits) leaves the file alone. With `protocol.singleInstance: false` launches overlap, so a boot never empties it: every launch appends and every file line carries `[pid <n>]` after the level. Either way it rotates at 10 MB (see the lifetime table below)
- **Cross-process timestamps** so log lines from main + preload + renderer interleave in arrival order

## Where the file lives

| Mode | Location |
|---|---|
| Dev (`npm start`, `app.isPackaged === false`) | `<projectRoot>/logs/runtime.log` |
| Prod (installed `.dmg` / `.exe` / `.deb`, `app.isPackaged === true`) | OS log dir: `~/Library/Logs/<ProductName>/runtime.log` (macOS), `%APPDATA%\<ProductName>\logs\runtime.log` (Windows), `~/.config/<ProductName>/logs/runtime.log` (Linux) |

`<ProductName>` = `config.app.productName` (falls back to `config.brand.name`). @omega.js/desktop calls `app.setName(productName)` at boot so `app.getPath('logs')` uses the human-readable brand name, not `package.json#name`.

## How to write logs

In **main process**:

```js
const omega = require('@omega.js/desktop/main');
await omega.initialize();

omega.logger.log('booted');
omega.logger.warn('connection slow');
omega.logger.error(new Error('boom'));
```

In **preload**:

```js
const omega = require('@omega.js/desktop/preload');
await omega.initialize();
omega.logger.log('preload ready');
```

In **renderer** (use the contextBridge surface, which forwards to main → file):

```js
window.desktop.logger.log('user clicked Save');
window.desktop.logger.warn('IPC slow');
window.desktop.logger.error(new Error('ui blew up'));
```

All three end up in the same `runtime.log`, prefixed with their scope in parentheses (`(main)`, `(preload)`, `(renderer)`). electron-log pads the level and, once a longer scope has been written, the scope:

```
[2026-05-05 14:32:11.045] [info]   (main) omega.initialize
[2026-05-05 14:32:11.122] [info]   (main) ipc ready
[2026-05-05 14:32:11.187] [info]   (preload) contextBridge exposed
[2026-05-05 14:32:11.401] [info]   (renderer) auth.listen attached
[2026-05-05 14:32:12.998] [warn]   (main)     auto-updater check failed: network
```

With the single-instance lock off, every file line carries the writing process's id after the level, so overlapping launches can be told apart:

```
[2026-05-05 14:32:11.045] [info]  [pid 12345]  (main) omega.initialize
[2026-05-05 14:32:11.187] [info]  [pid 12345]  (preload) contextBridge exposed
[2026-05-05 14:32:11.402] [info]  [pid 12388]  (main) omega.initialize
```

Grep one context with:

```bash
grep '(main)' logs/runtime.log
```

## CLI: `npx omega logs`

For dev-loop convenience. From the consumer project root:

| Command | Effect |
|---|---|
| `npx omega logs` | Print path, then `tail -50` of the file |
| `npx omega logs --tail` (or `-f`) | Follow mode (like `tail -f`). Ctrl+C to stop. Cross-platform. |
| `npx omega logs --path` (or `-p`) | Print the resolved path only (pipe-friendly) |
| `npx omega logs --open` | Open the log file in OS default editor |
| `npx omega logs --lines=100` | Default mode with custom tail length |

### The surface argument

An optional positional names which of the project's logs to read — `npx omega logs [runtime|dev|build|test]`, resolving `<cwd>/logs/<surface>.log`. It defaults to `runtime`, and every flag above works the same on whichever surface was named:

```bash
npx omega logs dev --tail       # follow the gulp pipeline live
npx omega logs test --lines=100 # last 100 lines of the previous test run
npx omega logs build --path     # just the path, for piping
```

Anything else fails naming the four surfaces. (The four files themselves are described in the lifetime table below; `deploy.log` and `signing.log` are not tail targets.)

`npx omega logs` only resolves the dev path (`<cwd>/logs/<surface>.log`). To find the production runtime log on a user's machine, use the table above or call `getLogFilePath()` from app code.

## How to find the file path from app code

```js
const LoggerLite = require('@omega.js/desktop/lib/logger-lite');
const filePath = LoggerLite.getLogFilePath();
// → '/Users/<user>/Library/Logs/MyApp/runtime.log' in production
```

Useful for:
- "Send us your log" buttons in your settings UI
- Programmatic log shipping (e.g. POSTing the file to your support backend)
- Crash reporters that want to attach the runtime log

## What @omega.js/desktop logs automatically

Beyond what you write yourself, @omega.js/desktop emits a fixed set of high-signal lifecycle lines so post-mortem debugging works without redeploying:

**At boot (`omega.initialize()`):**

```
(main)     Initializing @omega.js/desktop (main)... pid=12345 platform=darwin arch=arm64 packaged=true argv=["--omega-launched-at-login"]
(startup)  startup boot summary — RAW inputs:
(startup)    process.argv:            ["--omega-launched-at-login"]
(startup)    process.platform:        darwin
(startup)    process.arch:            arm64
(startup)    app.isPackaged:          true
(startup)    app.getLoginItemSettings(): {"status":"enabled","openAtLogin":true,"openAsHidden":false,"restoreState":false,"wasOpenedAtLogin":false,"wasOpenedAsHidden":false}
(startup)    boot env:                {}
(startup)  startup boot summary — RESOLVED values:
(startup)    config.startup.mode:     normal
(startup)    config.startup.openAtLogin: {enabled:true, mode:hidden}
(startup)    isDev:                   false
(startup)    hasLoginArg:             true
(startup)    wasLaunchedAtLogin():    true (via argv-flag)
(startup)    isLaunchHidden():        true
```

The boot summary has two parallel blocks: **RAW inputs** (what the OS / shell gave us) and **RESOLVED values** (what @omega.js/desktop decided to act on). Use it to debug both directions:
- "Why is @omega.js/desktop behaving like X?" → check resolved values
- "Why did @omega.js/desktop decide X?" → check raw inputs

The `via:` annotation on `wasLaunchedAtLogin()` distinguishes a real login launch (`via:macos-wasOpenedAtLogin`) from a flag-based simulation (`via:argv-flag` — i.e. the user passed `--omega-launched-at-login`).

**App lifecycle events** (logged from `main.js`):

```
app event: before-quit (entering quit sequence — close events bypass hide-on-close)
app event: will-quit
app event: quit code=0
app event: window-all-closed
app event: activate (macOS — dock click or app re-launch)
app event: open-url url=myapp://auth/token?...
app event: render-process-gone reason=crashed exitCode=139
app event: child-process-gone type=GPU reason=killed exitCode=9
process exit code=0
uncaughtException: <stack>
unhandledRejection: <stack>
```

**Window lifecycle events** (per named window, logged from `window-manager`):

```
createNamed: building "main" (show=false, hideOnClose=true)
createNamed: loaded /path/to/app.asar/dist/views/main/index.html for "main"
window "main": ready-to-show — staying invisible (show:false at create)
window "main": ready-to-show — surfacing
window "main": show event
window "main": hide event
window "main": focus event
window "main": minimize event
window "main": restore event
window "main": close intercepted (hide-on-close) — hiding instead
window "main": close allowed (hideOnClose=true, allowQuit=false, isQuitting=true, force=false)
window "main": closed (destroyed)
```

**Re-surface handlers**:

```
activate (macOS) — surfacing main (visible=false, minimized=false)
_ensureDockVisible — calling dock.show()
_ensureDockVisible — dock already visible
second-instance argv=["..."] eventArgv=["..."] cwd=/...
second-instance: surfacing main (visible=false, minimized=false)
```

**Single-instance lock and boot guard** ([deep-link.md](deep-link.md#single-instance-behavior), [boot-sequence.md](boot-sequence.md#boot-guard)):

```
single-instance lock taken over from a holder that exited (pid 12345)
quit held until the forwarded launch exits (pid 12388)
quit held 5 s and the forwarded launch has not exited (pid 12388); quitting anyway
boot did not finish within 60 s; last step: when-ready
```

The first is a launch that was sent to forward but took the lock instead; the second is a quit asked while a forwarding duplicate is still alive, waiting for it; the third is that wait reaching its 5 s limit, after which the app quits anyway; the fourth is the boot guard ending a boot that stalled, naming the step it stopped at, before the app exits with code 1.

These cover everything you'd want when debugging "why did the app go invisible / crash / fail to surface" without needing to attach a debugger.

## Log levels

Standard: `log`, `info`, `warn`, `error`, `debug`. All levels are written to both transports by default.

To dial down via env vars (useful in CI to silence verbose framework noise):

| Var | Effect |
|---|---|
| `OMEGA_LOG_LEVEL_FILE=warn` | Only `warn` + `error` reach the file |
| `OMEGA_LOG_LEVEL_CONSOLE=error` | Only `error` reaches stdout/stderr |

Default is `silly` (everything) on both.

## How it works under the hood

@omega.js/desktop's runtime logger (`lib/logger-lite.js`) detects which process it's in:

- **Main**: writes to `runtime.log` directly via [electron-log](https://github.com/megahertz/electron-log)'s file transport. Sets up an IPC listener on channel `desktop:log:forward` to receive forwarded calls from preload + renderer.
- **Preload**: writes to console (DevTools) AND forwards each call via `ipcRenderer.send('desktop:log:forward', ...)` to main.
- **Renderer**: same as preload via `window.desktop.logger` (contextBridge surface).
- **Outside Electron** (build/CLI tools that happen to require this module): falls back to console-only.

File path resolution in main:
1. Read `app.isPackaged`.
2. If packaged → `app.getPath('logs')`.
3. If dev → `<cwd>/logs/`.
4. `mkdirSync` the dir, point electron-log at `<dir>/runtime.log`.

The transport is set up lazily on first `log()` call, so importing `LoggerLite` in build/CLI contexts that have no Electron is harmless.

## Coexisting with `dev.log`, `build.log`, `test.log`, and `deploy.log`

Five separate logs in `<projectRoot>/logs/`:

| File | Source | Lifetime |
|---|---|---|
| `runtime.log` | Packaged-app runtime in dev mode | Lock on (the default): emptied of earlier launches' lines by the launch that holds the lock; a duplicate launch leaves it alone. Lock off (`protocol.singleInstance: false`): appended by every launch, each line tagged `[pid <n>]`. Both rotate at 10 MB to `runtime.old.log` (one archive generation) |
| `dev.log` | Gulp pipeline + spawned Electron child stdout (`npm start`) | Truncated each `npm start` |
| `build.log` | Gulp pipeline output for production builds/packages (`npm run build` / `package` / `publish`, i.e. `OMEGA_BUILD_MODE=true`) | Truncated each build |
| `test.log` | `npx omega test` runner output (suite names, pass/fail states, harness boot lines) | Truncated each test run |
| `deploy.log` | GH Actions run output, streamed locally by the follower every target's deploy uses (`omega deploy`, `npx omega release --target=<name>` at the brand root) ([#873](https://github.com/Omega-JS-Stack/omega/issues/873); this was `ci.log`) | Truncated each deploy |
| `signing.log` | JSONL signing events from Windows code-signing (local dev fallback; on CI this writes to the runner home as `omega-signing.log` instead) | Appended (not truncated) |

`dev.log` and `build.log` are the same gulp tee — which one it writes is chosen by `OMEGA_BUILD_MODE`, so they never both fill up in one run. (Disable the tee with `OMEGA_LOG_FILE=false`; override its path with `OMEGA_LOG_FILE=<path>`.)

They serve different purposes and don't overlap: `dev.log`/`build.log` show you "is the build still running?", `test.log` shows you "which test failed on the last run?", `deploy.log` shows you "did the release workflow pass?", `runtime.log` shows you "is my app's auto-updater finding the right release feed?". All useful.

In production: only `runtime.log` exists (no project, no gulp, no GH Actions stream).
