# Migration

Procedures for migrating old @omega.js/backend consumer projects to the current format: environment variables (Part 1), legacy code patterns (Part 2), and routes/schemas (Part 3).

## Part 1: Environment Variable Migration

Convert old config formats (runtime config / nested JSON) into individual top-level environment variables in `functions/.env`.

### Key Mapping

| Old Path | New ENV Key |
|----------|-------------|
| `backend_manager.key` or `backendmanager.key` | `OMEGA_ADMIN_KEY` |
| `backend_manager.namespace` or `backendmanager.namespace` | `OMEGA_NAMESPACE` |
| `github.key` or `github.token` | `GITHUB_TOKEN` |
| `openai.key` or `openai.api_key` | `OPENAI_API_KEY` |
| `paypal.client_id` | `payment.providers.paypal.clientId` in config/omega.json5 (public, #893) |
| `paypal.client_secret` | `PAYPAL_CLIENT_SECRET` |
| `stripe.secret_key` or `stripe.key` | `STRIPE_SECRET_KEY` |
| `chargebee.site` | `payment.providers.chargebee.site` in config/omega.json5 (public, #893) |
| `chargebee.api_key` or `chargebee.key` | `CHARGEBEE_API_KEY` |
| `cloudflare.token` or `cloudflare.key` | `CLOUDFLARE_TOKEN` |
| `recaptcha.secret_key` or `recaptcha.key` | `RECAPTCHA_SECRET_KEY` |
| `sendgrid.api_key` or `sendgrid.key` | `SENDGRID_API_KEY` |
| `beehiiv.api_key` or `beehiiv.key` | `BEEHIIV_API_KEY` |
| `zerobounce.api_key` or `zerobounce.key` | `ZEROBOUNCE_API_KEY` |

### Steps

1. **Check for config sources**: first `functions/.runtimeconfig.json` (parse JSON); else a `RUNTIME_CONFIG` variable inside `functions/.env` (parse the object inside).
2. **Extract key-value pairs** using the mapping table.
3. **Backup existing `.env`** as `functions/.env.backup` if it exists.
4. **Check existing `.env` for conflicts**: skip existing keys and warn.
5. **Write/update `functions/.env`**: each mapped key as a top-level variable.
6. **Delete source files**: remove `functions/.runtimeconfig.json` if it existed.
7. **Convert `functions/backend-manager-config.json` to `functions/config/omega.json5`** (shared sections top-level, backend settings under `targets.backend`, see CHANGELOG for the mapping), then: remove the deprecated `mailchimp` key entirely; update `brand` to the nested structure `{ name, url, contact: { email }, images: { brandmark, wordmark, combomark } }`; declare the repo owner once at the top level, `repo: { provider: 'github', owner: 'itw-creative-works' }` ([#883](https://github.com/Omega-JS-Stack/omega/issues/883): the content repo derives as `<brand.id>-omega` under it, and the retired `github.user` / per-target `github` keys fail validation).
8. Update `functions/.nvmrc` to `v22/*` and `functions/package.json` `engines.node` to `"22"`.
9. Clean up `functions/.gitignore` duplicates.

## Part 2: Legacy Code Migration

The old patterns below are the legacy text this migration matches, as a ported project still spells it. Search all `.js` files under `functions/` for legacy config reads and convert them:

- `Manager.config.*` secrets → `process.env.KEY_NAME`
- `RUNTIME_CONFIG` → individual `process.env` vars
- `functions.config()` → `process.env` vars

| Old Pattern | New Pattern |
|-------------|-------------|
| `Manager.config.github.key` | `process.env.GITHUB_TOKEN` |
| `Manager.config.sendgrid.key` | `process.env.SENDGRID_API_KEY` |
| `Manager.config.stripe.secret_key` | `process.env.STRIPE_SECRET_KEY` |
| `Manager.config.openai.key` | `process.env.OPENAI_API_KEY` |
| `Manager.config.paypal.client_id` | `omega.config.payment.providers.paypal.clientId` |
| `Manager.config.paypal.client_secret` | `process.env.PAYPAL_CLIENT_SECRET` |
| `Manager.config.chargebee.site` | `omega.config.payment.providers.chargebee.site` |
| `Manager.config.chargebee.api_key` | `process.env.CHARGEBEE_API_KEY` |
| `Manager.config.cloudflare.token` | `process.env.CLOUDFLARE_TOKEN` |
| `Manager.config.recaptcha.secret_key` | `process.env.RECAPTCHA_SECRET_KEY` |
| `Manager.config.beehiiv.api_key` | `process.env.BEEHIIV_API_KEY` |
| `Manager.config.zerobounce.api_key` | `process.env.ZEROBOUNCE_API_KEY` |
| `Manager.config.backend_manager.key` | `process.env.OMEGA_ADMIN_KEY` |
| `Manager.config.backend_manager.namespace` | `process.env.OMEGA_NAMESPACE` |

The consumer entry, the handler arguments and every other runtime shape a ported project rewrites (`Manager` to `omega`, `settings` to `data`, `libraries.admin` to `omega.firebase.admin`) are the by-hand steps of the breaking-changes register: [one runtime shape](../shared/breaking-changes.md#2026-09-25-one-runtime-shape-on-every-package-945).

## Part 3: Route/Schema Migration

**IMPORTANT:** Only migrate routes a ported `functions/index.js` already runs through the request pipeline (the legacy text: `Manager.Middleware(req, res).run('example')`, which becomes `omega.routes.run('example', { req, res })`). A route loaded by hand (`new (require(`${__dirname}/routes/example/index.js`))().main(Manager, req, res)`) is rewritten as a route first.

### Old → New Format

**Route:** constructor pattern → one-object export ([routes.md](routes.md)):

- `routes/example/index.js` → `routes/example/post.js` (or the appropriate method file)
- Remove the constructor; the file becomes an ES module: `export default async ({ ctx, omega, user, data, usage, analytics }) => {}`, its requires become `import`s ([routes.md](routes.md#new-route-consumer-project))

**Schema:** wrapped tiers → a function returning a flat declaration ([schemas.md](schemas.md)):

- `schemas/example/index.js` → `schemas/example/post.js`
- Remove the `['defaults']:` wrapper and flatten the structure: plan adjustments move INSIDE the function, splitting on `user.plan`
- `export default` a function of the request, `({ user, body, query, path, method, headers, geolocation })`, returning the declaration
- Rename every field's `types: ['string']` to `type: 'string'`, and remove `value: undefined` noise

| Aspect | Old Format | New Format |
|--------|-----------|------------|
| Route export | `module.exports = Route` (constructor) | `export default async ({ ctx, omega, user, data }) => {}` |
| Self reference | `const self = this;` | Not needed |
| File naming | `index.js` | `get.js`, `post.js`, `put.js`, `delete.js` |
| Schema wrapper | `['defaults']: { ... }` | A function returning the flat declaration |
| Schema params | `(ctx)` | `({ user, body, query, path, method, headers, geolocation })` |
| Context key | `{ assistant }` / `Manager.Assistant()` / `BackendAssistant` | `{ ctx }`, a `Context` the pipeline builds |
| Error factory | `assistant.errorify(e, { code, sentry, log })` | `ctx.report(e, { code })`: 5xx captures to Sentry automatically, 4xx never; sending stays `ctx.respond()` |

## Part 4: The dependency-resolution report

`npx omega migrate --target=<name>` at the brand root prints what the port
still owes and changes nothing, `--execute` included: the backend leg of the
ONE root verb ([#600](https://github.com/Omega-JS-Stack/omega/issues/600),
[#885](https://github.com/Omega-JS-Stack/omega/issues/885)).

Under BEM's FLAT install every framework dependency sat in the consumer's own
`node_modules`, so a ported route could `require('fs-jetpack')` and be right.
Under OMEGA the framework is a package with its own tree and that require
resolves only by HOISTING, which holds on one install and not on the next. The
requires that carry it are LAZY, inside the handler that needs them, so the
module loads fine and the route 500s the first time a request reaches it.

The leg names every bare specifier under `src/` that is neither a Node built-in
nor a package this target's own `package.json` declares, at file:line, with the
fix. It never installs: which version a brand wants is the brand's call. The
scan itself is `@omega.js/devkit`'s `src/bare-requires.js`, the SAME one the
web leg of `omega migrate` runs, so a brand's two ported targets cannot get
different answers.

The same scan runs after the port, on every verb: the backend scaffold warns
once per undeclared package under `src/`, and a package @omega.js/backend
declares also names the second fix, `omega.require('<module>')`, which loads
the framework's copy. Never an error, and a version the target declares itself
wins. The rule: [docs/shared/local-dev.md](../shared/local-dev.md#using-what-the-framework-depends-on).

The one-time CONVERSIONS stay their own run-alone verbs, `omega migrate:rules`
and `omega migrate:markers` (at the brand root, `--target=<name>` picks the
backend), because those change what the project enforces.

## See also

- [routes.md](routes.md) — the current route format being migrated TO
- [schemas.md](schemas.md) — the current schema contract
- [environment-detection.md](environment-detection.md) — env var conventions
