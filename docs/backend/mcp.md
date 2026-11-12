# Model Context Protocol (MCP)

@omega.js/backend includes a built-in MCP server that exposes @omega.js/backend routes as tools for Claude Chat, Claude Code, Claude Desktop, and other MCP clients. The MCP layer is a thin wrapper over the existing @omega.js/backend API: every tool maps to a route, and authentication goes through the same request pipeline.

## Architecture

Two transport modes:
- **Stdio** (local): `npx omega mcp` — for Claude Code / Claude Desktop
- **Streamable HTTP** (remote): `POST /omega/mcp` — for Claude Chat / Claude Desktop custom connectors (stateless, Firebase Functions compatible)

## Roles

Every tool has a `role` that controls who can see and call it:

| Role | Who sees it | Tool count | Examples |
|------|-------------|------------|---------|
| `admin` | Admin key connections only | 24 | `firestore_read`, `send_email`, `cancel_subscription` |
| `user` | Authenticated users + admins | 2 | `get_user`, `get_subscription` |
| `public` | Everyone (after OAuth) | 2 | `health_check`, `get_post` |

Admin sees ALL tools. User sees `user` + `public`. Unauthenticated connections get a 401 that triggers the OAuth flow — there is no unauthenticated tool access. Defense-in-depth: even if someone calls an admin tool by name, the underlying @omega.js/backend route still rejects.

Over HTTP the connection's role is its caller's, resolved ONCE per request through `Context.authenticate()`: the admin key, or an account whose doc carries `roles.admin`, is `admin`; any other account's `api.privateKey` is `user`; a token that matches no account is `public`.

## Available Tools (28)

| Tool | Role | Route | Description |
|------|------|-------|-------------|
| `firestore_read` | admin | `GET /omega/admin/firestore` | Read a Firestore document by path |
| `firestore_write` | admin | `POST /omega/admin/firestore` | Write/merge a Firestore document |
| `firestore_query` | admin | `POST /omega/admin/firestore/query` | Query a collection with where/orderBy/limit |
| `send_email` | admin | `POST /omega/admin/email` | Send transactional email via SendGrid |
| `send_notification` | admin | `POST /omega/admin/notification` | Send push notification via FCM |
| `get_user` | user | `GET /omega/user` | Get authenticated user info |
| `get_subscription` | user | `GET /omega/user/subscription` | Get subscription info for a user |
| `sync_users` | admin | `POST /omega/admin/users/sync` | Sync user data across systems |
| `list_users` | admin | `GET /omega/admin/users/list` | List users newest-first with the Auth join (providers, verified, disabled, last sign-in), email/uid prefix search, cursor pagination |
| `set_user_disabled` | admin | `POST /omega/admin/users/disable` | Disable or re-enable a user at the Auth level (disable also revokes refresh tokens) |
| `list_campaigns` | admin | `GET /omega/marketing/campaign` | List marketing campaigns |
| `create_campaign` | admin | `POST /omega/marketing/campaign` | Create a marketing campaign |
| `get_stats` | admin | `GET /omega/admin/stats` | Get system statistics |
| `cancel_subscription` | admin | `POST /omega/payments/cancel` | Cancel subscription at period end |
| `refund_payment` | admin | `POST /omega/payments/refund` | Process a refund |
| `get_payment_portal` | admin | `POST /omega/payments/portal` | Generate Stripe billing portal link |
| `update_campaign` | admin | `PUT /omega/marketing/campaign` | Update a pending campaign |
| `delete_campaign` | admin | `DELETE /omega/marketing/campaign` | Delete a pending campaign |
| `create_contact` | admin | `POST /omega/marketing/contact` | Add a marketing contact |
| `delete_contact` | admin | `DELETE /omega/marketing/contact` | Remove a marketing contact |
| `run_cron` | admin | `POST /omega/admin/cron` | Trigger a cron job by ID |
| `create_post` | admin | `POST /omega/admin/post` | Create a blog post |
| `update_post` | admin | `PUT /omega/admin/post` | Update an existing blog post |
| `get_post` | public | `GET /omega/content/post` | Fetch a post's markdown + frontmatter by URL (pairs with `update_post`) |
| `create_backup` | admin | `POST /omega/admin/backup` | Create a Firestore backup |
| `run_hook` | admin | `POST /omega/admin/hook` | Execute a custom hook |
| `generate_uuid` | admin | `POST /omega/general/uuid` | Generate a UUID |
| `health_check` | public | `GET /omega/health` | Check server health |

- `run_cron` and `run_hook` (`POST /omega/admin/cron`, `POST /omega/admin/hook`) load the named job or hook through the one handler loader: a file that is there but fails to load, or is still in the CommonJS form, fails the call loudly naming the file, never `Hook not found`.

