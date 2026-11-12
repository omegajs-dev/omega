/**
 * @omega.js/config platforms: the ONE shipping vocabulary and the ONE format
 * table ([#867](https://github.com/Omega-JS-Stack/omega/issues/867)), the
 * successor of desktop-artifacts.js.
 *
 * The vocabulary is the CLIENT's (@omega.js/client's `getPlatform()` /
 * `getBrowser()`): platforms `mac`, `windows`, `linux`, `chrome`, `firefox`,
 * `edge`; formats `dmg`, `nsis`, `deb`, `appimage`, `snap`, `zip`, `store`.
 * `mac`, never `macos`, because that is the word a stored login record, a
 * download card and a `/download/<platform>` URL already carry. Node's
 * `darwin`/`win32` and electron-builder's `mac`/`win`/`AppImage`/`nsis` are
 * FOREIGN vocabularies, each translated at exactly one point (the desktop
 * framework's `utils/platform.js` for Node's, its `gulp/tasks/build-config.js`
 * for electron-builder's).
 *
 * Two things live here, and every target reads them the same way:
 *
 *   1. PLATFORMS: what a target can ship to at all.
 *   2. FORMATS: per target, platform and format, what that format IS
 *      (`kind: 'asset'` = a file on the brand's releases repo, with an `ext`;
 *      `kind: 'store'` = a publish to somebody's store), the env keys it
 *      cannot ship without (`requires`), and the per-listing CONFIG paths a
 *      store needs before it can accept an upload (`listing`, #893: the ids
 *      are config, never .env keys).
 *
 * A brand DECLARES what it ships in one shape on both targets:
 * `targets.<name>.platforms.<platform>.formats.<format>`. Presence is the
 * switch, every platform and format defaults ON, and a default is dropped with
 * `false` (the `certificates: false` idiom). Per-format settings live inside
 * the format (`linux.formats.snap.channels`,
 * `firefox.formats.store.channel`), which is why the declaration is an object
 * and not a list.
 *
 * Everything that ships derives from here: the desktop build's electron-builder
 * target lists, the website's `/download/<platform>/<format>` links, and the
 * manage walk's per-brand list of ship credentials.
 */

const { ENV_SCHEMA, envSchemaEntry } = require('./env-schema.js');
const { hasValue } = require('./env-has-value.js');
const { formatShips, ships } = require('./env-when.js');

