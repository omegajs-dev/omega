# Deep Links

Cross-platform deep-link handling that's simple to use and hard to get wrong. @omega.js/desktop owns all the OS plumbing (single-instance lock, scheme registration, argv parsing, second-instance routing, focus-on-warm-start) and gives you one unified event API regardless of how the link arrived.

## Config

```jsonc
"deepLinks": {
  "schemes": ["myapp"]      // urls like myapp://...
}
```

@omega.js/desktop registers each scheme with the OS via `app.setAsDefaultProtocolClient` so the system routes matching URLs to your app. Registration is **production-only**: dev/test runs never claim OS-wide protocol handlers for unpackaged Electron binaries. In dev, exercise your handlers with `omega.deepLink.dispatch(url)` instead.

## How it works (so you don't have to think about it)

| Platform | Cold-start (app not running) | Warm-start (app already running) |
|---|---|---|
| **macOS** | `app.on('open-url')` — queued before `whenReady`, drained after | `app.on('open-url')` |
| **Windows** | URL appended to `process.argv`; @omega.js/desktop extracts it | OS forwards argv to the existing instance via `app.on('second-instance')`; @omega.js/desktop reads the duplicate's real argv from that event's `additionalData` |
| **Linux** | Same as Windows | Same as Windows |

@omega.js/desktop handles all of these and dispatches them through the same `omega.deepLink.on()` event registry. Your code looks identical regardless of platform or cold/warm start. Single-instance lock is acquired automatically (via `lib/protocol.js`); duplicate launches exit cleanly and forward their argv to the original instance.

## Public API

```js
omega.deepLink.on(pattern, handler)    // register a handler. Returns unsubscribe fn.
omega.deepLink.off(pattern, handler)
omega.deepLink.dispatch(url)           // manually fire (testing, custom triggers)
omega.deepLink.getColdStartUrl()       // the URL the app was launched with, or null
```

## Patterns

```
'auth/token'             // exact match
'user/profile/:id'       // named param → ctx.params.id
'org/:slug/repo/:repo'   // multiple params
'*'                      // wildcard catch-all (only fires when no concrete handler matched)
```

## Handler signature

```js
omega.deepLink.on('user/profile/:id', (ctx) => {
  ctx.url       // 'myapp://user/profile/42?ref=tray'
  ctx.scheme    // 'myapp'
  ctx.route     // 'user/profile/42'
  ctx.pattern   // 'user/profile/:id'
  ctx.params    // { id: '42' }
  ctx.query     // { ref: 'tray' }
  ctx.source    // 'cold-start' | 'warm-start' | 'manual'
  ctx.argv      // process.argv (cold) or the duplicate's real argv (warm, from additionalData)
  ctx.cwd       // working directory (the duplicate's on warm-start)
  ctx.handled   // mutable: set true to suppress remaining handlers (including built-ins)
});
```

## Built-in routes

@omega.js/desktop ships with handlers for common patterns. They run AFTER consumer handlers, so you can shadow any of them by registering your own handler at the same pattern.

