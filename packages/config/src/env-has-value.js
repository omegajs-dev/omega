/**
 * The ONE presence test for an env key: env-needs.js reads it for every key a
 * verb owes, and platforms.js's formatKeysSet for a store's login. It imports
 * nothing, so both can require it without a cycle.
 */

/**
 * Whether a key has a value under its own name or the name it is delivered
 * under (a target's build holds `GOOGLE_ANALYTICS_SECRET`, never the brand's
 * `GOOGLE_ANALYTICS_SECRET_WEB`). An empty string is absent.
 * @param {object} env - Env var map.
 * @param {object} entry - The schema entry.
 * @returns {boolean}
 */
function hasValue(env, entry) {
  return Boolean(env[entry.name] || (entry.deliverAs && env[entry.deliverAs]));
}

module.exports = { hasValue };
