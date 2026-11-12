/**
 * The router: an incoming request's URL to a route path, and a route path to
 * what serves it (the MCP endpoint, else a framework route). `omega_api` and
 * `/omega/*` are the framework's own: a consumer route rides its own Cloud
 * Function and hosting rewrite (`omega.routes.run()`), never this dispatch.
 */
const path = require('path');
const pipeline = require('./pipeline.js');

// The framework's own route and schema trees
const FRAMEWORK_ROUTES_DIR = path.resolve(__dirname, './routes');
const FRAMEWORK_SCHEMAS_DIR = path.resolve(__dirname, './schemas');

/**
 * The route path of a request: its path with the `/omega/` or `/omega_api/`
 * (direct Cloud Function URL) prefix stripped, else with the leading slash
 * stripped. The prefix must be a WHOLE first segment (longest alternative
 * first, then a slash or the end of the path), so /omega_api/… is never eaten
 * by `omega` and /omegatron/… is not a prefixed path at all.
 * @param {object} req - the request (only `req.path` is read).
 * @returns {string} the route path (e.g. /omega/user/sign-up → user/sign-up).
 */
function resolveRoutePath(req) {
  const urlPath = req.path || '';

  return urlPath
    .replace(/^\/(omega_api|omega)(\/|$)/, '')
    .replace(/^\//, '');
}

/**
 * Check if a routePath is an MCP-related route and normalize it.
 * Handles /omega/mcp/* paths and /.well-known/oauth-* discovery.
 *
 * @param {string} routePath - Resolved route path from resolveRoutePath()
 * @returns {string|null} - Normalized MCP route path, or null if not MCP
 */
function resolveMcpRoutePath(routePath) {
  // Direct MCP paths (via /mcp/* or /omega/mcp/*)
  if (routePath === 'mcp' || routePath.startsWith('mcp/')) {
    return routePath;
  }

  // OAuth discovery (via /.well-known/oauth-*)
  if (routePath === '.well-known/oauth-protected-resource'
    || routePath === '.well-known/oauth-authorization-server') {
    return routePath;
  }

  // Root-level OAuth paths: Claude Chat sends these directly
  // regardless of what the discovery endpoints return
  if (routePath === 'authorize') {
    return 'mcp/authorize';
  }
  if (routePath === 'token') {
    return 'mcp/token';
  }
  if (routePath === 'register') {
    return 'mcp/register';
  }

  return null;
}

/**
 * Serve one `omega_api` request: the MCP endpoint bypasses the pipeline and
 * speaks its protocol directly; everything else runs the pipeline against the
 * framework's route of that name.
 * @param {object} omega - the Omega instance.
 * @param {object} req - the request.
 * @param {object} res - the response.
 * @returns {*} the dispatch's result.
 */
function dispatch(omega, req, res) {
  const routePath = resolveRoutePath(req);
  const mcpRoutePath = resolveMcpRoutePath(routePath);

  if (mcpRoutePath) {
    return pipeline.cors(req, res, async () => {
      const { handleMcpRoute } = require('../mcp/handler.js');
      const { sendJson } = require('../mcp/utils.js');

      // cors() drops what this callback returns, so a throw left here is never answered
      try {
        await handleMcpRoute(req, res, { omega, routePath: mcpRoutePath });
      } catch (error) {
        console.error('[@omega.js/backend MCP] Request failed:', error);

        if (res.headersSent) {
          res.end();
          return;
        }

        sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: error.message } });
      }
    });
  }

  return pipeline.run(omega, routePath, req, res, {
    routesDir: FRAMEWORK_ROUTES_DIR,
    schemasDir: FRAMEWORK_SCHEMAS_DIR,
    schema: routePath,
  });
}

module.exports = {
  resolveRoutePath,
  resolveMcpRoutePath,
  dispatch,
  FRAMEWORK_ROUTES_DIR,
  FRAMEWORK_SCHEMAS_DIR,
};
