# Publishing

`OMEGA_IS_PUBLISH=true npm run build` packages AND uploads to extension stores in one step.

## Supported stores

- **Chrome Web Store** (Chrome / Edge / Brave / Opera users)
- **Firefox Add-ons** (AMO)
- **Microsoft Edge Add-ons** (separate from Chrome Web Store — Edge Insiders + corporate environments)

Which stores a publish talks to is the brand's DECLARATION, `targets.<name>.platforms.<chrome|firefox|edge>.formats.store` ([#867](https://github.com/Omega-JS-Stack/omega/issues/867)): presence is the switch and every store defaults on, so a brand drops one with `false`. A DECLARED store with a missing credential is not skipped: the publish refuses, naming the key, the declaration that requires it, and the walk that collects it (`omega manage --service publishing`). A declared store whose LISTING does not exist yet is neither: its zip is on the GitHub release and one manual step prints.

## Setup: two files, one rule ([#893](https://github.com/Omega-JS-Stack/omega/issues/893))

Each store knows this extension by an ID, and that id is PUBLIC (it is the id in
the listing URL every user sees). Public values live in config; credentials live
in `.env`.

`config/omega.json5`, beside that store's own listing url:

```json5
targets: {
  extension: {
    type: 'extension',
    listings: {
      chrome:  { id: '...', url: 'https://chromewebstore.google.com/detail/...' },
      firefox: { id: 'extension@yourbrand.com', url: 'https://addons.mozilla.org/...' },
      edge:    { id: '...', url: 'https://microsoftedge.microsoft.com/addons/...' },
    },
  },
},
```

The store API credentials go in your project's `.env` (gitignored):

```bash
# Chrome Web Store
CHROME_CLIENT_ID="..."
CHROME_CLIENT_SECRET="..."
CHROME_REFRESH_TOKEN="..."

# Firefox Add-ons
FIREFOX_API_KEY="..."
FIREFOX_API_SECRET="..."

# Microsoft Edge Add-ons
EDGE_CLIENT_ID="..."
EDGE_API_KEY="..."
```

`CHROME_EXTENSION_ID`, `FIREFOX_EXTENSION_ID` and `EDGE_PRODUCT_ID` are RETIRED
env keys: nothing reads them, and the brand-root `npx omega migrate` names each one
still in a `.env` with its config home.

## Getting credentials

### Chrome Web Store

