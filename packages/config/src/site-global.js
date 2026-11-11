/**
 * site-global.js — shape a resolved omega.json5 config as the Jekyll-style
 * `site.*` global, so existing template references port verbatim to the new
 * SSG (plan §2: toSiteGlobal()).
 *
 * Config-owned keys referenced in templates are the resolved
 * config's own shape, so this is an identity mapping plus: machinery keys
 * stripped (`targets`, `enabled`), `url` derived (explicit url, else
 * brand.url), `baseurl` defaulted. ENGINE-owned keys (posts, pages, data,
 * time) are the SSG's job, not config's. `collections` is NOT one of them
 * (#207): it is the config-carried collections DECLARATION
 * (`targets.web.collections`), which rides the identity mapping like any
 * other section and which the engine reads to generate each declared
 * collection's pages.
 *
 * The resolved config for target 'web' already overlays targets.web onto the
 * top level, so web-specific sections land here automatically.
 *
 * site.targets (#85) is a CURATED view of the raw `targets` machinery —
 * an explicit allow-list of display-safe facts (presence, the derived
 * desktop releases URL, extension store listings), never a spread of the
 * raw config. It is the ONLY home of those facts
 * ([#610](https://github.com/Omega-JS-Stack/omega/issues/610)): the
 * `/download` page, the `/extension` page and the shortlink generator all
 * read `site.targets.desktop.releasesUrl` and
 * `site.targets.extension.listings` directly. The hand-written
 * `download`/`extension` page maps — and the derivation that filled them —
 * are gone; the validator refuses a config still carrying either key.
 *
 * The desktop derivation is OPT-IN (#124): only a brand that carries a
 * `targets.desktop.releases` block gets releases/latest links — merely
 * declaring a desktop target derives nothing, since the release may not
 * exist yet. WHICH repo those links address is not decided here: it is
 * [repo.js](repo.js)'s `releasesRepo`, the one home of the brand's public
 * releases repo (#799/#883): `<brand.id>-releases` under the brand's one
 * `repo.owner`, with no override key anywhere.
 *
 * Beside the hub sits `downloads` ([#620](https://github.com/Omega-JS-Stack/omega/issues/620)):
 * one DIRECT-download URL per FORMAT, so a download button hands over a file
 * instead of a GitHub page. Both the format keys and the filenames are
 * [platforms.js](platforms.js)'s, the same table @omega.js/desktop packages
 * under, and they carry no version, so releasing a desktop build never touches
 * the website. A `store` format (the snap) has no file: its URL is the store
 * page itself ([#867](https://github.com/Omega-JS-Stack/omega/issues/867)).
 */

const { FORMATS, enabledFormats, desktopProductName, desktopArtifactNames, snapName } = require('./platforms.js');
const { releasesRepo } = require('./repo.js');

// Keys that are resolution machinery, not site content
const MACHINERY_KEYS = ['targets', 'enabled'];

/**
 * Whether the brand OPTED IN to derived desktop download links (#124):
 * declaring a desktop target is not enough — a `targets.desktop.releases`
 * block must be present (`enabled` defaults true when it is), and
 * `releases.enabled: false` always suppresses. On the pipeline's second
 * toSiteGlobal pass the raw block is gone, so a curated `releasesUrl` is
 * itself the opt-in (idempotence).
 * @param {object} desktop - the desktop target's entry
 * @returns {boolean}
 */
function desktopReleasesEnabled(desktop) {
  if (!desktop) return false;
  if (desktop.releases) return desktop.releases.enabled !== false;

  return Boolean(desktop.releasesUrl);
}

/**
 * The GitHub releases URL a desktop target's downloads point at: the brand's ONE
 * public releases repo, whose address `@omega.js/config`'s `releasesRepo` owns
 * (#799). Nothing is derived here; a repo the derivation cannot address (no
 * owner, no brand.id) yields no URL.
 * @param {object} desktop - the desktop target's entry
 * @param {object} config - resolved config object
 * @returns {string|undefined}
 */
function desktopReleasesUrl(desktop, config) {
  // Idempotence: the build pipeline applies toSiteGlobal more than once
  // (consumer.js loadSiteData, then engine.js configureOmega). On a second pass
  // the raw releases block is gone, so the curated view's own URL is the
  // authority: re-deriving off a config that no longer carries the block would
  // drop the links a brand already has.
  if (!desktop?.releases && desktop?.releasesUrl) return desktop.releasesUrl;

  const releases = releasesRepo(config);

  return releases ? `https://github.com/${releases.slug}/releases/latest` : undefined;
}

/**
 * The download URL of every desktop FORMAT, keyed platform then format (#620,
 * #867). An `asset` format links the file itself: GitHub's
 * `/releases/latest/download/<asset>` serves the newest release's asset by
 * name, which only holds because the names are versionless. A `store` format
 * links the store page, because the store holds the file.
 * @param {object} desktop - the desktop target's entry
 * @param {object} config - resolved config object
 * @param {string} releasesUrl - the derived releases hub URL
 * @returns {object|undefined}
 */
