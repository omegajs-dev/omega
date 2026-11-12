# Translation

AI translation for OMEGA consumers — one engine, config-driven, with a
**committed** per-string cache. Shipped cp96 (Ian directive 2026-07-11),
replacing both legacy systems: UJM's OpenAI-only gulp task with the
`cache-uj-translation` GitHub-branch cache, and BXM's Claude-only task with a
gitignored `.cache/` (which re-translated everything on any change and on
every fresh clone).

## Config (shared `translation` section of omega.json5)

```json5
translation: {
  enabled: true,          // optional master switch (default true)
  default: 'en',          // source language (default 'en')
  languages: ['es', 'fr'],// target codes — EMPTY/ABSENT = translation off
  providers: { claude: {} },// the engine is a KEY (#425): claude | chatgpt. Absent block = claude
  model: null,            // optional override for the chosen engine (claude → 'sonnet' alias, chatgpt → 'gpt-5.4-nano')
  include: ['**', '!blog/**'], // web only: globs over BRAND page routes, `!` negates; this is the framework default, a brand list replaces it (#858; the framework's own default pages are excluded on their own, #605)
}
```

Shared section (typically brand-level; `SHARED_SECTIONS` includes it, so
every target inherits it through the merge chain). Language codes
validate against the SSOT in `@omega.js/devkit/translate` (`LANGUAGE_NAMES`,
~32 codes) — an unknown code is a hard config error naming the supported set.
The same SSOT carries `LANGUAGE_LOCALES` + `ogLocale(code)`, the one code →
Open Graph `language_TERRITORY` map (`es` → `es_ES`).

## Providers

| Provider | Rides | Credentials |
|----------|-------|-------------|
| `claude` (default) | the locally-installed Claude Code via `@anthropic-ai/claude-agent-sdk` | **none** — local auth |
| `chatgpt` | OpenAI Responses API (native fetch) | `OPENAI_API_KEY` via the .env cascade |

The claude provider runs **hermetic** sessions: `settingSources: []` (no user
CLAUDE.md/hooks — they pollute mechanical output; a stop-hook reply actually
leaked into a canary before this was locked down), a custom translator system
prompt instead of the CLI persona, and NO `maxTurns` cap (a plain reply
already counts as the final turn — `maxTurns: 1` reports `error_max_turns`
even though the text arrived).

