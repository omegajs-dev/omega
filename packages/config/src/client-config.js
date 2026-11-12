/**
 * client-config.js: the ONE browser-safe subset of a resolved config
 * ([#894](https://github.com/Omega-JS-Stack/omega/issues/894)).
 *
 * Three surfaces bake a config into an artifact a browser can read: web's page
 * chrome, desktop's renderer bundle, and every extension bundle. Each one used
 * to decide what may go public on its own, three different ways (desktop
 * shipped the WHOLE resolved config, the extension kept a hand-written allow
 * list, web wired a subset together in its engine and its foot include), so a
 * new public value had to be added in three places and every one of them could
 * be the place it leaked.
 *
 * This is that decision, once. The schema's `CLIENT_SECTIONS` says which
 * sections a browser may see (and how much of each), the list below says which
 * BUILD FACTS ride beside them, and nothing else leaves the build. All three
 * bakes call this and wrap the answer identically:
 *
 *   OMEGA_BUILD_JSON = { config: clientConfig(resolved), package, mode, license, builtAt }
 *
 * Secrets are a loud failure, not a filter: a secret-shaped key inside a
 * section that is about to ship means the resolved config carried one at all,
 * which loadConfig() and validateConfig() already refuse. A value a build is
 * SANCTIONED to bake (`publicAtRest`, docs/shared/config.md) comes from .env
 * and is added by that build after this gate, never carried through it.
 */

const { CLIENT_SECTIONS } = require('./schema.js');
const { findSecretKeys } = require('./secrets.js');
const { resolveWinbackOffer } = require('./winback.js');
const { PAYMENT_PROVIDERS } = require('./payment-providers.js');
const { ANALYTICS_PROVIDERS } = require('./analytics-providers.js');

// The per-build facts a surface composes ON TOP of the resolved config before
// baking it. They are not config sections (nothing authors them in
// omega.json5): each is a fact about the artifact, spelled the same on every
// surface so one read answers everywhere.
//
//   runtime      'web' | 'browser-extension' | 'electron'
//   environment  the build's verdict ('development' | 'testing' | 'production')
//   version      the target's own package version, the release tag every error
//                report carries as `<brand.id>@<version>` (#380)
//   buildTime    the build stamp (ms)
//   target       WHICH target this artifact IS, by name (#887)
//   url          this target's own resolved public url (#588)
//   dev          the local stack's resolved map: ports + the sibling website's
//                origin, development builds only (#300/#262). The extension's
//                live-reload port rides here too (#896), the one home of a
//                local-stack number.
const CLIENT_FACT_KEYS = ['runtime', 'environment', 'version', 'buildTime', 'target', 'url', 'dev'];

/**
 * Copy exactly `paths` out of a section (dot-paths, deep).
 * @param {*} section - the resolved section value.
 * @param {string[]} paths - dot-paths inside it.
 * @returns {object|undefined} the picked sub-tree, or undefined when it is empty.
 */
function pickPaths(section, paths) {
  if (!section || typeof section !== 'object') {
    return undefined;
  }

  const picked = {};
  let found = false;

  for (const path of paths) {
    const keys = path.split('.');
    let source = section;
    let missing = false;

    for (const key of keys) {
      if (!source || typeof source !== 'object' || !(key in source)) {
        missing = true;
        break;
      }
      source = source[key];
    }
    if (missing) continue;

    let cursor = picked;
    for (const key of keys.slice(0, -1)) {
      cursor[key] = cursor[key] || {};
      cursor = cursor[key];
    }
    cursor[keys[keys.length - 1]] = source;
    found = true;
  }

  return found ? picked : undefined;
}

/**
 * The subset of a resolved config a browser may see.
 * @param {object} [resolved] - a resolved config (build.getConfig() output),
 *   with this build's facts composed onto it.
 * @returns {object} the blob every browser surface bakes as OMEGA_BUILD_JSON.config.
 * @throws {Error} when a section that is about to ship carries a secret-shaped key.
 */
function clientConfig(resolved) {
  const source = resolved || {};
  const client = {};

  for (const key of CLIENT_FACT_KEYS) {
    if (key in source) client[key] = source[key];
  }

  for (const [section, rule] of Object.entries(CLIENT_SECTIONS)) {
    if (!(section in source)) continue;

    const value = rule === true ? source[section] : pickPaths(source[section], rule);
    if (value === undefined) continue;

    client[section] = value;
  }

  // A secret in here is not a value to drop: it is a config that should never
  // have loaded, so it fails the build at the one place that would have
  // published it.
  const secrets = findSecretKeys(client);
  if (secrets.length) {
    throw new Error(
      `[@omega.js/config] refusing to bake a browser config carrying secret-shaped keys: ${secrets.join(', ')}. `
      + 'Secrets live in .env, never in config/omega.json5 (docs/shared/config.md).',
    );
  }

  // The browser is handed the RESOLVED winback offer and the provider
  // capability table, so the dialog and the coupon, and the checkout's buttons
  // and the backend's refusals, can never disagree.
  if (client.payment) {
    client.payment = { ...client.payment, winback: resolveWinbackOffer(client.payment), capabilities: PAYMENT_PROVIDERS };
  }

  // The analytics provider rows ride ALWAYS: they are provider facts, not brand
  // settings, so a brand with no analytics section still reads them.
  client.analytics = { ...client.analytics, capabilities: ANALYTICS_PROVIDERS };

  // Never an alias of the resolved config: what a bake stamps into an artifact
  // cannot be something a later build step can still mutate. A JSON round trip
  // and not structuredClone, because JSON is what a bake CAN carry: a page's
  // resolved config arrives through a template data cascade that hangs
  // functions and accessors off it, and those drop out here rather than
  // crashing the build.
  return JSON.parse(JSON.stringify(client));
}

module.exports = { clientConfig, CLIENT_FACT_KEYS };