// The Snap Store's name rule: lowercase letters, digits and single hyphens,
// at least one letter, at most 40 characters
const SNAP_NAME_PATTERN = /^(?=.{1,40}$)(?=[a-z0-9-]*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHIPS_SNAP = ships('linux', 'snap');

// What each target can ship to, in the order it offers them. The FIRST platform
// entry's first format is what a bare `/download/<platform>` leads with.
const PLATFORMS = {
  desktop: ['mac', 'windows', 'linux'],
  extension: ['chrome', 'firefox', 'edge'],
};

/**
 * The Windows signing keys, read off the env schema rather than restated: the
 * schema already gates each one on `platforms.windows.signing.*` (#891 pins
 * them to the strategy and cloud provider that owns them), so the nsis format
 * names THAT set and `formatKeys` narrows it per brand. SIGNTOOL_PATH is
 * deliberately not in it: it is where signtool.exe sits on the runner, gated by
 * nothing, and nobody mints it on a store page.
 * @returns {string[]} Key names, in schema order.
 */
function windowsSigningKeys() {
  return ENV_SCHEMA
    .filter((entry) => entry.requiredWhen && String(entry.requiredWhen.path).startsWith('platforms.windows.signing.'))
    .map((entry) => entry.name);
}

/**
 * The env keys one cloud signing provider needs: the schema entries gated on it.
 * @param {string} provider - A cloud provider (windows-signing.js's WINDOWS_CLOUD_PROVIDERS).
 * @returns {string[]} Key names, in schema order ([] for a provider nobody gates on).
 */
function windowsCloudProviderKeys(provider) {
  const gate = `platforms.windows.signing.cloud.provider=${provider}`;
  return ENV_SCHEMA.filter((entry) => entry.requiredWhen && entry.requiredWhen.text === gate).map((entry) => entry.name);
}

// Every format each platform ships, in offer order. `requires` names env keys
// (the env schema is the one home of what each is and where it is minted);
// `listing` names CONFIG paths (#893). A `store` also carries the two facts a
// human needs when its listing does not exist yet: the store's `label` and the
// `console` page that creates the listing, so the manage walk's Enter-to-open
// ask and the publish's manual step read one home instead of two tables.
//
// Deliberately absent on desktop: the mac auto-update ZIP. electron-updater
// fetches it from the feed and nobody links it, so it is a build detail of the
// mac leg rather than something a brand declares.
const FORMATS = {
  desktop: {
    mac: {
      // Apple's material (certificates, notarization keys) is the certificates
      // service's, not a per-format requirement: one Apple identity signs every
      // mac format the brand ever adds.
      dmg: { kind: 'asset', ext: 'dmg', requires: [], listing: [] },
    },
    windows: {
      nsis: { kind: 'asset', ext: 'exe', requires: windowsSigningKeys(), listing: [] },
    },
    linux: {
      deb: { kind: 'asset', ext: 'deb', requires: [], listing: [] },
      appimage: { kind: 'asset', ext: 'AppImage', requires: [], listing: [] },
      // The Snap Store publishes the snap, so it is never a release asset and
      // has no versionless filename to spell. Its listing is the snap NAME
      // (snapName), which the publishing walk registers with the login that
      // publishes, so there is no id to collect before the first upload.
      snap: { kind: 'store', requires: ['SNAPCRAFT_STORE_CREDENTIALS'], listing: [], label: 'Snap Store', console: 'https://snapcraft.io/account' },
    },
  },
  extension: {
    chrome: {
      zip: { kind: 'asset', ext: 'zip', requires: [], listing: [] },
      store: { kind: 'store', requires: ['CHROME_CLIENT_ID', 'CHROME_CLIENT_SECRET', 'CHROME_REFRESH_TOKEN'], listing: ['listings.chrome.id'], label: 'Chrome Web Store', console: 'https://chrome.google.com/webstore/devconsole' },
    },
    firefox: {
      zip: { kind: 'asset', ext: 'zip', requires: [], listing: [] },
      // Firefox's id IS the manifest's gecko id, so a brand that declared none
      // still publishes and its `listing` is empty: this store needs nothing
      // before it can accept an upload, and the id is ours anyway (the local
      // scaffold pins the derived `listings.firefox.id` into config, #893).
      // Nothing ever asks for it.
      store: { kind: 'store', requires: ['FIREFOX_API_KEY', 'FIREFOX_API_SECRET'], listing: [], label: 'Firefox Add-ons', console: 'https://addons.mozilla.org/en-US/developers/addon/submit/distribution' },
    },
    edge: {
      // Edge ships the CHROME build (one chromium artifact, two stores).
      zip: { kind: 'asset', ext: 'zip', requires: [], listing: [] },
      store: { kind: 'store', requires: ['EDGE_CLIENT_ID', 'EDGE_API_KEY'], listing: ['listings.edge.id'], label: 'Microsoft Edge Add-ons', console: 'https://partner.microsoft.com/dashboard/microsoftedge/' },
    },
  },
};

/**
 * The keys one format needs: the whole declared set, or with a config, only
 * the keys whose schema `requiredWhen` holds for it (the EV token belongs to
 * the self-hosted Windows strategy, never the cloud one). Those rules read
 * what the target ships, defaults included, so an unwritten snap still owes.
 * @param {string} target - Target type ('desktop' | 'extension').
 * @param {string} platform - Platform key ('mac', 'chrome', ...).
 * @param {string} format - Format key ('dmg', 'store', ...).
 * @param {object} [config] - A resolved target config, to narrow `requires`.
 * @returns {{ requires: string[], listing: string[] }} Empty lists for a format
 *   nobody declares.
 */
function formatKeys(target, platform, format, config) {
  const spec = FORMATS[target]?.[platform]?.[format];
  if (!spec) return { requires: [], listing: [] };

  const requires = config
    ? spec.requires.filter((key) => {
      const entry = ENV_SCHEMA.find((candidate) => candidate.name === key);
      // No gate declared = the format needs it whenever the format ships
      return !entry?.requiredWhen || entry.requiredWhen(config);
    })
    : [...spec.requires];

  return { requires, listing: [...spec.listing] };
}

/**
 * Everything a config ships for a target, read off the declaration.
 *
 * Presence is the switch and every platform and format defaults ON, so the
 * only thing that drops one is a literal `false`. A key the vocabulary does not
 * carry is ignored here (the validator names it as undeclared); nothing is
 * invented from it.
 *
 * @param {object} config - A resolved target config (the declaration is read at
 *   `config.platforms`, which is where `targets.<name>.platforms` resolves to).
 * @param {string} target - Target type ('desktop' | 'extension').
 * @returns {Array<{ platform: string, format: string, options: object }>} In
 *   offer order; `options` is the format's own settings block ({} when it has
 *   none).
 */
function enabledFormats(config, target) {
  const enabled = [];

  for (const platform of PLATFORMS[target] || []) {
    for (const format of Object.keys(FORMATS[target][platform])) {
      if (!formatShips(config, platform, format)) continue;

      const declaration = config?.platforms?.[platform]?.formats?.[format];
      enabled.push({ platform, format, options: declaration && typeof declaration === 'object' ? declaration : {} });
    }
  }

  return enabled;
}

/**
 * The snap's name: `brand.id`. The build pins it, the publishing walk
 * registers it and the site's Snap Store link ends in it, so the three cannot
 * disagree.
 *
 * @param {object} config - A brand config or a target's resolved view.
 * @returns {string} The name (the validator requires `brand.id`).
 */
function snapName(config) {
  return config.brand.id;
}

/**
 * Why this brand's snap cannot carry its name, or null. A `brand.id` may hold
 * `.` or `+`, which no snap name allows, so a brand that ships the snap with
 * such an id fails validation here rather than at the store.
 *
 * @param {object} config - A brand config or a target's resolved view.
 * @returns {string|null} The error, naming the id and the snap.
 */
function snapNameError(config) {
  // A missing or mistyped brand.id is the brand.id rule's own error
  if (typeof config?.brand?.id !== 'string' || !SHIPS_SNAP(config)) return null;

  const name = snapName(config);
  if (SNAP_NAME_PATTERN.test(name)) return null;

  return `config.brand.id ${JSON.stringify(name)} cannot name the snap (platforms.linux.formats.snap, on by default): `
    + 'a snap name is lowercase letters, digits and single hyphens, with a letter, at most 40 characters. '
    + 'Change brand.id, or set platforms.linux.formats.snap to `false`.';
}

/**
 * Whether every key one format requires holds a value, by env-has-value.js's
 * one presence test.
 *
 * @param {string} target - Target type ('desktop' | 'extension').
 * @param {string} platform - Platform key.
 * @param {string} format - Format key.
 * @param {object} env - Env var map (process.env, a composed target env).
 * @returns {boolean}
 */
function formatKeysSet(target, platform, format, env) {
  return formatKeys(target, platform, format).requires.every((key) => hasValue(env, envSchemaEntry(key)));
}

/**
 * The product name a desktop target packages under: the same derivation
 * @omega.js/desktop's `build.getConfig()` applies (`app.productName` then
 * `brand.name`), so the website reads the name the packager actually used.
 *
 * @param {object} config - Desktop-shaped config (`{ app, brand }`).
 * @returns {string} Product name ('' when neither key resolves).
 */
function desktopProductName(config) {
  return config?.app?.productName || config?.brand?.name || '';
}

/**
 * A product name reduced to filename-safe characters. electron-builder's
 * `${productName}` keeps spaces, which become dots in NSIS output and behave
 * inconsistently across targets; hyphens are consistent everywhere.
 *
 * @param {string} productName - Raw product name ("Deployment Playground").
 * @returns {string} Sanitized name ("Deployment-Playground"), '' when empty.
 */
function sanitizeProductName(productName) {
  return String(productName || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * One asset's versionless filename: `<Product>-<platform>-<format>.<ext>`
 * ([#620](https://github.com/Omega-JS-Stack/omega/issues/620)).
 *
 * Names carry NO version, which is the whole point: GitHub's
 * `/releases/latest/download/<asset>` only resolves when the asset name is the
 * same in every release, so releasing a desktop version never touches the
 * website and the published URLs never change. electron-updater is unaffected:
 * it reads the feed files (`latest-mac.yml`, `latest.yml`), which name whatever
 * artifact the build produced.
 *
 * Nothing puts an arch back into a name that omits one (electron-builder's
 * macro expander only REPLACES a `${arch}` token where it appears), so these
 * names support exactly the default build: a UNIVERSAL mac, a SINGLE linux
 * arch, and windows' multi-arch NSIS installer, which merges every arch into
 * one file anyway. build-config refuses any other arch set rather than let two
 * builds collide on one name.
 *
 * @param {string} productName - Raw product name (sanitized here).
 * @param {string} platform - Platform key (mac, windows, linux).
 * @param {string} format - Format key (dmg, nsis, deb, appimage).
 * @param {string} [ext] - Extension override: pass electron-builder's literal
 *   `${ext}` to get a TEMPLATE that covers every target sharing the platform's
 *   fallback.
 * @returns {string} The filename ('' for a store format, or with no product
 *   name to build it from).
 */
function desktopArtifactName(productName, platform, format, ext) {
  const product = sanitizeProductName(productName);
  const extension = ext || FORMATS.desktop[platform]?.[format]?.ext;
  if (!product || !extension) return '';

  return `${product}-${platform}-${format}.${extension}`;
}

/**
 * Every published asset's filename, keyed platform then format, in offer order.
 * Store formats are absent: they have no file on the releases repo.
 *
 * @param {string} productName - Raw product name.
 * @returns {object} `{ mac: { dmg: 'App-mac-dmg.dmg' }, ... }`, or `{}` when
 *   there is no product name to derive from.
 */
function desktopArtifactNames(productName) {
  if (!sanitizeProductName(productName)) return {};

  const names = {};
  for (const [platform, formats] of Object.entries(FORMATS.desktop)) {
    names[platform] = {};
    for (const [format, spec] of Object.entries(formats)) {
      if (spec.kind !== 'asset') continue;
      names[platform][format] = desktopArtifactName(productName, platform, format);
    }
  }

  return names;
}

module.exports = {
  PLATFORMS,
  FORMATS,
  enabledFormats,
  formatKeys,
  windowsCloudProviderKeys,
  snapName,
  snapNameError,
  formatKeysSet,
  desktopProductName,
  sanitizeProductName,
  desktopArtifactName,
  desktopArtifactNames,
};
