/**
 * @omega.js/config repo: the ONE derivation of every repo a brand owns. One
 * block says where a brand hosts its code, `repo: { provider: 'github', owner }`:
 * its presence enables the repo service, `provider` defaults to `github`, and
 * `owner` is the only typed value. No repo NAME is configured anywhere; each
 * derives from `<brand.id>-<role>`, one function per role: `<brand.id>-omega`
 * the source monorepo (`sourceRepo`), `<brand.id>-releases` the public release
 * channel (`releasesRepo`), `<brand.id>-<name>` per GitHub-hosted web target
 * (`websiteRepo`). The old override keys are rows in @omega.js/manager's
 * src/migrate/retired-keys.js. Visibility is the brand root package.json's
 * `private` field (`brandVisibility`), absent meaning private.
 */

const fs = require('node:fs');
const path = require('node:path');

const { isPlainObject } = require('./merge.js');
const { targetUrl, brandHost } = require('./targets.js');
// The two provider lists live in schema.js, with the rules that enumerate
// them (the WINBACK_DURATIONS pattern), and are re-exported here: this module
// is where every reader takes them from.
const { REPO_PROVIDERS, HOSTING_PROVIDERS } = require('./schema.js');

const DEFAULT_REPO_PROVIDER = 'github';

// Every GitHub default Pages host (`<owner>.github.io`, and the bare form): a
// url naming one is an ADDRESS, never a custom domain (#366).
const DEFAULT_PAGES_HOST = /(^|\.)github\.io$/i;
const DEFAULT_HOSTING_PROVIDER = 'github';

/**
 * The brand's repo block: `{ provider, owner }`, with the provider defaulted.
 *
 * Null when the config carries no `repo` block, and null when the block names
 * no owner: half an address addresses nothing, and the validator fails an
 * owner-less block on its own (an error here would be a second, quieter copy of
 * that rule).
 *
 * @param {object} config - Composed omega config (brand + local layers).
 * @returns {{ provider: string, owner: string }|null}
 */
function repoBlock(config) {
  const repo = config ? config.repo : undefined;
  if (!isPlainObject(repo)) return null;

  const owner = typeof repo.owner === 'string' ? repo.owner.trim() : '';
  if (!owner) return null;

  return { provider: repo.provider || DEFAULT_REPO_PROVIDER, owner };
}

/**
 * The brand's id, trimmed: the role suffix is appended to it, so untrimmed
 * whitespace would sit INSIDE the derived name.
 * @param {object} config - Composed omega config.
 * @returns {string} '' when the config names no brand id.
 */
function brandId(config) {
  const id = config && config.brand ? config.brand.id : undefined;
  return typeof id === 'string' ? id.trim() : '';
}

/**
 * A derived repo as one finished value, or null when either half is missing.
 * @param {object} config - Composed omega config.
 * @param {string} role - The role suffix ('omega', 'releases', a target name).
 * @returns {{ owner: string, name: string, slug: string }|null}
 */
function derivedRepo(config, role) {
  const block = repoBlock(config);
  const id = brandId(config);
  if (!block || !id) return null;

  const name = `${id}-${role}`;

  return { owner: block.owner, name, slug: `${block.owner}/${name}` };
}

/**
 * The brand's SOURCE monorepo: `<brand.id>-omega` under the declared owner. This
 * is the repo every SOURCE fact addresses: the workflow dispatch, the repo
 * Actions secrets, the CMS content commits, the scaffolded workflows.
 *
 * Its visibility is the brand root's `private` field (`brandVisibility`), not a
 * config key.
 *
 * @param {object} config - Composed omega config.
 * @returns {{ owner: string, name: string, slug: string }|null} Null when the config names no owner or no brand id.
 */
function sourceRepo(config) {
  return derivedRepo(config, 'omega');
}

/**
 * Whether the repo a brand's `origin` names IS the source repo its config
 * derives ([#934](https://github.com/Omega-JS-Stack/omega/issues/934)): the ONE
 * comparison, and the ONE wording of its answer, for every reader that holds
 * the two side by side. The boot prelude states it in one line; the manage walk
 * and the deploy, which act ON the derived repo, refuse with it.
 *
 * The WHOLE slug is compared, case-insensitively (GitHub's own comparison), so
 * a rename drifts as surely as a transfer: an owner-only compare let a renamed
 * repo through while every reader kept deriving the old name.
 *
 * @param {string} originSlug - The origin's `Owner/name`.
 * @param {object} config - Composed omega config.
 * @returns {string|null} The drift line, or null when the two agree or the
 *   config derives no source repo (no owner, or no brand id: nothing to compare).
 */