function desktopDownloads(desktop, config, releasesUrl) {
  // Idempotence, same trap as the URL above: the second toSiteGlobal pass sees
  // the curated view, which carries no app block and no brand-derived product
  // name, so the curated URLs are the authority by then.
  if (desktop?.downloads) return desktop.downloads;

  // No product name (an invalid config: brand.name is required) derives
  // nothing, because a guessed filename is a download button that 404s.
  const productName = desktopProductName({ app: desktop?.app, brand: config?.brand });
  const names = desktopArtifactNames(productName);
  if (!Object.keys(names).length) return undefined;

  // Only what this brand SHIPS gets a link: a dropped platform or format must
  // not render a button that 404s (#867).
  const downloads = {};
  for (const { platform, format } of enabledFormats(desktop, 'desktop')) {
    // An asset links its file; the one store format (the snap) links the Snap
    // Store listing, whose slug is the name the build pins and the publishing
    // walk registers (snapName).
    const filename = names[platform]?.[format];
    const url = filename
      ? `${releasesUrl}/download/${filename}`
      : `https://snapcraft.io/${snapName(config)}`;

    downloads[platform] = downloads[platform] || {};
    downloads[platform][format] = url;
  }

  return Object.keys(downloads).length ? downloads : undefined;
}

/**
 * What each linked format IS, keyed like `downloads`: the format table's
 * `kind` (`asset` | `store`), so the page hands a store link over as a plain
 * link and an asset with its install walkthrough. It reads the curated
 * downloads alone, so the second toSiteGlobal pass derives the same map.
 * @param {object} downloads - the curated downloads map
 * @returns {object}
 */
function desktopDownloadKinds(downloads) {
  const kinds = {};
  for (const [platform, formats] of Object.entries(downloads)) {
    kinds[platform] = {};
    for (const format of Object.keys(formats)) {
      kinds[platform][format] = FORMATS.desktop[platform][format].kind;
    }
  }

  return kinds;
}

/**
 * Whether an entry is a target of this TYPE (#886): the declared `type`, or,
 * on the second toSiteGlobal pass, the curated fact only that type derives.
 * The NAME is never the test, so a brand that names its desktop target `app`
 * still gets `site.targets.app.downloads`.
 * @param {object} entry - a raw or curated targets entry
 * @param {string} type - 'desktop' | 'extension'
 * @param {string} curatedKey - the curated key that type alone produces
 * @returns {boolean}
 */
function isTargetOfType(entry, type, curatedKey) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  return entry.type === type || entry[curatedKey] !== undefined;
}

/**
 * Curate one target's display-safe view. Presence = enabled; per-type
 * extras are allow-listed here, never spread from the raw entry.
 * @param {object} entry - the target's own config entry
 * @param {object} config - resolved config object
 * @returns {object}
 */
function curateTarget(entry, config) {
  const view = { enabled: true };

  if (isTargetOfType(entry, 'desktop', 'releasesUrl') && desktopReleasesEnabled(entry)) {
    const releasesUrl = desktopReleasesUrl(entry, config);
    if (releasesUrl) {
      view.releasesUrl = releasesUrl;
      const downloads = desktopDownloads(entry, config, releasesUrl);
      if (downloads) {
        view.downloads = downloads;
        view.downloadKinds = desktopDownloadKinds(downloads);
      }
    }
  }

  if (isTargetOfType(entry, 'extension', 'listings')) {
    const { listings } = entry;
    if (listings) {
      const curated = {};
      for (const [store, entry] of Object.entries(listings)) {
        if (!entry?.url && !entry?.state) continue; // empty entries stay absent, never a truthy {}
        curated[store] = {
          ...(entry.url ? { url: entry.url } : {}),
          ...(entry.state ? { state: entry.state } : {}),
        };
      }
      if (Object.keys(curated).length) view.listings = curated;
    }
  }

  return view;
}

/**
 * Convert a RESOLVED config (loadConfig(...).config) into the site.* global.
 * @param {object} config - resolved config object
 * @returns {object} the site global (new object; config is not mutated)
 */
function toSiteGlobal(config) {
  const site = {};

  for (const [key, value] of Object.entries(config || {})) {
    if (MACHINERY_KEYS.includes(key)) continue;
    site[key] = value;
  }

  site.url = config?.url || config?.brand?.url || '';
  site.baseurl = config?.baseurl || '';

  // Curated targets view (#85) — raw machinery stays stripped above.
  const targets = config?.targets;
  if (targets && typeof targets === 'object') {
    site.targets = {};
    for (const [name, entry] of Object.entries(targets)) {
      site.targets[name] = curateTarget(entry, config);
    }
  }

  return site;
}

module.exports = { toSiteGlobal };
