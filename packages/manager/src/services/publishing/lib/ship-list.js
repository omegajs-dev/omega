/**
 * The per-brand ship list ([#867](https://github.com/Omega-JS-Stack/omega/issues/867)):
 * which of this brand's targets ship something, and what each shipped format
 * needs before it can.
 *
 * It types NO key names. @omega.js/config's format table says what every
 * format requires and devkit's ship-plan narrows that to one brand's
 * declaration, so a brand that drops a store is never asked for its keys and a
 * store added to the table is asked for the moment it exists.
 *
 * Two readers: serviceInputs (src/config.js), which lists what the publishing
 * service CAN ask for, and the publishing service itself. Which keys a brand
 * owes is @omega.js/config's missingEnvKeys.
 */

const { FORMATS, TARGET_TYPE_ROWS } = require('@omega.js/config');
const { shipPlan } = require('@omega.js/devkit/ship-plan');

// The target types that ship: the rows that publish an artifact somebody
// installs. The others deploy, and carry no `platforms` declaration.
const SHIP_TYPES = TARGET_TYPE_ROWS.filter((row) => row.publishes).map((row) => row.id);

/**
 * Every credential ANY format can require, in table order: the static list of
 * what the publishing service can ask for (missingEnvKeys narrows it per brand).
 *
 * @returns {string[]} Key names, deduped.
 */
function shipCredentials() {
  const names = [];

  for (const target of SHIP_TYPES) {
    for (const formats of Object.values(FORMATS[target])) {
      for (const spec of Object.values(formats)) {
        for (const key of spec.requires) {
          if (!names.includes(key)) names.push(key);
        }
      }
    }
  }

  return names;
}

/**
 * The brand's shipping targets and what each one ships.
 *
 * The declaration is read off the TARGET ENTRY, which is where `platforms`
 * lives (the schema declares it under `targets.<desktop|extension>` and
 * nowhere else, so the entry IS that target's resolved view of it). An entry
 * with no usable `type` answers nothing rather than throwing: this runs inside
 * a registry predicate, against raw configs too.
 *
 * @param {object} brandConfig - The brand's config.
 * @returns {Array<{ name: string, type: string, formats: Array<object> }>} In
 *   config order; `formats` is devkit's shipPlan for that target.
 */
function shipTargets(brandConfig) {
  const targets = (brandConfig && brandConfig.targets) || {};
  const shipping = [];

  for (const [name, entry] of Object.entries(targets)) {
    if (!entry || !SHIP_TYPES.includes(entry.type)) continue;

    shipping.push({ name, type: entry.type, formats: shipPlan(entry, entry.type) });
  }

  return shipping;
}

module.exports = { shipCredentials, shipTargets };
