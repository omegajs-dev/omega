/**
 * The request pipeline: what every HTTP request passes through between the
 * router and the route handler, as ONE ordered list of named steps.
 *
 * Both request paths converge here: the deployed `omega_api` function and the
 * custom server's express routes (index.js), and a consumer's own Cloud
 * Function through `omega.routes.run()`. Each step reads and writes one shared state
 * (`{ omega, ctx, req, res, routePath, options, handler, settings }`) and
 * returns true when it ENDED the request (a response went out); `run()` stops
 * there. The route handler receives `{ ctx, omega, user, data, usage, analytics }`.
 */
const path = require('path');
const fs = require('fs');
const { merge } = require('lodash');
const JSON5 = require('json5');
const Context = require('./context.js');
const Settings = require('./services/settings.js');
const { loadHandler: loadHandlerFile } = require('./libraries/load-handler.js');
const { projectUserForLog, redactHeadersForLog, redactDataForLog, safeStringify } = require('./helpers/log-redaction.js');

// The one CORS policy every request passes (the MCP lane and the custom server included)
const cors = require('cors')({ origin: true });

// The `test/` route folder is DEVELOPMENT-ONLY: it exists to exercise the
// framework (echo the settings engine, increment a usage counter, reset a
// seeded persona), and nothing in it belongs at a production URL. There are
// no exceptions: the liveness + version probe a PRODUCTION host is checked
// through is a real route, `routes/health`.
const DEV_ONLY_ROUTE_FOLDER = 'test';

/**
 * The route path's segments, normalized the SAME way the loader's
 * path.resolve() below will read it. The router takes this straight off the
 * request URL, so every decision must key off the normalized form or a caller
 * walks past it with `./`, `//` or `x/../` and still lands on the handler.
 * @param {string} routeName - Route path (e.g. 'test/usage', './test/usage')
 * @returns {string[]} Segments ('x/../test/usage' → ['test', 'usage'])
 */
function normalizeRouteSegments(routeName) {
  return path.posix
    .normalize(String(routeName || '').replace(/\.js$/, '').toLowerCase())
    .split('/')
    .filter((segment) => segment && segment !== '.');
}

/**
 * Whether a route path names something OUTSIDE the routes directory. A leading
 * `..` is refused even when it climbs back in (`../routes/test/usage` resolves
 * right back to `routes/test/usage`, walking past every folder-level gate), and
 * an absolute path is refused because path.resolve() would hand it the whole
 * filesystem (`/omega/../schemas/test/usage` otherwise require()s a schema
 * module as a handler).
 * @param {string} routeName - Route path
 * @returns {boolean}
 */
function isRouteOutsideRoutesDir(routeName) {
  const raw = String(routeName || '').replace(/\.js$/, '');

  if (path.posix.isAbsolute(raw)) {
    return true;
  }

  return normalizeRouteSegments(raw)[0] === '..';
}

/**
 * Whether a route must be refused because it belongs to a development-only
 * folder and this is production. ONE guard for the whole folder instead of a
 * copy per handler, so a NEW `routes/test/*` file is gated the day it lands.
 * @param {string} routeName - Route path (e.g. 'test/usage', 'user/sign-up')
 * @param {string} environment - omega.getEnvironment() ('development' | 'testing' | 'production')
 * @returns {boolean}
 */
function isDevOnlyRouteBlocked(routeName, environment) {
  const segments = normalizeRouteSegments(routeName);

  if (segments[0] !== DEV_ONLY_ROUTE_FOLDER) {
    return false;
  }

  return environment === 'production';
}

// A route path may only ever name a handler INSIDE the routes directory. It
// arrives off the request URL, and the loader feeds it straight to
// path.resolve(), so anything that climbs out is refused FIRST, before any
// folder-level gate keys off a path that resolve() would rewrite.
function guardRoutePath({ ctx, routePath }) {
  if (isRouteOutsideRoutesDir(routePath)) {
    ctx.log(`Middleware.run(): Refused ${routePath} — a route path may not escape the routes directory`);
    ctx.respond('Not found', {code: 404});

    return true;
  }
}

// Development-only route folders are 404'd in production. This is the one place
// every request path converges, so gating here gates every test route at once,
// including any added later.
function guardDevOnly({ ctx, routePath }) {
  if (isDevOnlyRouteBlocked(routePath, ctx.getEnvironment())) {
    ctx.log(`Middleware.run(): Refused ${routePath} — the ${DEV_ONLY_ROUTE_FOLDER}/ route folder is development-only`);
    ctx.respond('Not found', {code: 404});

    return true;
  }
}