function repoDrift(originSlug, config) {
  const derived = sourceRepo(config);
  if (!derived || derived.slug.toLowerCase() === originSlug.toLowerCase()) return null;

  return `origin is ${originSlug} but config derives ${derived.slug}: fix repo.owner in config/omega.json5 or move the repo`;
}

// The name each role derives, as an owner reads it in a refusal.
const MISSING_REPO_NAMES = {
  source: '<brand.id>-omega',
  releases: '<brand.id>-releases',
  website: '<brand.id>-<target name>',
};

/**
 * The ONE line that tells an owner how to make a repo addressable: every
 * refusal that found no derivable repo quotes it after its own lead (what it
 * could not do), so no caller types `repo.owner` guidance itself.
 *
 * @param {string} role - 'source' | 'releases' | 'website'.
 * @returns {string} The guidance line, naming the repo the role derives.
 * @throws {Error} When the role is not one of the three.
 */
function repoMissing(role) {
  if (!Object.hasOwn(MISSING_REPO_NAMES, role)) {
    throw new Error(`repoMissing: unknown role "${role}": one of [${Object.keys(MISSING_REPO_NAMES).join(', ')}]`);
  }

  return `Set repo.owner and brand.id in config/omega.json5: the ${role} repo is ${MISSING_REPO_NAMES[role]} under that owner.`;
}

/**
 * The brand's ONE public releases repo: `<brand.id>-releases` under the same
 * owner, ALWAYS public, because the desktop updater polls it with no token
 * ([#620](https://github.com/Omega-JS-Stack/omega/issues/620),
 * [#799](https://github.com/Omega-JS-Stack/omega/issues/799)).
 *
 * It is the release channel for EVERY target's built artifacts (desktop
 * installers and the extension's zips alike, tagged per target) and the one
 * home of that address: the site's download links, @omega.js/desktop's
 * electron-builder publish block and its finalize-release upload all read it
 * here, so the feed a shipped app polls can never disagree with the URL a
 * download button carries.
 *
 * @param {object} config - Composed omega config.
 * @returns {{ owner: string, name: string, slug: string }|null} Null when the config names no owner or no brand id.
 */
function releasesRepo(config) {
  return derivedRepo(config, 'releases');
}

/**
 * A declared target's entry, by name.
 * @param {object} config - Composed omega config carrying `targets`.
 * @param {string} name - The target name.
 * @returns {object} The entry.
 * @throws {Error} When the config declares no target of that name.
 */
function targetEntry(config, name) {
  const targets = config && config.targets;
  const entry = isPlainObject(targets) ? targets[name] : undefined;

  if (!isPlainObject(entry)) {
    const declared = isPlainObject(targets) ? Object.keys(targets) : [];
    throw new Error(`No target "${name}" is declared: this brand declares [${declared.join(', ')}]`);
  }

  return entry;
}

/**
 * Where a WEB target is served from: its own `hosting.provider`, else the
 * default `github`.
 * @param {object} config - Composed omega config carrying `targets`.
 * @param {string} name - The target name.
 * @returns {string} A HOSTING_PROVIDERS value.
 * @throws {Error} When the config declares no target of that name.
 */
function hostingProvider(config, name) {
  const entry = targetEntry(config, name);
  const hosting = isPlainObject(entry.hosting) ? entry.hosting : {};

  return hosting.provider || DEFAULT_HOSTING_PROVIDER;
}

/**
 * A web target's own repo: `<brand.id>-<target name>` under the brand's owner,
 * holding the BUILT site only (one force-orphan commit on `gh-pages`, served
 * by Pages at the target's url). The source monorepo stays private in a free
 * org this way, which is what a shared `gh-pages` branch on it made impossible.
 *
 * Only the target's NAME distinguishes it, per the `<brand.id>-<role>` rule, so
 * a second web target named `community` publishes to `<brand.id>-community`.
 *
 * @param {object} config - Composed omega config carrying `targets`.
 * @param {string} name - The web target's name.
 * @returns {{ owner: string, name: string, slug: string }|null} Null when the config names no owner or no brand id, and null when another provider hosts this target (there is no GitHub repo to address then).
 * @throws {Error} When the name is not declared, or names a target that is not web.
 */
function websiteRepo(config, name) {
  const entry = targetEntry(config, name);

  if (entry.type !== 'web') {
    throw new Error(`targets.${name} is a ${entry.type} target: only a web target is served from its own website repo`);
  }

  if (hostingProvider(config, name) !== 'github') return null;

  return derivedRepo(config, name);
}

