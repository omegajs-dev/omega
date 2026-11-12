const path = require('path');
const { defaultExport } = require('@omega.js/devkit/run-consumer-hook');
const safeCompare = require('../omega/helpers/safe-compare.js');

const ROLE_HIERARCHY = {
  admin: ['admin', 'user', 'public'],
  user: ['user', 'public'],
  public: ['public'],
};

/**
 * Classify a Bearer token into a role without hitting the database.
 * Actual validation happens at the route level when a tool is called.
 */
function resolveAuthInfo(token) {
  const configKey = process.env.OMEGA_ADMIN_KEY;

  if (safeCompare(token, configKey)) {
    return { role: 'admin', authType: 'adminKey', token };
  }

  if (token) {
    return { role: 'user', authType: 'userToken', token };
  }

  return { role: 'public', authType: 'none', token: '' };
}

/**
 * Filter tools to only those visible for a given role.
 * admin → all, user → user + public, public → public only.
 */
function filterToolsByRole(tools, role) {
  const allowed = ROLE_HIERARCHY[role] || ROLE_HIERARCHY.public;

  return tools.filter((tool) => allowed.includes(tool.role || 'admin'));
}

/**
 * Load consumer MCP tools from the staged `dist/mcp.js` (authored at
 * `src/mcp.js`, an ES module whose default export is the array) if it exists.
 * Returns an empty array when there is no cwd, when the file doesn't exist, and
 * when a tool lacks `name` or `description`, or both `path` and `handler` (that
 * one logged). A file that fails to load throws naming the file, its cause
 * kept; so does one that is not an ES module whose default export is an array
 * (devkit's one read), and a route tool's `path` without the leading slash
 * (the HTTP path as served, `/notes`).
 */
function loadConsumerTools(cwd) {
  if (!cwd) {
    return [];
  }

  const jetpack = require('fs-jetpack');
  const mcpPath = path.join(cwd, 'mcp.js');

  if (!jetpack.exists(mcpPath)) {
    return [];
  }

  let loaded;

  try {
    loaded = require(mcpPath);
  } catch (error) {
    throw new Error(`[@omega.js/backend:mcp] ${mcpPath} failed to load: ${error.message}`, { cause: error });
  }

  const consumerTools = defaultExport(mcpPath, loaded, 'array');

  for (const tool of consumerTools) {
    if (!tool.name || !tool.description) {
      console.error(`[@omega.js/backend MCP] Consumer tool missing name or description:`, tool);
      return [];
    }

    if (!tool.path && !tool.handler) {
      console.error(`[@omega.js/backend MCP] Consumer tool "${tool.name}" must have a path or handler`);
      return [];
    }

    // A relative path would reach the host root unprefixed and 404 on every call
    if (tool.path && !String(tool.path).startsWith('/')) {
      throw new Error(`[@omega.js/backend:mcp] Consumer tool "${tool.name}" path "${tool.path}" must be the HTTP path as served, starting with "/" (e.g. "/notes")`);
    }

    tool.role = tool.role || 'admin';
    tool._consumer = true;
  }

  return consumerTools;
}

/**
 * Merge built-in and consumer tools into a Map.
 * Consumer tools with the same name override built-ins.
 */
function buildToolMap(builtinTools, consumerTools) {
  const map = new Map();

  for (const tool of builtinTools) {
    map.set(tool.name, tool);
  }

  for (const tool of consumerTools) {
    map.set(tool.name, tool);
  }

  return map;
}

/**
 * Answer a request with a JSON body (the MCP HTTP surface's one JSON door:
 * handler.js and oauth.js both answer through it).
 */
function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

module.exports = {
  resolveAuthInfo,
  filterToolsByRole,
  loadConsumerTools,
  buildToolMap,
  sendJson,
  ROLE_HIERARCHY,
};
