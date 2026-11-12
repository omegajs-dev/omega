# Schemas

A route's schema declares the input the route accepts. The request pipeline validates the request against it and hands the route the result as `data`.

- **Where**: `src/schemas/{name}/{method}.js`. The settings service (`src/omega/services/settings.js`) loads the method-specific file first (`get.js` / `post.js` / ...) and falls back to `{name}/index.js`. The name defaults to the route name (`omega.routes.run('items', { req, res })` loads `src/schemas/items/`); the `schema` pipeline option names another one.
- **What**: a schema file is an ES module whose default export is a function of the request, returning a PLAIN field declaration. It loads through the one handler loader, so a CommonJS schema (`module.exports = ...`) is refused by name ([routes.md](routes.md#new-route-consumer-project)).
- **No top-level `await`**: the file is loaded by `require()`, which refuses an async module. An `await` goes inside the default export.
- **How**: ONE adapter, `src/omega/helpers/schema.js`, turns that declaration into a zod schema and validates with it. zod is the only validator underneath, and the declaration stays a plain object until the adapter runs, so the function can change any field on any request fact before zod sees it.

## The schema function

The function receives the request's raw parts by name and returns the declaration:

| Key | What it is |
|---|---|
| `user` | The caller, a `User` from `@omega.js/account` (a signed-out `User` when nobody is signed in): read `user.plan`, `user.authenticated`, `user.roles.admin`, never the raw subscription |
| `body` | The raw request body |
| `query` | The raw query string |
| `path` | The request path (`/items/abc`) |
| `method` | The HTTP method (`POST`) |
| `headers` | The request headers |
| `geolocation` | `{ ip, continent, country, region, city, latitude, longitude }` |

The route receives the VALIDATED merge of `body` and `query` as `data`; the schema reads the raw parts.

## The full example

Every field option, and every split kind:

```javascript
// src/schemas/items/post.js
export default ({ user, body, query, path, method, headers, geolocation }) => {
  const fields = {
    name:    { type: 'string', required: true, clean: /[<>]/g, max: 80 },
    limit:   { type: 'number', default: 10, min: 1, max: 100 },
    tags:    { type: 'array', of: { type: 'string', max: 20 }, default: [], max: 5 },
    address: { type: 'object', default: {}, fields: {
      city: { type: 'string', default: '' },
      zip:  { type: 'string', pattern: /^\d{5}$/ },
    } },
    mode:    { type: 'string', enum: ['quick', 'full'], default: 'quick' },
    id:      { type: 'string', path: true },       // filled from /items/:id
    total:   { type: 'number', value: 0 },         // forced, the caller cannot set it
  };

  // Split on the caller
  if (user.plan === 'pro') { fields.limit.max = 200; }
  if (user.plan === 'max') { fields.limit.max = 500; }

  // Split on the request
  if (query.bulk === 'true') { fields.tags.max = 50; }
  if (path.endsWith('/admin')) { fields.total = { type: 'number', default: 0 }; }

  // Split on the input
  if (body.mode === 'full') { fields.address.fields.zip.required = true; }

  return fields;
};
```

What a `POST /items/abc` resolves to, for a `basic` caller sending `{ name: 'a<b>', limit: 500, tags: ['x'], total: 9 }`:

```json
{ "name": "ab", "limit": 100, "tags": ["x"], "address": { "city": "", "zip": "" }, "mode": "quick", "id": "abc", "total": 0 }
```

The same body from a `pro` caller resolves `limit` to 200. A body with `mode: 'full'` and no `address.zip` is refused: `400 Required key {address.zip} is missing in settings`.

## The three split kinds

A split is ordinary code in the function: it edits the declaration before the function returns it. The schema provides the declaration; the split is how one schema serves every case.

- **The caller** (`user`): the plan, the roles, the account. `if (user.plan === 'pro') { fields.limit.max = 200; }`. A premium-only field is a field the function adds only for that plan.
- **The request** (`query`, `path`, `method`, `headers`, `geolocation`): `if (query.bulk === 'true') { fields.tags.max = 50; }`.
- **The input** (`body`): a field that depends on another field the caller sent. `if (body.mode === 'full') { fields.address.fields.zip.required = true; }`. The same kind picks a whole nested group by a `type` the caller sent:

```javascript
export default ({ body }) => {
  const fields = {
    name: { type: 'string', required: true },
    type: { type: 'string', required: true, enum: ['url', 'text'] },
  };

  if (body.type === 'url') {
    fields.options = { type: 'object', fields: { url: { type: 'string', required: true } } };
  } else if (body.type === 'text') {
    fields.options = { type: 'object', fields: { text: { type: 'string', required: true } } };
  }

  return fields;
};
```

## The field vocabulary

| Key | What it does |
|---|---|
| `type` | One of `string`, `number`, `boolean`, `array`, `object`, `any`, or a LIST of them (`type: ['string', 'number']`) |
| `required` | A boolean, computed in the function when it depends on the request. A key counts as missing when it is `undefined` or `''` (null, 0 and false pass). Never paired with `default` (see the footgun below) |
| `default` | The value when the caller sends none; a value or a function (`default: () => Date.now()`), cloned per request |
| `min` / `max` | Numbers clamp to the range. Strings and arrays truncate at `max`; one shorter than `min` is REFUSED, sent or defaulted. Enforced only when declared: a declared `0` is a real bound |
| `enum` | The allowed values. Judges only a value the caller SENT |
| `pattern` | A RegExp a sent string must match. Judges only a value the caller SENT |
| `clean` | A RegExp (matched characters removed) or a function `(value) => cleaned` |
| `of` | The declaration every item of a `type: 'array'` passes through |
| `fields` | The nested declaration of a `type: 'object'`. Without `fields`, an object passes through whole (an open object) |
| `path` | `true` on a top-level field: filled from the request path (see below), never from the input |
| `value` | A forced value: it wins over the input and the default, so the caller cannot set the field |
| `sanitize` | `false` keeps the field's HTML when the route opts in to the pipeline's HTML strip (see [sanitization.md](sanitization.md)) |

A malformed field throws at the request, naming its dot-path: an unknown key (a typo such as `types` or `requried`), a `type` outside the list, `of` on a non-array, `fields` on a non-object, `path` below the top level.

## How a value resolves

Defaults coerce and never reject. For each field, in order:

1. `required` reads the RAW input, before any default.
2. The sent value (or the default) is forced to a single `type`; with a type LIST, a value matching none takes the default. A non-finite number takes the default.
3. Numbers clamp to `min` / `max`; strings and arrays truncate at `max`.
4. A forced `value` wins.
5. `clean` runs.
6. The refusals: an `enum` miss or a `pattern` miss on a sent value, and a string or array shorter than `min`.

Nested `fields` resolve the same way, level by level, and unknown keys strip at every level. A refusal answers 400 with one message: `Required key {x} is missing in settings`, or `Invalid settings {x}: <why>` (`must be one of [quick, full]`, `must match /^\d{5}$/`, `must be at least 1 character`, `must have at least 1 item`).

### The `required` and `default` footgun

`required` is checked against the ORIGINAL request value, before defaults apply, so a default on a required field could never be used: the pair throws when the declaration is read. For a field that must be non-empty but has a default, use `min: 1` instead: it refuses an empty value with a 400 AFTER the default applies.

## ID generation (POST, create)

IDs are generated in the **schema**, never in the route. A forced `value` computed in the function is a fresh id per request, and the route reads `data.id`:

```javascript
import omega from '@omega.js/backend';

export default () => ({
  id: { type: 'string', value: omega.utilities.randomId() },
  name: { type: 'string', required: true },
});
```

`omega.utilities.randomId()` is a 14-character nanoid over a 62-character alphabet (no `-` or `_`).

## IDs from the path (GET, PUT, DELETE)

A `path: true` field reads the request path's segments that follow the route path, in declaration order: `/items/abc` under the route `items` fills the first `path` field with `abc` (`/omega/items/abc` too). A request with no id in the path resolves the field to `''`.

```javascript
export default () => ({
  id: { type: 'string', path: true, min: 1, max: 128 },
});
```

`min: 1` is a real guard: a request with no id is refused with `400 Invalid settings {id}: must be at least 1 character` before the route runs, so a handler never reads or writes the wrong document. A GET that lists when no id is given omits it:

```javascript
export default () => ({
  id: { type: 'string', path: true },
  limit: { type: 'number', default: 20, min: 1, max: 100 },
  startAfter: { type: 'string', default: '' },
});
```

## Webhook routes

Webhook routes (`payments/webhook`, `marketing/webhook`, ...) keep an empty declaration by design (`export default () => ({})`): the body is the raw provider payload, which the route reads off `ctx.request`.

## Reference implementation

The schema exercising every field option and a plan split: [`src/omega/schemas/test/schema/post.js`](../../packages/backend/src/omega/schemas/test/schema/post.js). `test/helpers/settings.test.js` pins its resolved output, one case per split kind, and every refusal.

## Field sanitization

The pipeline always trims whitespace on string fields. HTML stripping is **opt-in per route** (`omega.routes.run('my-route', { req, res }, { sanitize: true })`), and a field opts back out with `sanitize: false`. See [sanitization.md](sanitization.md).

## See also

- [routes.md](routes.md): the routes reading `data`, and the pipeline options
- [sanitization.md](sanitization.md): trim versus HTML strip
- [test-framework.md](test-framework.md): schema tests (`test/routes/test/schema.test.js`)