/**
 * The GitHub Pages custom domain a web target serves at: the bare host of its
 * `targetUrl`. The ONE derivation of it, asked by the manage walk (which sets
 * the domain on the repo) and by the web deploy (which writes the CNAME file
 * the push publishes) alike, so the two can never claim different domains for
 * one site.
 *
 * A `*.github.io` host is NOT a custom domain
 * ([#366](https://github.com/Omega-JS-Stack/omega/issues/366)): a project
 * site's url names its PAGES address, and reading that as a domain would have
 * the deploy claim `<owner>.github.io` in a CNAME and mount the build at `/`,
 * where every asset 404s.
 *
 * @param {object} config - Composed omega config carrying `brand` and `targets`.
 * @param {string} name - The web target's name.
 * @returns {string} The bare host, or '' when the target has no custom domain (or no url at all).
 */
function pagesHost(config, name) {
  const targets = config && config.targets;
  // A target the config does not declare has no derivable url of its own: a
  // standalone project scaffolded before its first manage walk is the whole
  // site, so the brand's own url is the answer rather than a `<name>.` host
  // invented for a sibling that does not exist.
  const url = isPlainObject(targets) && isPlainObject(targets[name])
    ? targetUrl(config, name)
    : (config && config.brand ? config.brand.url : '');

  const host = brandHost(String(url || ''));

  return isDefaultPagesHost(host) ? '' : host;
}

/**
 * Whether a host is a GitHub default Pages host (`<owner>.github.io`, or the
 * bare form): an ADDRESS the hosting provider owns, never a domain a brand can
 * set a CNAME, a zone or a registrar on.
 * @param {string} host - A bare host, as `brandHost` returns it.
 * @returns {boolean}
 */
function isDefaultPagesHost(host) {
  return DEFAULT_PAGES_HOST.test(String(host || ''));
}

/**
 * The ONE skip reason of every domain-managing reader (the edge, domain,
 * search, cloud, account, campaigns and captcha services, the verify sweep's
 * live gate, the web purge): set when the url's host is a default Pages host,
 * so each skipper is one call.
 * @param {string} [url] - A brand url, scheme optional; empty answers null.
 * @returns {string|null} The reason, or null when the url names a domain (or nothing).
 */
function defaultAddressReason(url) {
  const host = brandHost(String(url || ''));

  return isDefaultPagesHost(host) ? `brand.url is the hosting provider's default address (${host}): no domain to manage` : null;
}

/**
 * A GitHub-hosted web target's default Pages address,
 * `https://<owner lowercased>.github.io/<brand.id>-<name>`: the url the
 * loader fills an unset `brand.url` with, and the host the web deploy's
 * project-site plan falls back to, so the two never spell it apart.
 * @param {object} config - Composed omega config carrying `targets`.
 * @param {string} name - The web target's name.
 * @returns {string|null} Null when `websiteRepo` is (no owner, no brand id, another provider).
 * @throws {Error} When the name is not declared, or names a target that is not web.
 */
function pagesAddress(config, name) {
  const website = websiteRepo(config, name);
  if (!website) return null;

  return `https://${website.owner.toLowerCase()}.github.io/${website.name}`;
}

/**
 * The brand monorepo's visibility, from the ONE place that states it: the brand
 * root's `package.json` `private` field. `true` or ABSENT is private (every
 * monorepo is private by default, Ian 2026-09-11); only a literal `false` is a
 * public brand. The manage walk reconciles the repo to this in both directions.
 *
 * @param {string} brandRoot - The brand root directory.
 * @returns {string} 'private' | 'public'.
 */
function brandVisibility(brandRoot) {
  let contents;

  try {
    contents = fs.readFileSync(path.join(brandRoot, 'package.json'), 'utf8');
  } catch (e) {
    // A brand with no manifest at all is private like any other: the default is
    // the safe half of the question, and the walk never guesses public. Any
    // OTHER read failure (a permission error, a directory in its place) is this
    // machine being broken, and answering 'private' for it would hide the break
    // behind a plausible answer.
    if (e.code === 'ENOENT') return 'private';
    throw e;
  }

  // A manifest that does not parse is a brand nobody can build: it fails here,
  // loudly, rather than reporting a visibility read off a file nothing read.
  const manifest = JSON.parse(contents);

  return manifest && manifest.private === false ? 'public' : 'private';
}

module.exports = {
  REPO_PROVIDERS,
  HOSTING_PROVIDERS,
  repoBlock,
  sourceRepo,
  repoDrift,
  repoMissing,
  releasesRepo,
  websiteRepo,
  hostingProvider,
  pagesHost,
  pagesAddress,
  isDefaultPagesHost,
  defaultAddressReason,
  brandVisibility,
};
