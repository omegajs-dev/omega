/**
 * Test: MCP utility functions
 * Tests resolveAuthInfo, filterToolsByRole, loadConsumerTools, buildToolMap
 *
 * Run: npx omega test backend:mcp/utils
 */
const expect = require('../../dist/vendor/devkit/test/expect.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

module.exports = defineCases({
  description: 'MCP utility functions',
  type: 'group',

  tests: [
    // --- resolveAuthInfo ---

    {
      name: 'resolveAuthInfo: admin key returns admin role',
      async run() {
        const { resolveAuthInfo } = require('../../dist/mcp/utils.js');
        const saved = process.env.OMEGA_ADMIN_KEY;

        try {
          process.env.OMEGA_ADMIN_KEY = 'test-admin-key';
          const result = resolveAuthInfo('test-admin-key');

          expect(result.role, 'Should be admin').toBe('admin');
          expect(result.authType, 'Should be adminKey type').toBe('adminKey');
          expect(result.token, 'Token should match').toBe('test-admin-key');
        } finally {
          process.env.OMEGA_ADMIN_KEY = saved;
        }
      },
    },

    {
      name: 'resolveAuthInfo: non-admin token returns user role',
      async run() {
        const { resolveAuthInfo } = require('../../dist/mcp/utils.js');
        const result = resolveAuthInfo('some-user-api-key');

        expect(result.role, 'Should be user').toBe('user');
        expect(result.authType, 'Should be userToken type').toBe('userToken');
      },
    },

    {
      name: 'resolveAuthInfo: empty token returns public role',
      async run() {
        const { resolveAuthInfo } = require('../../dist/mcp/utils.js');
        const result = resolveAuthInfo('');

        expect(result.role, 'Should be public').toBe('public');
        expect(result.authType, 'Should be none type').toBe('none');
        expect(result.token, 'Token should be empty').toBe('');
      },
    },

    {
      name: 'resolveAuthInfo: null/undefined token returns public role',
      async run() {
        const { resolveAuthInfo } = require('../../dist/mcp/utils.js');

        expect(resolveAuthInfo(null).role, 'null should be public').toBe('public');
        expect(resolveAuthInfo(undefined).role, 'undefined should be public').toBe('public');
      },
    },

    {
      name: 'resolveAuthInfo: returns public when OMEGA_ADMIN_KEY is not set',
      async run() {
        const { resolveAuthInfo } = require('../../dist/mcp/utils.js');
        const saved = process.env.OMEGA_ADMIN_KEY;

        try {
          delete process.env.OMEGA_ADMIN_KEY;
          const result = resolveAuthInfo('any-token');

          expect(result.role, 'Non-empty token with no config key should be user').toBe('user');
        } finally {
          process.env.OMEGA_ADMIN_KEY = saved;
        }
      },
    },

    {
      name: 'resolveAuthInfo: the admin key check goes through safeCompare',
      async run() {
        // Swap the helper in the require cache and load a fresh utils.js against it,
        // restoring both entries so later cases keep the real modules.
        const safeComparePath = require.resolve('../../dist/omega/helpers/safe-compare.js');
        const utilsPath = require.resolve('../../dist/mcp/utils.js');
        const realSafeCompare = require(safeComparePath);
        const savedSafeCompare = require.cache[safeComparePath];
        const savedUtils = require.cache[utilsPath];
        const saved = process.env.OMEGA_ADMIN_KEY;
        const calls = [];

        try {
          require.cache[safeComparePath] = {
            id: safeComparePath,
            filename: safeComparePath,
            loaded: true,
            exports: (a, b) => {
              calls.push([a, b]);
              return realSafeCompare(a, b);
            },
          };
          delete require.cache[utilsPath];
          process.env.OMEGA_ADMIN_KEY = 'test-admin-key';

          const { resolveAuthInfo } = require(utilsPath);
          const result = resolveAuthInfo('test-admin-key');

          expect(result.role, 'Should still classify the admin key as admin').toBe('admin');
          expect(calls, 'safeCompare receives the presented token and the admin key').toEqual([['test-admin-key', 'test-admin-key']]);
        } finally {
          process.env.OMEGA_ADMIN_KEY = saved;
          require.cache[safeComparePath] = savedSafeCompare;
          if (savedUtils) {
            require.cache[utilsPath] = savedUtils;
          } else {
            delete require.cache[utilsPath];
          }
        }
      },
    },

    // --- filterToolsByRole ---

    {
      name: 'filterToolsByRole: admin sees all roles',
      async run() {
        const { filterToolsByRole } = require('../../dist/mcp/utils.js');
        const tools = [
          { name: 'a', role: 'admin' },
          { name: 'b', role: 'user' },
          { name: 'c', role: 'public' },
        ];
        const result = filterToolsByRole(tools, 'admin');

        expect(result.length, 'Admin should see all 3').toBe(3);
      },
    },

    {
      name: 'filterToolsByRole: user sees user + public only',
      async run() {
        const { filterToolsByRole } = require('../../dist/mcp/utils.js');
        const tools = [
          { name: 'a', role: 'admin' },
          { name: 'b', role: 'user' },
          { name: 'c', role: 'public' },
        ];
        const result = filterToolsByRole(tools, 'user');

        expect(result.length, 'User should see 2').toBe(2);
        expect(result.some((t) => t.name === 'b'), 'Should include user tool').toBeTruthy();
        expect(result.some((t) => t.name === 'c'), 'Should include public tool').toBeTruthy();
        expect(!result.some((t) => t.name === 'a'), 'Should exclude admin tool').toBeTruthy();
      },
    },

    {
      name: 'filterToolsByRole: public sees public only',
      async run() {
        const { filterToolsByRole } = require('../../dist/mcp/utils.js');
        const tools = [
          { name: 'a', role: 'admin' },
          { name: 'b', role: 'user' },
          { name: 'c', role: 'public' },
        ];
        const result = filterToolsByRole(tools, 'public');

        expect(result.length, 'Public should see 1').toBe(1);
        expect(result[0].name, 'Should be the public tool').toBe('c');
      },
    },

    {
      name: 'filterToolsByRole: tools without role default to admin',
      async run() {
        const { filterToolsByRole } = require('../../dist/mcp/utils.js');
        const tools = [{ name: 'no-role' }];

        expect(filterToolsByRole(tools, 'admin').length, 'Admin should see role-less tool').toBe(1);
        expect(filterToolsByRole(tools, 'user').length, 'User should not see role-less tool').toBe(0);
        expect(filterToolsByRole(tools, 'public').length, 'Public should not see role-less tool').toBe(0);
      },
    },

    {
      name: 'filterToolsByRole: unknown role treated as public',
      async run() {
        const { filterToolsByRole } = require('../../dist/mcp/utils.js');
        const tools = [
          { name: 'a', role: 'admin' },
          { name: 'b', role: 'user' },
          { name: 'c', role: 'public' },
        ];
        const result = filterToolsByRole(tools, 'garbage');

        expect(result.length, 'Unknown role should see public only').toBe(1);
      },
    },

    // --- loadConsumerTools ---

    {
      name: 'loadConsumerTools: returns empty array when no cwd',
      async run() {
        const { loadConsumerTools } = require('../../dist/mcp/utils.js');

        expect(loadConsumerTools(null).length, 'null cwd').toBe(0);
        expect(loadConsumerTools('').length, 'empty cwd').toBe(0);
        expect(loadConsumerTools(undefined).length, 'undefined cwd').toBe(0);
      },
    },

    {
      name: 'loadConsumerTools: returns empty array for non-existent directory',
      async run() {
        const { loadConsumerTools } = require('../../dist/mcp/utils.js');
        const result = loadConsumerTools('/tmp/does-not-exist-12345');

        expect(result.length, 'Should return empty array').toBe(0);
      },
    },

    {
      name: 'loadConsumerTools: a route tool path without the leading slash is refused by name',
      async run() {
        const { loadConsumerTools } = require('../../dist/mcp/utils.js');
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-backend-mcp-'));

        fs.writeFileSync(path.join(cwd, 'mcp.js'), `export default [
          { name: 'list_notes', description: 'List notes', method: 'GET', path: 'notes' },
        ];`);

        expect(() => loadConsumerTools(cwd), 'the path is taken as served, so a relative one is a load-time error').toThrow(/Consumer tool "list_notes" path "notes" must be the HTTP path as served, starting with "\/"/);
      },
    },

    {
      // A half-converted file: export default beside a leftover top-level require
      name: 'loadConsumerTools: an mcp.js that throws at load is refused by name, not answered with an empty list',
      async run({ after }) {
        const { loadConsumerTools } = require('../../dist/mcp/utils.js');
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-backend-mcp-'));
        const mcpPath = path.join(cwd, 'mcp.js');

        after(() => fs.rmSync(cwd, { recursive: true, force: true }));
        fs.writeFileSync(mcpPath, `const { join } = require('node:path');

export default [
  { name: 'list_notes', description: 'List notes', method: 'GET', path: '/notes' },
];
`);

        let thrown = null;

        try {
          loadConsumerTools(cwd);
        } catch (e) {
          thrown = e;
        }

        expect(thrown, 'a broken mcp.js throws instead of answering no tools').not.toBe(null);
        expect(thrown.message, 'the load failure names the file and its cause').toContain(`${mcpPath} failed to load: require is not defined`);
        expect(thrown.cause instanceof ReferenceError, 'the cause is kept').toBe(true);
      },
    },

    // --- buildToolMap ---

    {
      name: 'buildToolMap: consumer tools override built-ins with same name',
      async run() {
        const { buildToolMap } = require('../../dist/mcp/utils.js');
        const builtin = [{ name: 'tool_a', description: 'original' }];
        const consumer = [{ name: 'tool_a', description: 'override', _consumer: true }];

        const map = buildToolMap(builtin, consumer);
        expect(map.get('tool_a').description, 'Consumer should override').toBe('override');
        expect(map.get('tool_a')._consumer, 'Should be marked as consumer').toBe(true);
      },
    },

    {
      name: 'buildToolMap: merges non-overlapping tools',
      async run() {
        const { buildToolMap } = require('../../dist/mcp/utils.js');
        const builtin = [{ name: 'a' }, { name: 'b' }];
        const consumer = [{ name: 'c' }];

        const map = buildToolMap(builtin, consumer);
        expect(map.size, 'Should have 3 tools total').toBe(3);
        expect(map.has('a'), 'Should have a').toBeTruthy();
        expect(map.has('b'), 'Should have b').toBeTruthy();
        expect(map.has('c'), 'Should have c').toBeTruthy();
      },
    },

    // --- Real tools verification ---

    {
      name: 'every built-in tool has a role assigned',
      async run() {
        const tools = require('../../dist/mcp/tools.js');

        const missing = tools.filter((t) => !t.role);
        expect(missing.length, `All tools should have roles, missing: ${missing.map((t) => t.name).join(', ')}`).toBe(0);
      },
    },

    {
      name: 'every built-in route tool path is the path as served, under /omega/',
      async run() {
        const tools = require('../../dist/mcp/tools.js');

        const stray = tools.filter((t) => !t.path.startsWith('/omega/'));
        expect(stray.length, `Every built-in path is /omega/<route>, stray: ${stray.map((t) => `${t.name}=${t.path}`).join(', ')}`).toBe(0);
      },
    },

    {
      name: 'role distribution matches expected counts',
      async run() {
        const tools = require('../../dist/mcp/tools.js');

        const admin = tools.filter((t) => t.role === 'admin');
        const user = tools.filter((t) => t.role === 'user');
        const pub = tools.filter((t) => t.role === 'public');

        expect(admin.length, `Should have 24 admin tools, got ${admin.length}`).toBe(24);
        expect(user.length, `Should have 2 user tools, got ${user.length}`).toBe(2);
        expect(pub.length, `Should have 2 public tools, got ${pub.length}`).toBe(2);
        expect(admin.length + user.length + pub.length, 'Every tool is in a known role bucket').toBe(tools.length);
      },
    },
  ],
});
