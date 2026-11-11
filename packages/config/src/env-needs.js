/**
 * The ONE answer to "which env keys is this brand missing": given a config,
 * an env map, a verb and an optional target, every key the verb owes and the
 * env leaves empty. Each caller decides what a miss costs; none keeps a list.
 *
 * A row's `need` says why it is owed: `required` (the config depends on it:
 * the schema's `required` and `requiredWhen`), `asked` (the feature is on, so
 * `omega manage` asks: `askedWhen`, one row per asking service), or `ship` (a
 * declared format cannot publish without it: the format table in platforms.js).
 * A key read only by targets the brand lacks is never required; an ask states
 * its own target rule, since a service may ask for a key for its own work.
 */

const { ENV_SCHEMA, envSchemaEntry } = require('./env-schema.js');
const { hasValue } = require('./env-has-value.js');
const { onUnlessOff, targetViews } = require('./env-when.js');
const { PLATFORMS, FORMATS, enabledFormats, formatKeys } = require('./platforms.js');
const { hasTargetOfType } = require('./targets.js');

const ENV_VERBS = ['onboard', 'status', 'manage', 'dev', 'build', 'deploy', 'publish', 'start'];

// The need each verb answers. `status` reports what `manage` would ask.
const VERB_NEEDS = {
  onboard: 'required',
  status: 'asked',
  manage: 'asked',
  dev: 'required',
  build: 'required',
  deploy: 'required',
  publish: 'ship',
  start: 'required',
};

// For a target, what a verb is answerable for: a build owes only what it
// bakes, a deploy only what it delivers. Absent = every key the target reads.
const VERB_DELIVERY = {
  build: (mode) => mode === 'bake',
  deploy: (mode) => Boolean(mode),
};

// The manager service that collects the ship keys, and its switch
const SHIP_SERVICE = 'publishing';
const SHIPPING_ON = onUnlessOff('publishing.enabled');

/**
 * Whether the brand (or the one target asked about) reads a key at all.
 * @param {object} entry - The schema entry.
 * @param {object} config - The config.
 * @param {string} [target] - A target type.
 * @returns {boolean}
 */
function readBy(entry, config, target) {
  if (target) return entry.targets.includes(target);

  return entry.targets.length === 0 || entry.targets.some((type) => hasTargetOfType(config, type));
}

/**
 * Whether the config makes a key required: on the target asked about, or
 * brand-wide on the shared config or any target that reads the key.
 * @param {object} entry - The schema entry.
 * @param {object} config - The config.
 * @param {string} [target] - A target type.
 * @returns {boolean}
 */
function isRequired(entry, config, target) {
  if (entry.required) return true;
  if (!entry.requiredWhen) return false;
  if (target) return targetViews(config, target).some(entry.requiredWhen);

  return entry.requiredWhen(config) || entry.targets
    .filter((type) => hasTargetOfType(config, type))
    .some((type) => targetViews(config, type).some(entry.requiredWhen));
}

/**
 * One owed key and what a caller prints for it: `path` is what requires it
 * (a config statement, or the declared format for a ship key), null for a
 * key every brand owes, and `text` is the one line every refusal names it by.
 * @param {string} key - The key.
 * @param {string} need - 'required', 'asked' or 'ship'.
 * @param {string} service - Who owes it.
 * @param {string|null} path - What requires it.
 * @param {object} [gate] - The key's `requiredWhen`, whose `note` the text adds.
 * @returns {{ key: string, need: string, service: string, path: string|null, text: string }}
 */
function row(key, need, service, path, gate) {
  const note = gate && gate.note ? `, ${gate.note}` : '';
  return { key, need, service, path, text: path ? `${key} (required by ${path})${note}` : key };
}

/**
 * The ship keys the declaration owes, per shipping target, each with the
 * first declared format that needs it.
 * @param {object} config - A brand config, or one target's resolved view.
 * @param {string} [target] - The target type `config` is a view of.
 * @returns {Array<{ key: string, path: string, label: string }>} Deduped, in declaration order.
 */
function declaredShipKeys(config, target) {
  const types = target ? [target] : Object.keys(PLATFORMS).filter((type) => hasTargetOfType(config, type));
  const views = types.filter((type) => PLATFORMS[type])
    .flatMap((type) => targetViews(config, type).map((view) => ({ view, type })));

  const keys = [];
  for (const { view, type } of views) {
    for (const { platform, format } of enabledFormats(view, type)) {
      const label = FORMATS[type][platform][format].label || format;
      for (const key of formatKeys(type, platform, format, view).requires) {
        if (keys.some((entry) => entry.key === key)) continue;
        keys.push({ key, path: `platforms.${platform}.formats.${format}`, label });
      }
    }
  }

  return keys;
}

