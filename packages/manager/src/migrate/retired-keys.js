/**
 * The retired config keys: the `omega migrate` rule set, and the only code that
 * knows an old config name. RETIRED_KEYS are NAMES walked at every depth;
 * RETIRED_PATHS are exact paths from the root, a target NAME read as its TYPE.
 */
const { TARGET_TYPES, keyPath, itemPath, pathSteps } = require('@omega.js/config');
const { excludeToInclude } = require('@omega.js/devkit/translation-include');

/**
 * Thrown by a row's `convert` for a value it must not move: the pass reports a
 * refusal line with its message and leaves the key where it is.
 */
class ConvertRefused extends Error {}

/**
 * An seo item's `author.token` as the variable NAME it pointed at: `env:X`
 * becomes `X`; a bare `env:` names nothing, and anything else is a literal
 * token, which never moves into config: both are refused.
 * @param {*} value - The authored `author.token`.
 * @returns {string}
 */
function tokenEnvName(value) {
  if (value === 'env:') throw new ConvertRefused('the value names no variable; write author.tokenEnv: "<NAME>" by hand');
  if (typeof value === 'string' && value.startsWith('env:')) return value.slice('env:'.length);

  throw new ConvertRefused('a token never lives in config; put it in .env as a variable and write author.tokenEnv: "<NAME>"');
}

// A row: { replacement, why } and an optional `convert` (old value → new value).
// key NAME, matched at every depth
const RETIRED_KEYS = {
  web_manager: {
    replacement: 'client',
    why: 'it configures @omega.js/client (#1); WebManager is not an OMEGA concept',
  },
  firebaseConfig: {
    replacement: 'cloud',
    why: "the provider-discriminated role key: cloud: { provider: 'firebase', config: {…} }",
  },
  cookieConsent: {
    replacement: 'client.consent',
    why: 'the banner became a real consent gate (#383): the block names the DECISION, not the cookie, and its palette/theme/type keys are gone (tokens paint it, the visitor\'s region picks opt-in vs opt-out)',
  },

  subdomains: {
    replacement: 'targets.web',
    why: "each subdomain is its own web TARGET (#588/#886): [\"admin\", \"cdn\"] becomes sibling keys beside the main site, `admin: { type: 'web' }, cdn: { type: 'web' }`, where the NAME is the subdomain (https://admin.<brand host>), an entry's own `url` overrides it for a custom host, and the targets share ONE api.<domain>",
  },

  oauth2: {
    replacement: 'connections',
    why: "the product concept is a CONNECTION (#788): the per-provider block is unchanged, the credentials are the CONNECTIONS_<PROVIDER>_CLIENT_ID/_SECRET env pair now, and a brand's own provider lives at targets/backend/src/connections/<name>.js",
  },

  parent: {
    replacement: 'company.webhooks',
    why: "the company block names the parent (#677): the topology is `company: { id: '<parent brand.id>' }` (or 'self'), and the only other thing `parent` ever said, `false` for \"the provider ACCOUNT is shared and its one account-level webhook is owned elsewhere\", is `company: { webhooks: false }`",
  },
};


