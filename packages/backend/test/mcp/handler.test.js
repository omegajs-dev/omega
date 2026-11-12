/**
 * Test: the HTTP MCP endpoint answers every request, a consumer mcp.js that
 * is refused included
 *
 * Run: npx omega test backend:mcp/handler
 *
 * Each case serves the real `omega_api` dispatch on a real local server, with
 * the instance's cwd at a scratch folder holding the consumer's `mcp.js`, and
 * sends one `tools/list` request. A refused file answers a JSON-RPC 500 naming
 * it; an ES module file answers its tools.
 */
const http = require('node:http');
const path = require('node:path');
const { dispatch } = require('../../dist/omega/router.js');
const { bootOmega } = require('../helpers/_boot-omega.js');
const { scratch } = require('../helpers/_handler-cases.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

// One tools/list request through dispatch() on a real express app (parsing the
// JSON body as Cloud Functions does), its status and body, then it closes
async function listTools(omega) {
  const express = require('express');
  const app = express();

  app.use(express.json());
  app.use((req, res) => dispatch(omega, req, res));

  const server = await new Promise((resolveServer) => {
    const listening = app.listen(0, '127.0.0.1', () => resolveServer(listening));
  });

  try {
    return await new Promise((resolveAnswer, rejectAnswer) => {
      const request = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path: '/omega/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': 'Bearer no-such-key',
        },
        signal: AbortSignal.timeout(10000),
      }, (response) => {
        let text = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolveAnswer({ status: response.statusCode, text }));
      });

      request.on('error', rejectAnswer);
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    });
  } finally {
    server.close();
  }
}

// The JSON-RPC message of a body, plain JSON or its one SSE `data:` line
function message(text) {
  const data = text.split('\n').find((line) => line.startsWith('data: '));

  return JSON.parse(data ? data.slice('data: '.length) : text);
}

module.exports = defineCases({
  description: 'MCP HTTP endpoint: the consumer mcp.js',
  type: 'group',

  tests: [
    {
      name: 'a-commonjs-mcp-js-answers-a-json-rpc-500-naming-the-file',
      async run({ expect, after }) {
        const omega = bootOmega();
        omega.cwd = scratch(after, {
          'mcp.js': "module.exports = [{ name: 'list_notes', description: 'List notes', role: 'public', method: 'GET', path: '/notes' }];\n",
        });

        const answer = await listTools(omega);

        expect(answer.status, 'the refusal is answered, not left hanging').toBe(500);
        expect(message(answer.text), 'the JSON-RPC internal error names the file and the array form').toEqual({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: `${path.join(omega.cwd, 'mcp.js')} must be an ES module with one default export (export default [ ... ])`,
          },
        });
      },
    },

    {
      name: 'an-es-module-mcp-js-lists-its-tool',
      async run({ expect, after }) {
        const omega = bootOmega();
        omega.cwd = scratch(after, {
          'mcp.js': "export default [{ name: 'list_notes', description: 'List notes', role: 'public', method: 'GET', path: '/notes' }];\n",
        });

        const answer = await listTools(omega);
        const names = message(answer.text).result.tools.map((tool) => tool.name);

        expect(answer.status, 'the list is answered').toBe(200);
        expect(names, 'the consumer tool is listed').toContain('list_notes');
      },
    },
  ],
});
