/**
 * The migrate rule set: the retired config keys (NAMES walked at every depth,
 * exact PATHS from the root) and the retired `.env` keys. The loader knows none
 * of them; `omega migrate` reports each one and converts it with `--execute`.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const path = require('node:path');
const JSON5 = require('json5');

const { findRetiredKeys, RETIRED_KEYS, RETIRED_PATHS, ConvertRefused } = require('../src/migrate/retired-keys.js');
const { RETIRED_ENV_KEYS, findRetiredEnvKeys } = require('../src/migrate/retired-env.js');
const { stageBrand, runMigrate, block } = require('./lib/migrate-harness.js');

const VALID = { brand: { id: 'sandbox-brand', name: 'Sandbox Brand' } };

// One line per finding, the shape the migrate report prints
const lines = (config) => findRetiredKeys(config).map(({ path, replacement, why }) => `${path} → ${replacement}: ${why}`);

// The row at `path` fired, and its line carries every word given
function fired(config, path, ...words) {
  return lines(config).some((line) => line.startsWith(`${path} → `) && words.every((word) => line.includes(word)));
}

const SEO_ITEM_ORG = `{
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://fixture-brand.test' },
  seo: {
    github: {
      content: [
        { name: 'fixture-tool', org: 'Acme-Org' },
      ],
    },
  },
  targets: { web: { type: 'web' } },
}
`;

module.exports = defineCases({
  type: 'group',
  description: 'migrate-retired',
  tests: [
    // ─── the config table ───

    {
      name: 'every row names its replacement and why',
      run: (ctx) => {
        for (const [key, row] of [...Object.entries(RETIRED_KEYS), ...Object.entries(RETIRED_PATHS)]) {
          ctx.expect(typeof row.replacement, `${key}: names where the setting went`).toBe('string');
          ctx.expect(row.why.length > 0, `${key}: says why`).toBeTruthy();
        }
      },
    },

    {
      name: 'parent is retired OUTRIGHT, and its last meaning is company.webhooks (#677)',
      run: (ctx) => {
        for (const value of [false, 'self', 'https://api.example.com', true]) {
          ctx.expect(fired({ ...VALID, parent: value }, 'parent', 'company.webhooks'), `parent: ${value} names the new home`).toBeTruthy();
        }
      },
    },

    {
      name: 'the flat provider picks are retired: one providers block per role (#425)',
      run: (ctx) => {
        const config = {
          ...VALID,
          translation: { languages: ['es'], provider: 'chatgpt' },
          domain: { provider: 'namecheap', email: { provider: 'cloudflare' } },
          devlog: { enabled: true, provider: 'ghostii', orgs: ['x'] },
          certificates: { apple: { bundleIdPrefix: 'com.acme' } },
          payment: { processors: { stripe: { publishableKey: 'pk_test_x' } } },
        };

        for (const [path, replacement] of [
          ['translation.provider', 'translation.providers.<name>'],
          ['domain.provider', 'domain.providers.<registrar>'],
          ['domain.email.provider', 'domain.email.providers.<provider>'],
          ['devlog.provider', 'devlog.providers.ghostii'],
          ['devlog.orgs', 'devlog.providers.ghostii.orgs'],
          ['certificates.apple', 'certificates.providers.apple'],
          ['payment.processors', 'payment.providers'],
        ]) {
          ctx.expect(fired(config, path, `→ ${replacement}:`), `${path} should name ${replacement}`).toBeTruthy();
        }
      },
    },

    {
      name: 'every converted monitoring + marketing leaf is retired by its exact path (#425)',
      run: (ctx) => {
        const config = {
          ...VALID,
          monitoring: {
            provider: 'sentry',
            org: 'acme-co',
            dsn: 'https://x@sentry.test/1',
            environment: 'production',
            sampleRate: 1,
            tracesSampleRate: 0.1,
            scrubEmail: true,
            attachScreenshot: false,
            bundlePatterns: ['/assets/js/'],
          },
          marketing: {
            campaigns: { provider: 'sendgrid', listId: 'lst_1' },
            newsletter: { provider: 'beehiiv', publicationId: 'pub_1' },
          },
          blog: { provider: 'ghostii' },
        };

        for (const [path, replacement] of [
          ['monitoring.provider', 'monitoring.providers.sentry'],
          ['monitoring.org', 'monitoring.providers.sentry.org'],
          ['monitoring.dsn', 'monitoring.providers.sentry.dsn'],
          ['monitoring.environment', 'monitoring.providers.sentry.environment'],
          ['monitoring.sampleRate', 'monitoring.providers.sentry.sampleRate'],
          ['monitoring.tracesSampleRate', 'monitoring.providers.sentry.tracesSampleRate'],
          ['monitoring.scrubEmail', 'monitoring.providers.sentry.scrubEmail'],
          ['monitoring.attachScreenshot', 'monitoring.providers.sentry.attachScreenshot'],
          ['monitoring.bundlePatterns', 'monitoring.providers.sentry.bundlePatterns'],
          ['marketing.campaigns.provider', 'marketing.campaigns.providers.sendgrid'],
          ['marketing.campaigns.listId', 'marketing.campaigns.providers.sendgrid.listId'],
          ['marketing.newsletter.provider', 'marketing.newsletter.providers.beehiiv'],
          ['marketing.newsletter.publicationId', 'marketing.newsletter.providers.beehiiv.publicationId'],
          ['blog.provider', 'blog.providers.ghostii'],
        ]) {
          ctx.expect(fired(config, path, `→ ${replacement}:`), `${path} should name ${replacement}`).toBeTruthy();
        }
      },
    },

    {
      name: 'a retired NAME fires wherever it sits: shared level and inside a target (#142)',
      run: (ctx) => {
        ctx.expect(fired({ ...VALID, web_manager: { auth: { enabled: true } } }, 'web_manager', 'client')).toBeTruthy();
        ctx.expect(fired({ ...VALID, targets: { web: { web_manager: { chatsy: {} } } } }, 'targets.web.web_manager', 'client')).toBeTruthy();
        ctx.expect(fired({ ...VALID, firebaseConfig: { projectId: 'acme' } }, 'firebaseConfig', 'cloud')).toBeTruthy();
        ctx.expect(fired({ ...VALID, targets: { web: { client: { cookieConsent: { enabled: false } } } } }, 'targets.web.client.cookieConsent', 'client.consent')).toBeTruthy();
      },
    },

    {
      name: 'the current client key is untouched by the table',
      run: (ctx) => {
        const config = { ...VALID, targets: { web: { type: 'web', client: { auth: {}, chatsy: {}, consent: {} } } } };

        ctx.expect(findRetiredKeys(config)).toEqual([]);
      },
    },

    {
      name: '#610: the legacy download and extension page maps name the blocks they derive from',
      run: (ctx) => {
        const config = {
          ...VALID,
          targets: { web: { type: 'web', download: { mac: { universal: 'https://acme.com/dl/mac' } }, extension: { chrome: 'https://acme.com/ext' } } },
        };

        ctx.expect(fired(config, 'targets.web.download', 'targets.desktop.releases')).toBeTruthy();
        ctx.expect(fired(config, 'targets.web.extension', 'targets.extension.listings')).toBeTruthy();
      },
    },

    {
      name: '#850: the four schema-less web sections are retired, one row each',
      run: (ctx) => {
        const config = {
          ...VALID,
          targets: {
            web: {
              type: 'web',
              favicon: { path: 'https://cdn.acme.com/favicon', 'theme-color': '#ffffff' },
              manifest: { name: 'Acme' },
              icons: { style: 'solid' },
              currency: 'USD',
            },
          },
        };

        const named = { favicon: 'assets/logo/brandmark.svg', manifest: 'site.webmanifest', icons: 'Font Awesome', currency: 'payment.currency' };
        for (const [key, replacement] of Object.entries(named)) {
          ctx.expect(fired(config, `targets.web.${key}`, replacement), `${key} names what answers it now: ${lines(config).join(' | ')}`).toBeTruthy();
        }
      },
    },

    {
      name: '#466 / #737 / #799: the web redirect map, the webpack externals and the downloads mirror keys',
      run: (ctx) => {
        ctx.expect(fired({ ...VALID, targets: { web: { redirects: [{ from: '/c/:id', to: '/code?id=:id' }] } } }, 'targets.web.redirects', 'edge.providers.cloudflare.rules.redirect')).toBeTruthy();
        ctx.expect(fired({ ...VALID, targets: { desktop: { em: { webpack: { externals: ['better-sqlite3'] } } } } }, 'targets.desktop.em.webpack.externals', 'esbuild')).toBeTruthy();

        const mirror = { ...VALID, targets: { desktop: { downloads: { enabled: true, owner: 'Acme-Org', repo: 'download-server', tag: 'installer' } } } };
        for (const key of ['enabled', 'owner', 'repo', 'tag']) {
          ctx.expect(fired(mirror, `targets.desktop.downloads.${key}`, '#799'), `downloads.${key} names the releases repo`).toBeTruthy();
        }
      },
    },

    {
      name: 'every de-branded top-level key names its new home (#23)',
      run: (ctx) => {
        const moved = {
          slapform: 'forms.providers.slapform',
          chatsy: 'inbound.chat.providers.chatsy',
          replyify: 'inbound.email.providers.replyify',
          cloudflare: 'edge.providers.cloudflare',
          recaptcha: 'captcha.providers.recaptcha',
          searchConsole: 'search.providers.searchConsole',
          gcp: 'cloud',
          firebase: 'cloud',
        };

        for (const [key, replacement] of Object.entries(moved)) {
          ctx.expect(fired({ ...VALID, [key]: {} }, key, replacement), `${key} must name ${replacement}`).toBeTruthy();
        }

        ctx.expect(fired({ ...VALID, advertising: { providers: { 'google-adsense': { client: 'ca-pub-1' } } } }, 'advertising.providers.google-adsense', 'advertising.providers.adsense')).toBeTruthy();
      },
    },

    {
      name: 'the retired adsense gates name the one switch (#628)',
      run: (ctx) => {
        for (const key of ['enabled', 'units']) {
          const config = { ...VALID, advertising: { providers: { adsense: { client: 'ca-pub-1', [key]: false } } } };
          ctx.expect(fired(config, `advertising.providers.adsense.${key}`, 'advertising.providers.adsense', '#527'), `adsense.${key}`).toBeTruthy();
        }
      },
    },

    {
      name: '#607: config meta.title / meta.description are retired, and only as PATHS',
      run: (ctx) => {
        const config = { ...VALID, meta: { title: 'Site default', description: 'Site desc' } };
        ctx.expect(fired(config, 'meta.title', 'brand.name')).toBeTruthy();
        ctx.expect(fired(config, 'meta.description', 'brand.description')).toBeTruthy();
        ctx.expect(fired({ ...VALID, targets: { web: { meta: { title: 'Site default' } } } }, 'targets.web.meta.title', 'brand.name')).toBeTruthy();

        // The analytics provider named `meta` keeps its name
        ctx.expect(findRetiredKeys({ ...VALID, analytics: { providers: { meta: { id: '123' } } } })).toEqual([]);
        ctx.expect(findRetiredKeys({ ...VALID, targets: { web: { type: 'web', meta: { index: false } } } })).toEqual([]);
      },
    },

    {
      name: '#564 / #858: seo.index and translation.exclude name their one-name homes',
      run: (ctx) => {
        ctx.expect(fired({ ...VALID, seo: { index: false } }, 'seo.index', 'targets.web.meta.index')).toBeTruthy();
        ctx.expect(fired({ ...VALID, translation: { exclude: ['docs'] } }, 'translation.exclude', 'translation.include')).toBeTruthy();
        ctx.expect(fired({ ...VALID, targets: { web: { type: 'web', translation: { exclude: ['docs'] } } } }, 'targets.web.translation.exclude', 'translation.include')).toBeTruthy();
      },
    },

    {
      name: '#858: the translation.exclude row CONVERTS: each skipped route becomes a negation',
      run: (ctx) => {
        const [finding] = findRetiredKeys({ ...VALID, translation: { exclude: ['docs', '/changelog/'] } });

        ctx.expect(finding.convert(['docs', '/changelog/'])).toEqual(['**', '!docs', '!changelog']);
      },
    },

    {
      name: '#732 / #886: a targets.<type> row fires inside the entry, on a target NAMED anything',
      run: (ctx) => {
        const config = {
          ...VALID,
          targets: {
            web: { type: 'web', meta: { title: 'Site default' }, redirects: [{ from: '/c/:id', to: '/code?id=:id' }] },
            community: { type: 'web', meta: { title: 'Site default' } },
            app: { type: 'desktop', downloads: { enabled: true } },
          },
        };

        ctx.expect(fired(config, 'targets.web.meta.title', 'brand.name')).toBeTruthy();
        ctx.expect(fired(config, 'targets.web.redirects', 'edge.providers.cloudflare.rules.redirect')).toBeTruthy();
        ctx.expect(fired(config, 'targets.community.meta.title', 'brand.name'), 'the second web target fires at its real path').toBeTruthy();
        ctx.expect(fired(config, 'targets.app.downloads.enabled', '#799'), 'the renamed desktop target fires too').toBeTruthy();

        // A type that owns no such row stays clean
        ctx.expect(findRetiredKeys({ ...VALID, targets: { docs: { type: 'custom', meta: { title: 'Docs' } } } })).toEqual([]);
      },
    },

    {
      name: '#588 / #788: subdomains and oauth2 are NAME rows, walked at every depth',
      run: (ctx) => {
        ctx.expect(fired({ ...VALID, brand: { ...VALID.brand, subdomains: ['admin', 'cdn'] } }, 'brand.subdomains', 'targets.web', "admin: { type: 'web' }")).toBeTruthy();
        ctx.expect(fired({ ...VALID, targets: { admin: { type: 'web', brand: { subdomains: ['x'] } } } }, 'targets.admin.brand.subdomains', 'targets.web')).toBeTruthy();
        ctx.expect(fired({ ...VALID, oauth2: { discord: { enabled: true } } }, 'oauth2', 'connections')).toBeTruthy();
        ctx.expect(fired({ ...VALID, targets: { backend: { oauth2: { google: {} } } } }, 'targets.backend.oauth2', 'connections')).toBeTruthy();
      },
    },

    {
      name: '#883: every retired repo key names what replaced it',
      run: (ctx) => {
        const config = {
          ...VALID,
          repo: { providers: { github: { enabled: true, org: 'Acme-Org', repo: 'acme-site', shared: false, private: true } } },
          github: { user: 'acme', website: 'https://github.com/acme/acme-site' },
          targets: {
            web: { type: 'web' },
            api: { type: 'backend', github: { repo: 'acme-content' } },
            desktop: { type: 'desktop', releases: { owner: 'Acme-Binaries', repo: 'acme-bins' } },
          },
        };

        const rows = {
          'repo.providers.github.org': 'repo.owner',
          'repo.providers.github.repo': '<brand.id>-omega',
          'repo.providers.github.private': 'package.json `private` field',
          'repo.providers.github.shared': 'org profile',
          'repo.providers.github.enabled': 'presence of the `repo` block',
          'github.user': 'repo.owner',
          'github.website': '<brand.id>-<target name>',
          'targets.api.github.repo': '<brand.id>-<role>',
          'targets.desktop.releases.owner': '<brand.id>-releases',
          'targets.desktop.releases.repo': '<brand.id>-releases',
        };

        for (const [path, replacement] of Object.entries(rows)) {
          ctx.expect(fired(config, path, replacement), `${path} must name ${replacement}: ${lines(config).join(' | ')}`).toBeTruthy();
        }
      },
    },

    {
      name: 'repo.org names repo.owner, and CONVERTS with the value as it is',
      run: (ctx) => {
        const config = { ...VALID, repo: { provider: 'github', org: 'Acme' } };
        const finding = findRetiredKeys(config).find((entry) => entry.path === 'repo.org');

        ctx.expect(fired(config, 'repo.org', 'repo.owner'), lines(config).join(' | ')).toBeTruthy();
        ctx.expect(finding.convert('Acme'), 'the owner moves as it is').toBe('Acme');

        // The live spelling is clean
        ctx.expect(findRetiredKeys({ ...VALID, repo: { provider: 'github', owner: 'Acme' } })).toEqual([]);
      },
    },

    {
      name: 'migrate --execute: repo.org is CONVERTED to repo.owner, and no org is left',
      run: async (ctx) => {
        const brand = stageBrand(`{
  brand: { id: 'fixture-brand', name: 'Fixture Brand', url: 'https://fixture-brand.test' },
  repo: { provider: 'github', org: 'Acme' },
  targets: { web: { type: 'web' } },
}
`);
        const { text } = await runMigrate(brand, { execute: true });

        const parsed = JSON5.parse(fs.readFileSync(path.join(brand, 'config', 'omega.json5'), 'utf8'));
        ctx.expect(parsed.repo, `the owner moved, and org is gone: ${text}`).toEqual({ provider: 'github', owner: 'Acme' });
      },
    },

    {
      name: 'migrate: an seo content item\'s org names seo.github.content[].owner, and --execute moves the value',
      run: async (ctx) => {
        const config = { ...VALID, seo: { github: { content: [{ name: 'fixture-tool', org: 'Acme-Org' }] } } };
        const finding = findRetiredKeys(config).find((entry) => entry.path === 'seo.github.content[0].org');
        ctx.expect(fired(config, 'seo.github.content[0].org', '→ seo.github.content[].owner:'), lines(config).join(' | ')).toBeTruthy();
        ctx.expect(finding.convert('Acme-Org'), 'the owner moves as it is').toBe('Acme-Org');

        const brand = stageBrand(SEO_ITEM_ORG);
        const report = await runMigrate(brand);
        ctx.expect(block(report.text, 'config/omega.json5'), report.text).toMatch(/due\s+move seo\.github\.content\[0\]\.org → seo\.github\.content\[0\]\.owner = "Acme-Org"/);

        const converted = await runMigrate(brand, { execute: true });
        const parsed = JSON5.parse(fs.readFileSync(path.join(brand, 'config', 'omega.json5'), 'utf8'));
        ctx.expect(parsed.seo.github.content, `owner written, org gone: ${converted.text}`).toEqual([{ name: 'fixture-tool', owner: 'Acme-Org' }]);
      },
    },

    {
      name: 'migrate --execute: an seo item carrying both org and owner is refused, never overwritten',
      run: async (ctx) => {
        const both = SEO_ITEM_ORG.replace("org: 'Acme-Org' }", "org: 'Acme-Org', owner: 'Other-Org' }");
        const brand = stageBrand(both);
        const { text, code } = await runMigrate(brand, { execute: true });

        ctx.expect(fs.readFileSync(path.join(brand, 'config', 'omega.json5'), 'utf8'), 'the file is untouched').toBe(both);
        ctx.expect(block(text, 'config/omega.json5'), text).toMatch(/refused seo\.github\.content\[0\]\.org → seo\.github\.content\[0\]\.owner/);
        ctx.expect(text.includes('delete one of the two by hand'), text).toBeTruthy();
        ctx.expect(code).toBe(1);
      },
    },

    {
      name: 'an seo item\'s author.token names author.tokenEnv, and CONVERTS by dropping the env: prefix',
      run: (ctx) => {
        const config = { ...VALID, seo: { github: { content: [{ name: 'fixture-tool', author: { token: 'env:GH_SOCK' } }] } } };
        const finding = findRetiredKeys(config).find((entry) => entry.path === 'seo.github.content[0].author.token');

        ctx.expect(fired(config, 'seo.github.content[0].author.token', '→ seo.github.content[].author.tokenEnv:'), lines(config).join(' | ')).toBeTruthy();
        ctx.expect(finding.convert('env:GH_SOCK'), 'the variable NAME moves, its prefix gone').toBe('GH_SOCK');
        ctx.expect(() => finding.convert('env:'), 'env: with no name names no variable, so nothing moves').toThrow(ConvertRefused);

        // The live spelling is clean
        ctx.expect(findRetiredKeys({ ...VALID, seo: { github: { content: [{ name: 'fixture-tool', author: { tokenEnv: 'GH_SOCK' } }] } } })).toEqual([]);
      },
    },

    {
      name: '#647: product limits and rateLimit name the features catalog, at their real array path',
      run: (ctx) => {
        const config = { ...VALID, payment: { products: [{ id: 'basic', name: 'Basic', limits: { saves: 100 }, rateLimit: 'monthly' }] } };

        ctx.expect(fired(config, 'payment.products[0].limits', 'payment.products[].features'), lines(config).join(' | ')).toBeTruthy();
        ctx.expect(fired(config, 'payment.products[0].rateLimit', 'features.<id>.usage.pace'), lines(config).join(' | ')).toBeTruthy();
      },
    },

    {
      name: '#849: a price spelled `amount` names `once`, at its real array path, and CONVERTS',
      run: (ctx) => {
        const config = { ...VALID, payment: { products: [{ id: 'kit', type: 'one-time', prices: { amount: 9.99 } }] } };
        const [finding] = findRetiredKeys(config);

        ctx.expect(fired(config, 'payment.products[0].prices.amount', 'payment.products[].prices.once'), lines(config).join(' | ')).toBeTruthy();
        ctx.expect(finding.convert(9.99), 'the number moves as it is').toBe(9.99);

        // The live spelling is clean
        ctx.expect(findRetiredKeys({ ...VALID, payment: { products: [{ id: 'kit', type: 'one-time', prices: { once: 9.99 } }] } })).toEqual([]);
      },
    },

    {
      name: '#677: the typed company name and parent wordmark name the resolved company',
      run: (ctx) => {
        const config = { ...VALID, brand: { ...VALID.brand, company: 'Acme Holdings Inc', images: { companyWordmark: '/wordmark.png' } } };

        ctx.expect(fired(config, 'brand.company', 'company.name')).toBeTruthy();
        ctx.expect(fired(config, 'brand.images.companyWordmark', 'company.images.wordmark')).toBeTruthy();
      },
    },

    {
      name: 'brand.contact.person is retired outright: one row for the block, deleted',
      run: (ctx) => {
        const config = { ...VALID, brand: { ...VALID.brand, contact: { email: 'support@acme.test', person: { name: 'Jane Doe, CEO', image: 'https://acme.test/jane.jpg' } } } };

        ctx.expect(fired(config, 'brand.contact.person'), lines(config).join(' | ')).toBeTruthy();
        ctx.expect(findRetiredKeys(config).length, 'one row for the block, never one per leaf').toBe(1);

        // The contact block itself stays live
        ctx.expect(findRetiredKeys({ ...VALID, brand: { ...VALID.brand, contact: { email: 'support@acme.test' } } })).toEqual([]);
      },
    },

    {
      name: 'migrate --execute: brand.contact.person is deleted, and the contact email it sat beside survives',
      run: async (ctx) => {
        const brand = stageBrand(`{
  brand: {
    id: 'fixture-brand',
    name: 'Fixture Brand',
    url: 'https://fixture-brand.test',
    contact: { email: 'support@fixture-brand.test', person: { name: 'Jane Doe, CEO' } },
  },
  targets: { web: { type: 'web' } },
}
`);
        const report = await runMigrate(brand);
        ctx.expect(block(report.text, 'config/omega.json5'), report.text).toMatch(/due\s+remove brand\.contact\.person → /);
        ctx.expect(report.code, 'a due step is a loud exit').toBe(1);

        const converted = await runMigrate(brand, { execute: true });
        const parsed = JSON5.parse(fs.readFileSync(path.join(brand, 'config', 'omega.json5'), 'utf8'));
        ctx.expect(parsed.brand.contact, `the person is gone: ${converted.text}`).toEqual({ email: 'support@fixture-brand.test' });
        ctx.expect(converted.code, converted.text).toBe(undefined);
      },
    },

    {
      name: 'the top-level adsense section and download map are rows too (#859)',
      run: (ctx) => {
        const config = {
          ...VALID,
          adsense: { accountId: 'pub-0000000000000000' },
          download: { mac: { universal: 'https://acme.test/mac' }, linux: { debian: 'https://acme.test/deb', snap: 'https://acme.test/snap' } },
        };

        ctx.expect(fired(config, 'adsense', 'advertising.providers.adsense.client'), lines(config).join(' | ')).toBeTruthy();
        ctx.expect(fired(config, 'download', 'targets.desktop.releases'), lines(config).join(' | ')).toBeTruthy();
        ctx.expect(findRetiredKeys(config).length, 'one row per section, never one per leaf').toBe(2);

        // The live homes stay clean
        ctx.expect(findRetiredKeys({ ...VALID, advertising: { providers: { adsense: { client: 'ca-pub-1' } } } })).toEqual([]);
      },
    },

    // ─── the .env table ───

    {
      name: 'every retired env key names its replacement and why',
      run: (ctx) => {
        ctx.expect(Object.keys(RETIRED_ENV_KEYS).sort()).toEqual([
          'CHARGEBEE_SITE',
          'CHROME_EXTENSION_ID',
          'EDGE_PRODUCT_ID',
          'FIREFOX_EXTENSION_ID',
          'OAUTH2_GOOGLE_CLIENT_ID',
          'OAUTH2_GOOGLE_CLIENT_SECRET',
          'OMEGA_TEST_FIREBASE_ADMIN_KEY',
          'OMEGA_TEST_USER_UID',
          'PAYPAL_CLIENT_ID',
          'RECAPTCHA_SITE_KEY',
        ]);

        for (const [name, row] of Object.entries(RETIRED_ENV_KEYS)) {
          ctx.expect(name, `${name}: env names are SCREAMING_SNAKE_CASE`).toMatch(/^[A-Z][A-Z0-9_]*$/);
          ctx.expect(typeof row.why === 'string' && row.why.length > 0, `${name}: says why`).toBeTruthy();

          // `null` is a key retired outright: a MECHANISM replaced it, not a value
          if (row.replacement === null) continue;

          ctx.expect(typeof row.replacement === 'string' && row.replacement.length > 0, `${name}: names its new home`).toBeTruthy();
          if (row.home === 'env') ctx.expect(row.replacement, `${name}: an env-side rename names an env key`).toMatch(/^[A-Z][A-Z0-9_]*$/);
        }
      },
    },

    {
      name: 'an env-side rename names the new ENV key, not a config path (#845)',
      run: (ctx) => {
        for (const name of ['OAUTH2_GOOGLE_CLIENT_ID', 'OAUTH2_GOOGLE_CLIENT_SECRET']) {
          const row = RETIRED_ENV_KEYS[name];

          ctx.expect(row.home, `${name}: its replacement lives in .env`).toBe('env');
          ctx.expect(row.replacement, `${name}: the prefix is the whole rename`).toBe(name.replace(/^OAUTH2_/, 'CONNECTIONS_'));
        }
      },
    },

    {
      name: 'the test-lane pair is retired outright, naming the mechanism (#819)',
      run: (ctx) => {
        for (const name of ['OMEGA_TEST_FIREBASE_ADMIN_KEY', 'OMEGA_TEST_USER_UID']) {
          ctx.expect(RETIRED_ENV_KEYS[name].replacement).toBe(null);
          ctx.expect(RETIRED_ENV_KEYS[name].why.includes('#904'), `${name}: names the seeded persona`).toBeTruthy();
        }
      },
    },

    {
      name: 'findRetiredEnvKeys reports only the keys a layer carries, in its own order',
      run: (ctx) => {
        const found = findRetiredEnvKeys({ GH_TOKEN: 'x', EDGE_PRODUCT_ID: '111', CHARGEBEE_SITE: 'acme' });

        ctx.expect(found.map((row) => row.key)).toEqual(['EDGE_PRODUCT_ID', 'CHARGEBEE_SITE']);
        ctx.expect(found[0].replacement).toBe('targets.<name>.listings.edge.id');
        ctx.expect(findRetiredEnvKeys({ GH_TOKEN: 'x' }), 'a clean layer reports nothing').toEqual([]);
        ctx.expect(findRetiredEnvKeys({})).toEqual([]);
      },
    },

    {
      name: 'a declared-but-empty line is still a retired line',
      run: (ctx) => {
        ctx.expect(findRetiredEnvKeys({ RECAPTCHA_SITE_KEY: '' }).map((row) => row.key)).toEqual(['RECAPTCHA_SITE_KEY']);
      },
    },
  ],
});
