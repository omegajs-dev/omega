# Admin Post Route

The `POST /admin/post` route creates blog posts via GitHub's API. It handles image extraction, resize, upload, and body rewriting.

**Consumers.** Besides direct admin/blogger HTTP calls, this route is the publish target for the **Ghostii article engine** (`src/omega/libraries/content/ghostii.js` → `publishArticle()`), which is used by two paths: the standalone daily `blog-auto-publisher.js` cron (off by default), and the newsletter generator's linked-article flow (`marketing.newsletter.content.article.enabled`). Both POST `title`/`url`/`description`/`headerImageURL`/`body`/`author`/`categories`/`tags`/`postPath`, admin-authenticated via the `omega-admin-key` header. **The target repo is never part of the request**: the route always derives owner/repo from its own brand config, so a blogger-role caller can't redirect a write at another repo the shared `GH_TOKEN` can reach (caller-supplied `githubUser`/`githubRepo` were removed from the schemas). Note: `headerImageURL` MUST resolve to a `.jpg` (the downloader rejects non-`.jpg` headers); Ghostii's `unsplash` hero satisfies this. See [docs/backend/marketing-campaigns.md](marketing-campaigns.md).

**Ghostii is unopinionated about @omega.js/backend.** Its `/write/article` response is a generic article — a `json` block array (`[{ name, content }]` where name ∈ `heading-1..6`/`image`/`paragraph`/`blockquote`/`list`) plus top-level `title`/`description`/`headerImageUrl`/`images`/`categories`/`keywords`. @omega.js/backend owns the transform into this route's shape: `blocksToPost(article.json)` extracts the `heading-1` as the title, the first `image` block as `headerImageURL`, and joins every remaining block as the `body` (content only — NO title, NO header image embedded, since this route adds those itself; section images stay in the body and are extracted normally). Older Ghostii responses without `json` fall back to the flat `article.{title,body,headerImageUrl}` fields.

## Which website: the `target` parameter

A brand's website lives at `targets/<name>/` inside the source monorepo, and ONE backend serves every website the brand runs ([#887](https://github.com/Omega-JS-Stack/omega/issues/887)). So every CMS route that touches repo content takes a `target` naming the web target (the `targets` key, [#886](https://github.com/Omega-JS-Stack/omega/issues/886)): `POST`/`PUT /admin/post`, `POST /admin/repo/content`, and `GET /content/post`.

The one-or-many rule, in `src/omega/helpers/web-target.js` (`resolveWebTarget`), is the same on all four:

- A brand with exactly ONE web target may omit it, and that target is the answer.
- A brand with SEVERAL requires it: a missing name answers 400 listing the declared web targets, and so does a name nobody declared. Nothing is guessed.
- A brand with no web target at all answers 400 too: content has nowhere to land.

