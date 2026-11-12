const jetpack = require('fs-jetpack');
const { loadHandler } = require('../../libraries/load-handler.js');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Resolve the per-IP daily signup cap the beforeUserCreated guard enforces.
 *
 * Config home: targets.backend.auth.signup.maxPerIpPerDay, which the config
 * loader overlays at the top level like every other target key. Its default
 * lives in the @omega.js/config schema, which the loader merges lowest, so a
 * resolved config always carries the value; a config without it was never
 * resolved, and the guard refuses to run on a guess.
 *
 * @param {object} config - The resolved config (omega.config).
 * @returns {number} Signups allowed per client IP per day.
 */
function resolveSignupLimit(config) {
  const limit = config?.auth?.signup?.maxPerIpPerDay;

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`[@omega.js/backend:auth] auth.signup.maxPerIpPerDay must resolve to a positive integer, got ${JSON.stringify(limit)}; the config was not loaded through @omega.js/config`);
  }

  return limit;
}

/**
 * Retry a function up to maxRetries times with exponential backoff
 */
async function retryWrite(ctx, tag, fn) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await fn();
      return; // Success
    } catch (error) {
      lastError = error;
      ctx.error(`${tag}: Write attempt ${attempt}/${MAX_RETRIES} failed:`, error);

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff: 1s, 2s, 4s
        ctx.log(`${tag}: Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError; // All retries failed
}

/**
 * Run the consumer's auth hook at hooks/auth/{eventName}.js (authored under
 * src/, staged into dist/, which is omega.cwd at runtime), after the framework's
 * own handler: before-create, before-signin, on-create, on-delete.
 *
 * A blocking hook (before-create, before-signin) may throw HttpsError to block
 * the operation; a trigger hook's (on-create, on-delete) errors are logged and never block it.
 *
 * Hook signature, an ES module through the one loader:
 *   export default async ({ ctx, omega, user, context }) => { ... }
 */
async function runAuthHook(eventName, args) {
  const { omega, ctx } = args;
  const hookPath = `${omega.cwd}/hooks/auth/${eventName}.js`;

  // Check if hook file exists
  if (!jetpack.exists(hookPath)) {
    return;
  }

  ctx.log(`${eventName}: Running consumer hook @ ${hookPath}`);

  // Load and execute — passes the same args object the @omega.js/backend handler received
  const hook = loadHandler(hookPath);
  await hook(args);

  ctx.log(`${eventName}: Consumer hook completed`);
}

module.exports = { retryWrite, runAuthHook, resolveSignupLimit, MAX_RETRIES };
