const path = require('path');
const { validate, pathParams } = require('../helpers/schema.js');
const { loadHandler } = require('../libraries/load-handler.js');

// The module that issues a schema's require: a resolution failure it issues is a missing schema file
const LOADER = require.resolve('../libraries/load-handler.js');

/**
 * Settings: the request service that validates a request's input against its
 * route schema. A schema file exports a function of the request's raw parts,
 * `({ user, body, query, path, method, headers, geolocation })`, and returns a
 * plain field declaration; helpers/schema.js validates with it. The pipeline
 * runs this once per request and hands the result to the route as `data`;
 * `declaration` is kept for the sanitize pass (per-field `sanitize: false`).
 */
class Settings {
  /**
   * @param {object} ctx - the Context whose input this validates.
   */
  constructor(ctx) {
    this.ctx = ctx;

    this.declaration = null;
  }

  /**
   * Load a route's schema, call it with the request, and validate the input.
   * @param {object} options
   * @param {string} options.schema - the schema name: `<dir>/<schema>/<method>.js`, else `<dir>/<schema>/index.js`.
   * @param {string} [options.dir] - the schemas directory (default: the consumer's `schemas/`).
   * @param {string} [options.routePath] - the route path the request path's `path: true` ids follow (default: the schema name).
   * @param {object} [options.input] - the input to validate (default: the request's body and query, merged).
   * @param {object} [options.user] - the `User` the schema receives (default: ctx.user).
   * @returns {object} the validated data.
   * @throws {Error} 400 on a refusal, 500 when no schema file exists or it returns no declaration.
   */
  resolve({ schema, dir, routePath, input, user }) {
    const ctx = this.ctx;

    // ctx.request is null outside HTTP (a document resolved from a trigger)
    const request = ctx.request || {};
    const schemaName = schema.replace('.js', '');

    dir = dir || `${ctx.omega.cwd}/schemas`;
    routePath = typeof routePath === 'undefined' ? schemaName : routePath;

    // The raw parts, by name: the route receives the validated merge as `data`
    const factory = loadSchema(ctx, path.resolve(dir, schemaName), (request.method || '').toLowerCase(), schemaName);
    const declaration = factory({
      user: user || ctx.user,
      body: request.body || {},
      query: request.query || {},
      path: request.path || '',
      method: request.method || '',
      headers: request.headers || {},
      geolocation: request.geolocation || {},
    });

    if (Object.prototype.toString.call(declaration) !== '[object Object]') {
      throw ctx.report(`Invalid schema ${schemaName}: the schema function must return a plain field declaration`, {code: 500});
    }

    const { data, error } = validate(declaration, typeof input === 'undefined' ? request.data : input, {
      pathParams: pathParams(request.path, routePath),
    });

    if (error) {
      throw ctx.report(error, {code: 400});
    }

    this.declaration = declaration;

    return data;
  }
}

// The schema module: the method file (post.js) first, then index.js
function loadSchema(ctx, schemaDir, method, schemaName) {
  const methodFile = `${method}.js`;

  // Fall back only when THIS file is missing; one that loads and throws surfaces.
  // err.requireStack[0] is the module that issued the failing require: the loader
  // only when the schema file itself cannot be resolved (a message match cannot
  // tell, since Node's "Require stack:" names the schema file in both cases).
  const isMissingModule = (err) => err
    && err.code === 'MODULE_NOT_FOUND'
    && Array.isArray(err.requireStack)
    && err.requireStack[0] === LOADER;

  try {
    const factory = loadHandler(path.resolve(schemaDir, methodFile));
    ctx.log(`Settings.resolve(): Loaded method-specific schema: ${schemaName}/${methodFile}`);

    return factory;
  } catch (methodErr) {
    if (!isMissingModule(methodErr)) {
      throw methodErr;
    }
  }

  try {
    const factory = loadHandler(path.resolve(schemaDir, 'index.js'));
    ctx.log(`Settings.resolve(): Method-specific schema not found, using main schema fallback`);

    return factory;
  } catch (indexErr) {
    if (!isMissingModule(indexErr)) {
      throw indexErr;
    }

    throw ctx.report(
      `No schema for ${method.toUpperCase()} request: expected ${schemaName}/${methodFile} or ${schemaName}/index.js`,
      {code: 500},
    );
  }
}

module.exports = Settings;
