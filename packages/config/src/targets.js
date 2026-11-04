/**
 * The `targets` map: every key is a target NAME, every entry declares its
 * `type` ([#886](https://github.com/Omega-JS-Stack/omega/issues/886)).
 *
 * The name is the whole addressing story: it is the folder
 * (`targets/<name>`), the `--target=<name>` word, and the derived-repo
 * suffix. The type says WHICH framework runs there, so a brand runs two web
 * targets by declaring two names:
 *
 *   targets: {
 *     web:       { type: 'web', url: 'https://somiibo.com' },
 *     community: { type: 'web', url: 'https://community.somiibo.com' },
 *     backend:   { type: 'backend' },
 *     docs:      { type: 'custom' },
 *   }
 *
 * There is no id, no folder key, and no name table: the key IS the answer, so
 * the dir walk and the path derivation are each one line. This module is the
 * ONE home of that derivation, imported by every framework and the manager,
 * never copied.
 */

const path = require('node:path');

const { TARGETS, CUSTOM_TARGET_TYPE } = require('./schema.js');

// A target name is a folder name, so it must be a dir-safe slug
const TARGET_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

// Every legal `type`: the framework targets plus the custom one whose verbs
// come from its own package.json scripts (#603)
const TARGET_TYPES = [...TARGETS, CUSTOM_TARGET_TYPE];

/**
 * Every declared target as `{ name, type, ...entry }`, in config order.
 * @param {object} config - A raw or resolved config carrying `targets`.
 * @returns {Array<object>} The entries; [] when the config declares none.
 * @throws {Error} When an entry carries no `type`, or a type no framework owns.
 */
function targetEntries(config) {
  const targets = config && config.targets;
  if (!targets || typeof targets !== 'object') return [];

  return Object.keys(targets).map((name) => {
    const entry = targets[name] || {};

    if (!TARGET_TYPES.includes(entry.type)) {
      throw new Error(`targets.${name} must declare a type: one of [${TARGET_TYPES.join(', ')}] (got ${entry.type === undefined ? 'nothing' : JSON.stringify(entry.type)})`);
    }

    return { ...entry, name, type: entry.type };
  });
}

/**
 * The declared targets of one type, in config order.
 * @param {object} config - A raw or resolved config carrying `targets`.
 * @param {string} type - A value from TARGET_TYPES.
 * @returns {Array<object>} The matching entries.
 */
function targetsOfType(config, type) {
  return targetEntries(config).filter((entry) => entry.type === type);
}

/**
 * Does this config declare a target of that TYPE? The ONE presence gate, for
 * every "only when this brand runs a backend/desktop/mobile" check: a key
 * lookup answers the wrong question now that a backend may be named `api`
 * (#886). Raw, unvalidated configs answer too, so a missing or unknown `type`
 * is simply "no", never a throw.
 * @param {object} config - A raw or resolved config carrying `targets`.
 * @param {string} type - A value from TARGET_TYPES.
 * @returns {boolean} True when at least one entry declares that type.
 */
function hasTargetOfType(config, type) {
  const targets = config && config.targets;
  if (!targets || typeof targets !== 'object') return false;

  return Object.values(targets).some((entry) => entry && entry.type === type);
}

/**
 * A target's folder, relative to the brand root: the name IS the folder.
 * @param {object} config - A raw or resolved config carrying `targets`.
 * @param {string} name - The target name.
 * @returns {string} `targets/<name>` (posix separators).
 * @throws {Error} When the config declares no target of that name.
 */
function targetPath(config, name) {
  const declared = config && config.targets ? Object.keys(config.targets) : [];

  if (!declared.includes(name)) {
    throw new Error(`No target "${name}" is declared: this brand declares [${declared.join(', ')}]`);
  }

  return `targets/${name}`;
}

/**
 * WHICH target a project dir is: the target root's basename when the dir (or
 * one of its TARGET_SUBDIRS, functions/ and dist/) sits inside a brand
 * monorepo. A standalone project's dir name is arbitrary, so it names nothing.
 * @param {string} projectDir - Target root, or one of its TARGET_SUBDIRS.
 * @returns {string|null} The target name, or null outside a brand.
 */
function targetNameFromDir(projectDir) {
  // Local require to avoid a load-time cycle (load.js requires this module)
  const { findBrandRoot, TARGET_SUBDIRS } = require('./load.js');

  let targetRoot = path.resolve(projectDir);
  if (TARGET_SUBDIRS.includes(path.basename(targetRoot))) {
    targetRoot = path.dirname(targetRoot);
  }

  if (!findBrandRoot(targetRoot)) return null;
  return path.basename(targetRoot);
}

/**
 * The host `brand.url` names, EXACTLY as it states it: a `www.` label is kept
 * (a www brand is a www brand), any path is dropped, a port survives. A
 * scheme-less value is read as https.
 * @param {string} url - A brand URL.
 * @returns {string} The host, or '' when the value is not a URL.
 */
function brandHost(url) {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).host;
  } catch {
    return '';
  }
}

/**
 * The live URL of a target: its entry's `url`, a target-scoped `brand.url`
 * override, then the derivation. A target NAMED for its type is the brand
 * itself (`brand.url`); any other name is that name AS A SUBDOMAIN of the
 * brand host (#588), which is what makes `community: { type: 'web' }` a
 * complete declaration. On a default Pages host a sibling WEB target derives
 * its own Pages address (`pagesAddress`) instead. Nothing is half-derived: no
 * usable brand.url means null, never `https://community.`.
 * @param {object} config - The (resolved) config carrying brand.url and targets.
 * @param {string} name - The target name.
 * @returns {string|null} The target's URL, or null when none is known.
 */
function targetUrl(config, name) {
  const entry = config && config.targets ? config.targets[name] : null;

  if (entry && entry.url) return entry.url;
  if (entry && entry.brand && entry.brand.url) return entry.brand.url;

  const brandUrl = config && config.brand ? config.brand.url : null;
  if (!brandUrl) return null;
  if (entry && name === entry.type) return brandUrl;

  const host = brandHost(brandUrl);

  // A sibling web target of a brand on a default Pages host has its own Pages
  // address: `<name>.<owner>.github.io` is no site. Local require: repo.js
  // requires this module.
  if (entry && entry.type === 'web') {
    const { isDefaultPagesHost, pagesAddress } = require('./repo.js');
    if (isDefaultPagesHost(host)) return pagesAddress(config, name);
  }

  return host ? `https://${name}.${host}` : null;
}

/**
 * A target's deterministic dev-port offset: its position among the targets of
 * ITS type, so N same-type targets get N side-by-side ports off the same
 * classic base. Unknown names offset 0, and the N7 bump-if-taken allocator
 * still guarantees a free port.
 * @param {object} config - A raw or resolved config carrying `targets`.
 * @param {string} name - The target name.
 * @returns {number} Zero-based offset.
 */
function targetPortOffset(config, name) {
  const entry = config && config.targets ? config.targets[name] : null;
  if (!entry || !entry.type) return 0;

  const index = targetsOfType(config, entry.type).findIndex((sibling) => sibling.name === name);
  return index > 0 ? index : 0;
}

module.exports = {
  TARGET_NAME_PATTERN,
  TARGET_TYPES,
  targetEntries,
  targetsOfType,
  hasTargetOfType,
  targetPath,
  targetNameFromDir,
  targetUrl,
  targetPortOffset,
  brandHost,
};
