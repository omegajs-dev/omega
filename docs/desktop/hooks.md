# Lifecycle Hooks

Consumers can inject custom logic at well-defined points without forking @omega.js/desktop's gulp tasks. All hooks are **purely additive extension points** — @omega.js/desktop's core logic always runs first, the hook is called after (or before, depending on the lifecycle point), and a hook throwing only logs a warning, never breaks the build.

## How hooks work

1. @omega.js/desktop scaffolds empty hook files into `<consumer>/hooks/**/*.js` on every verb (`ensureTarget()`).
2. At each lifecycle point, @omega.js/desktop checks for the file. If it exists, devkit's one hook runner (`runConsumerHook`, shared with @omega.js/extension) loads it through `require()` and invokes its default export. If not, no-op.
3. A hook file is an ES module with one default export, `export default async (ctx) => { ... }`, with `ctx` the ONE hook-argument shape every OMEGA framework passes, `{ build, projectRoot, mode }`: `build` is the build module (`@omega.js/desktop/build`, one plain object of functions: `getConfig()`, `getPackage()`, `getRootPath()`, ...). Whatever it returns is awaited but ignored.
   - The body uses `import`: a top-level `import`, `await import()` for a lazy load, and `import.meta.dirname` for the file's folder.
   - No top-level `await`: the file is loaded by `require()`, which refuses an async module. An `await` goes inside the default export.
   - An edit shows on the next run: Node never reloads an ES module inside one process.
4. **Failure semantics:**
   - File missing entirely → logged informationally (`hook "<name>" not present at ..., skipping`), build continues.
   - File exists but fails to load (syntax error, etc.) → **throws**, build fails.
   - File exists but is not an ES module with a default export function (a `module.exports` hook included) → **throws** `<file> must be an ES module with one default export (export default async (...) => {})`, build fails.
   - File loads + invokes the function and the function throws → **throws**, build fails.

   In other words: a hook that doesn't exist is fine (you'll see one log line), but a hook that's broken in any way fails loudly. You should never silently ship a malformed hook to production.
5. **A hook runs under plain node, outside the bundle**, so an `import` (or `import()`) of a framework dependency the target never declared resolves only by hoisting: every verb's scaffold warns on it (the dependency nudge, never an error), and the two fixes are declaring it or loading the framework's copy with `desktop.require(name)` after `import desktop from '@omega.js/desktop'` ([the shared rule](../shared/local-dev.md#using-what-the-framework-depends-on)).

## Hooks reference

| Hook file | When it runs | `ctx` shape |
|---|---|---|
| `hooks/build/pre.js`     | Before the build pipeline runs (`defaults` → `distribute` → `bundle` ...) | `{ build, projectRoot, mode }` |
| `hooks/build/post.js`    | After the build pipeline finishes, before `electron-builder` packages anything | `{ build, projectRoot, mode }` |
| `hooks/release/pre.js`   | Before `electron-builder build --publish always` | `{ build, projectRoot, mode }` |
| `hooks/release/post.js`  | After the release publishes | `{ build, projectRoot, mode }` |
| `hooks/deploy/pre.js`    | Inside `omega deploy`, after the local scaffold and before the network precheck, on both lanes (the dispatch and `--direct`); a dry run skips it, because a hook may act on the world ([#900](https://github.com/Omega-JS-Stack/omega/issues/900): the playground's prunes its release family down to the newest, so two releases stay live; the VERSION comes from `omega bump` at the brand root, [#869](https://github.com/Omega-JS-Stack/omega/issues/869), never from a hook) | `{ build, projectRoot, mode: 'production' }` |
| `hooks/notarize/post.js` | After @omega.js/desktop's built-in macOS notarization completes (extension only — @omega.js/desktop's notarize is the real entrypoint) | electron-builder afterSign context |

`mode` is `'production'` when `OMEGA_BUILD_MODE=true`, else `'development'`. A deploy hook always reads `'production'`: the verb runs outside a build, and what it is about to publish is a release.

## Why this design

- **Notarize specifically:** the consumer's `hooks/notarize/post.js` is **never** the electron-builder afterSign entrypoint. @omega.js/desktop's `gulp/build-config` injects `afterSign:` pointing at @omega.js/desktop's real notarize implementation (resolved via `require.resolve('@omega.js/desktop/hooks/notarize')`). @omega.js/desktop's real notarize calls into the consumer's `hooks/notarize/post.js` as a final post-step. So the consumer can never accidentally break notarization by editing the file — the file can be empty, malformed, or missing entirely and the app still notarizes correctly.
- **Why no `hooks/notarize/pre.js`?** electron-builder's `afterSign` hook is the only signing-related extension point we control. Anything that would belong in a "pre-notarize" step belongs either in `hooks/release/pre.js` (whole-release-level prep, runs before the gulp release task), or in electron-builder's own `afterPack` / `afterAllArtifactBuild` configuration (per-artifact mutation). If you have a real use case that doesn't fit either, file an issue.
- **Build/release hooks:** standard before/after lifecycle pattern, the same `ctx` @omega.js/extension hands its hooks.

## Examples

### Slack notification on release

```js
// hooks/release/post.js
export default async ({ build }) => {
  const pkg = build.getPackage('project');
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `🚀 ${pkg.name} v${pkg.version} released` }),
  });
};
```

### Generate changelog before build

```js
// hooks/build/pre.js
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export default async ({ projectRoot }) => {
  const log = execSync('git log --oneline -n 20', { cwd: projectRoot });
  fs.writeFileSync(path.join(projectRoot, 'CHANGELOG_LATEST.txt'), log);
};
```

### Custom post-notarize archive

```js
// hooks/notarize/post.js
import fs from 'node:fs';
import path from 'node:path';

export default async (context) => {
  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  // e.g. archive a copy somewhere off the build path
  fs.cpSync(appPath, `/tmp/omega-archive/${appName}-${Date.now()}.app`, { recursive: true });
};
```

## Tests

- `packages/devkit/test/run-consumer-hook.test.js`: the one hook runner, desktop's and extension's alike (a missing file skips, an ES module hook runs with its args, a `module.exports` hook is refused by name).
- `src/test/suites/build/deploy-hook.test.js`: `omega deploy` runs `hooks/deploy/pre.js` after the scaffold and before the precheck; a dry run skips it.
- `src/test/suites/build/build-config.test.js` — `injectAfterSign` always points at @omega.js/desktop's notarize.