// exact dotted path from the root, a `targets.<type>` row matching every target of that type
const RETIRED_PATHS = {
  slapform: {
    replacement: 'forms.providers.slapform',
    why: 'config keys name the ROLE, not the vendor (#23)',
  },
  chatsy: {
    replacement: 'inbound.chat.providers.chatsy',
    why: 'config keys name the ROLE, not the vendor (#23): one home for the manager fields and the widget settings',
  },
  replyify: {
    replacement: 'inbound.email.providers.replyify',
    why: 'config keys name the ROLE, not the vendor (#23)',
  },
  cloudflare: {
    replacement: 'edge.providers.cloudflare',
    why: 'config keys name the ROLE, not the vendor (#23)',
  },
  recaptcha: {
    replacement: 'captcha.providers.recaptcha',
    why: 'config keys name the ROLE, not the vendor (#23)',
  },
  searchConsole: {
    replacement: 'search.providers.searchConsole',
    why: 'config keys name the ROLE, not the vendor (#23): `seo` already means the parasite-SEO content feature',
  },
  gcp: {
    replacement: 'cloud',
    why: 'one cloud home (#23): gcp.organizationId/billingAccount are now cloud.organizationId/cloud.billingAccount',
  },
  firebase: {
    replacement: 'cloud',
    why: 'one cloud home (#23): the provisioning fields are now cloud.shared/supportEmail/apiSubdomain, and projectId lives only at cloud.config.projectId',
  },
  'advertising.providers.google-adsense': {
    replacement: 'advertising.providers.adsense',
    why: 'provider ids drop the vendor prefix and every key is camelCase (#23): the slots are displaySlot/inArticleSlot/inFeedSlot/multiplexSlot',
  },

  'advertising.providers.adsense.enabled': {
    replacement: 'advertising.providers.adsense',
    why: 'adsense has ONE switch (#527): `client` presence manages the account, renders the units and writes the ads.txt record together: set `advertising.providers.adsense: false` to opt the provider out, and there is no second gate to disable it with',
  },
  'advertising.providers.adsense.units': {
    replacement: 'advertising.providers.adsense',
    why: 'adsense has ONE switch (#527): the render gate the key proposed was refused: `client` presence is the whole answer, so a managed-but-ad-free brand omits the block and manages the account by hand',
  },

  'payment.processors': {
    replacement: 'payment.providers',
    why: 'one provider shape everywhere (#425): the block is `providers` in every role, payment included (and the singular word followed in #428: `provider` on a subscription/webhook document, on the payments routes, and in the code)',
  },
  'certificates.apple': {
    replacement: 'certificates.providers.apple',
    why: 'one provider shape everywhere (#425): no bare vendor keys; Windows signing will sit beside it as certificates.providers.<vendor>',
  },
  'domain.provider': {
    replacement: 'domain.providers.<registrar>',
    why: 'one provider shape everywhere (#425): the registrar is a KEY under `domain.providers` (namecheap/squarespace); no entry = none chosen and the domain service skips, exactly as a null provider did',
  },
  'domain.email.provider': {
    replacement: 'domain.email.providers.<provider>',
    why: 'one provider shape everywhere (#425): the mailbox provider is a KEY under `domain.email.providers` (cloudflare/squarespace/privateemail); `domain.email.forwarding` stays role-level',
  },
  'translation.provider': {
    replacement: 'translation.providers.<name>',
    why: 'one provider shape everywhere (#425): presence picks the engine ({ claude: {} } / { chatgpt: {} }); `translation.model` stays role-level',
  },
  'devlog.provider': {
    replacement: 'devlog.providers.ghostii',
    why: 'one provider shape everywhere (#425): the writer is a KEY under `devlog.providers`, and its settings moved inside it; `devlog.enabled` stays role-level',
  },
  'devlog.lookbackDays': {
    replacement: 'devlog.providers.ghostii.lookbackDays',
    why: 'provider-hung devlog settings live under the provider that reads them (#425)',
  },
  'devlog.orgs': {
    replacement: 'devlog.providers.ghostii.orgs',
    why: 'provider-hung devlog settings live under the provider that reads them (#425)',
  },
  'devlog.excludeRepos': {
    replacement: 'devlog.providers.ghostii.excludeRepos',
    why: 'provider-hung devlog settings live under the provider that reads them (#425)',
  },
  'devlog.excludeCommits': {
    replacement: 'devlog.providers.ghostii.excludeCommits',
    why: 'provider-hung devlog settings live under the provider that reads them (#425)',
  },
  'devlog.excludeTopics': {
    replacement: 'devlog.providers.ghostii.excludeTopics',
    why: 'provider-hung devlog settings live under the provider that reads them (#425)',
  },
  'devlog.includePrivate': {
    replacement: 'devlog.providers.ghostii.includePrivate',
    why: 'provider-hung devlog settings live under the provider that reads them (#425)',
  },
  'devlog.postPath': {
    replacement: 'devlog.providers.ghostii.postPath',
    why: 'provider-hung devlog settings live under the provider that reads them (#425)',
  },
  'devlog.destinations': {
    replacement: 'devlog.providers.ghostii.destinations',
    why: 'provider-hung devlog settings live under the provider that reads them (#425)',
  },
  'devlog.overrides': {
    replacement: 'devlog.providers.ghostii.overrides',
    why: 'provider-hung devlog settings live under the provider that reads them (#425)',
  },
  'monitoring.provider': {
    replacement: 'monitoring.providers.sentry',
    why: "one provider shape everywhere (#425): the monitor is a KEY under `monitoring.providers` (only sentry today); `monitoring.enabled` stays role-level",
  },
  'monitoring.org': {
    replacement: 'monitoring.providers.sentry.org',
    why: 'provider-hung Sentry settings live under the provider that reads them (#425)',
  },
  'monitoring.dsn': {
    replacement: 'monitoring.providers.sentry.dsn',
    why: 'provider-hung Sentry settings live under the provider that reads them (#425): per-surface DSNs are targets.<name>.monitoring.providers.sentry.dsn',
  },
  'monitoring.environment': {
    replacement: 'monitoring.providers.sentry.environment',
    why: 'provider-hung Sentry settings live under the provider that reads them (#425)',
  },
  'monitoring.sampleRate': {
    replacement: 'monitoring.providers.sentry.sampleRate',
    why: 'provider-hung Sentry settings live under the provider that reads them (#425)',
  },
  'monitoring.tracesSampleRate': {
    replacement: 'monitoring.providers.sentry.tracesSampleRate',
    why: 'provider-hung Sentry settings live under the provider that reads them (#425)',
  },
  'monitoring.scrubEmail': {
    replacement: 'monitoring.providers.sentry.scrubEmail',
    why: 'provider-hung Sentry settings live under the provider that reads them (#425)',
  },
  'monitoring.attachScreenshot': {
    replacement: 'monitoring.providers.sentry.attachScreenshot',
    why: 'provider-hung Sentry settings live under the provider that reads them (#425)',
  },
  'monitoring.bundlePatterns': {
    replacement: 'monitoring.providers.sentry.bundlePatterns',
    why: 'provider-hung Sentry settings live under the provider that reads them (#425)',
  },
  'marketing.campaigns.provider': {
    replacement: 'marketing.campaigns.providers.sendgrid',
    why: "one provider shape everywhere (#425): the email-marketing vendor is a KEY under `marketing.campaigns.providers`; `marketing.campaigns.enabled` stays role-level",
  },
  'marketing.campaigns.listId': {
    replacement: 'marketing.campaigns.providers.sendgrid.listId',
    why: 'the list id is a SendGrid fact and lives under the provider that reads it (#425)',
  },
  'marketing.newsletter.provider': {
    replacement: 'marketing.newsletter.providers.beehiiv',
    why: "one provider shape everywhere (#425): the newsletter vendor is a KEY under `marketing.newsletter.providers`; `marketing.newsletter.enabled` and `marketing.newsletter.content` stay role-level (content is pipeline config, not Beehiiv config)",
  },
  'marketing.newsletter.publicationId': {
    replacement: 'marketing.newsletter.providers.beehiiv.publicationId',
    why: 'the publication id is a Beehiiv fact and lives under the provider that reads it (#425)',
  },
  'blog.provider': {
    replacement: 'blog.providers.ghostii',
    why: "one provider shape everywhere (#425): the blog writer is a KEY under `blog.providers`; `blog.enabled` and `blog.content` stay role-level (content is pipeline config)",
  },

  'meta.title': {
    replacement: 'brand.name (and the page\'s own frontmatter `meta.title`)',
    why: 'a title never exists in two places (#607): page frontmatter `meta:` is the only per-page meta, and the site-wide default is the brand block the head falls back to',
  },
  'meta.description': {
    replacement: 'brand.description (and the page\'s own frontmatter `meta.description`)',
    why: 'a description never exists in two places (#607): page frontmatter `meta:` is the only per-page meta, and the site-wide default is the brand block the head falls back to',
  },
  'targets.web.meta.title': {
    replacement: 'brand.name (and the page\'s own frontmatter `meta.title`)',
    why: 'a title never exists in two places (#607): @omega.js/web reads no site-wide title; a per-page title belongs in that page\'s own frontmatter',
  },
  'targets.web.meta.description': {
    replacement: 'brand.description (and the page\'s own frontmatter `meta.description`)',
    why: 'a description never exists in two places (#607): @omega.js/web reads no site-wide description; a per-page description belongs in that page\'s own frontmatter',
  },

  'seo.index': {
    replacement: 'targets.web.meta.index',
    why: 'a global value and its specific override share ONE name (#564, Ian 2026-09-09): the site-wide default is `targets.web.meta.index` and a page overrides it with `meta.index` in its own frontmatter; `seo` keeps `enabled` and `github.content`',
  },

  'targets.web.download': {
    replacement: 'targets.desktop.releases',
    why: 'two homes for one fact (#610): the /download page and its shortlinks derive from the desktop target\'s releases block, curated onto site.targets.desktop.releasesUrl; a hand-written map could point at a release that does not exist',
  },
  'targets.web.extension': {
    replacement: 'targets.extension.listings',
    why: 'two homes for one fact (#610): the /extension page and its shortlinks read the extension target\'s store listings, curated onto site.targets.extension.listings',
  },

  'targets.web.favicon': {
    replacement: 'nothing for the path; the brand\'s assets/logo/brandmark.svg is the source image',
    why: 'the web build ships the favicon set at /assets/images/favicon (#850): the target\'s own `src/assets/images/favicon/`, else a set it derives from the brand\'s assets/logo/brandmark.svg, so a path override pointed the whole site at a folder nothing fills; theme-color comes from `brand.color` now, the one place a brand states its hex',
  },
  'targets.web.manifest': {
    replacement: 'nothing: the favicon set ships site.webmanifest',
    why: 'no reader anywhere in @omega.js/web (#850): the web app manifest that ships is the favicon set\'s own site.webmanifest, so every key under this block was a value nothing consulted',
  },
  'targets.web.icons': {
    replacement: 'the `icon` on the link itself, as Font Awesome classes',
    why: 'one icon mechanism (#619): a footer link carries its own `fa-*` classes (`icon: \'fa-brands fa-github\'`), so the name-to-markup map is gone; the legacy block only ever held a `style`, which the map lookup could never resolve',
  },
  'targets.web.currency': {
    replacement: 'payment.currency',
    why: 'two homes for one fact (#850): the price currency belongs to the payment section every other surface reads it from, and the pricing JSON-LD reads it there',
  },

  'targets.web.redirects': {
    replacement: 'edge.providers.cloudflare.rules.redirect',
    why: 'redirects are not web config (#466): a TEMPLATED redirect (/c/:id → /code?id=:id) is a Cloudflare redirect rule the edge service reconciles, and a redirect whose URLs can be enumerated is a PAGE on the `modules/utilities/redirect` layout with `redirect.url` in its frontmatter',
  },

  'targets.desktop.em.webpack.externals': {
    replacement: 'nothing: the externals set is framework-owned',
    why: "the desktop bundler is esbuild (#737) and there is no consumer-facing override key: the externals set is the framework's native-module list (`nativeExternals` in @omega.js/desktop's src/gulp/tasks/bundle.js) plus what the consumer's own package.json declares from it, so a genuinely native module the list misses is raised upstream and every brand gets the fix",
  },

  'payment.products.limits': {
    replacement: 'payment.products[].features',
    why: 'a product names one VALUE per feature (#647): `limits: { saves: 100 }` becomes `features: { saves: 100 }`, and the feature itself (name, icon, definition, pacing, mirrors) is defined once in the top-level `features` catalog',
  },
  'payment.products.rateLimit': {
    replacement: 'features.<id>.usage.pace',
    why: 'pacing is per FEATURE now (#647): day pacing is the default on every counted feature, and `usage: { pace: false }` on the catalog entry is the opt-out the product-wide `rateLimit: "monthly"` used to be',
  },

  'payment.products.prices.amount': {
    replacement: 'payment.products[].prices.once',
    why: 'one one-time price key (#849): every reader of a one-time price takes `once`, and the config validator refuses `amount` (and `monthly` on a one-time product), so the number moves to `once` inside its own product',
    convert: (value) => value,
  },

  'targets.desktop.downloads.enabled': {
    replacement: 'targets.desktop.releases',
    why: 'one public releases repo per brand (#620/#799): the fixed-name mirror is gone, and the versionless assets on the releases repo ARE the permanent download links',
  },
  'targets.desktop.downloads.owner': {
    replacement: 'targets.desktop.releases.owner',
    why: 'one public releases repo per brand (#620/#799): there is no second repo to own, and the releases owner defaults to the brand repo owner',
  },
  'targets.desktop.downloads.repo': {
    replacement: 'targets.desktop.releases.repo',
    why: 'one public releases repo per brand (#620/#799): the release artifacts and the marketing downloads are the same assets in `<brand.id>-releases`',
  },
  'targets.desktop.downloads.tag': {
    replacement: 'nothing: the versionless assets live on the `v<x.y.z>` release',
    why: 'one public releases repo per brand (#620/#799): a stable mirror tag is what `/releases/latest/download/<asset>` replaced, so no tag is configured anywhere',
  },

  'repo.org': {
    replacement: 'repo.owner',
    why: 'a repo is owned by a user or an org, and GitHub\'s word is owner (#1041): `repo: { provider: \'github\', owner }` is the whole block, so the value moves unchanged',
    convert: (value) => value,
  },
  'seo.github.content.org': {
    replacement: 'seo.github.content[].owner',
    why: 'a repo is owned by a user or an org, and GitHub\'s word is owner (#1041): an seo content item names its own repo owner with `owner`, so the value moves unchanged inside its item',
    convert: (value) => value,
  },
  'seo.github.content.author.token': {
    replacement: 'seo.github.content[].author.tokenEnv',
    why: 'a token never lives in config (#1059): the key names the `.env` variable that holds it, so `env:GH_SOCK` becomes `tokenEnv: "GH_SOCK"`, and the seo walk fails the item when that variable is unset',
    convert: tokenEnvName,
  },
  'repo.providers.github.org': {
    replacement: 'repo.owner',
    why: 'ONE repo block (#883): `repo: { provider: \'github\', owner }` is the whole declaration, and the owner owns every repo the brand derives',
  },
  'repo.providers.github.repo': {
    replacement: 'nothing: the source repo IS `<brand.id>-omega`',
    why: 'no repo NAME is configurable anywhere (#883): a repo name that must differ is a brand id that must differ, so rename the GitHub repo to `<brand.id>-omega` instead',
  },
  'repo.providers.github.private': {
    replacement: 'the brand root package.json `private` field',
    why: 'visibility has ONE statement (#883): `private: true` (or absent) is a private brand, `false` a public one, and the manage walk reconciles the repo to it in both directions',
  },
  'repo.providers.github.shared': {
    replacement: 'nothing: an org may host many brands, and no brand rewrites an org profile',
    why: 'the org-profile reconcile is gone (#883), so there is no shared-org exception left to declare',
  },
  'repo.providers.github.enabled': {
    replacement: 'the presence of the `repo` block',
    why: 'presence is the switch (#883), exactly as a target key\'s presence enables that target: a brand that hosts its source somewhere the manager does not touch omits the block',
  },
  'github.user': {
    replacement: 'nothing: the owner is `repo.owner`',
    why: 'the separate GitHub identity block is gone (#883): nothing read `user`, and every repo address derives from `repo.owner` plus `brand.id`',
  },
  'github.website': {
    replacement: 'nothing: a web target\'s site repo is `<brand.id>-<target name>`',
    why: 'the website repo derives now (#883): each GitHub-hosted web target publishes its built site to its own `<brand.id>-<name>` repo, Pages serving it at the target\'s url',
  },
  'brand.company': {
    replacement: 'company.name (resolved from `company: { id }`)',
    why: "the company is ONE top-level key now (#677): type `company: { id: '<parent brand.id>' }` (or 'self') and the loader fills company.name/url/images from the parent's own config, so no brand restates its parent's facts",
  },
  'brand.images.companyWordmark': {
    replacement: 'company.images.wordmark (resolved from `company: { id }`)',
    why: "the parent's wordmark is the parent's own `brand.images.wordmark` (#677), resolved through `company: { id }` for every sub-brand instead of pasted into each one",
  },
  'brand.contact.person': {
    replacement: 'nothing: the sends sign off as the brand',
    why: 'the welcome, discount-nudge and checkup emails speak as the brand\'s team and sign off as it (#824), so no human identity is configured anywhere',
  },

  'platforms.win': {
    replacement: 'platforms.windows (with its formats inside: platforms.windows.formats.nsis)',
    why: "ONE platform vocabulary, the client's (#867): run `npx omega manage --migration=platform-names --execute` at the brand root to rewrite it (it also renames config/icons/macos/ to config/icons/mac/). Run the migration BEFORE `npx omega migrate --execute`, which deletes a retired key rather than moving it",
  },
  'targets.desktop.platforms.win': {
    replacement: 'targets.desktop.platforms.windows (with its formats inside: platforms.windows.formats.nsis)',
    why: "ONE platform vocabulary, the client's (#867): run `npx omega manage --migration=platform-names --execute` at the brand root to rewrite it (it also renames config/icons/macos/ to config/icons/mac/). Run the migration BEFORE `npx omega migrate --execute`, which deletes a retired key rather than moving it",
  },
  'platforms.linux.snap': {
    replacement: 'platforms.linux.formats.snap (presence IS the switch, so the `enabled` flag is gone)',
    why: 'what a target ships is one declaration now (#867): every platform and format defaults ON and `platforms.linux.formats.snap: false` is the only way to drop the snap. Its settings (channels, confinement, grade, autoStart) move inside the format. `npx omega manage --migration=platform-names --execute` performs the move',
  },
  'targets.desktop.platforms.linux.snap': {
    replacement: 'targets.desktop.platforms.linux.formats.snap (presence IS the switch, so the `enabled` flag is gone)',
    why: 'what a target ships is one declaration now (#867): every platform and format defaults ON and `platforms.linux.formats.snap: false` is the only way to drop the snap. Its settings (channels, confinement, grade, autoStart) move inside the format. `npx omega manage --migration=platform-names --execute` performs the move',
  },

  'translation.exclude': {
    replacement: 'translation.include',
    why: "the route list says what to TRANSLATE now (#858, Ian 2026-09-13): globs with `!` negation, read in .gitignore order, defaulting to ['**', '!blog/**'], so `exclude: ['docs']` becomes `include: ['**', '!docs']`, and a page overrides it for itself with `translation.include: true`/`false` in its own frontmatter. `npx omega migrate --execute` at the brand root performs the move",
    convert: excludeToInclude,
  },
  'targets.web.translation.exclude': {
    replacement: 'targets.web.translation.include',
    why: "the route list says what to TRANSLATE now (#858, Ian 2026-09-13): globs with `!` negation, read in .gitignore order, defaulting to ['**', '!blog/**'], so `exclude: ['docs']` becomes `include: ['**', '!docs']`, and a page overrides it for itself with `translation.include: true`/`false` in its own frontmatter. `npx omega migrate --execute` at the brand root performs the move",
    convert: excludeToInclude,
  },

  'targets.desktop.releases.owner': {
    replacement: 'nothing: the releases repo is `<brand.id>-releases` under `repo.owner`',
    why: 'one public releases repo per brand (#883), with no override: `releases: {}` stays the presence switch for the site\'s download links',
  },
  'targets.desktop.releases.repo': {
    replacement: 'nothing: the releases repo is `<brand.id>-releases` under `repo.owner`',
    why: 'one public releases repo per brand (#883), with no override: `releases: {}` stays the presence switch for the site\'s download links',
  },

  adsense: {
    replacement: 'advertising.providers.adsense.client',
    why: "the AdSense account is the ad provider's own `client` id (ca-pub-…), from which the manager derives the account, so a top-level `adsense` section is read by nothing (#527): write the id as `advertising.providers.adsense.client` if it is not there yet",
  },
  download: {
    replacement: 'targets.desktop.releases',
    why: 'two homes for one fact (#610): the /download page and its shortlinks derive from the desktop target\'s releases block, curated onto site.targets.desktop.downloads; a hand-written map could point at a release that does not exist',
  },
};

