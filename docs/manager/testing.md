# The testing service — health checks after the walk

The `testing` service runs LAST: per-target health checks after every other service has had
its pass. Local checks read the repo; live checks fetch the deployed brand. A dry run never
touches the network — every live check prints a "would" line instead.

## What it checks

| Target | Checks |
|---|---|
| `web` | `package.json`, `dist/index.html`, the installed framework version vs npm latest, and a homepage fetch. Once the homepage is live, a brand with a brandmark (`assets/logo/brandmark.svg`, which the web build derives these from) also gets `/favicon.ico` and `/assets/images/brand/brandmark.png` fetched; a miss fails naming the URL. |
| `backend` | `package.json`, `firebase.json`, the staged `dist/` build output, the installed framework version vs npm latest, and API health + the deployed version (skipped for a shared Firebase project). |
| every target | `package.json`, and the framework version when declared. |
| repo-level (once) | A clean working tree, and the latest GitHub Actions run (only with a `repo` block naming `repo.owner`). |

Results roll up honestly: any failed check makes the service an error, any warning makes it
warned. The output shape matches omega-manager's testing service, so the run summary's
drill-down works unchanged.

## Config

No config of its own; it reads the brand's targets, `repo.owner`, and
`cloud.shared`. Injection seams for the network-free tests ride `options` (`fetch`, `exec`,
`retryDelayMs`).

## Gotchas

- **A custom-mode backend has no `firebase.json`** to demand
  ([#584](https://github.com/Omega-JS-Stack/omega/issues/584)): that is the one Firebase-only
  check, noted with its reason instead of failed. The staged `dist/` check still runs — a
  custom backend builds like any other.
- **Not ported from omega-manager**: the `build.json` check (a UJM artifact — `@omega.js/web`
  has no build manifest) and the stash check (nothing stashes in the new update service).
  GitHub Actions is repo-level here, because a brand is one repo.
