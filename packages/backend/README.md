<p align="center">
  <a href="https://itwcreativeworks.com">
    <img src="https://cdn.itwcreativeworks.com/assets/itw-creative-works/images/logo/itw-creative-works-brandmark-black-x.svg" width="100px">
  </a>
</p>

<p align="center">
  <strong>OMEGA Backend</strong>: all-in-one development framework for Firebase Cloud Functions backends. Sister project to
  <a href="../web/">@omega.js/web</a>,
  <a href="../desktop/">@omega.js/desktop</a>, and
  <a href="../extension/">@omega.js/extension</a>.
</p>

## Installation

```bash
npm install @omega.js/backend
```

**Requirements:**
- Node.js 22
- Firebase project with Firestore and Authentication enabled
- `service-account.json` - Firebase service account credentials
- `config/omega.json5` - OMEGA configuration file (in your functions directory)

## Quick Start

Create `src/index.js`. The package's main export is the ONE `omega` instance; you never write `new`:

```javascript
const omega = require('@omega.js/backend');

omega.initialize({
  identity: true,
});

// Create a custom function
omega.functions.myEndpoint = omega.firebase.functions
  .runWith({ memory: '256MB', timeoutSeconds: 120 })
  .region(omega.project.resourceZone)
  .https.onRequest((req, res) => omega.routes.run('myEndpoint', { req, res }, { /* options */ }));

module.exports = omega.functions;
```

Create `src/routes/myEndpoint/index.js`:

```javascript
export default async ({ ctx, omega, user, data }) => {
  ctx.log('Request data:', data);

  // Return response
  return ctx.respond({ success: true, message: data.message, timestamp: new Date().toISOString() });
};
```

Create `src/schemas/myEndpoint/index.js`:

```javascript
export default ({ user, body, query }) => ({
  message: { type: 'string', default: 'Hello World' },
});
```

Run any verb; the first one scaffolds the project:

```bash
npx omega test
```

## Initialization Options

```javascript
const omega = require('@omega.js/backend');

omega.initialize(options);
```

`initialize()` is synchronous and returns the instance. Every option is optional:

| Option | Default | Description |
|--------|---------|-------------|
| `projectType` | `targets.backend.projectType` (default `'firebase'`) | `'firebase'` for Cloud Functions, `'custom'` for an Express server on `PORT`. The brand's `config/omega.json5` is the switch; pass it here only to override the config |
| `identity` | `true` | Wire the blocking auth functions (`beforeCreate`, `beforeSignIn`) |
| `routes` | `'/routes'` | Directory for custom route handlers |
| `schemas` | `'/schemas'` | Directory for schema definitions |
| `resourceZone` | `'us-central1'` | Firebase/GCP region |
| `sentry` | `true` | Enable Sentry error tracking |
| `reportErrorsInDev` | `false` | Report errors to Sentry in development too |
| `serviceAccountPath` | `'service-account.json'` | Path to Firebase service account (local scripts only) |
| `checkNodeVersion` | `true` | Validate Node.js version on startup |
| `uniqueAppName` | none | The Firebase Admin app name |
| `cwd` | `process.cwd()` | The functions directory |
| `logSavePath` | `false` | A file the logger also writes to |
| `useFirebaseLogger` | `true` | Route `console` to Cloud Logging in production |
| `express.bodyParser.json` | `{ limit: '100kb' }` | Express JSON body parser options |
| `express.bodyParser.urlencoded` | `{ limit: '100kb', extended: true }` | Express URL-encoded options |

The test runner calls `initialize({ runnerHost: true })`: that alone turns off the Firebase init, the function wiring, the custom server and Sentry.

## Configuration File

Create `config/omega.json5` in your functions directory (the first verb scaffolds it from the template). Shared sections (`brand`, `cloud`, `analytics`, `payment`, `monitoring`, `connections`) sit at the top level with identical spelling in every OMEGA project; backend-specific settings live under `targets.backend`. Secrets NEVER go in this file — they belong in `.env` (the loader hard-fails on secret-shaped keys).

```json5
{
  brand: {
    id: 'my-app',
    name: 'My Brand',
    url: 'https://example.com',
    contact: {
      email: 'support@example.com',
    },
    images: {
      wordmark: 'https://example.com/wordmark.png',
      brandmark: 'https://example.com/brandmark.png',
      combomark: 'https://example.com/combomark.png',
    },
  },
  monitoring: {
    providers: {
      sentry: {
        dsn: 'https://xxx@xxx.ingest.sentry.io/xxx',
      },
    },
  },
  analytics: {
    providers: {
      google: { id: 'G-XXXXXXXXXX' },
    },
  },
  cloud: {
    provider: 'firebase',
    config: {
      apiKey: 'xxx',
      authDomain: 'your-brand.com', // brand host — the web build self-hosts /__/auth/*
      projectId: 'project-id',
      storageBucket: 'project-id.appspot.com',
      messagingSenderId: '123456789',
      appId: '1:123:web:456',
      measurementId: 'G-XXXXXXXXXX',
    },
  },
  repo: { provider: 'github', owner: 'your-org' }, // the CMS commits to <brand.id>-omega under it
  targets: {
    backend: {
      type: 'backend',
      parent: '',
      marketing: { /* campaigns, newsletter, prune */ },
      reviews: { enabled: true, sites: ['trustpilot.com'] },
    },
  },
}
```