The path rule: the repo path is `targetPath(config, target)` (@omega.js/config's one derivation, `targets/<name>`) plus the SITE-relative path each route already composed. So a post is `targets/<target>/src/_posts/<year>/<postPath>/<date>-<url>.md`, its images are `targets/<target>/src/assets/images/blog/post-<id>/`, and `POST /admin/repo/content` keeps the caller's site-relative `path` and reports where it landed as `repoPath`. No route composes `targets/` by hand.

Two consequences worth knowing:

- `GET /content/post` scopes its code search to `targets/<target>/src/_posts` AND refuses a hit outside that folder, so two websites with the same slug can never answer for each other (a `path:` qualifier narrows a GitHub code search, it does not bind it).
- The D13 publish dispatch names the target's own workflow. A brand monorepo composes one workflow per target ([#265](https://github.com/Omega-JS-Stack/omega/issues/265)), so the post's target decides: `web-build.yml`, `community-build.yml`, and so on.

The repo is still never part of the request: it is the brand's SOURCE monorepo, derived from the one `repo` block ([#883](https://github.com/Omega-JS-Stack/omega/issues/883)).

## Image Processing Flow

1. Receives markdown body with external image URLs (e.g., `![alt](https://images.unsplash.com/...)`)
2. Extracts all `![alt](url)` patterns from the body using regex
3. Downloads each image to a tmp dir
4. **Converts** png/webp sources to progressive JPEG in place (`convertToJpeg` — alpha flattened onto white); other non-JPG formats are rejected, naming the offending URL
5. **Resizes** each image in place if its long edge exceeds `IMAGE_MAX_DIMENSION` (see below)
6. Commits all images to `targets/<target>/src/assets/images/blog/post-{id}/` on GitHub (single commit via Git Trees API)
7. **Rewrites the body** to replace external URLs with `@post/{filename}` format
8. The `@post/` prefix is resolved at Jekyll build time by `jekyll-uj-powertools` to the full path

**Download failures:** the header image is fatal (the whole request 400s); body images are skipped with a warning (the body keeps the original external URL — the post still publishes). Failure reasons go through `formatImageDownloadError` — `Could not download image (<url>): <reason>` with HTML stripped from the reason (CDN 404 pages return raw HTML bodies) and long reasons truncated, so callers (e.g. sponsorship failure emails) surface something readable. Unsupported formats (anything that isn't jpg/png/webp) are rejected, naming the offending URL. Tests: `test/routes/admin/post-download-error.test.js` + `test/routes/admin/post-convert-image.test.js`.

## Image resize

Sources from guest-post submissions can be enormous (16384×10576 has been seen in the wild — ~520MB raw RGB). Sources that large stall downstream Jekyll/imagemin pipelines on the consumer site, and can OOM a 256MB Cloud Function when sharp decompresses them (a 5184×3456 JPEG decodes to ~71MB raw pixels).

Two defenses:

1. **CDN pre-scale** — `applyImageCDNParams(src)` adds server-side resize params to supported CDN URLs *before* downloading. Currently supports Unsplash (`images.unsplash.com`, Imgix-style `?w=&q=` params) and Pexels (`images.pexels.com`, `?w=&auto=compress`). The CDN delivers a pre-scaled image (e.g. ~314KB instead of 3.8MB for a 2048px cap), so sharp never sees the massive original. Params are only added if not already present on the URL.

2. **Local sharp resize** — after download, `resizeImage()` checks the long edge against `IMAGE_MAX_DIMENSION` and re-encodes as progressive JPEG at `IMAGE_JPEG_QUALITY` if it exceeds the limit. Images already within the limit pass through untouched. `sharp.cache(false)` is set so decoded pixel buffers are freed immediately between images — without this, processing several images serially can OOM even at 256MB.

The resize happens in `downloadImage()` (after the `.jpg` extension check, before returning to the caller), so:
- The base64 content that gets committed to GitHub is the resized version
- The consumer repo never sees the giant source
- Future downstream optimization (web's imagemin, etc.) starts from a sane source size

Constants live in `src/omega/routes/admin/post/images.js` (web's `imagemin.js` uses the same names and values):
```js
const IMAGE_MAX_DIMENSION = 2048;
const IMAGE_JPEG_QUALITY = 80;
```

If these need to become configurable later, promote to `config/omega.json5` rather than env vars (deploy-environment-specific overrides aren't a real use case — the values are algorithm constants).

## Key Details

- Image filenames are derived from `hyphenate(alt_text)` + downloaded extension
- Only `.jpg` is accepted; other formats reject with a 400
- Header image (`headerImageURL`) is uploaded but NOT rewritten in the body (it's in frontmatter)
- Failed image downloads are skipped — the original external URL stays in the body
- All images + the post markdown are committed in a single commit via the Git Trees API

## Files

- `src/omega/routes/admin/post/post.js`: POST handler (create), includes the `downloadImage()` helper
- `src/omega/routes/admin/post/images.js`: the image helpers and constants (`applyImageCDNParams`, `formatImageDownloadError`, `convertToJpeg`, `resizeImage`, `IMAGE_MAX_DIMENSION`, `IMAGE_JPEG_QUALITY`)
- `src/omega/routes/admin/post/commit-all.js`: `commitAll()`, the one Git Trees commit; `upload-post.js` holds the edit's `uploadPost()`
- `src/omega/routes/admin/post/put.js`: PUT handler (edit); does NOT download images, just edits frontmatter/body in place
- `src/omega/routes/admin/post/templates/post.html`: Post template
- `src/omega/helpers/web-target.js`: `resolveWebTarget()`, the one-or-many rule every CMS route resolves its target through, and `cmsContext()`, the one call each route makes for both facts it needs before touching content (the source repo it commits to, and that target): a response-shaped 500 when the brand names no repo, the same 400s otherwise
- `test/helpers/web-target.test.js`, `test/routes/admin/cms-target-paths.test.js`, `test/routes/content/post-target-scope.test.js`: the target rule, the committed paths, and the scoped read
