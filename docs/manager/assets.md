# The assets service — the brand's derived visual collateral

The `assets` service generates everything derived from the brand's logo sources: the wordmark
and combomark, colour and black SVG variants with PNG size ladders, the PSD templates and
their exports, the macOS/Windows app icons and the social profile icons.
It runs on the BOOT lane too — `omega dev` and a brand-root `omega deploy` both redistribute
it — because it is local file work the target legs consume.

**Sources** are committed brand collateral in the brand repo: `assets/logo/*.svg` and
`assets/templates/*.psd`. **Derived files** land in the gitignored `.omega/assets/`.

**What a deployed site gets.** Nothing from `.omega/assets/`. A web build takes its brand
image through the one lookup order of [`@omega.js/devkit/brand-image`](../devkit/index.md):
the target's own file, then the brand's `assets/logo/brandmark.svg`, then the framework
default. It derives the favicon set, the brandmark png and the social image it lacks into the
brand's cache and its build output, never into the target's source
([docs/web/index.md](../web/index.md), the static channel), so this service need not run
before a deploy and nothing it makes rides the snapshot. The `social-icons` operation and the
web build share one social-square recipe (`makeSocialSquare`).

## What it reconciles

| Operation | What it does |
|---|---|
| `logo-gen` | Wordmark + combomark SVGs from the brandmark and `brand.font`, text rendered as PATH OUTLINES so the SVGs are self-contained. Missing-only: an existing (possibly hand-tuned) file is never overwritten. The service renders the path data itself, since opentype.js rounds a coordinate sitting within float noise of an integer to NaN and truncates the glyph there ([#916](https://github.com/Omega-JS-Stack/omega/issues/916)), and a path that still carries NaN or Infinity fails the run naming the font file and the text rather than writing a sliver. |
| `process` | Per logo source: the colour SVG as-is plus an all-black conversion, exported as SVG + PNGs at every ladder size. |
| `templates` | Seeds the brand's PSDs from the company tree's `assets/templates/` when missing (a brand of a company, [#677](https://github.com/Omega-JS-Stack/omega/issues/677)), replaces the logo and text layers, writes the PSD back, composites and exports the PNGs. |
| `icons` | macOS `.icns` and Windows `.ico`, from the composited `icon.png` the templates op produced when there is one, else the brandmark. |
| `social-icons` | The square brandmark centred on white with padding, for profile pictures, through the shared `makeSocialSquare`. |
| `reconcile` | Deletes the files inside the operations' own output dirs that the brand's current sources no longer derive ([#636](https://github.com/Omega-JS-Stack/omega/issues/636)) — dropping `assets/logo/wordmark.svg` takes its variants and ladders with it. Runs last, so everything this walk generated is already derived; the derived NAMES come from the same lib the writers generate from (`lib/derived.js`). The brand's committed sources are never touched. |

## Config

- `assets.enabled: false` — skip.
- `brand.font` — a font FILE NAME without extension, resolved from the brand repo's
  `assets/fonts/` first, then the system font dirs. No font configured means nothing to
  generate a wordmark with (noted and passed); configured but not found is an ERROR — the
  config intent failed. There is no default: omega-manager packaged the company's licensed
  fonts, this port ships none.
- `brand.name`, `brand.images.brandmark` and the other brand values the templates read.

**Credentials** (optional): `MRLOGO_SERVICE_ACCOUNT` / `MRLOGO_API_KEY` / `LOGO_API_ID_TOKEN`
— the product-service ladder for AI brandmark generation via MrLogo when the brand has no
`assets/logo/brandmark.svg` yet. Zero config options by design: setting a credential IS the
consent to spend the call. Interactive runs ask for optional art direction; dry runs never
mint. With no credentials the service skips with guidance.

## The force refresh

The `assets` service is mtime-diffed, so a converged brand rebuilds nothing; `omega manage --reset-assets` ([#214](https://github.com/Omega-JS-Stack/omega/issues/214)) is the force refresh for the cases no timestamp records. It clears the derived cache under `.omega/assets/` before the walk, then the same operations regenerate it and the run names what was cleared. Bare resets both kinds; `--reset-assets=logos` takes the logo variants, app icons and social icons, `--reset-assets=templates` the PSD exports. The brand's committed `assets/logo/*.svg` and `assets/templates/*.psd` are sources, never cache, so they are never touched (the port of omega-manager's `--reset-logos` / `--reset-templates`).

Invalidation IS deletion: `isStale()` calls a missing derived file stale, so removing a kind's
outputs is precisely what makes the same walk regenerate them — no second freshness mechanism
to keep in sync.

## Gotchas

- **The brandmark is the root of every derived asset.** No `assets/logo/brandmark.svg` and no
  MrLogo credential means the whole service skips.
- **A PSD stores each layer's raster.** Replaced TEXT content lands in the layer metadata and
  Photoshop re-renders it on open, so a text change appears in the exports only after the PSD
  is opened and saved once. The LOGO layers are re-rastered here, so they are always current.
- **Manual Photoshop edits persist and re-trigger the pass**: editing a PSD bumps its mtime, so
  the next run re-replaces the logo/text layers and re-exports.