In a brand monorepo (`{brand}/targets/backend`), shared sections can live in the brand root's `config/omega.json5` instead — the loader merges `brand shared → brand targets.backend → local shared → local targets.backend`, and any shared key inside `targets.backend` acts as a backend-only override.

## Creating Custom Functions

### Routes

Routes handle HTTP requests. Create files in your `routes/` directory:

**Structure:**
- `routes/{name}/index.js` - Handles all HTTP methods
- `routes/{name}/get.js` - Handles GET requests only
- `routes/{name}/post.js` - Handles POST requests only
- (also supports `put.js`, `delete.js`, `patch.js`)

**Route File Pattern:** a route is an ES module whose one default export is an async function receiving ONE object (a CommonJS `module.exports` handler is refused by name):

```javascript
export default async ({ ctx, omega, user, data, usage, analytics }) => {
  // data: the input validated against the route's schema
  // The raw request stays on ctx.request
  const body = ctx.request.body;       // POST body
  const query = ctx.request.query;     // Query params
  const headers = ctx.request.headers;
  const method = ctx.request.method;
  const geolocation = ctx.request.geolocation; // { ip, country, region, city, latitude, longitude }
  const client = ctx.request.client;   // { userAgent, language, platform, mobile }

  // Check authentication (user is a User, never null)
  if (!user.authenticated) {
    return ctx.respond('Authentication required', { code: 401 });
  }

  // Check admin role
  if (!user.roles.admin) {
    return ctx.respond('Admin required', { code: 403 });
  }

  // Track analytics
  analytics.event('my_event', { action: 'test' });

  // Count a use of a metered feature: check, count and write in ONE call,
  // throwing a 429 over limit
  await usage.consume('requests');

  // Send response
  return ctx.respond({ success: true, data });
};
```

Everything in the argument is also on `ctx` (`ctx.user`, `ctx.data`, `ctx.usage`, `ctx.analytics`, `ctx.omega`). A route never constructs a service: it reads it off `ctx` or `omega`.

### Schemas

A schema file exports a function of the request and returns a plain field declaration. One adapter validates it with zod; a split on the plan, the request or the input is ordinary code:

```javascript
export default ({ user, body, query, path, method, headers, geolocation }) => {
  const fields = {
    message: { type: 'string', default: 'Hello' },
    count: { type: 'number', default: 10, min: 1, max: 100 },
    format: { type: 'string', enum: ['json', 'csv'], default: 'json', clean: (value) => value.toLowerCase().trim() },
    id: { type: 'string', path: true },
  };

  // A higher limit for a paid plan
  if (user.plan !== 'basic') {
    fields.count.max = 1000;
  }

  // Required only when the caller asks for a file
  if (body.output === 'file') {
    fields.format = { type: 'string', required: true };
  }

  return fields;
};
```

**Field keys:**

| Key | Type | Description |
|----------|------|-------------|
| `type` | `string \| string[]` | `'string'`, `'number'`, `'boolean'`, `'array'`, `'object'`, `'any'`, or a list of them |
| `default` | `any \| function` | Value when the caller sends none |
| `required` | `boolean` | Refuse the request when the field is missing (never paired with `default`) |
| `min` / `max` | `number` | Numbers clamp; strings and arrays truncate at `max` and are refused under `min` |
| `enum` | `any[]` | The allowed values of a sent field |
| `pattern` | `RegExp` | A sent string must match it |
| `clean` | `RegExp \| function` | Sanitize/transform the value |
| `of` / `fields` | `object` | An array's item declaration / an object's nested declaration |
| `path` | `true` | Filled from the request path (`/items/:id`) |
| `value` | `any` | A forced value the caller cannot set |
| `sanitize` | `false` | Keep the field's HTML when the route opts in to the HTML strip |

The full example and the split kinds: [docs/backend/schemas.md](../../docs/backend/schemas.md).

### Pipeline Options

The third argument of `omega.routes.run()`:

```javascript
omega.routes.run('routeName', { req, res }, {
  authenticate: true,           // Authenticate user (default: true)
  setupAnalytics: true,         // Initialize analytics (default: true)
  setupUsage: true,             // Initialize usage tracking (default: true)
  validate: true,               // Validate the input against the schema into data (default: true)
  includeUnknown: false,        // Keep undeclared input keys in data (default: false)
  sanitize: false,              // Strip HTML from data (default: false)
  schema: 'routeName',          // Schema file to use (default: same as route)
  parseMultipart: true,         // Parse multipart uploads (default: true)
  routesDir: `${omega.cwd}/routes`,   // Custom routes directory
  schemasDir: `${omega.cwd}/schemas`, // Custom schemas directory
});
```

## Built-in Functions

### HTTP API (`omega_api`)

