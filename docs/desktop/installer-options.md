# Installer & Distribution Options

Single source of truth for everything that controls how your app is packaged + delivered to end users. @omega.js/desktop owns the *target type* choices (NSIS on Windows, DMG+zip on Mac, deb+AppImage on Linux) and lets you configure the per-target UX through a small set of config knobs.

## Why @omega.js/desktop owns the target list

@omega.js/desktop picks specific installer types because they're the only ones that play well with the auto-update mechanism + cross-platform release pipeline:

| Platform | Target | Why |
|---|---|---|
| **macOS** | `dmg` + `zip` | DMG is the user-facing installer, zip is what `electron-updater` consumes for the auto-update feed. Universal binary (one .dmg works on Intel + Apple Silicon). |
| **Windows** | `nsis` | The only target that integrates with `electron-updater` for delta updates. Squirrel.Windows works too but installs to a weird per-user location with no Add/Remove Programs entry. MSI uses Windows Installer's own update mechanism (no electron-updater). |
| **Linux** | `deb` + `AppImage` + `snap` | `deb` for Ubuntu/Debian/Mint users, `AppImage` for distro-agnostic distribution, `snap` for the Snap Store. `snap` ships by default; `platforms.linux.formats.snap: false` turns it off. |

If you genuinely need a different target (Squirrel for "no installer UI" UX, MSI for enterprise, MAS for App Store), use the raw `electronBuilder` override block in `omega.json5` — that's an escape hatch into electron-builder's full config surface. We just don't expose those choices in the consumer-facing API to keep the default path safe.

## Cross-platform fields (`app.*`)

These apply identically on every OS — set them once.