| Route | Default behavior |
|---|---|
| `auth/token` | Calls `omega.auth.handleToken(query.authToken)`: the receiving end of the `omega.openAuthFlow()` sign-in round-trip. MODERN shape only (`?authToken=`, what the website's token page sends); other formats (`?token=`, `?payload=`) are ignored. In production the URL arrives via the OS scheme; in dev/test `lib/auth-flow.js`'s loopback listener dispatches the same URL manually (the scheme isn't OS-registered in dev: protocol.js registers only in production, and macOS can't runtime-register unlisted schemes at all) |
| `app/show` | `omega.windows.show(query.window || 'main')` |
| `app/quit` | `omega.quit()`, so a warm-start link waits for its forwarding duplicate to exit (see Single-instance behavior) |

### Overriding a built-in

```js
// Replace the built-in app/show with custom logic.
omega.deepLink.on('app/show', (ctx) => {
  if (ctx.query.window === 'admin' && !omega.appState.isAdminUser()) {
    showError('not authorized');
    ctx.handled = true;       // suppress built-in
    return;
  }
  // Otherwise let the built-in run normally.
});
```

## Resolution order

For each incoming URL, @omega.js/desktop walks handlers in this order:

1. **Consumer concrete handlers** (any non-wildcard pattern you registered with `.on()`)
2. **Built-in concrete handlers** (`auth/token`, `app/show`, `app/quit`)
3. **Wildcard handlers** (`'*'`) — only if NO concrete handler matched

Setting `ctx.handled = true` in any handler stops the cascade. Within a single tier, handlers fire in registration order. Errors in a handler are caught and logged — they don't stop subsequent handlers.

## Common patterns

### Route to a window + send IPC

```js
omega.deepLink.on('user/profile/:id', (ctx) => {
  omega.windows.show('main');
  omega.windows.get('main').webContents.send('navigate', {
    to: `/profile/${ctx.params.id}`,
  });
});
```

### Catch-all logger

```js
omega.deepLink.on('*', (ctx) => {
  omega.logger.warn(`Unrouted deep link: ${ctx.url}`);
});
```

### Cold-start branching

```js
const coldUrl = omega.deepLink.getColdStartUrl();
if (coldUrl) {
  omega.logger.log(`Launched from deep link: ${coldUrl}`);
  // appState.launchedFromDeepLink() is also set automatically
}
```

### Manually dispatching (e.g. from a tray click)

```js
tray.item({
  label: 'Open Profile',
  click: () => omega.deepLink.dispatch('myapp://user/profile/me'),
});
```

## Boot queueing

Every dispatch is held until `omega.initialize()` completes (main.js calls `deepLink.markOmegaReady()` as its last step). A cold-start `auth/token` link (the OS launching the app from the sign-in round trip) therefore never fires before `omega.auth` has Firebase up; it queues and drains the moment the instance is ready. Warm-start dispatches on a running app pass straight through.

## Single-instance behavior

@omega.js/desktop acquires the OS-level single-instance lock during `protocol.initialize()` (boot step 5, before deep-link inits). If another copy of the app is already running:

1. The new instance loses the lock.
2. The OS forwards its argv to the original instance.
3. The new instance's `omega.initialize()` halts (after `protocol.hasSingleInstanceLock() === false`): the duplicate quits and its promise never settles.
4. The original instance's `app.on('second-instance')` fires with the Chromium-processed argv as its second argument AND the duplicate's real argv as its fourth, `additionalData` (@omega.js/desktop passes `{ argv, cwd, pid }` to `app.requestSingleInstanceLock()` for you).
5. @omega.js/desktop's own listener runs first: `lib/deep-link.js` prepends it when the main module loads, so it is ahead of every brand listener, one registered before `require('@omega.js/desktop/main')` included.
6. @omega.js/desktop extracts the deep-link URL from that argv and dispatches normally, but as `source: 'warm-start'`.
7. @omega.js/desktop also focuses the existing main window automatically (consumer can override by registering a route handler that does its own thing).

### Quitting from a `second-instance` handler

A brand quits through `omega.quit()` (or `omega.relaunch()`), never `app.quit()`. Every `second-instance` event names its duplicate's pid to the framework, and while a named duplicate is still alive, `omega.quit()`, `omega.relaunch()`, the `app/quit` route and the Windows/Linux `window-all-closed` quit are held until it has exited, then quit. The duplicate waits on a handshake with the holder before it learns it lost the lock; a holder that exits first leaves the duplicate to take the lock as if it were a first launch, so the forwarded launch never exits as the duplicate it is. Held, the quit logs `quit held until the forwarded launch exits (pid <n>)`. The hold has a fixed limit of 5 seconds (no config key): a duplicate still alive then gets `quit held 5 s and the forwarded launch has not exited (pid <n>); quitting anyway`, and the app quits. With no named duplicate alive, `omega.quit()` quits at once.

```js
app.on('second-instance', (event, argv, cwd, additionalData) => {
  if (lastNotificationEnded(additionalData.argv)) omega.quit();   // waits for the duplicate, then quits
});
```

The holder records its pid in `single-instance-holder.pid` in the userData folder. A launch that finds a live holder there was launched to forward, so when it takes the lock instead (the holder exited before the handshake ended), it logs `single-instance lock taken over from a holder that exited (pid <n>)` and boots as the new holder. Every boot is also under the boot guard, so a takeover whose boot stalls ends by name instead of holding the lock in silence ([boot-sequence.md](boot-sequence.md#boot-guard)).

Reading the duplicate's own flags (a CLI-shaped app, a `--open <file>` handler) means reading that fourth argument:

```js
app.on('second-instance', (event, argv, cwd, additionalData) => additionalData.argv);
```

Never parse the event's own `argv` for flags: Chromium re-serializes it (switches first, Chromium's own switches spliced in, the values detached at the end), so a `--message two` launch arrives with the value detached from the flag.

`targets.desktop.protocol.singleInstance: false` turns the lock off (unset reads as true). `protocol.initialize()` then never requests it, logs `single-instance lock off by config`, and `hasSingleInstanceLock()` answers true, so no launch quits as a duplicate. It is for a CLI-shaped app whose every launch is its own short process (a notifier that shows one banner and exits), where a stuck running copy would otherwise swallow every later launch. What it gives up: `second-instance` never fires, so a second launch's argv and a warm-start deep link on Windows and Linux reach the new process, never the running copy. The lock's other job is yours too: two live copies share the app store, any local servers, and the restart-manager registration, so keep the process short. With it off, boots append to `runtime.log` instead of emptying it and every line carries `[pid <n>]` ([logging.md](logging.md)).

## Linking with `appState`

When a deep link is detected at cold-start, @omega.js/desktop calls `omega.appState.setLaunchedFromDeepLink(true)`. This means:

```js
if (omega.appState.launchedFromDeepLink()) {
  // user clicked a link to launch the app — handle differently than a tray click or login launch
}
```

Combine with `appState.isFirstLaunch()` to detect "first launch via deep link" (e.g. from an onboarding flow on your website).

## Testing

The dispatch pipeline is unit-testable without actually triggering an OS event:

```js
omega.deepLink.dispatch('myapp://auth/token?token=test');
// Fires source='manual'. Handlers run synchronously.
```

See `src/test/suites/main/deep-link.test.js` for the full coverage.

## Implementation notes

- `lib/protocol.js` owns the single-instance lock + scheme registration; `lib/deep-link.js` owns the dispatch pipeline. They're separate modules but tightly coupled.
- OS scheme registration is gated on `omega.isProduction()` (in `lib/protocol.js`): unpackaged dev/test binaries are never registered as system protocol handlers (unconditional registration also intermittently triggered macOS Launch Services `-600` dialogs during test runs).
- On Windows/Linux, scheme registration uses `app.setAsDefaultProtocolClient(scheme, process.execPath, [process.cwd()])` so `app.exe scheme://...` style invocations route argv correctly.
- macOS open-url events that arrive before `whenReady` are queued internally and drained on `deepLink.initialize()`.
- Argv extraction walks backward from the end of argv (where the URL typically sits) and matches against registered schemes.
