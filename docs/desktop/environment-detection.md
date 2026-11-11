# Environment Detection

`getEnvironment()` returns exactly ONE of three mutually-exclusive, exhaustive values:

```javascript
omega.getEnvironment()    // 'development' | 'testing' | 'production'

omega.isDevelopment()     // true ONLY in development
omega.isTesting()         // true ONLY in testing
omega.isProduction()      // true ONLY in production
```

**ONE input, and no default** ([#817](https://github.com/Omega-JS-Stack/omega/issues/817)). `getEnvironment()` reads the `OMEGA_ENVIRONMENT` variable in Node, and the baked `OMEGA_BUILD_JSON.config.environment` in a renderer (which has no `process.env`). Nothing else is consulted: the `app.isPackaged`, `config.em.environment`, `OMEGA_BUILD_MODE` and `NODE_ENV` sniffs are gone, and a context with neither input **throws**, naming the variable. The old default here was `production`, so a plain `npm start` bundled itself as a production artifact while @omega.js/extension's copy of the same function answered `development` from the same inputs.

**One implementation, shared with every sibling framework.** The four calls are `@omega.js/config`'s [environment.js](../../packages/config/src/environment.js), the module @omega.js/extension, @omega.js/web, @omega.js/backend and @omega.js/client all answer from. @omega.js/desktop has four entry points (main / renderer / preload / build); [src/utils/mode-helpers.js](../../packages/desktop/src/utils/mode-helpers.js) re-exports the shared four beside desktop's own `getVersion()`. The build module exports them as plain functions, and every process's `omega` carries them as methods.

```javascript
omega.getEnvironment()                                // same answer in main / renderer / preload
require('@omega.js/desktop/build').isTesting()        // the build module, for build-time scripts
```

**Who sets the input.** [src/build.js](../../packages/desktop/src/build.js) names it at LOAD, from the lane: `OMEGA_BUILD_MODE` (which `omega build` / `package` / `publish` / `release` and the boot runner's staged build all set) is `production` and WINS over an inherited value, so a production build spawned from a test run still bakes production; otherwise a lane that already named one keeps it (the test runners spawn their children naming `testing`), and a bare dev boot is `development`. The electron app that lane spawns inherits the variable. A PACKAGED app has no parent lane, so [src/main.js](../../packages/desktop/src/main.js) names it from the word the build baked into the artifact: that is a FALLBACK for the context with no input, never an override ([#925](https://github.com/Omega-JS-Stack/omega/issues/925)). A process that already carries `OMEGA_ENVIRONMENT` keeps it, which is why a test lane that boots a production artifact still answers `testing` inside it.

**The renderer gets the running word too.** A page has no `process`, so its `omega` reads input 2, the baked `config.environment`, which is the word the BUILD was for. Those agree everywhere except a lane that boots a production artifact, so the preload (a Node context, it has the variable) exposes it on `window.desktop.environment` and [src/renderer.js](../../packages/desktop/src/renderer.js) applies it over the baked word at `initialize()`. Same precedence, one context removed: the running environment first, the bake second. No second signal exists.

**The three checks are mutually exclusive**: exactly one is true. `isDevelopment()` is **false** during testing, and `isProduction()` is a real positive check (it is NOT `!isDevelopment()`).

## Available helpers

| Helper | Returns |
|---|---|
| `getEnvironment()` | `'development' \| 'testing' \| 'production'`: the one reader of the one input; throws when it is absent. |
| `isDevelopment()` | `true` ONLY in development, and NOT testing. Derives from `getEnvironment()`. |
| `isTesting()` | `true` ONLY in testing. Derives from `getEnvironment()`. |
| `isProduction()` | `true` ONLY in production. A **real positive check**, NOT `!isDevelopment()`. |

## Gating side effects — use the INTENTIONAL check

Because there are three environments, never gate a side effect on a two-value assumption. State what you mean:

```javascript
// Production-only (skip OS side effects / real telemetry in dev AND testing):
if (isProduction())  { /* do the real thing */ }
if (!isProduction()) { /* skip / use the safe local behavior */ }

// Local-or-test (anything that should run in BOTH dev and testing):
if (isDevelopment() || isTesting()) { /* localhost URL, isolate userData, suppress login items */ }
```

**Avoid** `if (!isDevelopment())` or `if (env !== 'development')` to gate production behavior — those wrongly include `testing` as production and leak real side effects (login items, telemetry, auto-update) during test runs. This is the bug class that motivated the 3-value model. (A genuinely dev-only feature like live-reload is the exception: `env !== 'development'` correctly skips it in both testing and production.)

## URL helpers

```javascript
omega.getApiUrl()  // the app's API URL: the SSOT for calling the backend
```

`getApiUrl()` / `getFunctionsUrl()` / `getWebsiteUrl()` resolve to **local** URLs (from the baked dev map, whose floor is the classic hosting / functions / website numbers) in development OR testing, and to production otherwise: `getApiUrl()` is `apiAddress(brand.url, cloud.config.projectId)` from `@omega.js/config/api-address`, `https://api.<brand.url host>` on an owned host and the project's `omega_api` functions url (`https://us-central1-<projectId>.cloudfunctions.net/omega_api`) on a default Pages host ([docs/shared/config.md](../shared/config.md)). They route through `this.getEnvironment()`, so they're correct everywhere without an argument: call them directly. Pass an explicit `env` arg (`getApiUrl('production')`) only to force a specific environment regardless of the current one, rarely needed, and mainly used by tests to pin a specific environment's mapping.

`getAuthUrl()` builds the **sign-in URL that round-trips an auth token back to the app**: `<site>/signin?returnUrl=<site>/token?returnUrl=<brand.id>://auth/token`, where `<site>` is `getWebsiteUrl()` (same env split). The website's `/signin` page logs the user in (or bounces straight through if already signed in), its `/token` page mints a Firebase custom token via the backend, and the final redirect (`?authToken=<token>`, the ONE shape) deep-links the token into the app's built-in `auth/token` route → `omega.auth.handleToken()` → `signInWithCustomToken`. Use it for EVERY "Sign in" affordance an app exposes; never link the bare `/signin` page, which strands the login in the browser. Requires `brand.id` (the deep-link scheme) in config; throws when missing. The optional second arg `getAuthUrl(env, returnUrl)` overrides the chain's final hop: that's how `lib/auth-flow.js` swaps in its dev loopback return.

**Apps should launch the flow through `omega.openAuthFlow()` (main process), not by opening `getAuthUrl()` themselves**: production opens `getAuthUrl()` externally as-is (the OS routes the custom scheme back), while dev/test, where the scheme is NOT OS-registered (protocol.js registers only in production, and macOS can't runtime-register schemes missing from the bundle's Info.plist), swap the final hop for a one-shot, nonce-checked loopback HTTP listener (RFC 8252 §7.3) that feeds the token into the SAME deep-link pipeline. Sign-in always happens in the user's REAL default browser (their existing session/SSO), never an embedded window. Requires @omega.js/client ≥ 4.3.4 on the website (`isValidRedirectUrl` accepts loopback hosts while the SITE runs in dev). See [src/lib/auth-flow.js](../../packages/desktop/src/lib/auth-flow.js).

Every local answer is delegated to `@omega.js/client/modules/dev-ports.js`, the one local port chain every surface shares ([docs/shared/config.md § Port auto-allocation](../shared/config.md#port-auto-allocation-n7)): the `OMEGA_*_PORT` env var first (the CLI that booted the stack publishes it), then the `dev` map the bundle baked into `OMEGA_BUILD_JSON` (a packaged main process has no parent env, so a bumped emulator port reaches it only this way, [#745](https://github.com/Omega-JS-Stack/omega/issues/745)), then a throw naming the port and desktop's bundle task. There is no classic step ([#834](https://github.com/Omega-JS-Stack/omega/issues/834)).

| Helper | Env channel | Baked channel | Local URL | Neither |
|---|---|---|---|---|
| `getApiUrl()` | `OMEGA_HTTPS_PORT`, else `OMEGA_HOSTING_PORT` | `dev.ports.https`, else `dev.ports.hosting` | `https://localhost:<https>` (the mkcert proxy), else `http://127.0.0.1:<hosting>` | throws |
| `getFunctionsUrl()` | `OMEGA_FUNCTIONS_PORT` | `dev.ports.functions` | `http://127.0.0.1:<port>/<projectId>/us-central1` | throws |
| `getAuthEmulatorUrl(omega)` (url-helpers export, what `omega.auth` connects a testing run to, [auth.md](auth.md)) | `OMEGA_AUTH_PORT` | `dev.ports.auth` | `http://127.0.0.1:<port>` | throws |
| `getWebsiteUrl()` | `OMEGA_WEBSITE_PORT` | `dev.origin` (the whole origin) first, else `dev.ports.website` | the baked origin, else `https://localhost:<port>` | throws |

Every plain-http emulator answers on `127.0.0.1`, because `localhost` can resolve to `::1` in Node and miss an emulator bound to `127.0.0.1`. The mkcert proxy and the website answer on `localhost`, the name their local certificate carries.

The classics still reach these helpers, from the ONE place they are defined: the bundle task bakes `CLASSIC_PORTS` and `CLASSIC_DEV_ORIGIN` (`@omega.js/config`) as the FLOOR of the `dev` map, with the live stack's resolved numbers over them, so a dev artifact always carries a complete map. A read that finds none names the fact it wanted and the build step that writes it. A production build bakes no `dev` at all, which is correct: a packaged app has no local stack to reach.

The first three rows are port chains: each cell names a port, and the helper builds the URL around it. The website row is an ORIGIN chain ([#747](https://github.com/Omega-JS-Stack/omega/issues/747)): the baked `dev.origin` the live website published carries scheme, host AND port, so it is the complete fact and outranks the port cell; only when it is absent does a port compose an origin, over **https**, because `omega dev` fronts its public port with the mkcert proxy by default and a port number alone can never say the scheme. Whenever the website published an origin, that is the same answer `@omega.js/client`'s `getDevWebsiteOrigin()` gives every other surface ([#262](https://github.com/Omega-JS-Stack/omega/issues/262)), and `getAuthUrl()` inherits it by construction.

Resolving local in test mode is required because tests hit the local emulator — without it, the app (and tests calling `getApiUrl()`) would leak to the live production server.

> The URL helpers live in [src/utils/url-helpers.js](../../packages/desktop/src/utils/url-helpers.js) as plain functions of the instance (`getApiUrl(omega, environment)`), reading its `getEnvironment()`; main and preload reach them through the one environment mixin.

## Where they live

Source: [src/utils/mode-helpers.js](../../packages/desktop/src/utils/mode-helpers.js) for `getEnvironment()` + `is*()` + `getVersion()`; [src/utils/url-helpers.js](../../packages/desktop/src/utils/url-helpers.js) for the URL builders. Both modules export plain functions. [build.js](../../packages/desktop/src/build.js) exports the mode helpers as they are; [main.js](../../packages/desktop/src/main.js) and [preload.js](../../packages/desktop/src/preload.js) both take them as ONE set of methods mixed in from [lib/_environment-mixin.js](../../packages/desktop/src/lib/_environment-mixin.js) (`Object.assign(Omega.prototype, ...)`), and [renderer.js](../../packages/desktop/src/renderer.js) takes the environment four and `getApiUrl()` / `getFunctionsUrl()` from @omega.js/client's base class it extends.

## How detection works

`getEnvironment()` reads ONE input, and there is no precedence ladder under it
([#817](https://github.com/Omega-JS-Stack/omega/issues/817)):

1. **`process.env.OMEGA_ENVIRONMENT`**, wherever this context has a `process` (main, preload, build-time Node).
2. **The baked `config.environment`** off the `omega` the call is made on, for a renderer, which has none. It is the build fact every OMEGA surface spells the same way ([#896](https://github.com/Omega-JS-Stack/omega/issues/896)). The preload hands the running word across to the renderer when the two differ, so this step answers the artifact's own build only when no lane named one ([#925](https://github.com/Omega-JS-Stack/omega/issues/925)).
3. **Neither** is a loud error naming `OMEGA_ENVIRONMENT`. There is no default, because the four framework copies this replaced each had one and they disagreed.

The lanes above supply that input, and the whole table of who names what lives in
[docs/shared/config.md](../shared/config.md).

## Adding a new helper

Write the function in a `src/utils/<topic>-helpers.js` module, export it from [build.js](../../packages/desktop/src/build.js), and call it from a method on each process class that needs it. Don't define a helper's logic inside one process class: that path leads to duplicated semantics. For anything environment-derived, derive from `getEnvironment()` rather than reading `process.env` / `app.*` directly, so there is one source of truth and no chance of drift.

## Why this matters

**One signal, used everywhere.** The test runners spawn their children naming `OMEGA_ENVIRONMENT=testing`; every piece of code that calls `isTesting()` (framework or consumer) then sees `true`, no need to invent a per-module env var.

**Sub-modules check the same signal.** When framework code (an auto-update poll, a restart-manager registration) needs to skip side effects in tests, it checks `isTesting()` — the same answer the consumer's own code gets. No drift.

**`is*()` can never disagree with `getEnvironment()`.** Because the checks derive from the single resolver instead of reading raw signals, there is exactly one definition of "what environment is this," and a wrong-but-confident gate is structurally impossible. Since #817 that holds ACROSS frameworks too: the resolver is one shared module, so @omega.js/desktop and @omega.js/extension can no longer answer differently from the same inputs.

## See also

- [test-framework.md](test-framework.md): `OMEGA_ENVIRONMENT=testing` is named automatically by the test runners; extended mode (`--extended` / `TEST_EXTENDED_MODE`) gates real external APIs.
