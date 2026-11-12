# Sanitization (XSS Prevention)

The @omega.js/backend request pipeline always **trims** whitespace on incoming string fields (via `omega.utilities.trim()`). HTML sanitization is **opt-in**: it does not run by default because it mangles legitimate input like URL query strings (`&` → `&amp;`) and Markdown.

The expectation is that you sanitize at the **HTML-insertion site** (in the template, in the email body, etc.), not at the request boundary.

## How It Works

1. **Trimming**: Every string in `data` is whitespace-trimmed by the pipeline's `trim` step (objects and arrays walked recursively). Always on.
2. **HTML sanitization**: Off by default. Opt in per route with the `sanitize: true` pipeline option.
3. **Schemas** can mark individual fields with `sanitize: false` to skip the HTML strip for that field when route-level sanitize is enabled (for fields that legitimately need raw HTML: rich-text editors, email templates).

## Route-Level Opt-In

```javascript
// In src/index.js: enable the HTML strip for a specific function
omega.functions.myRoute = omega.firebase.functions
  .region(omega.project.resourceZone)
  .https.onRequest((req, res) => omega.routes.run('my-route', { req, res }, { sanitize: true }));
```

When enabled, every string in `data` is run through `sanitize-html` (strip all tags) unless the schema marks the field with `sanitize: false`.

## Schema Field Opt-Out (when route-level sanitize is on)

```javascript
export default () => ({
  // This field will NOT be sanitized: raw HTML is preserved
  htmlContent: { type: 'string', default: '', sanitize: false },
  // This field IS sanitized when route-level sanitize is enabled
  name: { type: 'string', default: '' },
});
```

A nested object's own `fields` carry `sanitize: false` the same way.

## Manual Sanitization (Recommended)

For most use cases (particularly anywhere you insert user-supplied content into HTML), call `omega.utilities.sanitize()` directly at the insertion site:

```javascript
export default async ({ ctx, omega, data }) => {
  const safeHtml = omega.utilities.sanitize(data.body);
};
```

Accepts any data type: strings, objects, arrays, primitives. Walks objects and arrays recursively, strips HTML from strings, passes everything else through unchanged.

## Why HTML Sanitization Is Not the Pipeline Default

Stripping HTML from every incoming string at the request boundary is too aggressive; it corrupts legitimate input:

- URL query strings: `https://example.com/?a=1&b=2` becomes `https://example.com/?a=1&amp;b=2`
- Markdown / code snippets with `<`, `>`, `&` characters get mangled
- API payloads round-tripped through the system get silently rewritten

Stored XSS comes from rendering, not from receiving. Sanitize at the render site (where you know the output context: HTML body, attribute, URL, JSON) instead of at the front door.

## Route Handler Context

```javascript
export default async ({ ctx, omega, user, data, usage, analytics }) => {
  // data             whitespace-trimmed by the pipeline; HTML preserved unless the route opts in with { sanitize: true }
  // omega.utilities  the process service for a manual sanitize() / trim()
};
```