/**
 * The rows the format table owes: `ship` for a publish (each carrying the
 * format's `label`, for the refusal), `asked` by the publishing service for a manage.
 * @param {object} config - A brand config, or one target's resolved view.
 * @param {object} env - Env var map.
 * @param {string} [target] - The target type `config` is a view of.
 * @param {string} need - 'ship' or 'asked'.
 * @returns {object[]} Rows.
 */
function shipRows(config, env, target, need) {
  if (need === 'asked' && !SHIPPING_ON(config)) return [];

  return declaredShipKeys(config, target)
    .filter(({ key }) => {
      const entry = envSchemaEntry(key);
      // The table names keys only; the schema says what each one is
      if (!entry) throw new Error(`The ship-format table names ${key}, which the env schema does not declare`);
      return readBy(entry, config, target) && !hasValue(env, entry);
    })
    .map(({ key, path, label }) => (need === 'ship'
      ? { ...row(key, need, SHIP_SERVICE, path, envSchemaEntry(key).requiredWhen), label }
      : row(key, need, SHIP_SERVICE, null)));
}

/**
 * Every env key a verb owes and the env leaves empty.
 * @param {object} config - The brand config, or a target's resolved view.
 * @param {object} env - Env var map (process.env, a composed target env, ...).
 * @param {{ verb: string, target?: string }} options - A verb of ENV_VERBS,
 *   and a target type to narrow to the keys that target reads.
 * @returns {Array<{ key, need, service, path, text }>} `service` is the asking
 *   service for `asked`, the publishing service for `ship`, the key's owner
 *   for `required`; `path` and `text` are what a caller prints (see row()).
 * @throws {Error} When the verb is not one of ENV_VERBS.
 */
function missingEnvKeys(config, env, { target, verb } = {}) {
  if (!ENV_VERBS.includes(verb)) {
    throw new Error(`missingEnvKeys needs a verb, one of ${ENV_VERBS.join(', ')} (got ${JSON.stringify(verb)})`);
  }

  const brand = config || {};
  const values = env || {};
  const need = VERB_NEEDS[verb];

  if (need === 'ship') return shipRows(brand, values, target, need);

  const delivered = target && VERB_DELIVERY[verb];
  const rows = [];

  for (const entry of ENV_SCHEMA) {
    // A pattern family has no fixed name, so nothing can be owed under it
    if (!entry.name || hasValue(values, entry)) continue;
    if (target && !entry.targets.includes(target)) continue;
    if (delivered && !delivered(entry.delivery && entry.delivery[target])) continue;

    if (need === 'required') {
      if (readBy(entry, brand, target) && isRequired(entry, brand, target)) {
        rows.push(row(entry.name, need, entry.owner, entry.requiredWhen ? entry.requiredWhen.text : null, entry.requiredWhen));
      }
      continue;
    }

    // One row per service that asks: a key may serve several (the Google client)
    const services = entry.askedWhen ? entry.askedWhen.services : {};
    for (const [service, rule] of Object.entries(services)) {
      if (rule(brand)) rows.push(row(entry.name, need, service, null));
    }
  }

  if (need === 'asked') rows.push(...shipRows(brand, values, target, need));

  return rows;
}

/**
 * What every brand owes a verb, whatever its config. An empty config makes no
 * key mandatory, so its answer is exactly the keys no config can switch off.
 * @param {object} env - Env var map.
 * @param {{ verb: string, target?: string }} options - As missingEnvKeys.
 * @returns {object[]} Rows.
 */
function baseMissingKeys(env, { target, verb } = {}) {
  return missingEnvKeys({}, env, { target, verb });
}

/**
 * What THIS config makes a verb owe beyond what every brand owes: the rows an
 * empty config would not return. For the lanes that report what the config
 * added, where the keys every brand owes are another lane's to name.
 * @param {object} config - The brand config, or a target's resolved view.
 * @param {object} env - Env var map.
 * @param {{ verb: string, target?: string }} options - As missingEnvKeys.
 * @returns {object[]} Rows.
 */
function missingConfigKeys(config, env, options) {
  const owedByAll = new Set(baseMissingKeys(env, options).map((entry) => entry.key));
  return missingEnvKeys(config, env, options).filter((entry) => !owedByAll.has(entry.key));
}

/**
 * The keys `omega manage` asks of one service for this config, present or
 * not: the service's half of the one answer.
 * @param {object} config - The brand config.
 * @param {string} service - A manager service name.
 * @returns {Set<string>} Key names.
 */
function serviceAskedKeys(config, service) {
  return new Set(missingEnvKeys(config, {}, { verb: 'manage' })
    .filter((entry) => entry.service === service)
    .map((entry) => entry.key));
}

module.exports = { ENV_VERBS, SHIP_SERVICE, missingEnvKeys, baseMissingKeys, missingConfigKeys, serviceAskedKeys };
