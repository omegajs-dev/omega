# Build Hooks

Two lifecycle hooks let consumers run custom logic during the build pipeline.

## Hook files

| Hook | Source | When |
|---|---|---|
| `build:pre` | `hooks/build/pre.js` (in consumer project) | Before packaging — after `dist/` is built but before `packaged/` is assembled |
| `build:post` | `hooks/build/post.js` | After packaging — `packaged/<browser>/raw/` and `.zip` exist |

Hooks are optional: `gulp/tasks/package.js` runs each through devkit's one hook runner (`runConsumerHook`, shared with @omega.js/desktop), which checks for the file's presence and runs it if present.

The NESTED path above is the one path the runner reads: it is what `src/defaults/hooks/build/` scaffolds and what the brand root's `omega migrate --execute` moves a flat `hooks/build:pre.js` to.

## Hook shape

- A hook file is an ES module with one default export. A `module.exports` hook is refused, and the build throws `<file> must be an ES module with one default export (export default async (...) => {})`.
- The body uses `import`: a top-level `import`, `await import()` for a lazy load, and `import.meta.dirname` for the file's folder.
- No top-level `await`: the file is loaded by `require()`, which refuses an async module. An `await` goes inside the default export.

```js
// hooks/build/pre.js
export default async function ({ build, projectRoot, mode }) {
  console.log('Pre-build hook running for', build.getConfig().brand.name);

  // Mutate files, generate assets, validate, anything you want.
  // Return a Promise (or use async fn) to make the build wait.
};
```

## The `ctx` argument

Hooks take the ONE hook-argument shape every OMEGA framework passes, `{ build, projectRoot, mode }`, the same `ctx` @omega.js/desktop hands its lifecycle hooks:

- `ctx.build`: the build module (`require('@omega.js/extension/build')`, one plain object of functions)
- `ctx.projectRoot`: the consumer project root, absolute
- `ctx.mode`: `'production'` when `OMEGA_BUILD_MODE=true`, else `'development'`. The deploy hook (`hooks/deploy/pre.js`, run by `omega deploy`) always reads `'production'`: the verb runs outside a build, and what it is about to publish is a release

Everything else a build hook needs comes off `ctx.build`:

| What you want | Where it is |
|---|---|
| Parsed `package.json` | `build.getPackage('project')` |
| Parsed `src/manifest.json` (JSON5) | `build.getManifest()` |
| Resolved `config/omega.json5` (targets.extension overlaid onto the top level) | `build.getConfig()` |
| The brand block | `build.getConfig().brand` |
| The project / framework roots | `build.getRootPath('project')` / `build.getRootPath('main')` |

## Common uses

### Sync a CHANGELOG version into the manifest

```js
// hooks/build/pre.js
import fs from 'node:fs';
import path from 'node:path';

export default async function ({ build, projectRoot }) {
  const manifest = build.getManifest();
  const changelog = fs.readFileSync(path.join(projectRoot, 'CHANGELOG.md'), 'utf8');
  const latestVersion = changelog.match(/## \[([\d.]+)\]/)?.[1];
  if (latestVersion && latestVersion !== manifest.version) {
    console.warn(`Manifest version (${manifest.version}) doesn't match CHANGELOG latest (${latestVersion})`);
  }
};
```

### Inject a build timestamp

```js
// hooks/build/pre.js
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export default async function ({ projectRoot }) {
  const buildInfo = {
    builtAt: new Date().toISOString(),
    gitSha: execSync('git rev-parse HEAD').toString().trim(),
  };
  fs.writeFileSync(path.join(projectRoot, 'dist', 'build-info.json'), JSON.stringify(buildInfo, null, 2));
};
```

### Trigger a post-publish webhook

```js
// hooks/build/post.js
export default async function ({ build }) {
  if (process.env.OMEGA_IS_PUBLISH !== 'true') return;   // only after real publish
  await fetch('https://api.myservice.com/extension-released', {
    method: 'POST',
    body: JSON.stringify({ version: build.getManifest().version }),
  });
};
```

## Async by default

Hooks are awaited — the build waits for them to resolve before continuing. Throw or reject to fail the build (and abort packaging / publishing).

A hook runs under plain node, outside the bundle, so an `import` (or `import()`) of a framework dependency the target never declared resolves only by hoisting: every verb's scaffold warns on it (the dependency nudge, never an error), and the two fixes are declaring it or loading the framework's copy with `extension.require(name)` after `import extension from '@omega.js/extension'` ([the shared rule](../shared/local-dev.md#using-what-the-framework-depends-on)).

## Where hooks are invoked

[src/gulp/tasks/package.js](../../packages/extension/src/gulp/tasks/package.js) runs the build hooks and [src/commands/deploy.js](../../packages/extension/src/commands/deploy.js) the deploy hook, each through `runConsumerHook` from `@omega.js/devkit/run-consumer-hook`. Search for `runConsumerHook(` in those files to see the exact wiring.

## Why not just edit gulp tasks?

You COULD fork @omega.js/extension's gulp tasks for any custom build behavior. Hooks exist so consumers don't need to. Hooks are stable contract (the `ctx` shape is the same one every OMEGA framework passes), survive @omega.js/extension upgrades, and live in the consumer's repo (where build-specific concerns belong).

## See also

- [build-system.md](build-system.md) — gulp pipeline details
- [publishing.md](publishing.md) — store auto-publishing happens AFTER `build:post`