## Tool Annotations

Every tool has MCP annotations that control how Claude Desktop categorizes and displays it:

| Field | Purpose |
|-------|---------|
| `title` | Human-readable display name (e.g. "Get authenticated user info" instead of `get_user`) |
| `readOnlyHint` | `true` → "Read-only tools" category in Claude Desktop |
| `destructiveHint` | `true` → marked as destructive (cancel, refund) |
| `idempotentHint` | `true` → safe to retry (firestore_write with merge) |
| `openWorldHint` | `true` → touches external systems (email, notifications) |

Consumer tools can set all the same annotations — they're passed through automatically.

## Authentication

### OAuth Flow (HTTP transport — Claude Desktop / Claude Chat)

1. Client sends `POST /omega/mcp` with no auth → 401 with `WWW-Authenticate` header
2. Client discovers `/.well-known/oauth-protected-resource` → finds authorization server
3. Client discovers `/.well-known/oauth-authorization-server` → gets endpoints
4. Client registers via `POST /omega/mcp/register` (RFC 7591 Dynamic Client Registration)
5. Client opens browser to `/omega/mcp/authorize`
   - If `client_id` matches admin key → auto-redirects (admin access)
   - Otherwise → redirects to consumer's website (`/token?redirect_uri=...&state=...&mcp=true`)
6. User signs in on their familiar site, gets a Firebase ID token
7. Consumer's `/token` page redirects back with `code={idToken}&state={state}`
8. Client exchanges code: `POST /omega/mcp/token` → @omega.js/backend verifies ID token, returns `api.privateKey` as `access_token`
9. Client uses the API key for all future MCP requests as `Authorization: Bearer {key}`

The consumer auth URL is resolved from `omega.getWebsiteUrl()` (auto-resolves localhost in dev, production domain otherwise), or overridden via `mcp.authUrl` in `config/omega.json5`.

### Admin (Stdio)

```bash
npx omega mcp    # Reads OMEGA_ADMIN_KEY from the .env cascade (the target's, then the brand's), staged into dist/.env: sees all 28 tools
```

### User (Stdio)

```bash
npx omega mcp --token <api-key>    # User-level — sees 4 tools (2 user + 2 public)
```

## Consumer MCP Tools

Consumer projects expose custom MCP tools via a single `src/mcp.js` file, which `omega build` stages to `dist/mcp.js` where both transports load it. Tools are automatically discovered and merged with the built-in tools.

