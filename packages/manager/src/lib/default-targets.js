/**
 * The targets a new brand starts with, and the line a run prints where a
 * target would run and the brand has none. Onboard writes the default and
 * `omega dev` prints the line; `omega dev`'s own boot set is a different list
 * (commands/dev.js). Both read the target-type rows.
 */

const { TARGET_TYPE_ROWS } = require('@omega.js/config');

// The types onboarding writes when given no pick: the website alone, which runs
// on any machine with Node
const ONBOARD_TARGETS = TARGET_TYPE_ROWS.filter((row) => row.onboardDefault).map((row) => row.id);

// The --targets word for a brand with no targets at all
const NO_TARGETS = 'none';

const NO_TARGETS_LINE = `Nothing to run: this brand has no targets. Add one: npx omega onboard --targets=${ONBOARD_TARGETS.join(',')}`;

module.exports = { ONBOARD_TARGETS, NO_TARGETS, NO_TARGETS_LINE };
