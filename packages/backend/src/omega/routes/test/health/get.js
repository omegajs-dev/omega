/**
 * GET /test/health: the liveness probe's old home, kept for the dev/testing
 * callers that still ask for it. ONE implementation: the probe is a real route
 * now (`routes/health`), and this folder is development-only, so the path 404s
 * in production like every other test route.
 */
import path from 'path';
import { loadHandler } from '../../../libraries/load-handler.js';

// Another handler comes through the one loader: an `import` of it re-parses the
// file (the package names no "type") and prints MODULE_TYPELESS_PACKAGE_JSON
export default async (args) => loadHandler(path.join(import.meta.dirname, '..', '..', 'health', 'get.js'))(args);