- `mcp.js` is an ES module whose default export is the tools array.
- A CommonJS `mcp.js` (`module.exports = [...]`), or one whose default export is not an array, is refused by name, `<file> must be an ES module with one default export (export default [ ... ])`, and the load throws rather than answering an empty tool list.
- An `mcp.js` that fails to load (a leftover top-level `require(` beside `export default [` throws `require is not defined`) throws too, `[@omega.js/backend:mcp] <file> failed to load: <cause>`, the cause kept. Over HTTP a refused or broken `mcp.js` answers the request with a 500, a JSON-RPC error (`-32603`) carrying that message.
- No consumer tools are served when the backend has no cwd, when `mcp.js` is missing, or when a tool lacks `name` or `description`, or lacks both `path` and `handler` (that file's whole list is dropped, logged with `console.error`).
- No top-level `await`: the file is loaded by `require()`, which refuses an async module.

```js
// src/mcp.js
export default [
  // Route delegation — points at an existing route (works on stdio + HTTP)
  {
    name: 'get_sponsorship',
    description: 'Get sponsorship details by ID',
    role: 'user',
    method: 'GET',
    path: '/sponsorship',
    annotations: { title: 'Get sponsorship details', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Sponsorship ID' },
      },
      required: ['id'],
    },
  },

  // Handler mode — runs code directly (HTTP transport only)
  {
    name: 'my_sponsorships',
    description: 'Count the caller\'s sponsorships created in the past N days',
    role: 'user',
    annotations: { title: 'Count my sponsorships', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Days to look back', default: 30 },
      },
    },
    handler: async ({ ctx, omega, user, params }) => {
      // No route stands behind a handler tool to refuse a signed-out caller, so it is its own gate
      if (!user.authenticated) {
        throw new Error('Sign in to count your sponsorships');
      }

      const cutoff = Date.now() - (params.days || 30) * 86400000;
      const snapshot = await omega.firebase.admin.firestore()
        .collection('sponsorships')
        .where('owner', '==', user.uid)
        .where('metadata.created.timestampUNIX', '>=', Math.floor(cutoff / 1000))
        .get();

      ctx.log(`my_sponsorships: ${snapshot.size} for ${user.uid}`);

      return { total: snapshot.size };
    },
  },
];
```

A route tool's `path` is the HTTP path AS SERVED, and the client prefixes nothing: `/sponsorship` for a consumer route, `/omega/admin/firestore` for a built-in. A consumer route is not on `omega_api`, so it needs its own function (`omega.routes.run('sponsorship', { req, res })`) and its own hosting rewrite ([routes.md](routes.md#functions-entry-point-srcindexjs)) before a tool can reach it.

**Rules:**
- Consumer tools with the same name as a built-in tool override it
- Every tool needs `name`, `description`, and either `path` (route delegation) or `handler` (direct execution)
- A `path` starts with `/`; one without it refuses to load, naming the tool
- `role` defaults to `admin` if not specified
- Handler-based tools only work on the HTTP transport (they return an error on stdio)
- A handler tool runs with the request's `Context` as `ctx` and the resolved caller as `user` (a `User`, signed out when the token matches no account), outside the route pipeline (no schema, no `ctx.respond`): it executes directly with `{ ctx, omega, user, params }` and its return value is the tool's answer. The admin key is an admin caller with no account behind it (`user.roles.admin` true, `user.uid` null)
- All MCP-standard fields are passed through: `annotations`, `outputSchema`, `inputSchema`

## HTTPS Local Development

`npx omega serve` AND `npx omega emulator` front the public port with an HTTPS proxy (the classic `https://localhost:5002` — firebase serves internally on 5443). This enables Claude Desktop to connect locally since it requires HTTPS.

- Certificates are auto-generated via mkcert into `.temp/certs/`
- `getApiUrl()` returns `https://localhost:5002` when the HTTPS proxy is active
- Disable with `--no-https` to fall back to plain HTTP (the emulator an `omega test` run auto-starts is always plain — the harness talks http)
- Install mkcert: `brew install mkcert && mkcert -install` on macOS — the CLI prints the line for the host it is running on (choco/scoop on Windows, apt on Linux)
- The cert + proxy machinery is the shared `@omega.js/devkit/local-https` module (vendored at prepare time) — the same engine behind web's `omega dev` HTTPS

## Hosting Rewrites

The target checks `npx omega test` runs automatically add the required Firebase Hosting rewrites for MCP OAuth:

```json
{
  "source": "{/omega,/omega/**,/.well-known/oauth-protected-resource,/.well-known/oauth-authorization-server,/authorize,/token}",
  "function": "omega_api"
}
```

## Claude Desktop Configuration

1. Go to Settings → Integrations → Add Custom Integration
2. **URL:** `https://api.yourdomain.com/omega/mcp` (production) or `https://localhost:5002/omega/mcp` (local dev with HTTPS proxy)
3. For admin access: set **OAuth Client ID** to your `OMEGA_ADMIN_KEY`
4. For user access: leave Client ID empty — the OAuth flow redirects to the consumer's website for sign-in

## Claude Code Configuration

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "@omega.js/backend": {
      "command": "npx",
      "args": ["omega", "mcp"],
      "cwd": "/path/to/consumer-project"
    }
  }
}
```

## Key Files

| Purpose | File |
|---------|------|
| Tool definitions (roles + annotations) | `src/mcp/tools.js` |
| Shared utilities (auth, filtering, consumer loading) | `src/mcp/utils.js` |
| HTTP handler (discovery, the caller's role, the protocol) | `src/mcp/handler.js` |
| OAuth authorize, token, and client registration | `src/mcp/oauth.js` |
| Tool call (handler tools in-process, route tools over HTTP) | `src/mcp/call-tool.js` |
| Stdio server | `src/mcp/index.js` |
| HTTP client | `src/mcp/client.js` |
| CLI command | `src/cli/commands/mcp.js` |
| HTTPS proxy for local dev | `@omega.js/devkit/local-https` (wired in `src/cli/commands/serve.js` + `emulator.js`) |
| MCP route interception | `src/omega/router.js` (`dispatch`, `resolveMcpRoutePath`) |
| Hosting rewrites setup | `src/cli/commands/setup-tests/hosting-rewrites.js` |

## Adding New Tools

### Built-in tools (in @omega.js/backend itself)

Add a tool definition to `src/mcp/tools.js` with `name`, `description`, `role`, `method`, `path`, `annotations`, and `inputSchema`. The `path` is the route as served, `/omega/<route>` (e.g. `/omega/admin/firestore`), and the HTTP client calls it untouched.

### Consumer tools (in a consumer project)

Add an entry to `src/mcp.js`. Use `path` + `method` for route delegation (works on both transports), or `handler` for direct execution (HTTP only). The `path` is the route as served (`/notes`), and the route behind it needs its own function and hosting rewrite, since `omega_api` serves only the framework's routes. All MCP fields (`annotations`, `outputSchema`, etc.) are passed through automatically.