// The pipeline's options, defaulted. routesDir/schemasDir default to the consumer's own.
function resolveOptions({ omega, routePath, options }) {
  options.authenticate = typeof options.authenticate === 'boolean' ? options.authenticate : true;
  options.setupAnalytics = typeof options.setupAnalytics === 'boolean' ? options.setupAnalytics : true;
  options.setupUsage = typeof options.setupUsage === 'boolean' ? options.setupUsage : true;
  options.validate = typeof options.validate === 'undefined' ? true : options.validate;
  options.sanitize = typeof options.sanitize === 'undefined' ? false : options.sanitize;
  options.includeUnknown = typeof options.includeUnknown === 'undefined' ? false : options.includeUnknown;
  options.schema = typeof options.schema === 'undefined' ? routePath : options.schema;
  options.parseMultipart = typeof options.parseMultipart === 'undefined' ? true : options.parseMultipart;
  options.routesDir = typeof options.routesDir === 'undefined' ? `${omega.cwd}/routes` : options.routesDir;
  options.schemasDir = typeof options.schemasDir === 'undefined' ? `${omega.cwd}/schemas` : options.schemasDir;
}

// Parse multipart/form-data: the body is the `json` field whole, or the fields
async function parseMultipart({ ctx, req, options }) {
  if (!options.parseMultipart || !req.headers['content-type']?.includes('multipart/form-data')) {
    return;
  }

  try {
    const parsed = await ctx.parseMultipart();

    if (parsed.fields.json) {
      ctx.request.body = JSON5.parse(parsed.fields.json || '{}');
    } else {
      ctx.request.body = parsed.fields;
    }

    // Re-assign data how the Context normally does it
    ctx.request.data = merge({}, ctx.request.body, ctx.request.query);

    ctx.log(`Middleware.run(): Parsed multipart form data successfully`);
  } catch (e) {
    ctx.respond(new Error(`Failed to parse multipart form data: ${e.message}`), {code: 400});

    return true;
  }
}

// The request trace and its headers, credentials redacted (helpers/log-redaction.js)
function logRequest({ ctx }) {
  const { data, headers, geolocation } = ctx.request;
  const method = ctx.request.method.toLowerCase();
  const strippedUrl = stripUrl(ctx.request.url);

  ctx.log(`Middleware.process(): Request (${geolocation.ip || 'unknown'} @ ${geolocation.country || '?'}, ${geolocation.region || '?'}, ${geolocation.city || '?'}) [${method} > ${strippedUrl}]`, safeStringify(redactDataForLog(data)));
  ctx.log(`Middleware.process(): Headers`, safeStringify(redactHeadersForLog(headers)));
}

// Wakeup trigger: quit immediately, before the route module is even required,
// so a warm-up ping costs nothing but the cold start it exists to absorb
function wakeup({ ctx }) {
  if (ctx.request.data.wakeup) {
    ctx.log(`Middleware.process(): Wakeup activated at ${new Date().toISOString()}`);
    ctx.respond({wakeup: true});

    return true;
  }
}

// Load the handler: the method file (get.js, post.js) first, then index.js.
// Existence is checked BEFORE require so a route module's own broken require
// can't be mistaken for a missing file, and a route DIR with neither file for
// this method answers an honest 405 instead of a 500.
function loadHandler(state) {
  const { ctx, routePath, options } = state;
  const method = ctx.request.method.toLowerCase();
  const routesDir = path.resolve(options.routesDir, routePath.replace('.js', ''));

  try {
    const methodFile = `${method}.js`;
    const methodFilePath = path.resolve(routesDir, methodFile);
    const indexPath = path.resolve(routesDir, 'index.js');

    if (fs.existsSync(methodFilePath)) {
      state.handler = loadHandlerFile(methodFilePath);
      ctx.log(`Middleware.process(): Loaded route: ${methodFile}`);
    } else if (fs.existsSync(indexPath)) {
      state.handler = loadHandlerFile(indexPath);
      ctx.log(`Middleware.process(): Method-specific file (${methodFile}) not found, using index.js`);
    } else if (fs.existsSync(routesDir)) {
      ctx.respond(new Error(`Method not allowed: ${method.toUpperCase()} is not supported by ${routePath}`), {code: 405});

      return true;
    } else {
      ctx.respond(new Error(`Unable to load route @ (${routePath}): route does not exist`), {code: 404});

      return true;
    }
  } catch (e) {
    ctx.respond(new Error(`Unable to load route @ (${routePath}): ${e.message}`), {code: 500});

    return true;
  }
}

// Resolve the caller into ctx.user
async function authenticate({ ctx, options }) {
  if (options.authenticate) {
    await ctx.authenticate();
  }
}

// The usage counter: LAZY ([#647](https://github.com/Omega-JS-Stack/omega/issues/647)).
// Building it costs nothing, and it resolves the account on its first
// consume()/read(), so a route that never counts never pays for one.
function attachUsage({ ctx, options }) {
  // Reading the getter builds the counter now, bound to this request
  if (options.setupUsage) {
    void ctx.usage;
  }
}