1. Create an OAuth client via [Google Cloud Console](https://console.cloud.google.com/) (Web application type)
2. Enable the [Chrome Web Store API](https://developer.chrome.com/docs/webstore/using_webstore_api/)
3. Generate a refresh token via the OAuth flow (one-time)
4. `listings.chrome.id` is in your Chrome Web Store Developer Dashboard URL: `chrome.google.com/webstore/devconsole/<id>`. With credentials set and no id declared, the publish refuses naming the config path

### Firefox Add-ons

1. Sign in to [Add-on Developer Hub](https://addons.mozilla.org/developers/)
2. Generate JWT credentials at "Manage API Keys"
3. `listings.firefox.id` IS the manifest's `browser_specific_settings.gecko.id` (AMO uses it as the add-on guid): config is its one home, the package task writes it into the manifest, and a manifest declaring a different one fails the build naming both

> **Declare `listings.firefox.id` before your FIRST publish.** Packaging no longer waits for it: with none declared, the firefox pass DERIVES `extension@<brand.url host>` (or `extension@<brand.id>.extension` when the brand has no url) and builds, failing only when there are no brand facts at all to derive from, so a fresh scaffold produces an artifact out of the box. Declare your own anyway before you submit: the id must stay stable across every release, an id assigned at submission time can never be changed from a self-hosted build, and `brand.url` can change under a derived one ([#574](https://github.com/Omega-JS-Stack/omega/issues/574)). A first publish WRITES the id it created the listing under back into your config, so a derived id stops being derived the moment it becomes real ([#893](https://github.com/Omega-JS-Stack/omega/issues/893)). The same pass translates the chrome-only panel keys (`side_panel` → `sidebar_action`) and drops every Chrome-only permission (`sidePanel`, `offscreen`), so the firefox artifact is a real firefox artifact ([#264](https://github.com/Omega-JS-Stack/omega/issues/264)).

#### The FIRST Firefox publish carries the listing metadata ([#884](https://github.com/Omega-JS-Stack/omega/issues/884))

addons.mozilla.org builds the listing from the FIRST version it receives and reuses it on every update, so a publish with `listings.firefox.id` set needs credentials and nothing else. Creating the listing is the one moment AMO demands three more fields, and without them the submission comes back after a green build:

```
WebExtError: Submission failed (2): Bad Request
  "version": { "license": [ "This field, or custom_license, is required for listed versions." ] }
```

So a publish with no `listings.firefox.id` writes `.temp/amo-metadata.json` and signs with `--amo-metadata <path>`:

| Field | Where it comes from |
|---|---|
| `summary['en-US']` | `brand.description`, cut to AMO's 250-character cap with a warning naming the key. Translated summaries follow the same `translations/` the store description already uses |
| `categories` | `targets.extension.categories` in `config/omega.json5`: a list of AMO's own slugs, default `['alerts-updates']` (the most generic one that is not `other`, since AMO has no utilities or productivity slug). A slug AMO does not know fails the build listing the live set, never at the store |
| `version.license` | The target `package.json` `license` field. Absent or npm's `UNLICENSED` lists as AMO's `all-rights-reserved` (what every OMEGA scaffold writes, closed-source commercial); one of `MPL-2.0`, `Apache-2.0`, `MIT`, `ISC`, `BSD-2-Clause`, `GPL-2.0-only`, `GPL-3.0-only`, `LGPL-2.1-only`, `LGPL-3.0-only`, `AGPL-3.0-only`, `Unlicense` passes through; anything else (a compound expression, a deprecated id like `GPL-3.0`) fails loudly with that list |

Chrome and Edge pick their category and license in their own dashboards, so neither lane sends any of this.

### Microsoft Edge Add-ons

1. Sign up for the [Microsoft Edge Add-ons Partner Center](https://partner.microsoft.com/dashboard/microsoftedge)
2. Generate API credentials in the "API publishing" section
3. `listings.edge.id` is the GUID assigned to your extension by Microsoft

## Publish flow

```bash
OMEGA_IS_PUBLISH=true npm run build
```

What happens:

1. `npm run build` runs the full gulp pipeline (build → package → packaged/<browser>/raw + zip)
2. `gulp/tasks/package.js` detects `OMEGA_IS_PUBLISH=true`
3. For each browser, reads the store credentials from `.env` and the listing id from config
4. Uploads the `.zip` via each declared store's API. A missing developer key refuses before anything uploads; a missing listing id prints the manual step (create the listing, upload the zip that is already on the release, set the config path, re-run) and the rest of the run continues
5. Logs success / failure per store, each failed store with its reason (a version the store already holds says to bump `version` in package.json and deploy again); exits non-zero if any upload fails

## Manual upload

Run `npm run build` without `OMEGA_IS_PUBLISH=true` — you get unsigned `.zip` files per browser under `packaged/`:

```
packaged/
├── chrome/<ExtensionName>.zip
└── firefox/<ExtensionName>.zip
```

Upload these manually via each store's web dashboard.

## CI / GitHub Actions

For automated releases, store credentials as encrypted GitHub Actions secrets. A typical workflow:

```yaml
- name: Build + publish
  env:
    OMEGA_IS_PUBLISH:        true
    CHROME_CLIENT_ID:      ${{ secrets.CHROME_CLIENT_ID }}
    CHROME_CLIENT_SECRET:  ${{ secrets.CHROME_CLIENT_SECRET }}
    CHROME_REFRESH_TOKEN:  ${{ secrets.CHROME_REFRESH_TOKEN }}
    # ...same for FIREFOX_*, EDGE_*
    GOOGLE_ANALYTICS_SECRET: ${{ secrets.GOOGLE_ANALYTICS_SECRET }}
  run: npm run build
```

No listing id appears there: it is config, and the config rides the checkout.
The block is GENERATED from the env schema anyway, so a brand never types it.

**The zips also land on a GitHub release** ([#883](https://github.com/Omega-JS-Stack/omega/issues/883)): after the store uploads, the publish task attaches `extension-<browser>.zip` to the tag `<target name>-v<version>` (`extension-v<version>` for the default target) in the brand's ONE public releases repo, `<brand.id>-releases` under `repo.owner`: the same channel desktop distributes installers through, and where the site's download links point. Nothing names that repo: it derives from the config, and the transport is the `gh` CLI, so the credential is `GH_TOKEN` (the brand's cross-repo token, never the run-scoped `secrets.GITHUB_TOKEN`, which cannot reach another repo).

**The store credentials are not the only secret CI needs.** A dispatched run has no `.env`, so `GOOGLE_ANALYTICS_SECRET` — the Measurement Protocol secret the build BAKES into `OMEGA_BUILD_JSON` — only reaches the build through the workflow env. Without it, a CI-published extension shipped an empty secret and sent no analytics events, silently ([#582](https://github.com/Omega-JS-Stack/omega/issues/582)). The scaffolded `publish.yml` injects it, and a build-mode build of a brand that HAS `analytics.providers.google.id` fails loudly when the secret is empty rather than publishing a dead sender.

Same pattern EM uses for its desktop apps. Each store does its own review afterward (Chrome / Firefox: hours to a few days; Edge: typically same day).

## What about Safari?

Safari (Apple) uses a different extension model and requires Xcode-based packaging via `safari-web-extension-converter`. Not currently in scope for @omega.js/extension's auto-publish. Manual conversion + App Store Connect upload is the route.

## Store listing description (`config/description.md`)

`config/description.md` is the Chrome Web Store listing description. When writing or rewriting it, first read `config/omega.json5` (brand), `config/messages.json` (extension name + short description), `src/manifest.json` (permissions/features), and the component JS under `src/assets/js/components/` to understand what the extension actually does — be specific about real features, not generic copy.

The package task renders `{{ brand.* }}` tokens against `config/omega.json5` before writing `packaged/assets/description/<lang>.md` — the English source and every translated variant — so the store listing carries the resolved brand, never a literal token.

**Format:**

```
[emoji] [Key Feature Headline 1]
[emoji] [Key Feature Headline 2]
[emoji] [Key Feature Headline 3]
[emoji] [Key Feature Headline 4]
[emoji] [Key Feature Headline 5]

[Extension Name] is [compelling one-sentence pitch]. [Pain point 1]. [Pain point 2]. [Pain point 3].
If you [target audience description] — [Extension Name] was made for you.

[emoji] How it works
[Extension Name] [brief mechanism description].

[emoji] [Feature 1]: [One-line description]
[emoji] [Feature 2]: [One-line description]
[emoji] [Feature 3]: [One-line description]
[emoji] [Feature 4]: [One-line description]

[Brief usage instructions — 2-3 sentences].
No complicated setup. No learning curve. Just [core value proposition].

[emoji] Why [Extension Name] is a game changer

[Benefit 1 title]: [Description].
[Benefit 2 title]: [Description].
[Benefit 3 title]: [Description].
[Benefit 4 title]: [Description].
[Benefit 5 title]: [Description].

[emoji] The [Extension Name] Difference
Most people either:

[Alternative 1 that's worse]
[Alternative 2 that's worse]

[Extension Name] gives you a [better option description].
[Catchy metaphor with emoji]
[Closing sentence about who benefits].

[emoji] Install [Extension Name] now and [call to action].
[Short imperative sentence].

:money_with_wings: Bonus:
While you're browsing, the extension also finds and applies shopping deals from top partners like Amazon, Capital One, and NordVPN. Get discounts and bonuses without lifting a finger. When you buy through links on our extension, we may earn an affiliate commission.

:locked_with_key: Your privacy is respected — we do not sell or misuse your data. By using our extension, you agree to our terms of service and privacy policy.
When you buy through links on our extension, we may earn an affiliate commission.
```

**Rules:**

- **Keep the Bonus section and Privacy section EXACTLY as shown** — do not modify these
- Name the extension with `{{ brand.name }}` (or its literal name from `config/messages.json`) — the token resolves at package time
- Be specific about features — reference what the code actually does
- Tone: enthusiastic, conversational, persuasive; emojis for section headers and feature bullets
- Feature headlines short and punchy (under 50 characters)
- 300-500 words (excluding the Bonus and Privacy sections)

**After rewriting**, have the user run `npm run build` on their own machine and commit `translations/`: the edited source misses the committed cache, so every language retranslates it, and the saved entries for the old text are pruned (see [translations.md](translations.md)).

## See also

- [build-system.md](build-system.md) — packaging pipeline that produces the per-browser zips
- [hooks.md](hooks.md) — `build:pre` and `build:post` hooks run before/after publish
- [cli.md](cli.md) — env var conventions