**Enabling translation on web means installing the SDK (#37).** `@omega.js/web`
does NOT ship `@anthropic-ai/claude-agent-sdk`: translation is opt-in and the
SDK is heavy, so a web brand that turns it on installs it in the target itself
(`npm install @anthropic-ai/claude-agent-sdk`); `@omega.js/extension` still
declares it. The SDK is lazy-required at the first claude call, so a brand
without translation never pays for it, and a brand that enabled translation
without the SDK gets a hard error naming the package and that install command,
never a silent skip. The `chatgpt` provider needs no SDK at all (native fetch
plus `OPENAI_API_KEY`).

**The manage cycle provisions it (#168).** Nobody types that install in a
managed brand: the manager's workspace service reconciles it like every other
brand file. A web app whose RESOLVED config translates with the `claude`
provider gets `@anthropic-ai/claude-agent-sdk` written into its package.json
`dependencies` (at the range `@omega.js/web` declares as its optional peer,
read from the installed web package), followed by one `npm install` at the
brand root. Converge-to-config, so: already declared (in `dependencies` or
`devDependencies`) = zero-mutation no-op that never overwrites a
consumer-chosen spec, `--dry-run` plans without writing, translation off or
provider `chatgpt` leaves the target untouched, and turning translation back OFF
never REMOVES the dep (uninstalling on a config flip is riskier than leaving
it). Only web targets are provisioned, since backend and extension declare the
SDK as a real dependency of the framework. The loud error above stays the backstop
for hand-managed brands (`packages/manager/src/services/workspace/ensure/translation-sdk.js`,
pinned by `packages/manager/test/workspace-translation-sdk.test.js`).

## Engine protocol (`@omega.js/devkit/translate`)

`translateStrings({ strings, language, languageName, brand, extraRules, send })`
→ positionally-aligned translations:

- **JSON array in → same-length JSON array out**, batches of 25.
- **Batches fly concurrently**, `CONCURRENCY` wide (the constant at the top of
  `packages/devkit/src/translate/engine.js`, currently 5 —
  [#604](https://github.com/Omega-JS-Stack/omega/issues/604)). A batch is one
  model call and the model's latency dominates it, so a serial pass paid that
  latency once per 25 strings and one language took minutes it never needed.
  Results are stitched back in BATCH order, never completion order, and
  everything below still happens per batch, unchanged. Raise it only as far as
  the providers' rate limits allow.
- **Duplicates are deduped before batching** ([#529](https://github.com/Omega-JS-Stack/omega/issues/529)):
  a page sends its title and description once per meta tag (`<title>`,
  `og:title`, `twitter:title`), so the same string used to ride a batch three
  times over — three times the AI spend, and adjacent twins are what a model
  merges. Each unique string is translated ONCE and the translation is fanned
  back to every occurrence. Occurrences key on the exact source string,
  whitespace included, so a batch is 25 UNIQUE strings.
- The `OMEGA-TRANSLATION-CONTROL` sentinel is appended to EVERY batch and must
  return unchanged at its exact position — alignment proof per batch.
- Validation failures (parse, length, sentinel) retry up to 2× then throw.
- An ALIGNMENT failure (length or sentinel) that survives the retries splits the
  batch in half and re-asks each half, down to one string
  ([#523](https://github.com/Omega-JS-Stack/omega/issues/523)): a model that
  merges a pair of strings does it every time, so retrying the same array can
  only fail the same way — the playground's ship-the-docs page came back
  25-for-26 on all six attempts, in both languages, and shipped untranslated.
  A single string that still will not come back whole throws, and the caller
  ships that page-language pair untranslated (never half-translated).
- Original leading/trailing whitespace is re-applied to every translation.
- Rules baked into the system prompt: preserve HTML/URLs/placeholders
  (`$1`, `{name}`, `{{ value }}`), never translate the brand name.

## The one cached call (`translateCached`)

Every pass translates through ONE function in `@omega.js/devkit/translate`
(`packages/devkit/src/translate/cached.js`): the website's page pass, and the
extension's messages and store description passes. No pass keeps a lookup loop
of its own.

`translateCached({ strings, language, namespace, settings, cachedOnly, rootDir })`
takes a key → source map and answers `{ translated, cold, fresh, usage }`:

- It reads `translations/{lang}/{namespace}.json` (below) and answers every warm
  string from it, with no provider call.
- **Cache-only** (`cachedOnly`): a cold string keeps its SOURCE text, `cold`
  names its key, nothing is saved, and no provider is called, so no AI key is
  needed and nothing can fail.
- Otherwise the cold strings go to the settings' provider in one
  `translateStrings` call, `fresh` names them, and the cache is saved, pruned to
  the current sources. A provider failure throws to the caller.
- `send`, `brand` and `extraRules` are optional and ride to the engine (`send`
  replaces the settings' provider, the seam the tests use).

**The one switch.** A build is cache-only when it runs on a CI runner (devkit's
`isCI`, `@omega.js/devkit/ci`) or when its caller passed `--cached-only`; the
rule is `isCachedOnly(flag, env)` beside `translateCached`, and both the web and
the extension build ask it. A local build without the flag translates cold
strings live and saves them for the commit; a runner reads the committed cache
only, and never needs a translation key. Cloud translation (a per-brand switch
that lets a runner translate) does not exist yet.

## The committed cache (`<app>/translations/`)

`translations/{lang}/{namespace}.json` maps `sha256(source)[:12]` → translated
string. Committed to git — that's the whole point:

- **Incremental**: editing one source string changes one hash → exactly one
  re-translation. Everything else is a cache hit (zero provider calls).
- **Survives clones/CI**: a warm cache builds a fully-translated site with NO
  AI credentials (kills the BXM parked finding where fresh clones burned live
  Claude calls). No AI key is delivered to CI by default
  ([#819](https://github.com/Omega-JS-Stack/omega/issues/819), Ian 2026-09-13):
  translation runs on the developer's machine and a runner reads the committed
  cache, which is why `OPENAI_API_KEY` is an `env` delivery on every target that
  names it and no workflow carries a line for it. A build on a runner is
  cache-only on its own ([the one switch](#the-one-cached-call-translatecached)).
- **Human-overridable**: hand-edit a translation VALUE in the cache file and
  it sticks for as long as the source is unchanged (the value is the
  translation; the key only changes when the SOURCE changes).
- Maps are pruned to the current source set on save — no stale entries.

`@omega.js/web` ships a second cache in exactly this shape for its OWN default
pages, inside the package ([below](#framework-shipped-default-page-translations-621)).

## Web (`@omega.js/web`)

`omega build` translates everything by default (Ian's #24 final call): warm
strings come from the committed cache instantly, cold strings translate live
through the provider — a build ships the COMPLETE translated site whenever
the provider delivers, and a warm cache means zero provider calls. A provider
FAILURE ships that page-language pair UNTRANSLATED, warning loudly with the page
and the language (the build still exits 0): no half-translated copy ever ships
behind full language chrome.
`omega build --cached-only`, and every `omega build` on a CI runner, ships cold
page-language pairs UNTRANSLATED instead (the warning lists them) for
provider-free builds; `omega translate` on the developer's machine fills them.
An untranslated pair still lands the SOURCE page at its translated path
(`dist/{lang}/...`, `{lang}.html` for the home) with its links rewritten into
the language, because every produced copy links there and a missing file is a
dead link that fails `omega test`'s link check and ships with `omega deploy`
([#953](https://github.com/Omega-JS-Stack/omega/issues/953)). It is never
ADVERTISED: its `<html lang dir>` and `og:locale` name the source language its
text is in, its canonical and `og:url` stay the source page's (it duplicates
that page), no hreflang alternate names it (on it or on the original), and the
sitemap does not list it.
`omega translate` still runs the live pass standalone against an existing
dist/ and exits 1 on failures. `OMEGA_TRANSLATE_ONLY=<route>` limits any of
these to one page (canary/debug).

Per page × language: text nodes/`<title>`/meta/attribute copy translate
(cache-first), then the copy lands at `dist/{lang}/...` with `<html lang dir>`
(RTL-aware), canonical + `og:url` + `og:locale` localized, internal links
rewritten to `/{lang}/...`, and hreflang + `og:locale:alternate` tags
stitched into BOTH the copy and the original — naming only the languages
actually PRODUCED for that page (a pair left untranslated, cold or failed, is never
advertised, on the copies as on the originals), so hreflang never lies.
A rerun over the same dist/ replaces the set rather than adding to it: every
alternate an earlier pass stitched (all but the build's own `x-default` and
source-language tags) is stripped first, on the copies as on the originals.
`og:locale` carries Open Graph's `language_TERRITORY` form (`en_US`,
`es_ES`) from the devkit language SSOT's locale map — on translated copies
and on the source pages the head include renders. Cache namespace:
`pages/{route}` (`pages/home` for `/`).

On a site served under a base path ([#355](https://github.com/Omega-JS-Stack/omega/issues/355)),
link rewriting composes **prefix, then language**: the pass reads the mount
point off the `<html data-omega-path-prefix>` stamp the build wrote (so
`omega translate` standalone sees it too), takes the route from underneath it,
and mounts the language segment after it — `/workkit/es/pricing`, never
`/es/workkit/pricing` ([#359](https://github.com/Omega-JS-Stack/omega/issues/359)).
Exclusions are matched on that same underneath-the-prefix route. ABSOLUTE URLs
(canonical, `og:url`, hreflang alternates, the sitemap entries) are built from
`brand.url`, which for a mounted site already carries the path — nothing
prefixes them twice.

Never sent to the PROVIDER, and the framework owns the list
([#605](https://github.com/Omega-JS-Stack/omega/issues/605)): every one of its
OWN default pages whose layout says it is plumbing rather than marketing copy —
the auth flows, the `/app` shell, the account/payment/portal screens, the legal
boilerplate, `404`, and the redirect stubs (`/login`, `/account`, `/cancel`, …).
Those pages still get their `/{lang}/` copies — from the translations PACKAGED
with `@omega.js/web`, at no cost to the brand (next section).
The list is DERIVED from the packaged defaults tree
(`packages/web/defaults/pages/**`, read by `src/translate/default-routes.js`),
never typed out, so a default page that moves or arrives cannot drift out of it,
and each excluded route guards its subtree too. On top of that: socials
redirects (config `socials` keys), the `admin`/`test`/`team`/`updates` folders,
every known language-code folder.

**Which of the BRAND's own pages are translated is `translation.include`**
([#858](https://github.com/Omega-JS-Stack/omega/issues/858), Ian 2026-09-13,
the same-name ruling): a list of route GLOBS read like a `.gitignore`, where
`!` negates and the LAST pattern that matches a route decides it. A route no
pattern matches is not translated, so an empty list translates nothing. A
folder pattern covers the folder itself as well as its contents, so
`!blog/**` takes `/blog` out along with every post under it. The framework
default lives in the DEFAULTS layer of the merge chain (the schema's own
`default:`, resolution-only so no brand file carries a copy of it):

```json5
translation: { include: ['**', '!blog/**'] }   // the default: the whole site except the blog
```

A brand list **REPLACES** it outright rather than adding to it (arrays replace
at every level of the merge chain), so a brand that writes `['docs/**']` gets
docs and nothing else. It is for the brand's own pages only: the framework's
derived exclusions above are not in its hands, and a brand that names `signin`
or `account` is naming something already skipped.

**A page overrides the list for itself**, under the same key name one level
down: `translation: { include: true }` in its frontmatter translates a page the
list left out, `false` takes one out that the list would have covered. The
build stamps that answer on `<html data-omega-translate>` (the seam #355's base
path already uses), because the pass runs post-build over `dist/` and
`omega translate` runs with no build in reach. `include` is the only key a page
may write under a bare `translation:`; anything else is a config section
restated bare and fails the build.

**`translation.exclude` is RETIRED** with it. There is no dual-read: a config
still carrying it fails validation naming its replacement, and
`omega migrate --execute` at the brand root CONVERTS the list (`exclude: ['docs']`
becomes `include: ['**', '!docs']`, which keeps translating exactly what the
brand was translating before) and deletes the old key in the same run.

Element opt-out: `data-omega-no-translate`, unchanged. Collector fixes vs UJM:
`aria-describedby`/`aria-labelledby` are NOT collected (ID refs), `value`
only on button-type inputs (hidden-input tokens stay intact).

### Framework-shipped default-page translations ([#621](https://github.com/Omega-JS-Stack/omega/issues/621))

The default pages above render the SAME chrome on every brand, so the framework
translates them ONCE and ships the result: `packages/web/translations/{lang}/pages/{route}.json`,
the identical `{lang}/{namespace}.json` shape as a consumer's own cache (same
loader, same `sha256(source)[:12]` keys, same prune-on-save, hand-fixable the
same way), committed to the package and published under `files`.

The keys are brand-NEUTRAL. The generator renders with a fixture brand and
replaces every occurrence of it with the sentinel `__OMEGA_BRAND__` before
hashing; the read-through replaces the CONSUMER's `brand.name` with the same
token before the lookup and puts it back on the way out, so "Sign in to MiniCo"
and "Sign in to Acme" are one packaged entry (`src/translate/packaged-defaults.js`).

Consumer side, on every pass — `omega build`, `--cached-only`, `omega translate`
alike, since it never touches a provider:

- Each default route gets its `dist/{lang}/…` copy with the same localized
  chrome, hreflang and sitemap entry as any other page. Link rewriting is the
  same pass too, which means links OUT to brand pages gain the language segment
  while links between two default routes (signin → signup) do not — those routes
  are excluded from rewriting, and that is unchanged from #605.
- A string the package does not carry (copy the brand overrode, a page the
  framework has not regenerated for) stays in the source language and is
  COUNTED — one log line per route names the miss count. Never guessed at.
- A brand whose NAME is a word the chrome itself uses ("Sign") still gets every
  string that does not interpolate the brand — the lookup falls back to the raw
  key when the sentinel-normalized one misses. The strings that DO interpolate
  it (`Sign in to Sign`) miss, and stay in the source language.
- A route the package carries nothing for gets NO copy, so hreflang keeps
  telling the truth. That is how the legal boilerplate stays one language:
  `terms`/`privacy`/`cookies` are deliberately not generated.
- A configured language the package does not ship is one log line for the whole
  run, not an error — those routes stay in the source language.
- A brand's `translation.include` list never touches the framework's default
  pages: it scopes the brand's OWN pages, and the framework's chrome is
  translated once, on the framework side.

**Shipped set: `es`, `fa`.** Regenerating, or extending the set, is one command
in `packages/web` (the ONLY place the framework's own pages ever reach a
provider):

```bash
npm run translate:defaults                      # the shipped set
npm run translate:defaults -- --languages es,fa,de   # …plus a new one
```

It renders the defaults tree through the real production build against a
throwaway consumer (no brand repo involved), harvests with the same collector
the pass uses, translates ONLY the strings the packaged cache is missing —
across all routes at once, so the header/footer chrome every default page
repeats is paid for exactly once — and writes the files back. Idempotent: a
re-run costs nothing, adding a language costs only that language. A provider
failure, or a translation that dropped the sentinel, STOPS the run and writes
nothing.

`dist/sitemap.xml` (emitted by the build in the source language only) is
rewritten afterwards so it tells the same story: every PRODUCED copy joins it
as its own `<url>`, and each entry of a translated set — source and copies
alike — carries the full `xhtml:link rel="alternate"` list (`x-default` at the
source language) plus the source entry's `lastmod`/`changefreq`/`priority`.
Entries stay in loc byte order. The language-prefixed entries are owned by that
pass: each run drops them all and re-emits only what it produced, so an
untranslated pair (cold or failed) is listed nowhere.

The visitor-facing **language switcher** is the footer dropup in the shared
base footer include (`_includes/frontend/sections/footer.html`, the base layer
every theme inherits). It renders CLIENT-SIDE from the page's own
`link[rel="alternate"][hreflang]` tags — the produced-only SSOT above — so the
menu can never offer a copy that was not written: `core/js/core/language-switcher.js`
drops `x-default`, labels each row with its native name (`Intl.DisplayNames` in
that language's own locale, upper-cased code as the fallback), marks
`documentElement.lang` as current, and leaves the mount empty and hidden when
fewer than two languages exist. Selecting a language is a plain link to that
alternate's href — never a redirect or a negotiation.

Not here yet: no default homepage exists in the D8 set, so brand sites
translate their own `index` when they add one.

## Extension (`@omega.js/extension`)

Build-mode gulp `translate` task (setup/dev builds only deploy). Both passes
go through `translateCached`, so `omega build` follows the same switch as the
website: live for cold strings on the developer's machine, cache-only on a CI
runner or with `omega build --cached-only`.

- **messages**: namespace `messages`, keyed by message key. Cold `message`
  values translate (CWS limits ride the prompt as extra rules; violations warn
  with the file path to shorten). `dist/_locales/{lang}/messages.json` is
  COMPOSED from the EN source + cache (English fallback per missing key, so
  the file is always complete; developer `description` fields stay English).
- **description**: namespace `description`, the whole `config/description.md`
  as one string, cached in `translations/{lang}/description.json` like any
  other string (source edit → re-translate). The package task ships the saved
  translation of the CURRENT source as a store asset
  (`packaged/assets/description/{lang}.md`); a cold language ships none.
- **Cold under cache-only**: each pass prints one warning per language naming
  the namespace and the cold keys, and the build exits 0. A cold message ships
  in the source language; a cold description ships no translated store asset.

Languages/provider come from resolved config — the old hardcoded 16-language
list in `gulp/config/locales.js` is gone (only the CWS `limits` remain there).

## Testing

- devkit `test/translate.test.js`: engine protocol, providers, cache, the
  cached call, language SSOT, settings reader (fake `send`).
- web `test/translate.test.js` — handcrafted dist through the real pipeline:
  copies/chrome/links/exclusions/alternates/cache/override/only-filter, the
  produced-languages-only alternates, and the untranslated-copy fallback
  (cold and failed pairs land unadvertised, no language link dangles).
- web `test/language-switcher.test.js` — the switcher's DOM read (x-default
  dropped, duplicates collapsed, current marked, escaping) and the built footer
  mount in classy and newsflash.
- extension `build/translate.test.js`: the translate task's compose,
  description and cache-only glue.
- Live canary (cp96, local Claude): omega-brand `/about` → es (102 strings,
  rerun 0 calls) and the extension's 4 messages (2 unique) + 2,703-char
  description → es, both idempotent; artifacts committed under each target's
  `translations/`.
