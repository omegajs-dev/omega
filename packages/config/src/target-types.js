/**
 * target-types.js: one frozen row per target TYPE, the one home of every rule
 * a type carries. The schema's type list, the manager's framework map, its
 * deploy, publish, verify and ship sets and both default target lists derive
 * from these rows. `custom` is no row: a type with no rules, whose verbs come
 * from its own package.json scripts (schema.js CUSTOM_TARGET_TYPE).
 *
 * The dispatcher cannot depend on this package, so @omega.js/devkit's verbs.js
 * keeps a stdlib twin of the id, framework and walkRank facts, pinned against
 * these rows by a test. The field contract: docs/shared/config.md (Targets).
 */

const { deepFreeze } = require('./deep-freeze.js');

// In the schema's order. Backend walks first: its API goes live before the
// surfaces that call it. deploy: 'direct' runs the target's deploy script from
// this machine, 'verb' the framework's deploy verb, null nothing.
const TARGET_TYPE_ROWS = deepFreeze([
  { id: 'web', framework: '@omega.js/web', walkRank: 1, deploy: 'direct', publishes: false,
    verify: ['site', 'domain', 'cloudflare'], onboardDefault: true, devDefault: true, reserved: false, translates: true },
  { id: 'backend', framework: '@omega.js/backend', walkRank: 0, deploy: 'direct', publishes: false,
    verify: [], onboardDefault: false, devDefault: true, reserved: false, translates: false },
  { id: 'desktop', framework: '@omega.js/desktop', walkRank: 3, deploy: 'verb', publishes: true,
    verify: [], onboardDefault: false, devDefault: false, reserved: false, translates: false },
  { id: 'extension', framework: '@omega.js/extension', walkRank: 2, deploy: 'verb', publishes: true,
    verify: [], onboardDefault: false, devDefault: false, reserved: false, translates: true },
  { id: 'mobile', framework: null, walkRank: 4, deploy: null, publishes: false,
    verify: [], onboardDefault: false, devDefault: false, reserved: true, translates: false },
]);

/**
 * The row for a target type, or null when no row has that id (`custom`, a
 * typo, a target NAME that is not a type).
 * @param {string} id - The type word (`web`, `backend`, …).
 * @returns {object|null}
 */
function targetType(id) {
  return TARGET_TYPE_ROWS.find((entry) => entry.id === id) || null;
}

module.exports = { TARGET_TYPE_ROWS, targetType };