The main API endpoint serves the framework's built-in routes and the MCP endpoint. Requests to `/omega/<route>` (hosting rewrite; `/omega_api/<route>` on the direct function URL) resolve to the framework's `routes/{name}/{method}.js` handlers with their matching schemas. A route of yours never rides it: it gets its own function and its own hosting rewrite, at its own path (see [Creating Custom Functions](#creating-custom-functions) above).

```javascript
// POST https://api.<yourdomain>/omega/user/token
// → routes/user/token/post.js (responds { token })
```

### Auth Events

| Function | Trigger | Description |
|----------|---------|-------------|
| `omega_authBeforeCreate` | `beforeUserCreated` | Runs before user creation, can block signup |
| `omega_authBeforeSignIn` | `beforeUserSignedIn` | Runs before sign-in, can block login |
| `omega_authOnCreate` | `onCreate` | Runs after user creation, creates user document |
| `omega_authOnDelete` | `onDelete` | Runs when user is deleted, cleanup |

### Firestore Events

| Function | Trigger | Description |
|----------|---------|-------------|
| `omega_notificationsOnWrite` | `onWrite` | Triggers on `notifications/{id}` changes |

### Cron Jobs

| Function | Schedule | Description |
|----------|----------|-------------|
| `omega_cronDaily` | Every 24 hours | Runs the framework's daily jobs, then yours from `hooks/cron/daily/` |
| `omega_cronFrequent` | Every 10 minutes | Runs the framework's frequent jobs, then yours from `hooks/cron/frequent/` |

**Creating Custom Cron Jobs:**

Create `src/hooks/cron/daily/myJob.js`. A job is an ES module whose default export is an async function receiving ONE object, and each job gets its own `ctx`:

```javascript
export default async ({ ctx, omega, context }) => {
  ctx.log('Running my daily job...');

  // Your job logic here (Firebase Admin is omega.firebase.admin)
};
```

### Custom Triggers

A trigger of your own runs its handler through the framework with `omega.events.run(name, payload)`; the handler receives `{ ctx, omega, user, context, change, snapshot }`:

```javascript
omega.functions.usersOnCreate = omega.firebase.functions
  .auth.user()
  .onCreate((user, context) => omega.events.run('users/on-create', { user, context }));
```

`'users/on-create'` loads `src/events/users/on-create.js` (staged to `dist/events/`).

## Email System

Unified MJML-based email rendering for transactional, marketing, and newsletter emails. All emails are rendered server-side — no SendGrid dynamic templates.

- **Unified pipeline** — shared `prepare.js` layer for brand, sender, content, signoff, categories, unsubscribe URL
- **Composable template system** — `base.js` provides building blocks (skeleton, logo, card wrapper, signoff, button, footer); templates compose what they need
- **4 email templates** — `card` (default workhorse), `plain` (personal email feel), `order` (all 9 payment event types), `feedback` (rating faces)
- **MJML compilation** — templates return MJML strings, compiled to email-safe HTML via the `mjml` package
- **Hidden ASM + category tags** — baked into the skeleton to suppress SendGrid's auto-unsubscribe and enable email sorting

### Email API

```javascript
const email = ctx.email;
await email.send({
  template: 'card',
  subject: 'Welcome!',
  to: 'user@example.com',
  sender: 'hello',
  data: { body: { title: 'Welcome', message: '# Hello!\n\nWelcome aboard.' } },
});
```

## Marketing & Campaigns

Built-in marketing system with multi-provider support (SendGrid + Beehiiv + FCM push).

- **Contact management** — add, sync, remove contacts across providers with custom field syncing
- **Campaign CRUD** — `POST/GET/PUT/DELETE /marketing/campaign` with calendar-backed scheduling
- **Recurring campaigns** — seasonal sales, newsletters with automatic sendAt advancement
- **Newsletter generator** — AI-assembled newsletters from parent server content sources
- **Newsletter-driven blog articles** — `content.article.enabled` expands the newsletter's lead section into a full blog post (via Ghostii → `admin/post`) and links to it with a "Read the full article" CTA
- **Segment SSOT** — 22 segment definitions resolved to provider IDs at runtime
- **UTM auto-tagging** — brand domain links tagged automatically in marketing + transactional emails
- **Contact pruning** — monthly 2-stage re-engagement + deletion of inactive contacts
- **Template variables** — `{brand.name}`, `{holiday.name}`, `{season.name}`, `{date.*}` resolved at send time

Configure via the `marketing` section under `targets.backend` in `config/omega.json5`. See [docs/backend/marketing-campaigns.md](../../docs/backend/marketing-campaigns.md) and [docs/backend/marketing-fields.md](../../docs/backend/marketing-fields.md) for full documentation.

## Marketing Consent

GDPR/CASL-compliant consent capture and cross-provider unsubscribe sync.

- **Two-checkbox signup form** — separate legal (required) and marketing (optional) consent
- **Canonical user-doc shape** — `consent.{legal,marketing}.{status, grantedAt, revokedAt}` with full audit metadata (timestamp, source, IP, exact label text)
- **Server-authoritative timestamps** — client timestamps ignored, defending against clock manipulation
- **Account-page toggle** — `/account` notifications section lets logged-in users opt in/out, hits both SendGrid + Beehiiv
- **HMAC unsubscribe links** — email-footer one-click flow continues to work; unsubscribe removes the contact from ALL providers (not just the SendGrid ASM group), re-subscribe re-adds the contact
- **Provider webhook receivers** — `POST /marketing/webhook?provider=sendgrid|beehiiv&key=X` catches unsubscribe / spam / bounce events from SendGrid and Beehiiv, writes the user doc + syncs to the OTHER provider
- **Parent forwarder** — single public webhook endpoint (`/marketing/webhook/forward`) on the parent @omega.js/backend fans out to every brand's child @omega.js/backend so each one updates its own Firestore
- **Library-level consent gate** — `email.add()` and `email.sync()` skip users whose `consent.marketing.status === 'revoked'` (covers every call site: payment syncs, admin re-syncs, newsletter form); admin contact DELETE mirrors `revoked` back to the user doc so removals stick

See [docs/backend/consent.md](../../docs/backend/consent.md) for the full architecture, source enum reference, migration script template, and provider configuration steps.

## Context and Services

Every route, event and cron job runs with ONE `Context`, the `ctx` its handler receives. The services hang off `ctx` (per request, built on first read) or off `omega` (per process, built once); a route never constructs one.

### Context (`ctx`)

Handles the request/response lifecycle, authentication, and logging. `ctx.request` is null outside HTTP.

```javascript
export default async ({ ctx, omega, user }) => {
  // The caller: a User, signed out until the pipeline's authenticate step resolves one
  ctx.user.authenticated;

  // Request data
  ctx.request.data;        // Merged body + query (raw)
  ctx.data;                // The validated input
  ctx.request.body;        // POST body
  ctx.request.query;       // Query params
  ctx.request.headers;     // Request headers
  ctx.request.method;      // HTTP method
  ctx.request.geolocation; // { ip, country, region, city, latitude, longitude }
  ctx.request.client;      // { userAgent, language, platform, mobile }

  // Response
  ctx.respond({ success: true });                    // 200 JSON
  ctx.respond({ success: true }, { code: 201 });     // Custom status
  ctx.redirect('https://example.com');               // 302

  // Errors: a 5xx captures to Sentry, a 4xx never does
  ctx.respond(new Error('Bad request'), { code: 400 });
  throw ctx.report('Something went wrong', { code: 500 }); // report() logs and captures without sending

  // Logging
  ctx.log('Info message');
  ctx.warn('Warning message');
  ctx.error('Error message');
  ctx.debug('Debug message');

  // Environment (forwarded from omega)
  ctx.isDevelopment(); // true in emulator
  ctx.isProduction();  // true in production
  ctx.isTesting();     // true when running tests

  // File uploads (the pipeline already parsed a multipart body)
  const { fields, files } = await ctx.parseMultipart();
};
```

### User

`ctx.user` (the route's `user`) is a `User` from `@omega.js/account`, the same class the browser's `omega.auth.user` is. Its own fields are the stored account document; the derived facts are getters:

```javascript
user.authenticated;   // false for a signed-out caller (never null)
user.uid;             // user.auth.uid
user.email;           // user.auth.email
user.plan;            // the plan with access right now ('basic' when cancelled)
user.active;          // an active paid plan (including trialing and cancelling)
user.trialing;
user.cancelling;
user.everPaid;
user.profile;         // { displayName, photoURL, emailVerified } from the ID token
user.toJSON();        // the stored document alone

// The stored document:
{
  auth: { uid, email, temporary },
  subscription: {
    product: { id, name },   // product from config ('basic', 'premium', etc.)
    status: 'active',        // active | suspended | cancelled
    expires: { timestamp, timestampUNIX },
    trial: { claimed, expires: {...} },
    cancellation: { pending, date: {...} },
    limits: {},
    payment: { provider, resourceId, frequency, startDate, updatedBy }
  },
  roles: { admin, betaTester, developer },
  affiliate: { code, referrals, referrer },
  metadata: { created, updated },
  activity: { geolocation, client },
  api: { clientId, privateKey },
  usage: { requests: { monthly, daily, total, last } },
  personal: { birthday, gender, location, name, company, telephone },
  connections: {}
}
```

### Analytics

`ctx.analytics` (the route's `analytics`) sends GA4 events as the caller:

```javascript
analytics.event('purchase', {
  item_id: 'product-123',
  value: 29.99,
  currency: 'USD',
});
```

**Auto-tracked User Properties:**
- `app_version`, `device_category`, `operating_system`, `platform`
- `authenticated`, `subscription_id`, `subscription_trial_claimed`, `activity_created`
- `country`, `city`, `language`, `age`, `gender`

### Usage

Track and limit API usage:

```javascript
// The pipeline attaches `ctx.usage` to every route. Attaching is I/O-free:
// the counter resolves the account on its first consume()/read()
const usage = ctx.usage;

// Read the state WITHOUT counting: the effective limit (per-user overrides
// applied), both counters, and what is left of each
const state = await usage.read('requests');
// → { limit, planLimit, override, used, left, day: { limit, used, left }, ... }

// Count a use: check both counters, refuse with a 429 naming which one hit,
// else count and write. Returns what is left.
const left = await usage.consume('requests');       // { used, left, day: { used, left } }
await usage.consume('requests', 5);                 // a bigger bite

// Whitelist keys (they never get refused, and still count)
usage.addWhitelistKeys(['another-key']);

// An anonymous key is EXPLICIT — a SEPARATE counter, so a key can never move a
// signed-in user's own counters into the anonymous store
await usage.forKey(ctx.request.geolocation.ip).consume('signups', 1, { limit: 5 });

// Another account is EXPLICIT too: a SEPARATE counter on users/{uid}, so that
// account's plan decides and the use counts against it, never the caller
await usage.forUser(sellerUid).consume('reviews');
```

A feature is defined ONCE in the top-level `features` catalog (name, icon, definition, and the `usage` block that meters it); each product names only its VALUE. Mirrors are declared there too — no call-site mirror API. Full reference: [docs/backend/usage-rate-limiting.md](../../docs/backend/usage-rate-limiting.md).

### The Request Pipeline

Every request (the built-in `omega_api`, your own function through `omega.routes.run()`, the custom server) passes one ordered list of steps (`src/omega/pipeline.js`):

1. Refuses a route path outside the routes directory, and a `test/` route in production
2. Parses multipart form data
3. Logs request details (credentials redacted)
4. Answers a `wakeup` request and stops
5. Loads the route handler (method-specific or index.js)
6. Authenticates the caller into `ctx.user`
7. Initializes usage tracking and analytics
8. Validates the input against the schema into `data`, then trims it (and strips HTML when `sanitize` is on)
9. Calls your route handler

### Settings

The pipeline's validation step: it loads `schemas/{name}/{method}.js` (else `index.js`), calls it with `{ user, body, query, path, method, headers, geolocation }`, and validates the input into `ctx.data`. Full contract: [docs/backend/schemas.md](../../docs/backend/schemas.md).

### Utilities

Batch operations and helper functions:

```javascript
const utilities = omega.utilities;

// Batch iterate Firestore collection
const results = await utilities.iterateCollection(
  async ({ docs }, batch, totalCount) => {
    for (const doc of docs) {
      // Process each document
    }
    return { processed: docs.length };
  },
  {
    collection: 'users',
    batchSize: 1000,
    maxBatches: 10,
    where: [{ field: 'subscription.product.id', operator: '==', value: 'premium' }],
    orderBy: { field: 'metadata.created.timestamp', direction: 'desc' },
    startAfter: 'lastDocId',
    log: true,
  }
);

// Batch iterate Firebase Auth users
await utilities.iterateUsers(
  async ({ users, pageToken }, batch) => {
    for (const user of users) {
      // Process each auth user
    }
  },
  {
    batchSize: 1000,
    maxBatches: Infinity,
    log: true,
  }
);

// Get document with owner user
const { document, user } = await utilities.getDocumentWithOwnerUser('posts/abc123', {
  owner: 'owner',
  resolve: {
    schema: 'posts',
    ctx: ctx,
    checkRequired: false,
  },
});

// Generate random ID
const id = utilities.randomId({ size: 14 }); // 'A1b2C3d4E5f6G7'

// Cached Firestore read
const doc = await utilities.get('users/abc123', {
  maxAge: 1000 * 60 * 5, // 5 minute cache
  format: 'data',        // 'raw' or 'data'
});
```

### Metadata

Stamp a document's `metadata` block (`updated` and a `tag`; `created` is never touched):

```javascript
ctx.metadata({ tag: 'my-operation' }, document);
// document.metadata:
// {
//   updated: { timestamp: '...', timestampUNIX: ... },
//   tag: 'my-operation'
// }
```

### Local Storage

Persistent JSON storage using lowdb:

```javascript
const storage = omega.storage({
  name: 'myStorage',     // Storage name (default: 'main')
  temporary: false,      // Use OS temp directory (default: false)
  clear: true,           // Clear on dev startup (default: true)
  log: false,            // Enable logging
});

// lowdb API
storage.set('key', 'value').write();
const value = storage.get('key').value();
storage.set('nested.path', { data: true }).write();
```

## Authentication

@omega.js/backend supports multiple authentication methods (checked in order):

1. **Bearer Token (JWT)**
   ```
   Authorization: Bearer <firebase-id-token>
   ```

2. **API Key**
   ```javascript
   { apiKey: 'user-private-key' }
   // or
   { authenticationToken: 'user-private-key' }
   ```

3. **OMEGA Admin Key** (Admin access — header only, never query/body)
   ```
   omega-admin-key: <OMEGA_ADMIN_KEY>
   ```
   A separate lane from `Authorization` (which stays user-only), so one request can be admin-authenticated AND carry a user token at the same time.

4. **Session Cookie**
   ```
   Cookie: __session=<firebase-id-token>
   ```

**The authenticated caller** is `ctx.user` (the route's `user`), a `User`:

```javascript
user.authenticated;       // true
user.auth;                // { uid: 'abc123', email: 'user@example.com' }
user.roles;               // { admin: false, betaTester: false, developer: false }
user.subscription;        // { product: { id: 'basic', name: 'Basic' }, status: 'active', ... }
user.api;                 // { clientId: '...', privateKey: '...' }
user.plan;                // 'basic'
```

The pipeline authenticates once per request before the route runs; `ctx.authenticate()` resolves the same answer for code outside the pipeline.

## CLI Commands

@omega.js/backend includes a CLI for development and deployment:

```bash
# Install globally or use npx
npm install -g @omega.js/backend
# or
npx @omega.js/backend <command>
```

| Command | Description |
|---------|-------------|
| `mgr setup` | Run Firebase project setup and validation |
| `mgr serve` | Start local Firebase emulator |
| `mgr deploy` | Deploy functions to Firebase |
| `mgr test [paths...]` | Run integration tests |
| `mgr emulator` | Start Firebase emulator (keep-alive mode; HTTPS proxy on the public port, `--no-https` for plain http) |
| `mgr stripe` | Start Stripe CLI webhook forwarding to local server |
| `mgr version`, `mgr v` | Show @omega.js/backend version |
| `mgr clear` | Clear cache and temp files |
| `mgr install`, `mgr i` | Install @omega.js/backend (local — links every `@omega.js/*` dep from the Omega monorepo — or production) |
| `mgr clean` | Clean and reinstall npm modules (alias `clean:npm`) |
| `mgr help`, `mgr -h` | Print the command listing; bare `mgr` runs `setup`, unknown commands print the listing and exit 1 |
| `mgr firestore:indexes:get` | Get Firestore indexes |
| `mgr cwd` | Show current working directory |
| `mgr firestore:get <path>` | Read a Firestore document |
| `mgr firestore:set <path> '<json>'` | Write/merge a Firestore document (emulator unless `--production`) |
| `mgr firestore:query <collection>` | Query a Firestore collection |
| `mgr firestore:delete <path>` | Delete a Firestore document (emulator unless `--production`) |
| `mgr auth:get <uid-or-email>` | Get an Auth user by UID or email |
| `mgr auth:list` | List Auth users |
| `mgr auth:delete <uid-or-email>` | Delete an Auth user (emulator unless `--production`) |
| `mgr auth:set-claims <uid-or-email> '<json>'` | Set custom claims on an Auth user (emulator unless `--production`) |
| `mgr logs:read` | Fetch Cloud Function logs from Google Cloud Logging |
| `mgr logs:tail` | Stream live Cloud Function logs |

Every Firestore/Auth subcommand — reads and writes alike — targets the local emulator by default and reaches live only with `--production` (one rule, no exceptions; `--emulator` is accepted but just names the default). All of them support `--force` to skip confirmation and `--raw` for compact JSON output, and every one prints the stack it hit.

Logs commands support `--fn <name>` (function name filter), `--severity <level>`, `--since <duration>` (read only), `--limit <n>` (read only), and `--raw`. Requires `gcloud` CLI installed and authenticated.

## Environment Variables

Set these in your `functions/.env` file:

| Variable | Description |
|----------|-------------|
| `OMEGA_ADMIN_KEY` | Admin authentication key |
| `STRIPE_SECRET_KEY` | Stripe secret key (enables auto webhook forwarding in `serve`/`emulator`) |

## Response Headers

@omega.js/backend attaches metadata to responses:

```
omega-properties: {"code":200,"tag":"functionName/executionId","usage":{...},"schema":{...}}
```

## Testing

@omega.js/backend includes an integration test framework that runs against the Firebase emulator.

### Running Tests

```bash
# Option 1: Two terminals (recommended for development)
npx omega emulator  # Terminal 1 - keeps emulator running
npx omega test      # Terminal 2 - runs tests

# Option 2: Single command (auto-starts emulator, shuts down after)
npx omega test
```

`npx omega emulator` **seeds the test personas on boot** (same wipe-and-create pass the test runner uses), so an emulator-connected dev site is signin-able immediately — any persona email + the deterministic `TEST_ACCOUNT_PASSWORD` (`omega-test-password`). Pass `--no-seed` to boot without seeding. Seeding is non-fatal: if it fails (e.g. missing config), the emulator keeps running. See [docs/backend/test-framework.md](../../docs/backend/test-framework.md#personas-n6).

**Ports auto-allocate (N7)**: boot resolves each emulator port from firebase.json, bumping +1 when taken — so a second brand's emulator runs ALONGSIDE the first instead of killing it (bumped runs boot via a generated, gitignored `firebase.resolved.json`; the committed firebase.json never changes). The resolved map publishes to `.temp/ports.json` (sibling processes — `omega test` reads it automatically) and `OMEGA_<NAME>_PORT` env (URL getters). Pin a port explicitly with the config `ports` section — pins never bump (busy pin = hard error). Single-brand dev on free defaults behaves exactly as before. `mgr serve` and `mgr emulator` allocate the same way (`--port` pins) and publish `https` (the mkcert proxy on the public port) + `hosting` (the internal plain-http port) so siblings — including `omega dev`'s page chrome — follow even a bumped run; Stripe forwarding targets the resolved plain-http port. Plain-http requests to the public port get a 307 redirect to https (typing `http://localhost:5002` lands in the right place). Pass `--no-https` (or run without mkcert installed) for plain http on the public port; the emulator an `omega test` run auto-starts is always plain.

### Extended Mode (real APIs)

Pass `--extended` (or set `TEST_EXTENDED_MODE=true`) on the **test command** to opt into real external API calls (SendGrid, Beehiiv, Stripe webhook handlers, marketing libraries). `--extended` is the CLI shorthand for the shared, unprefixed `TEST_EXTENDED_MODE` env var standardized across all four frameworks; the two forms are equivalent. The mode flows automatically to BOTH the test-runner subprocess and the running emulator (via `<projectRoot>/.temp/test-mode.json`), so there is no need to set it on the emulator too:

```bash
# Terminal 1 — start once, no flag needed
npx omega emulator

# Terminal 2 — toggle freely between runs
npx omega test --extended ...                 # extended mode (--extended sets TEST_EXTENDED_MODE)
TEST_EXTENDED_MODE=true npx omega test ...    # identical — the env-var form
npx omega test ...                            # normal mode (next run flips back)
```

See [docs/backend/test-framework.md](../../docs/backend/test-framework.md#extended-mode-test_extended_mode) for the full mechanism.

### Filtering Tests

```bash
npx omega test rules/             # Project rules tests (bare paths = project source; C5 — docs/shared/testing.md)
npx omega test framework:rules/   # Only @omega.js/backend's rules tests (aliases: omega:, mgr:, backend:)
npx omega test full:rules/        # Both sources
npx omega test user/ admin/       # Multiple project paths
```

### Log Files

@omega.js/backend CLI commands automatically save their output — two lanes, two homes.

The **verb** tees its own run to `<projectDir>/logs/`, the lane every OMEGA framework shares:
- **`logs/dev.log`** — `npx omega serve` / `npx omega emulator` (port allocation, the proxy, the watcher)
- **`logs/build.log`** — `npx omega build`
- **`logs/test.log`**: `npx omega test` (setup lines, port summary, emulator boot, and the test runner's own output)

The firebase **children** write to `<projectDir>/dist/`, alongside firebase-tools' own `*-debug.log` files so everything is grep-able from one place:
- **`dist/dev.log`** — the `firebase serve` child
- **`dist/emulator.log`** — full emulator + Cloud Functions output
- **`dist/deploy.log`** — `npx omega deploy`
- **`dist/production.log`** — Production Cloud Function logs (`npx omega logs:read` or `npx omega logs:tail`)

Every log is truncated on each run (`logs/` is gitignored; `dist/` output is gitignored via `*.log`), and the stale-log sweep at each verb start clears ours while deliberately leaving firebase-tools' debug logs alone. Read them to debug failing tests or review function output instead of restarting a long-running process. Transient internal artifacts (reset sentinels, watch trigger, `test-mode.json`) live separately in `<projectDir>/.temp/`. The cross-framework contract and the full path table: `docs/shared/logging.md` in the Omega repo.

### Test Locations

- **@omega.js/backend core tests:** `test/`
- **Project tests:** `functions/test/`

Bare runs and bare paths are PROJECT-scoped (C5); reach the framework corpus explicitly with `framework:`/`omega:`/`mgr:`/`backend:`, or `full:` for both. Grammar: docs/shared/testing.md in the Omega repo.

### Writing Tests

A case file exports its spec through `defineCases`, from the public test API (`@omega.js/backend/test`). Every case receives the real `omega` instance, a real `ctx`, `http`, `accounts`, `firestore` and the rest of the emulator layer's extras, and asserts with the `expect` it receives beside them (`toBe`, `toEqual`, `toBeTruthy`, `toBeSuccess()`, `toBeError(status)`, `toHaveProperty`, `toContain`, `toBeTypeOf`, `expect.fail` and the rest of devkit's matchers). The test command runs every suite in ONE process on devkit's shared runner and ends on one Results block; `--filter=<text>`, `--extended`, `--lane=<name>` and `--reporter=json` shape the run. An optional `test/_init.js` is a factory, `({ projectRoot, config, omega, ctx }) => ({ accounts, setup })`, that declares extra test accounts and seeds fixtures; if it fails to load or throws, the run stops and names the file.

**Suite** - Sequential tests with shared state (stops on first failure):

```javascript
// test/user/sign-up.test.js
const { defineCases } = require('@omega.js/backend/test');

module.exports = defineCases({
  description: 'User signup flow with affiliate tracking',
  type: 'suite',
  tests: [
    {
      name: 'verify-referrer-exists',
      async run({ firestore, expect, state, accounts }) {
        state.referrerUid = accounts.referrer.uid;
        const doc = await firestore.get(`users/${state.referrerUid}`);
        expect(doc, 'Referrer should exist').toBeTruthy();
      },
    },
    {
      name: 'call-user-signup-with-affiliate',
      async run({ http, expect, state }) {
        const response = await http.as('signup-referred').post('omega/user/signup', {
          attribution: { affiliate: { code: 'TESTREF' } },
        });
        expect(response).toBeSuccess();
      },
    },
  ],
});
```

**Group** - Independent tests (continues even if one fails):

```javascript
// test/admin/firestore-write.test.js
const { defineCases } = require('@omega.js/backend/test');

module.exports = defineCases({
  description: 'Admin Firestore write operation',
  type: 'group',
  tests: [
    {
      name: 'admin-auth-succeeds',
      auth: 'admin',
      async run({ http, expect }) {
        const response = await http.post('omega/admin/firestore', {
          path: '_test/doc',
          document: { test: 'value' },
        });
        expect(response).toBeSuccess();
      },
    },
    {
      name: 'unauthenticated-rejected',
      auth: 'none',
      async run({ http, expect }) {
        const response = await http.post('omega/admin/firestore', {
          path: '_test/doc',
          document: { test: 'value' },
        });
        expect(response).toBeError(401);
      },
    },
  ],
});
```

**Auth levels:** `none`, `user`/`basic`, `admin`, `premium-active`, `premium-expired` (a case's own `auth`, else its suite's, else `none`)

See [docs/backend/test-framework.md](../../docs/backend/test-framework.md) for complete test API documentation.

## Subscription System

@omega.js/backend includes a built-in payment/subscription system with Stripe and PayPal integration.

### Subscription Statuses

| Status | Meaning | User can delete account? |
|--------|---------|--------------------------|
| `active` | Subscription is current and valid (includes trialing) | No (unless `product.id === 'basic'`) |
| `suspended` | Payment failed (Stripe: `past_due`, `unpaid`) | No |
| `cancelled` | Subscription terminated (Stripe: `canceled`, `incomplete`, `incomplete_expired`) | Yes |

### Stripe Status Mapping

| Stripe Status | `subscription.status` | Notes |
|---|---|---|
| `active` | `active` | Normal active subscription |
| `trialing` | `active` | `trial.claimed = true` |
| `past_due` | `suspended` | Payment failed, retrying |
| `unpaid` | `suspended` | Payment failed |
| `canceled` | `cancelled` | Subscription terminated |
| `incomplete` | `cancelled` | Never completed initial payment |
| `incomplete_expired` | `cancelled` | Expired before completion |
| `active` + `cancel_at_period_end` | `active` | `cancellation.pending = true` |

### PayPal Status Mapping

| PayPal Status | `subscription.status` | Notes |
|---|---|---|
| `ACTIVE` | `active` | Normal active subscription |
| `SUSPENDED` | `suspended` | Payment failed or manually suspended |
| `CANCELLED` | `cancelled` | Subscription terminated |
| `EXPIRED` | `cancelled` | Billing cycles completed |

### Product Configuration

Products are defined in `config.payment.products` with flat prices and per-provider IDs:

```javascript
payment: {
  products: [
    { id: 'basic', name: 'Basic', type: 'subscription', limits: { requests: 10 } },
    {
      id: 'plus', name: 'Plus', type: 'subscription',
      limits: { requests: 100 }, trial: { days: 14 },
      prices: { monthly: 28, annually: 276 },  // also supports 'weekly' and 'daily'
      stripe: { productId: 'prod_xxx' },
      paypal: { productId: 'PROD-abc123' },
    },
    {
      id: 'boost', name: 'Boost Pack', type: 'one-time',
      prices: { once: 9.99 },
      stripe: { productId: 'prod_yyy' },
    },
  ],
}
```

### Unified Subscription Object

The same subscription shape is stored in `users/{uid}.subscription` and `payments-orders/{orderId}.subscription`:

```javascript
subscription: {
  product: {
    id: 'basic',                   // product ID from config ('basic', 'premium', etc.)
    name: 'Basic',                 // display name from config
  },
  status: 'active',                // 'active' | 'suspended' | 'cancelled'
  expires: { timestamp, timestampUNIX },
  trial: {
    claimed: false,                // has user EVER used a trial
    expires: { timestamp, timestampUNIX },
  },
  cancellation: {
    pending: false,                // true = cancel at period end
    date: { timestamp, timestampUNIX },
  },
  payment: {
    provider: null,               // 'stripe' | 'paypal' | etc.
    resourceId: null,              // provider subscription ID (e.g., 'sub_xxx')
    frequency: null,               // 'monthly' | 'annually' | 'weekly' | 'daily'
    startDate: { timestamp, timestampUNIX },
    updatedBy: {
      event: { name: null, id: null },
      date: { timestamp, timestampUNIX },
    },
  },
}
```

### Access Check Patterns

```javascript
// Is premium (paid)?
user.subscription.status === 'active' && user.subscription.product.id !== 'basic'

// Is on trial?
user.subscription.trial.claimed && user.subscription.status === 'active'

// Has pending cancellation?
user.subscription.cancellation.pending === true

// Payment failed?
user.subscription.status === 'suspended'
```

### The `User` getters

A route's `user` is a `User`, and the derived subscription facts are getters on it (the same class, and the same answers, as the browser's `omega.auth.user`):

```javascript
user.plan;        // effective plan ID right now ('basic' if cancelled/suspended)
user.active;      // an active paid plan (including trialing and cancelling)
user.trialing;    // in an active trial (status 'active' + claimed + unexpired)
user.cancelling;  // cancellation pending (status 'active' + cancellation.pending, not trialing)
user.everPaid;    // the user has ever paid
```

Prefer the getters over the manual checks above: they hold the derivation logic in one place.

## Final Words

If you are still having difficulty, open an issue in the OMEGA monorepo. It is much easier to answer questions that include your code and relevant files! So if you can provide them, we'd be extremely grateful (and more likely to help you find the answer!)

## Projects Using this Library

[Somiibo](https://somiibo.com/): A Social Media Bot with an open-source module library.
[JekyllUp](https://jekyllup.com/): A website devoted to sharing the best Jekyll themes.
[Slapform](https://slapform.com/): A backend provider for your HTML forms on static sites.
[SoundGrail Music App](https://app.soundgrail.com/): A resource for producers, musicians, and DJs.
[Hammock Report](https://hammockreport.com/): An API for exploring and listing backyard products.

Ask us to have your project listed! :)

## License

[Elastic License 2.0](LICENSE). The source is free to use and modify; a license key unlocks payments in production deploys and removes the attribution (local dev and test payments are always free); and you may not offer `@omega.js/backend` to third parties as a hosted or managed service.