// The per-target `github` override, one row per TYPE, so a type nobody listed
// by hand is covered too.
for (const type of TARGET_TYPES) {
  RETIRED_PATHS[`targets.${type}.github.repo`] = {
    replacement: 'nothing: every repo the brand owns is `<brand.id>-<role>` under `repo.owner`',
    why: 'no repo NAME is configurable anywhere (#883): the CMS commits to the SOURCE repo `<brand.id>-omega`, so a content repo of its own is a brand of its own',
  };
}

/**
 * The SHAPE a walked path matches rows by: list positions dropped, a target
 * NAME read as its TYPE. The reported path stays the real one.
 * @param {string} path
 * @param {object} types - target name → type
 * @returns {string}
 */
function shapePath(path, types) {
  const parts = pathSteps(path).filter((step) => typeof step !== 'number');

  if (parts[0] === 'targets' && parts.length > 1 && types[parts[1]]) {
    parts[1] = types[parts[1]];
  }

  return parts.join('.');
}

/**
 * Every declared target's name → type, read off the config being walked.
 * @param {object} object - Parsed config (or any sub-tree of one).
 * @returns {object} name → type; {} when there is no targets map.
 */
function targetTypes(object) {
  const targets = object && object.targets;
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) return {};

  const types = {};
  Object.keys(targets).forEach((name) => {
    const entry = targets[name];
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.type === 'string') {
      types[name] = entry.type;
    }
  });

  return types;
}

function walk(node, path, found, types) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, itemPath(path, index), found, types));
    return;
  }

  if (typeof node !== 'object' || node === null) {
    return;
  }

  Object.keys(node).forEach((key) => {
    const childPath = keyPath(path, key);

    if (RETIRED_KEYS[key]) {
      found.push({ path: childPath, key, ...RETIRED_KEYS[key] });
    }

    const shape = shapePath(childPath, types);

    if (RETIRED_PATHS[shape]) {
      found.push({ path: childPath, key, ...RETIRED_PATHS[shape] });
    }

    walk(node[key], childPath, found, types);
  });
}

/**
 * Every retired key a config carries, in file order.
 * @param {object} object - Parsed config (or any sub-tree of one).
 * @returns {Array<{ path: string, key: string, replacement: string, why: string, convert?: Function }>}
 */
function findRetiredKeys(object) {
  const found = [];
  walk(object, '', found, targetTypes(object));
  return found;
}

module.exports = { findRetiredKeys, ConvertRefused, RETIRED_KEYS, RETIRED_PATHS };
