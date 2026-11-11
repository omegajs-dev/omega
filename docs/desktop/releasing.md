# Releasing — From `.env` to GitHub Release

End-to-end walkthrough for cutting a signed + notarized + published release of an OMEGA Desktop app.

## Repo layout (private app, ONE public releases repo)

@omega.js/desktop separates the app from its binaries:

| Repo | Visibility | Purpose |
|---|---|---|
| `<owner>/<app>` | usually **private** | the app source code |
| `<owner>/<brand.id>-releases` | **public** | release artifacts + auto-update feed (`latest-mac.yml` etc.) — AND the marketing site's direct-download links |

Why: auto-update feeds and marketing downloads MUST be publicly accessible (no auth headers in `electron-updater` or in an `<a href>`). Your app source can stay private; the public repo contains only binaries.

ONE public repo answers both ([#620](https://github.com/Omega-JS-Stack/omega/issues/620)), because the assets carry no version — see [Versionless assets](#versionless-assets-and-direct-download-links) below.

**Its address has ONE home** ([#799](https://github.com/Omega-JS-Stack/omega/issues/799)): `@omega.js/config`'s `releasesRepo`, which defaults the name to `<brand.id>-releases` and the owner to the brand repo's own owner. Every reader takes it from there: the electron-builder publish block the build bakes into `app-update.yml`, the deploy precheck's repo provisioning, `finalize-release`'s uploads, and the website's download buttons. Nothing reads a git remote, so a target inside a brand monorepo (and a brand nested in another repo) addresses its own repo rather than the enclosing one.

`npx omega deploy`'s precheck auto-creates the public repo if it doesn't exist (uses `GH_TOKEN`). Override the defaults in `config/omega.json5` only if you need to:

```jsonc
releases: {
  enabled: true,
  // owner: null,             // null = the brand repo's owner
  // repo:  'myapp-releases', // default: `<brand.id>-releases`
},
```

## Versionless assets and direct-download links

Every artifact name is **stable across releases** — no version in it:

| Platform | Format | Asset name |
|---|---|---|
| mac | `dmg` | `<Product>-mac-dmg.dmg` |
| mac | auto-update zip (not a declared format) | `<Product>-mac.zip` |
| windows | `nsis` | `<Product>-windows-nsis.exe` |
| linux | `deb` | `<Product>-linux-deb.deb` |
| linux | `appimage` | `<Product>-linux-appimage.AppImage` |
| linux | `snap` | none: the Snap Store holds the file under the snap name `brand.id`, so it is never a release asset. A Linux `package` or `release` refuses without `SNAPCRAFT_STORE_CREDENTIALS`; a plain build does not |

`<Product>` is `app.productName` (← `brand.name`) with non-filename characters hyphenated. The platform and format words are the ONE vocabulary ([#867](https://github.com/Omega-JS-Stack/omega/issues/867)) and the rule has ONE home, `@omega.js/config`'s `platforms.js`, which `gulp/build-config` writes into `dist/electron-builder.yml`'s artifactName templates and the website reads to build its buttons. Never spell an asset name anywhere else.

Because the names never change, GitHub's latest-release redirect is a permanent direct-download URL:

```
https://github.com/<owner>/<brand.id>-releases/releases/latest/download/<asset>
```

That is what `site.targets.desktop.downloads[platform][format]` derives (see [docs/shared/config.md](../shared/config.md#the-site-global-the-curated-targets-view-85-610) in the Omega repo), what the `/download` page's buttons link, and what every `/download/<platform>[/<format>]` shortlink redirects to. **Releasing a desktop version never touches the website**, and the published URLs never change.

Auto-update is unaffected: `electron-updater` reads the feed files (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`), which name whatever artifact the build produced.

Because the names carry no arch either, they support exactly the default build: a **universal** mac, a **single** linux arch, and windows' multi-arch NSIS installer (one file for every arch). Nothing appends an arch back — `gulp/build-config` REFUSES a `platforms.mac.arch` that is not universal, and a `platforms.linux.arch` with more than one arch, rather than let two builds overwrite one name. Per-arch names are a future additive change.

### Moving the releases repo

If the releases repo has to move (rename or transfer), the rules are:

- **The existing repo is the survivor** — transfer it, never build a fresh one. GitHub keeps redirects for the web pages, git remotes, the API and release-asset URLs, and `electron-updater` follows them, so every already-installed app (its feed URL is baked into `app-update.yml` at build time) keeps updating.
- **Never reuse the old org/name.** A new repo created at the old path takes the redirect over and silently steals every installed app's update feed and every published download link.
- The repo NAME is not configurable ([#883](https://github.com/Omega-JS-Stack/omega/issues/883)): it is always `<brand.id>-releases` under `repo.owner`, so a move means renaming the repo to match (or, if the brand itself is renaming, changing `brand.id` / `repo.owner` once). The website's URLs re-derive on its next build; the asset names do not change.
- **Fallback only** — if the surviving repo were a *different* repo, installed apps would need a bridge release: build once with the new feed baked in and publish it to the OLD repo, so clients update themselves onto the new feed before it is retired.

> The `downloads:` block (the `download-server` mirror at tag `installer`, `gulp/mirror-downloads`) predated this: it existed only to give marketing a fixed filename, which the versionless names made free. It is GONE ([#799](https://github.com/Omega-JS-Stack/omega/issues/799)): the task, the `publish` step, the finalize-release mirror and the second repo's provisioning are deleted, and `downloads.enabled|owner|repo|tag` are retired config keys a brand still carrying them fails validation on. One public repo, one set of assets.


## Prerequisites

1. **Apple Developer membership** ($99/year) with a Developer ID Application certificate exported as `.p12`.
2. **App Store Connect API key** (`AuthKey_*.p8`) — generate at App Store Connect → Users and Access → Keys.
3. **GitHub Personal Access Token** with `repo` scope (for publishing releases + pushing CI secrets).
4. **Apple Team ID** — visible on developer.apple.com membership page.
5. (Optional) **Windows EV USB code-signing token** if you target Windows.

See [`docs/desktop/signing.md`](signing.md) for full cert setup details.

## One-time setup (per app)

```bash
cd <your-app>
npm i @omega.js/desktop --save-dev
npx omega build
```

Every verb runs `ensureTarget()` first ([#675](https://github.com/Omega-JS-Stack/omega/issues/675)):
1. Ensures peer deps (`gulp`, `electron`, `electron-builder`) are installed.
2. Writes @omega.js/desktop's `projectScripts` into your `package.json` (`start`, `build`, `release`, `test`).
3. Copies framework defaults (config, builder yml, hooks, scaffold src/, build/) — merging `.env` and `.gitignore` so user customizations are preserved.

`npx omega deploy` adds the network half as a precheck (`--no-secrets` opts out):

- Validates signing prereqs (warns if missing — non-fatal).
- Pushes the composed `.env` → GitHub Actions secrets over the `gh` CLI (`gh auth login`; a CI run, an empty cascade, or no GitHub remote skips loudly, and a checkout whose `origin` is not the derived source repo refuses on the one drift line, `origin is <slug> but config derives <derived>: fix repo.owner in config/omega.json5 or move the repo`, [#934](https://github.com/Omega-JS-Stack/omega/issues/934)).

Now drop your cert files:

```bash
cp ~/Downloads/developer-id-application.p12 config/certs/
cp ~/Downloads/AuthKey_XXXXXXXXXX.p8        config/certs/
```

Edit `.env`:

```bash
GH_TOKEN="ghp_..."

CSC_LINK="config/certs/developer-id-application.p12"
CSC_KEY_PASSWORD="<password>"

APPLE_API_KEY="config/certs/AuthKey_XXXXXXXXXX.p8"
APPLE_API_KEY_ID="XXXXXXXXXX"
APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"
APPLE_TEAM_ID="XXXXXXXXXX"
```

Deploy to push the now-populated secrets to GitHub:

```bash
npx omega deploy
```

You should see ✓ for each secret in the output.

## Local release (manual, single-platform)

`npx omega release --target=<name>` builds nothing on this machine: it dispatches the CI workflow below and streams its run ([Multi-platform release via CI](#multi-platform-release-via-ci)). The LOCAL lane, for testing the full sign + notarize + publish flow on your own machine and for the host platform only, is the target's `release:local` script, `omega publish --local`, the same command CI's mac and linux legs run and the one `npx omega deploy --target=<name> --direct` runs:

```bash
npx omega publish --target=<name> --local   # at the brand root
npm run release:local                        # inside targets/<name>/
```

`--local` cleans first, then the ship-credential check and the STRICT `validate-certs` run, then a **single gulp invocation** (`gulp publish` with `OMEGA_BUILD_MODE=true OMEGA_IS_PUBLISH=true`):
1. **build** — defaults → distribute → bundle/sass/html → audit → build-config (materializes `dist/electron-builder.yml` with mode-dependent injections like `LSUIElement` for tray-only)
2. **release** — `electron-builder build --publish always`
   - Signs the `.app` with your Developer ID Application cert
   - Calls @omega.js/desktop's built-in `afterSign` hook which submits to Apple notarytool via the API key (consumer can extend via `hooks/notarize/post.js`)
   - Stapling + final `.dmg` / `.zip` packaging
   - Uploads to GitHub Releases (using `GH_TOKEN`)

The pipeline performs **one** sign+notarize cycle per architecture. (`npm run build` separately runs build + electron-builder package only — no publish, no GH upload — for local smoke-test artifacts.)

A successful release on macOS prints something like:

```
[notarize] Notarizing MyApp via App Store Connect API key (XXXXXXXXXX)...
[notarize] Done in 84s.
[release] Released 2 artifact(s):
  • release/MyApp-mac-dmg.dmg
  • release/MyApp-mac.zip
```

The release will appear on the GitHub repo's Releases page (as a draft if `releaseType: draft` is set in `electron-builder.yml`, or published if `release`).

A release that uploaded NOTHING fails the task ([#891](https://github.com/Omega-JS-Stack/omega/issues/891)). electron-builder resolves its build promise with the local artifact paths whether or not a byte was published, and it reports a skipped upload only as a warning on its own logger, so the task reads that logger for the length of the build. Any `skipped publishing` / `GitHub release not created` warning ends the run with electron-builder's own reason and tag instead of the `Released N artifact(s)` line:

```
[release] Nothing was uploaded: electron-builder skipped publishing 4 artifact(s) (...) to v0.0.1
  (existing release published more than 2 hours ago). Bump the version in package.json: a release
  that already exists is never re-uploaded.
```

## Multi-platform release via CI

CI handles the cross-platform matrix. The scaffolded workflow is `build.yml`, dispatched by `npx omega release` / `npx omega deploy`:

**Standalone the file is `.github/workflows/build.yml`; inside a brand monorepo it is the brand root's `.github/workflows/desktop-build.yml`** ([#265](https://github.com/Omega-JS-Stack/omega/issues/265), [#799](https://github.com/Omega-JS-Stack/omega/issues/799)): GitHub runs workflows from the repo root only, so `ensureTarget` composes the target's copy there and the dispatching verbs ask `@omega.js/devkit/ci-workflows`'s `composedWorkflowName` for the name, the same helper the web and extension deploy verbs use.

```
setup             resolves the `platforms` input ('all' by default) into a build matrix
                  plus per-platform flags
build             needs setup; matrix over the resolved OSes: npm ci, then
                  `npm run release:local` on mac and linux (sign, notarize, and
                  electron-builder publishes the DRAFT release in the brand's releases
                  repo), and `npm run package` on windows, whose unsigned output uploads
                  as the `windows-unsigned` artifact, a one-day intermediate that
                  windows-sign consumes in the same run (the releases repo is the
                  durable home)
windows-strategy  needs [setup, build]; reads platforms.windows.signing.strategy from config
                  (only when windows is in the matrix)
windows-sign      the self-hosted EV-token box, hosted windows-latest for the cloud
                  strategy, skipped for local: `omega sign-windows`, then
                  `omega finalize-release --signed-dir` attaches the signed installers
                  to that same draft
finalize          needs [setup, build, windows-sign] under always(), gated on the build
                  having succeeded: `omega finalize-release --publish` flips the draft to
                  published, and only on an all-platforms run (a partial run leaves the
                  draft standing for the next one to fill in)
```

The macOS step decodes `secrets.CSC_LINK` and `secrets.APPLE_API_KEY` (uploaded by `omega deploy`'s precheck as base64-encoded file contents) back to disk before running `npm run release:local`.

**Dispatch only, never a push trigger** ([#802](https://github.com/Omega-JS-Stack/omega/issues/802)): the workflow declares the one dispatch trigger (`workflow_dispatch`, [#880](https://github.com/Omega-JS-Stack/omega/issues/880), [#923](https://github.com/Omega-JS-Stack/omega/issues/923)) and nothing else, so no commit and no tag releases anything ([docs/shared/deploys.md](../shared/deploys.md) in the Omega repo is the contract for all four frameworks). It runs no tests either: the suites run on the developer's machine and the commit gate runs the battery at ship.

To release:
1. Bump the version in `package.json`.
2. `npx omega release` dispatches the workflow and streams the run's logs; `--platforms windows` (or `mac,linux`) narrows the matrix. `npx omega deploy` is the same dispatch behind the network prechecks.
3. Watch the streamed output, or the run at `https://github.com/<owner>/<repo>/actions`.

## Windows signing strategies

Set `platforms.windows.signing.strategy` in `config/omega.json5`:

| Strategy | What runs | When to use |
|---|---|---|
| `self-hosted` (default) | Self-hosted runner with EV USB token; `npx omega sign-windows` drives `signtool` | You own the EV token |
| `cloud` | Hosted `windows-latest`; `npx omega sign-windows` shells out to provider CLI (Azure / SSL.com / DigiCert) | Future cloud-signing migration |
| `local` | CI uploads unsigned; you sign manually on your Windows box | No runner, no cloud — fallback |

For details see [`docs/desktop/signing.md`](signing.md#windows-setup).

## Troubleshooting

### "No notarytool API key" error
- Confirm `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` are all set.
- The key file's filename should match the pattern `AuthKey_<KEY_ID>.p8` and `<KEY_ID>` should equal `APPLE_API_KEY_ID`.

### "Could not find Developer ID Application certificate"
- Run `security find-identity -v -p codesigning` on macOS.
- If absent, re-import your `.p12` to Keychain Access (must include the private key).

### Notarization hangs / times out
- Apple's notarytool can take 1–10 minutes. The hook waits.
- Check the App Store Connect notarization history at https://appstoreconnect.apple.com/apps for status / errors.

### "Hardened runtime requires entitlements"
- @omega.js/desktop generates `dist/config/entitlements.mac.plist` at build time from defaults + your `entitlements.mac` overrides in `config/omega.json5`.
- For extra capabilities (camera, mic, etc.), add keys to `entitlements.mac`. See `docs/desktop/signing.md` for the override syntax.

### CI: GitHub Releases upload fails
- Verify `GH_TOKEN` secret is set. The auto-injected `GITHUB_TOKEN` won't work for cross-repo writes.
- Confirm the config addresses the right repo: `repo.owner` + `brand.id` derive both the source repo (`<brand.id>-omega`) and the artifacts' repo (`<brand.id>-releases`), and `targets.desktop.releases` is the presence switch alone.

## Related docs

- [`docs/desktop/signing.md`](signing.md) — cert file inventory, env vars, Windows strategy details
- [`docs/desktop/build-system.md`](build-system.md) — gulp tasks, the three esbuild bundles, electron-builder integration
- [`docs/desktop/startup.md`](startup.md) — `tray-only` mode injects `LSUIElement` into Info.plist at build-config time