| Field | Default | What it does |
|---|---|---|
| `app.category` | `'productivity'` | Generic app category. @omega.js/desktop maps to `mac.category` (Apple UTI) and `linux.category` (freedesktop). Allowed: `productivity`, `developer-tools`, `utilities`, `media`, `social`, `network`. |
| `app.copyright` | `'© {YEAR}, ITW Creative Works'` | Copyright string. `{YEAR}` token is expanded to the current year at build time, so the string stays current without consumers ever editing it. |
| `app.languages` | `['en']` | Locale list. Applied as `mac.electronLanguages` (which strips other locales' `.lproj` dirs from the .app bundle). win/linux currently ignore this. |
| `app.darkModeSupport` | `true` | macOS honors via `NSRequiresAquaSystemAppearance: false` in Info.plist. Win/linux ignore. |

### Category mapping table

| `app.category` | mac (`mac.category`) | linux (`linux.category`) |
|---|---|---|
| `productivity` (default) | `public.app-category.productivity` | `Utility` |
| `developer-tools` | `public.app-category.developer-tools` | `Development` |
| `utilities` | `public.app-category.utilities` | `Utility` |
| `media` | `public.app-category.entertainment` | `AudioVideo` |
| `social` | `public.app-category.social-networking` | `Network` |
| `network` | `public.app-category.business` | `Network` |

If you need a per-platform value not in the table, use the raw `electronBuilder.mac.category` / `electronBuilder.linux.category` override.

## Windows (`platforms.windows.*`)

| Field | Default | What it does |
|---|---|---|
| `platforms.windows.arch` | `['x64', 'ia32']` | Architectures. Single multi-arch NSIS installer ships both. |
| `platforms.windows.oneClick` | `true` | Slack-style: no installer wizard, just installs immediately to `%LocalAppData%\Programs\<App>`. Set to `false` for a standard "Next, Next, Finish" wizard. |
| `platforms.windows.desktopShortcut` | `true` | Create desktop shortcut. |
| `platforms.windows.startMenuShortcut` | `true` | Create Start menu entry. |
| `platforms.windows.runAfterFinish` | `true` | Auto-launch the app when the install completes. |
| `platforms.windows.perMachine` | `false` | Install for current user. Set `true` to install for all users (requires UAC elevation; **incompatible with `oneClick: true`**). |

### Why `oneClick: true` by default

Most Electron consumer apps default to `oneClick: true` (Slack, Discord) — it's a "nothing to think about" flow that gets users to your app fast. Trade-offs:
- ✅ No installer wizard, no choices for the user, fastest install
- ✅ Combined with `runAfterFinish: true`, the app just opens after install finishes
- ❌ Cannot install per-machine (incompatible with multi-user environments / enterprise)
- ❌ User can't pick install location (always per-user `%LocalAppData%`)

If your app needs enterprise deployment, set `oneClick: false` to opt into the wizard installer with `perMachine: true`.

### `ia32` (32-bit Windows)

@omega.js/desktop ships `ia32` alongside `x64` in a single multi-arch installer. Real-world 32-bit Windows usage is <3%, but the cost of including it is just ~2x installer size + ~2x signing time, no separate code path. Worth keeping for the long-tail user on an old Win 10 machine. To drop, set `platforms.windows.arch: ['x64']`.

## macOS (`platforms.mac.*`)

| Field | Default | What it does |
|---|---|---|
| `platforms.mac.arch` | `['universal']` | Architectures. `universal` produces one .dmg/.zip that runs on both Intel and Apple Silicon (electron-builder lipo's the two arch binaries together). Override to `['arm64']` or `['x64']` for single-arch builds. |
| `platforms.mac.mas.*` | (stubbed) | Mac App Store distribution config. **Not yet implemented** — see "MAS distribution" below. |

### Universal binary trade-off

`universal` produces ~2x file size (~225MB vs ~117MB) and ~2x build time on the Mac CI runner (builds both archs sequentially then stitches with `lipo`). Win: one .dmg link to give users — no "which one do I download?" flow.

### MAS distribution (stubbed)

Mac App Store config keys exist in @omega.js/desktop (`platforms.mac.mas.{enabled, provisioningProfile, entitlements, entitlementsInherit}`) but **are not yet wired up** — setting `enabled: true` triggers an audit warning and is otherwise ignored. The standard DMG+zip targets still build normally.

When MAS support lands, the work covered will be: separate `mas` target alongside DMG/zip, separate sandbox entitlements (4 plist files instead of 1), provisioning profile copy from `config/embedded.provisionprofile`, application-groups derivation, App Store Connect submission flow (manual via Transporter, not GH Releases).

Reference plists from a working MAS-published Electron app (Slapform) are archived at `<em>/src/defaults/_mas/` for the eventual implementation.

## Linux (`platforms.linux.*`)

| Field | Default | What it does |
|---|---|---|
| `platforms.linux.arch` | `['x64']` | Architectures. ia32 is essentially extinct on modern Linux. |
| `platforms.linux.formats.deb` | on | The Debian package. `false` drops it. |
| `platforms.linux.formats.appimage` | on | The AppImage. `false` drops it. |
| `platforms.linux.formats.snap` | on | Snap Store publishing. Presence is the switch ([#867](https://github.com/Omega-JS-Stack/omega/issues/867)): `false` drops it. On by default, it owes `SNAPCRAFT_STORE_CREDENTIALS`: a Linux package or release, and a publish, refuse without it. The snap is named `brand.id`. |
| `platforms.linux.formats.snap.confinement` | `'strict'` | `strict` (sandboxed) or `classic` (unrestricted, requires Snap Store approval). |
| `platforms.linux.formats.snap.grade` | `'stable'` | `stable` or `devel`. |
| `platforms.linux.formats.snap.autoStart` | `true` | Register the snap to auto-start on login. |
| `platforms.linux.formats.snap.channels` | `['stable']` | Snap Store channels to publish to. |

### Snap Store publishing

Behavior, since the snap became a declared FORMAT (#867):

- **Nothing declared** → the snap SHIPS, like every other format: presence is the switch and the default is on, so the brand owes `SNAPCRAFT_STORE_CREDENTIALS` and `omega manage` asks for it.
- **The name is `brand.id`** (`@omega.js/config`'s `snapName`). The build pins it as electron-builder's `linux.executableName` (electron-builder names the snap after the Linux executable), the `publishing` walk registers it on the Snap Store, and the site's `/download/linux/snap` link ends in it, so the three cannot disagree.
- **Shipped (written or defaulted) + no `SNAPCRAFT_STORE_CREDENTIALS`** → the tasks that make installers, `package` and `release`, FAIL first thing on Linux, naming `platforms.linux.formats.snap` and `SNAPCRAFT_STORE_CREDENTIALS`. A plain build, a dev run, `package-quick` (`--dir`, no snap) and a test boot make no installer, so they neither refuse nor warn. A mac or Windows package or release goes on: electron-builder builds the host platform only. `omega publish` REFUSES in its first step on every platform, naming the credential, `platforms.linux.formats.snap` (on by default until set to `false`) and `omega manage --service publishing`. Each store format is checked against its own keys (`formatKeysSet` in `@omega.js/config`).
- **A `brand.id` with `.` or `+`** cannot name a snap (lowercase letters, digits and single hyphens, with a letter, at most 40 characters), so a brand that ships the snap with one fails validation, naming the id and the snap. Change the id or set `platforms.linux.formats.snap: false`.
- **Shipped + `SNAPCRAFT_STORE_CREDENTIALS` set** → the snap target emits and publishes on release.
- **`platforms.linux.formats.snap: false`** → off, regardless of credentials: no snap target, no login check, no name registered. The explicit opt-out.

To turn snap publishing on for a project that ships the format:

1. Mint store credentials locally:
   ```bash
   snapcraft export-login -    # writes a credentials blob to stdout
   ```
2. Paste the entire blob (multi-line) into `.env` as `SNAPCRAFT_STORE_CREDENTIALS=...`, or let `npx omega manage --service publishing` ask for it. The same walk registers the name (`brand.id`) with `snapcraft`, which it expects on the machine: the step prints the install line when it is missing. No target needs `snapcraft` to run, so `omega dev` and `omega status` never ask for it.
3. Run `npx omega deploy` (its precheck flows the secret to GitHub Actions).
4. The next `npx omega release --target=<name>` at the brand root builds + uploads the snap automatically. No config flip needed.

Reference: the workflow's Linux step installs `snapcraft` (`sudo snap install snapcraft --classic`) whenever the brand ships the snap format, read through `@omega.js/config`'s own `enabledFormats` so the check cannot drift from the build's. It never checks the secret: a missing `SNAPCRAFT_STORE_CREDENTIALS` fails the build step by name.

## File associations + custom protocols (uncommon)

Available for the rare app that needs them — both pass through to electron-builder verbatim.

```jsonc
{
  fileAssociations: [
    { name: 'My Document', description: 'My App document', ext: 'mydoc', role: 'Editor' },
  ],
  protocols: [
    { name: 'CustomScheme', schemes: ['mycustom'] },
  ],
}
```

`protocols` is **additive** — @omega.js/desktop auto-registers `<brand.id>://` for every app (handled by `lib/protocol.js` at runtime). Use this to add EXTRA schemes (e.g., to handle `mailto:` if you're a custom email client).

99% of apps don't need either of these — leave both unset.

## Raw `electronBuilder` overrides (escape hatch)

For anything @omega.js/desktop doesn't expose, set the value directly on `config.electronBuilder.*` in `omega.json5`. @omega.js/desktop merges your overrides on top of its generated config:

**Gotcha: the merge REPLACES arrays wholesale** (objects deep-merge, arrays don't). A `target:` override must restate the FULL target list — `target: [{ target: 'mas' }]` alone would silently DROP dmg+zip and break auto-update.

```jsonc
{
  electronBuilder: {
    mac: {
      target: [
        { target: 'dmg', arch: ['universal'] },            // restate @omega.js/desktop's defaults…
        { target: 'zip', arch: ['universal'] },            // …(zip is the auto-update artifact)
        { target: 'mas', arch: ['universal'] },            // …then add MAS
      ],
    },
    win: {
      target: [
        { target: 'nsis', arch: ['x64', 'ia32'] },
        { target: 'msi',  arch: ['x64'] },                 // add MSI alongside NSIS
      ],
    },
  },
}
```

Use this for: legacy apps migrating from a custom builder config, enterprise deployments needing MSI, MAS apps until first-class support lands. Generally try the framework-native config first.