// The caller, as an allow-listed projection (never the document: it carries api.privateKey)
function logUser({ ctx }) {
  const user = ctx.user;

  ctx.log(`Middleware.process(): User (${user.auth.uid}, ${user.auth.email}, ${user.subscription.product.id}=${user.subscription.status} (resolved: ${user.plan})):`, safeStringify(projectUserForLog(user)));
}

// Analytics as the caller: the uid, else the IP, else 'unknown'
function attachAnalytics({ ctx, options }) {
  // Reading the getter builds it now, with the caller just authenticated
  if (options.setupAnalytics) {
    void ctx.analytics;
  }
}

// Validate the input against the route's schema into ctx.data (the instance is
// held: the sanitize pass reads the declaration it validated with)
function resolveData(state) {
  const { ctx, routePath, options } = state;
  const data = ctx.request.data;

  if (!options.validate) {
    ctx.data = data;

    return;
  }

  try {
    state.settings = new Settings(ctx);
    ctx.data = state.settings.resolve({ schema: options.schema, dir: path.resolve(options.schemasDir), routePath });
  } catch (e) {
    ctx.respond(new Error(`Unable to resolve schema ${options.schema}: ${e.message}`), {code: e.code || 500});

    return true;
  }

  // Merge the validated input over the raw one, so undeclared keys reach the route too
  if (options.includeUnknown) {
    ctx.data = merge(data, ctx.data);
  }

  // Log multipart files if they exist
  const files = ctx.request.multipart.files || {};
  if (files) {
    ctx.log(`Middleware.process(): Multipart files`, safeStringify(files));
  }
}

// Trim whitespace on every string of the input (always on: harmless and useful)
function trim({ omega, ctx }) {
  ctx.data = omega.utilities.trim(ctx.data);
}

// Optional HTML strip (off by default, opt in with `{ sanitize: true }`); respects
// `sanitize: false` on individual schema fields. Sanitize at the HTML-insertion
// site instead unless you need a belt-and-suspenders pass here.
function sanitize({ omega, ctx, options, settings }) {
  if (options.sanitize) {
    ctx.data = sanitizeWithSchema(omega.utilities, ctx.data, settings ? settings.declaration : null);
  }

  ctx.log(`Middleware.process(): Resolved settings with schema=${options.schema}`, safeStringify(ctx.data));
}

// Run the route. The route answers through ctx.respond() itself; a throw or a
// rejection is answered here with its own code.
function runHandler({ omega, ctx, handler }) {
  const context = {
    ctx: ctx,
    omega: omega,
    user: ctx.user,
    data: ctx.data,
    usage: ctx.usage,
    analytics: ctx.analytics,
  };

  try {
    handler(context)
      .catch(e => {
        return ctx.respond(e, {code: e.code});
      });
  } catch (e) {
    ctx.respond(e, {code: e.code});
  }
}

// The request pipeline, in order
const STEPS = [
  guardRoutePath,
  guardDevOnly,
  resolveOptions,
  parseMultipart,
  logRequest,
  wakeup,
  loadHandler,
  authenticate,
  attachUsage,
  logUser,
  attachAnalytics,
  resolveData,
  trim,
  sanitize,
  runHandler,
];

/**
 * Run one request through the pipeline.
 * @param {object} omega - the Omega instance.
 * @param {string} routePath - the route path (e.g. 'user/sign-up').
 * @param {object} req - the request.
 * @param {object} res - the response.
 * @param {object} [options] - the pipeline options (see resolveOptions).
 * @returns {*} what cors() returns.
 */
function run(omega, routePath, req, res, options) {
  return cors(req, res, async () => {
    const state = {
      omega: omega,
      ctx: new Context(omega, { req, res }),
      req: req,
      res: res,
      routePath: routePath,
      options: options || {},
      handler: null,
      settings: null,
    };

    for (const step of STEPS) {
      if (await step(state)) {
        return;
      }
    }
  });
}

// `fields` is the declaration level that describes obj (a nested object's `fields`)
function sanitizeWithSchema(utilities, obj, fields) {
  // Not an object: sanitize directly
  if (obj == null || typeof obj !== 'object') {
    return utilities.sanitize(obj);
  }

  // Arrays: sanitize each item (no schema for array items)
  if (Array.isArray(obj)) {
    return obj.map(item => utilities.sanitize(item));
  }

  // Objects: walk keys, skip fields declared sanitize: false
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const field = fields ? fields[key] : null;

    if (field && field.sanitize === false) {
      result[key] = value;
    } else {
      result[key] = sanitizeWithSchema(utilities, value, field ? field.fields : null);
    }
  }
  return result;
}

function stripUrl(url) {
  const newUrl = new URL(url);

  return `${newUrl.host}${newUrl.pathname}`.replace(/\/$/, '');
}

module.exports = {
  run,
  cors,
  STEPS,
  isDevOnlyRouteBlocked,
  isRouteOutsideRoutesDir,
  DEV_ONLY_ROUTE_FOLDER,
};
