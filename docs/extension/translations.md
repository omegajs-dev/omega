# Translations

`npm run build` automatically translates `config/messages.json` (and `config/description.md`) to the languages set in `translation.languages` (omega.json5). Only missing translations are generated — existing translations live in the committed `translations/` cache and are preserved.

## Languages produced

Exactly the codes listed in `translation.languages` — there is no fixed set. Unset means translation is OFF (the build logs one skip line). The shared contract, including the supported-code list, is docs/shared/translation.md in the Omega repo.

(Output written to `dist/_locales/<lang>/messages.json`, then packaged to `packaged/<browser>/raw/_locales/`.)

## How it works

[src/gulp/tasks/translate.js](../../packages/extension/src/gulp/tasks/translate.js):

1. Reads `config/messages.json` (source of truth: author all your strings here).
2. For each configured language, loads the committed cache at `translations/<lang>/messages.json` (source-string hash → translated message).
3. Sends ONLY the uncached strings to the translation provider (per-key incremental).
4. Saves the results back into the cache, then composes `dist/_locales/<lang>/messages.json` from source + cache: a miss falls back to English so the file is always complete.

`config/description.md` translates the same way, whole-document, cached in `translations/<lang>/description.json`: editing the source retranslates it.

Both passes are the shared `translateCached` call in `@omega.js/devkit/translate` (docs/shared/translation.md in the Omega repo).

## Cache-only builds (CI and `--cached-only`)

On a CI runner, or with `omega build --cached-only`, the build reads the committed cache only and never calls a provider, so no AI key is needed. A string with no saved translation ships in English, and the build prints one warning per language naming the namespace (`messages` or `description`) and the cold keys, then exits 0. A cold description ships no translated store listing for that language. Translate on your own machine with a plain `omega build`, then commit `translations/`.

Existing translations are NEVER overwritten — once a string is translated, it stays until the source string changes. Edit the cache file directly if you want to change a translation.

## What gets translated

Keys with a `message` field:

```jsonc
{
  appName: {
    message: 'Tabblar — Workspace & Tab Manager',
    description: 'The name of the extension.'
  },
  appDescription: {
    message: 'Powerful tab and workspace manager...',
    description: 'The description of the extension.'
  }
}
```

Only the `message` values are sent for translation; the `description` field stays English (it documents the key for maintainers and the store review).

## What the scaffold seeds

`config/messages.json` is scaffolded once (never overwritten) with the brand already rendered in: `appName`, `appNameShort` and `btnTooltip` from `brand.name`, and `appDescription` from `brand.description` when it fits the 200-character Chrome Web Store cap — a longer or absent description falls back to "The official &lt;brand&gt; browser extension." ([#573](https://github.com/Omega-JS-Stack/omega/issues/573)). Edit any of them afterward; setup will not touch them again.

## Manifest `__MSG_*__` placeholders

`src/manifest.json` references locale keys via `__MSG_<key>__`:

```jsonc
{
  name: '__MSG_appName__',
  description: '__MSG_appDescription__',
}
```

Chrome resolves these at install time using the user's browser locale, falling back to `default_locale` (set in the manifest).

The [test-framework.md](test-framework.md) ships a `locales.test.js` pattern that verifies every `__MSG_*__` placeholder in your manifest has a definition in `messages.json` — catches drift between manifest and i18n catalog before users see broken store listings.

## Disabling translations

Leave `translation.languages` unset (or empty) in omega.json5 — translation is opt-in and off by default.

## Cost / API key

The default provider is `claude`: it rides the locally-installed Claude Code via `@anthropic-ai/claude-agent-sdk` (declared by this framework), billed to your Claude subscription — no API key. `translation.providers: { chatgpt: {} }` uses the OpenAI API instead (needs `OPENAI_API_KEY`). Either way the cost is one-time per language per changed string — typically pennies.

## See also

- [build-system.md](build-system.md) — gulp pipeline including translate task
- [publishing.md](publishing.md) — auto-publishing to Chrome / Firefox / Edge stores
