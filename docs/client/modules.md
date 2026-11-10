# Module Quick Reference

## Storage (`storage.js`)

- **Class**: `Storage`
- **Key Methods**: `get(path, default)`, `set(path, value)`, `remove(path)`, `clear()`
- **Session**: Same methods under `.session` namespace
- **Storage Key**: `_manager` in localStorage

## Auth (`auth.js`)

- **Class**: `Auth`
- **Key Properties**: `user` (the current `User`, never null), `state` (the newest landed `{ user, denied }`, or null before the first), `settled` (resolves when the first state lands)
- **Key Methods**: `listen(options, callback)`, `reload()`, `signInWithEmailAndPassword()`, `signInWithCustomToken()`, `signOut()`, `getIdToken()`, `probeSession()`
- **Bindings**: Updates `auth` and `usage` context on auth settle
- **`probeSession()`** ([#798](https://github.com/Omega-JS-Stack/omega/issues/798)): the forced token refresh the client runs at a moment of doubt (tab visible, network back, a 401). Resolves `'signed-out' | 'alive' | 'gone' | 'unknown'`; a non-network `auth/*` error signs the user out, a network error keeps them, and probes coalesce to one in flight. Full contract: [docs/client/index.md](index.md)
- **Listener state**: `callback({ user, denied })`. `user` builds from the empty schema shape when the doc is not written yet (a NORMAL pending state); `denied` is true only when Firestore rules refused the read, the one REAL failure; web signs out on it
- **Usage Resolution**: `_resolveUsage(user)` merges `user.usage` (Firestore) with the EFFECTIVE limits of `user.plan` to produce the `usage` bindings key. Both halves are config (the `features` catalog says what a feature is and whether it is counted, the product's `features` map says what the tier promises), and the arithmetic is `@omega.js/account`'s, the same module @omega.js/backend's gate reads ([#647](https://github.com/Omega-JS-Stack/omega/issues/647)). Per feature: `{ monthly, daily, total, limit, left, override, day: { limit, used, left } }`, with a per-user `usage.overrides.<feature>` winning over the plan's number

### auth.user

`auth.user` is a `User` from `@omega.js/account`, the same class @omega.js/backend builds as `ctx.user`, so a document resolved here is identical to one resolved there. Signed out, it is a `User` with `authenticated` false and `plan` basic, never null.

```javascript
const { user } = omega.auth;
// Stored document as own fields: user.auth.uid, user.subscription.status, user.roles.admin
// Getters: authenticated, uid, email, plan, active, trialing, cancelling, everPaid
// From the sign-in: user.profile.{ displayName, photoURL, emailVerified }
```

- `plan`: Effective plan ID the user has access to RIGHT NOW (`'basic'` if cancelled/suspended)
- `active`: User has active access (active, trialing, or cancelling: all mean the user can use the product)
- `trialing`: In an active trial (status `'active'` + `trial.claimed` + unexpired `trial.expires`)
- `cancelling`: Cancellation pending (status `'active'` + `cancellation.pending` + NOT trialing)
- `everPaid`: A payment start date exists
- `toJSON()`: the stored document alone, never the getters or the profile
- A brand's own top-level keys ride through: the account schema's root is passthrough, so a key the brand stores on `users/{uid}` (`notes`) lands on `auth.user` as stored, on every surface (`ctx.user` on the backend, desktop main, the extension background). A stored key named like a `User` property (a getter, `toJSON`, `profile`) throws, naming the key; the framework rules refuse a client write of one. Any OTHER key the brand adds is client-writable: the framework rules let a signed-in user write their own `users/{uid}` document, so a brand key that must not be forged by its owner (a credit balance, a flag the backend trusts) needs the brand's own `match /users/{uid}` block in its Firestore rules to tighten the match (the rules compiler ANDs it onto the framework's), or a backend route to write it

### One State Per Auth Change

`_landState` (reached from `index.js`'s `onAuthStateChanged` through `_handleAuthStateChange`, not awaited, and from `reload()`) is the ONE place an auth state is built: one account fetch, one `User`, one `{ user, denied }` state per change. It sets `auth.user` and `auth.state`, updates the bindings and storage once, resolves `auth.settled`, then delivers the state to every persistent listener. A build superseded by a newer change while its fetch was in flight is dropped (#196).

- **`once` listeners** (`listen({ once: true }, cb)`): wait for `auth.settled` (the first landed state), then receive the newest landed state. No cleanup needed.
- **Persistent listeners** (`listen({}, cb)`): receive every landed state. One registered after a state already landed catches up with it once, on the next microtask.
- Every consumer of one change holds the SAME `User` instance, which is also `auth.user`.
- **`reload()`**: first waits for Firebase to restore the saved session (`authStateReady()`), then re-reads the account for the current Firebase user, lands it as a new state, and resolves with it (following a newer build when one superseded it mid-fetch).

## Bindings (`bindings.js`)

- **Class**: `Bindings`
- **Key Methods**: `update(data)`, `getContext()`, `clear()`
- **HTML Attr**: `data-omega-bind`
- **Actions**: `@text`, `@value`, `@show`, `@hide`, `@attr`, `@style`
- **Deep reference**: [bindings.md](bindings.md) — comma syntax, condition operators, state paths, skeleton loaders, root-key filtering

## Request (`request.js`) — harmonized API fetch

- **Instance API**: `await omega.request('/omega/user/token', { method: 'POST', body: {} })`
- **Options**: `method` (default GET), `headers`, `body` (objects JSON-encoded automatically), `auth: false` (skip the Bearer token for public routes), `output: 'complete'` (returns `{ status, ok, headers, data, properties }` instead of just the body), `tries` (bounded retries on network errors + 5xx), `timeout` (per-attempt `AbortSignal.timeout`), `wakeup: true` (below)
- **`wakeup: true`** ([#637](https://github.com/Omega-JS-Stack/omega/issues/637)): a fire-and-forget GET that warms a cold backend and nothing else — `omega.request(WAKEUP_ROUTE, { wakeup: true })`, with `WAKEUP_ROUTE` exported by this module (the ONE route every surface pings, [#644](https://github.com/Omega-JS-Stack/omega/issues/644)). It appends `wakeup=true` to the URL, mints no ID token, reads no response body, returns `undefined`, and RESOLVES rather than throwing when the network is down. @omega.js/backend's middleware answers a wakeup before it loads a route or authenticates, so every route is the same warm-up at the same price and none of them runs.
- **Behavior**: leading-`/` paths resolve through `getApiUrl()`; absolute URLs pass through. A fresh Firebase ID token rides as `Authorization: Bearer` when signed in. Non-ok responses THROW an `Error` carrying `.code` (HTTP status), `.data` (parsed body), and `.properties`.
- **omega-properties**: the backend assistant attaches this header (code, tag, usage current+limits, schema, additional) to every response; `omega.request()` parses it on success AND error, and merges server usage into the `usage` bindings key — `data-omega-bind` elements refresh automatically.
- **Standalone**: contexts with no browser instance build their own via `createRequest({ getApiUrl, getIdToken, onProperties, onUnauthorized })` from `@omega.js/client/modules/request.js`: the extension background and desktop main each build their `omega.request()` on their own session this way, once per instance, and their token sync fetches through it. `onProperties` and `onUnauthorized` are optional; only `getApiUrl` and `getIdToken` are required.
- **401 probes the session** ([#798](https://github.com/Omega-JS-Stack/omega/issues/798)): a 401 on a request that asked for auth calls the optional `onUnauthorized` dep (the instance passes `omega.auth.probeSession()`) without awaiting it and swallowing its rejection, then throws the caller's error unchanged. `auth: false` requests and every other status never call it.

## Device (`device.js`) — local device stats

- **Class**: `Device` (`omega.device`)
- **Key Methods**: `getUsageDuration(unit)`, `getSessionDuration(unit)`, `getInstalledDate()`, `getSessionCount()`, `getBindingData()`, `reset()`
- **Storage**: localStorage (web) or extension storage, key `omega_device`
- **Bindings**: seeds the `device` key on initialize (installed / session / version / duration) — distinct from the server-derived `usage` key (see [bindings.md](bindings.md))

## Firestore (`firestore.js`)

- **Class**: `Firestore`
- **Key Methods**: `doc(path)`, `collection(path)`
- **Doc Methods**: `.get()`, `.set()`, `.update()`, `.delete()`
- **Query Methods**: `.where()`, `.orderBy()`, `.limit()`, `.startAt()`, `.endAt()`
- **Instance**: the first read awaits `omega.loadFirebaseFirestore()`, the one Firestore instance (emulator already connected on a local stack); there is no second `getFirestore` path. Code that needs the raw instance (the admin pages' count queries) awaits the same loader. See [architecture.md § What boot loads](architecture.md#what-boot-loads-and-what-waits-for-first-use)

## Notifications (`notifications.js`)

- **Class**: `Notifications`
- **Key Methods**: `isSupported()`, `isSubscribed()`, `subscribe()`, `unsubscribe()`, `getToken()`, `onMessage()`
- **`isSupported()`**: synchronous. True when the browser has Notification, a service worker and the Push API, and Firebase is configured (`omega.firebaseApp`). It never loads the messaging SDK
- **Messaging instance**: every method that needs it awaits `omega.loadFirebaseMessaging()`, so the SDK loads at the first subscribe, token read or foreground listener, once per page
- **Storage**: Saves to localStorage and Firestore
- **VAPID key**: resolved from `config.cloud.messaging.vapidKey` (the omega.json5 home; the web engine bridges it into the `firebase.messaging.config.vapidKey` contract shape too). Public by design.

## ServiceWorker (`service-worker.js`)

- **Class**: `ServiceWorker`
- **Key Methods**: `isSupported()`, `register()`, `ready()`, `postMessage()`, `onMessage()`, `getState()`, `unregisterAll()`
- **Registration policy**: `serviceWorker.enabled` (default true) registers at
  scope `/` with `updateViaCache: 'none'` on every init — dev included (the
  worker is how push/caching get tested locally, and same-scope registration
  is what replaces a DIFFERENT project's worker left on the same localhost
  port). `enabled: false` calls `unregisterAll()` instead — the origin is
  swept clean, never left to a stale foreign worker.
- **Under a URL-path mount** ([#360](https://github.com/Omega-JS-Stack/omega/issues/360)):
  when the page carries the web build's `<html data-omega-path-prefix>` stamp,
  `register()` mounts the script and the scope under it
  (`/workkit/service-worker.js` at scope `/workkit/` — the only scope a script
  served from there can claim) and appends the prefix to the script URL as
  `?omega-path-prefix=…`, which is how the worker (no document, no stamp) learns
  the mount for the URLs it builds. No stamp means the domain root and an
  unchanged registration.

## Path prefix (`path-prefix.js`)

- **Exports**: `pathPrefix()`
- The base path this page is mounted under (#355), read off the web build's
  `<html data-omega-path-prefix>` stamp — `''` at the domain root,
  `'/workkit'`-shaped otherwise. The client's mirror of the web package's
  runtime helper (`core/js/libs/path-prefix.js`); nothing imports across the
  package boundary.
- **Read by**: the ServiceWorker registration above ([#360](https://github.com/Omega-JS-Stack/omega/issues/360))
  and the instance's refresh-new-version poll, which fetches the build manifest
  at `<prefix>/build.json` ([#364](https://github.com/Omega-JS-Stack/omega/issues/364))
  — root-relative, that poll 404s forever under a path mount.

## Slugify (`slugify.js`)

- **Exports**: `slugify(input)`
- The ONE slugifier of the stack: lowercase, apostrophes (straight and
  typographic) deleted, every run of anything but `a-z0-9` turned into one `-`,
  and `-` trimmed off both ends, so "Beginner's Guides" is `beginners-guides`.
- **Read by**: @omega.js/template-kit's `omega_slugify` filter, @omega.js/web's
  admin post editor, @omega.js/web's `src/sections.js` (a showcase demo
  variant's slug, `demo` when the label slugs to nothing), @omega.js/manager's
  devlog (`src/devlog/lib/generate-post.js`, a generated post's slug), and
  @omega.js/backend's `omega.utilities.slugify`
  (`packages/backend/src/omega/services/utilities.js`, admin/post's URL and image
  filenames, the newsletter's article CTA), so a slug the editor fills in and one
  a build renders agree.

## Site path (`site-path.js`)

- **Exports**: `isSitePath(value)`
- The ONE home of the return-path rule: true only for a string that starts with a
  single `/` and carries no `//`, no backslash and no whitespace (a query and a
  hash are fine), so an absolute URL, `//host`, `/\host` and `javascript:` are all out.
- **Read by**: @omega.js/backend's connections route, which refuses a `returnUrl`
  that fails it (the 400 words the rule as `RETURN_PATH_RULE`), @omega.js/backend's
  test redirect route (`src/omega/routes/test/redirect/get.js`), which refuses a
  `url` that fails it, and @omega.js/web's connections callback, which runs it
  again before handing the value to `location`.

## Sentry (`sentry.js`)

- **Class**: `Sentry` (`omega.sentry`)
- **Key Methods**: `schedule(config)`, `init(config)`, `captureException(error, context)`
- **Start**: `initialize()` calls `schedule()` when Sentry is on and never awaits the SDK. `schedule()` installs the early-error buffer (`@omega.js/monitoring/browser`'s `installEarlyErrorBuffer`), then hands `init()` to `dom.js`'s `whenSettled`, with a timer standing in where `requestIdleCallback` is missing. A test drives the window's `requestIdleCallback` (or its `load` event). The sequence and its timings: [monitoring.md § When Sentry starts](../shared/monitoring.md#when-sentry-starts)
- **Replay**: when `init()` has initialized the SDK it captures every buffered entry through `Sentry.captureException` (so `beforeSend`'s filters apply), stops the buffer's listeners and empties it: each early error is captured once. A buffered `error` or `unhandledrejection` rides the SDK's own global-handler mechanism (`handled: false`, `auto.browser.global_handlers.onerror` / `.onunhandledrejection`); a buffered `captureException()` call keeps its own context
- **Before init**: `captureException()` pushes `{ type: 'capture', error, context }` to the buffer instead of dropping it; with Sentry off (no buffer) it logs and returns null
- **Failed load**: when `init()` rejects (the SDK import failed), the buffer's listeners stop and it empties for good, and `captureException()` stops pushing
- **Filtering**: Blocks dev mode, Lighthouse, Selenium/Puppeteer

## DOM (`dom.js`)

- **Exports**: `loadScript(options)`, `ready()`, `whenSettled(fn, options)`, `replaceChildren(el, ...nodes)`
- **`replaceChildren(el, ...nodes)`**: the ONE way browser code swaps an element's children. It calls the native `replaceChildren` where the browser has it, else clears `innerHTML` and appends, because the native method is newer than the browser floor ([devkit](../devkit/index.md)'s `NEWER_BROWSER_APIS`). Every other site calls this helper (motion's marquee, verts' promo, web's dev palette and the verts test page)
- **`whenSettled(fn, { timeout, fallbackDelay, doc })`**: the ONE scheduler for work kept out of the first-paint window (the motion dotfield, the Sentry SDK). Once `doc` is complete (no `doc` counts as complete), or at the window's `load`, or after a 10 s ceiling when `load` never fires, it asks `requestIdleCallback` with `timeout`; where that is missing it runs `fn` after `fallbackDelay` ms, or at once when none is given
- **loadScript Options**: src, async, defer, crossorigin, integrity, timeout, retries

## Utilities (`utilities.js`)

- **Exports**: `clipboardCopy()`, `escapeHTML()`, `sanitizeURL()`, `renderMarkdown()`, `showNotification()`, `getPlatform()`, `getBrowser()`, `getRuntime()`, `isMobile()`, `getDevice()`, `getContext()`
- **clipboardCopy(input)**: copies a string or an element's value/text; the returned promise REJECTS when the clipboard refuses (denied permission, blurred document) — the legacy lane reads `execCommand`'s return, so no lane reports a failed copy as success ([#726](https://github.com/Omega-JS-Stack/omega/issues/726)).
- **escapeHTML(input)**: walks strings, arrays and objects recursively; escapes `& < > " '` (quotes too, so an escaped value is safe inside an attribute). Non-strings pass through.
- **sanitizeURL(url)**: returns the URL unchanged when it resolves to `http:`/`https:`, `''` for every other scheme (`javascript:`, `data:`, …).

### renderMarkdown(text)

Untrusted text as safe markup — an escape-first mini renderer for API answers and user-supplied prose (ported from the workkit tower's issue dialog). It composes the two helpers above rather than owning escaping: the source is escaped ONCE up front and every rule then works on that escaped string, so no rule can resurrect a `<script>` that is already `&lt;script&gt;`.

- **Grammar**: `#`–`######` headings, fenced blocks (```` ``` ````), inline code, `-`/`*` bullet and `1.`/`1)` numbered lists, `**bold**`, `*italic*`, and `[label](href)` links. Anything else renders as the text it was — it is not a markdown engine.
- **Links**: `sanitizeURL` gives the scheme verdict and the href must additionally be absolute `http(s)` — a `javascript:`/`data:`/relative href leaves the bracket text as text, never an anchor. Built anchors are stashed behind a NUL sentinel while the emphasis rules run, so an href holding asterisks survives untouched. Anchors carry `target="_blank" rel="noopener"`.
- **Output shape**: headings render three levels down (`#` → `<h4 class="h6 mt-3 mb-2">`, floored at `h6`) so a rendered fragment never competes with its host page's title; fenced blocks render `<pre class="p-2 rounded"><code>` (Bootstrap utilities, same idiom as `showNotification`).
- **Edges**: empty/whitespace/`null` input returns `''` (the caller says what empty means); an unterminated fence still renders its content.

## Live Page (`live-page.js`) — the self-refreshing page primitives

- **Exports**: `loading(message)`, `swap(host, markup)`, `createFeedPoller(options)`
- **Pattern**: transport-free standalone module with the deps-injected seam `request` uses: the page boots it and hands it a fetcher, and it never reaches the instance. Ported from the workkit tower's page runtime.
- **`swap($host, markup)`**: writes `innerHTML` ONLY when the markup differs from what swap itself last wrote (a WeakMap keyed by the element), so an unchanged section keeps its DOM, focus, scroll position and open `details` across a poll. The comparison never reads `host.innerHTML` back — the browser re-serializes what it parses, so a read-back never matches the string that produced it and every tick would count as a change. Returns `true` when it wrote, which is what post-draw work (charts, listeners) hangs off.
- **`loading(message)`**: the spinner line a section shows while its feed has never answered — a first paint says which read it is waiting on instead of drawing an empty region. The message is escaped through `utilities.escapeHTML`.
- **`createFeedPoller({ feeds, fetcher, onChange })`**: `feeds` is the declared table (`{ name: { path, every, fresh? } }`, where `fresh` is the cache-bypass path a user-triggered refresh uses); `fetcher` is an `omega.request`-shaped function (resolves with the body, throws an `Error` carrying `.code`), so a page passes `omega.request` and a context with no browser instance passes its own `createRequest(...)`; `onChange` fires at every state transition (a read starting, a read landing) and is where the page repaints.
- **Poller surface**: `state` (`{ feeds, pending, stamp }`), `read(name, fresh)`, `readAll(fresh)`, `staleFeeds()`, `start()` (first pass, then arms one interval per feed; idempotent), `stop()` (also lets go of the visibility listener).
- **Hidden-tab pause**: the cadence stops while the page is hidden (a covered tab) and resumes with one immediate read on return. A visible-but-unfocused window keeps polling, and a context with no `document` (the extension service worker) keeps its cadence. There is no option for it.
- **Feed result shape**: `{ ok, data, status, reason }` — `status` is the thrown error's `.code` (null for a transport failure), `reason` its message.
- **Keep-last-good**: a refresh that fails does NOT clear the page — the last good result stays in `state.feeds[name]` with a `stale` key naming why the refresh missed. A feed that has never answered simply carries its own latest failure. `staleFeeds()` returns `[{ name, reason }]` for both cases, which is what a chrome bar's "N feeds unavailable" chip draws from.
- **`state.pending`**: how many reads are in flight — a refresh is visible while it happens and the page under it keeps showing the data it already has.

## Verts (`verts.js`) — adblock-safe ad engine

- **Class**: `Verts` (+ `VertUnit` per mounted house unit)
- **Key Methods**: `render($el, options)` (the full ladder), `renderHouse($el, options)` (fallback lane directly — the desktop/extension lane), `mount($el, options?)` (lazy IntersectionObserver arm from `data-omega-vert*` attributes, idempotent), `bind(root?)` (auto-mount every `[data-omega-vert]`), `resolveSource(source?)`
- **The ladder** (docs/web/ads-system.md, monorepo): AdSense when `advertising.providers.adsense.client` is configured and the type is a provider type — script-load failure of `adsbygoogle.js` IS the adblock detector (no bait divs, no poll); fill awaited via a MutationObserver on `data-ad-status` + timeout; `unfilled`/timeout/blocked → the `advertising.fallback` lane (`'inhouse'`) → no-fill collapse (`display: none` + `omega-vert:no-fill`)
- **House lane**: sandboxed iframe → `<source>/omega/verts/serve` (`parent`, `tags`, `vertId`, `height`, `theme`, cache-buster); origin-validated postMessage vocabulary `omega-vert:set-dimensions` / `omega-vert:click`; HOST-owned lifecycle — rotation timer (`rotateInterval`, off by default), staleness recovery (`visibilitychange`/`online` → reload when stale), fill timer
- **Source resolution** (`advertising.providers.inhouse.source`): `'self'` → `getApiUrl()`, `'company'` → `config.company.url` through the api derivation (`getApiUrl(null, companyUrl)`, which hands the url no project id of this brand's, so a company on a default Pages host has no address: `getApiUrl` throws naming `cloud.config.projectId` and the source resolves to nothing, with a warning), full URL → verbatim
- **Element vocabulary**: `data-omega-vert` (type: `display`/`in-article`/`in-feed`/`multiplex`/`house`), `data-omega-vert-size` (preset or px), `data-omega-vert-id`, `data-omega-vert-tags` — the web `verts/unit` section and the phase-4 desktop/extension binding share it
- **Events**: `omega-vert:fill` / `omega-vert:no-fill` / `omega-vert:click` / `omega-vert:reload` bubble from the host (+ `onFill`/`onNoFill`/`onClick`/`onReload` callbacks)

## Features (`features.js`) — the features contract in the browser

- **Shape**: a plain re-export, not a class — `import { resolveFeatures } from '@omega.js/client/modules/features.js'`
- **Exposes**: `isCountedFeature`, `isPacedFeature`, `featureMirrors`, `featureOverride`, `featureCounters`, `productFeatureValue`, `daysInMonth`, `dayShare`, `nextReset`, `resolveFeature`, `resolveFeatures`
- **Why it exists**: the derivations live ONCE, in `@omega.js/account` — the same module @omega.js/backend's `consume` gate reads — so the number that refuses a request and the number a usage card draws can never be two different numbers. `@omega.js/account` is a private package a consumer's install never resolves by name, and this package's dist carries it vendored, so this module is the DOOR a frontend goes through. Same idiom as `analytics.js` fronting `@omega.js/analytics` ([#647](https://github.com/Omega-JS-Stack/omega/issues/647))
- **The catalog is config**, not a module export: `omega.config.features`, which the embedding framework's build bridges in beside `omega.config.payment`
- **`resolveFeature(id, { catalog, product, account, now })`** returns everything a surface needs to speak about one feature: `{ id, name, icon, definition, counted, paced, mirror, value, limit, planLimit, override, used, left, total, day: { limit, used, left } }`. `-1` is the unlimited sentinel wherever a limit or a remainder can appear
- **Callers**: @omega.js/web's `payment-config.js` (`getProductLimits` is the catalog-aware read) and the account page's billing panel (plan bullets and usage cards); `auth.js`'s `_resolveUsage` reaches the same functions directly

## Motion (`motion.js`)

- **Exports**: `createMotion()`, `parseCountTarget(text)`, `formatCount(target, value)`
- **Pattern**: transport-free factory like icon-renderer: the base class builds one as `omega.motion` (`createMotion()`), and `@omega.js/web` adopts its first-paint engine in its place (`core/js/core/motion.js`)
- **Engine surface**: `start(doc?)` (idempotent scan + IntersectionObserver + MutationObserver + scroll watcher), `stop()`, `scan(root)` for manually rendered roots
- **Attribute contract** (styled by the embedding framework's motion stylesheet): `data-omega-reveal[="up|fade|left|right|scale"]`, `data-omega-reveal-stagger`, `data-omega-countup`, `data-omega-rotate`, `data-omega-marquee` (+ `.omega-marquee__track` — the set is cloned until half the track covers the container; attr value = px/s), `data-omega-scroll-watch`, `data-omega-segmented` (gliding `.omega-segmented__thumb` under the checked/`.active` segment), `data-omega-dotfield` (canvas dot grid: traveling wave + drifting rainbow tint + window-tracked pointer glow; attr value = px spacing)
- **Resilience**: no-JS pages render visible (the hiding styles are gated on an inline `html[data-omega-motion]` stamp); `prefers-reduced-motion` renders final states with no animation; missing observers (exotic embeds) degrade to instant reveal
