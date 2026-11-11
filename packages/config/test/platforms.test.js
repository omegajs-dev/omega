/**
 * platforms: the ONE shipping vocabulary and format table (#867). What each
 * target can ship, what each format needs to ship, and the versionless
 * artifact names desktop packages under (#620, inherited from the retired
 * desktop-artifacts.js).
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

const {
  PLATFORMS, FORMATS, enabledFormats, formatKeys,
  WINDOWS_SIGNING_STRATEGIES, DEFAULT_WINDOWS_SIGNING_STRATEGY, WINDOWS_CLOUD_PROVIDERS, windowsSigningStrategy, windowsCloudProviderKeys, validateConfig,
  desktopProductName, sanitizeProductName, desktopArtifactName, desktopArtifactNames,
} = require('../src/index.js');
const { snapName, formatKeysSet } = require('../src/platforms.js');
const { ENV_SCHEMA } = require('../src/env-schema.js');
const { SHARED_SCHEMA, TARGET_SCHEMAS } = require('../src/schema.js');

const DESKTOP = { targets: { desktop: { type: 'desktop' } } };
const signing = (value) => ({ ...DESKTOP, platforms: { windows: { signing: value } } });
const SIGNING_CONFIGS = {
  'self-hosted': signing({ strategy: 'self-hosted' }),
  ...Object.fromEntries(WINDOWS_CLOUD_PROVIDERS.map((provider) => [provider, signing({ strategy: 'cloud', cloud: { provider } })])),
};

/**
 * The signing configs a key's requiredWhen holds on. A key owed on every
 * signing choice (the default snap's login) hangs off none of them.
 * @param {object} entry - An env schema entry.
 * @returns {string[]} The strategy or cloud provider names.
 */
const gatedOn = (entry) => {
  const names = Object.entries(SIGNING_CONFIGS)
    .filter(([, config]) => typeof entry.requiredWhen === 'function' && entry.requiredWhen(config))
    .map(([name]) => name);
  return names.length === Object.keys(SIGNING_CONFIGS).length ? [] : names;
};

module.exports = defineCases({
  type: 'group',
  description: 'platforms',
  tests: [
    // ─── the vocabulary ──────────────────────────────────────────────────────────

    {
      name: 'the vocabulary is the client\'s, per target: mac, never macos',
      run: (ctx) => {
        ctx.expect(PLATFORMS.desktop).toEqual(['mac', 'windows', 'linux']);
        ctx.expect(PLATFORMS.extension).toEqual(['chrome', 'firefox', 'edge']);
        // Every platform in the vocabulary carries a format table, and nothing else does
        ctx.expect(Object.keys(FORMATS)).toEqual(['desktop', 'extension']);
        for (const target of Object.keys(FORMATS)) {
          ctx.expect(Object.keys(FORMATS[target]), target).toEqual(PLATFORMS[target]);
        }
      },
    },

    {
      name: 'every format says what it IS: a release asset with an extension, or a store',
      run: (ctx) => {
        ctx.expect(Object.keys(FORMATS.desktop.mac)).toEqual(['dmg']);
        ctx.expect(Object.keys(FORMATS.desktop.windows)).toEqual(['nsis']);
        ctx.expect(Object.keys(FORMATS.desktop.linux)).toEqual(['deb', 'appimage', 'snap']);
        ctx.expect(Object.keys(FORMATS.extension.chrome)).toEqual(['zip', 'store']);

        ctx.expect(FORMATS.desktop.windows.nsis.kind).toBe('asset');
        ctx.expect(FORMATS.desktop.windows.nsis.ext).toBe('exe');
        ctx.expect(FORMATS.desktop.linux.appimage.ext).toBe('AppImage');
        // A store publishes; it is never a file on the releases repo
        ctx.expect(FORMATS.desktop.linux.snap.kind).toBe('store');
        ctx.expect(FORMATS.desktop.linux.snap.ext).toBe(undefined);
        ctx.expect(FORMATS.extension.chrome.store.kind).toBe('store');
        ctx.expect(FORMATS.extension.chrome.zip.kind).toBe('asset');
      },
    },

    // ─── the keys a format cannot ship without ───────────────────────────────────

    {
      name: 'every env key a format requires EXISTS in the env schema',
      run: (ctx) => {
        const names = new Set(ENV_SCHEMA.filter((entry) => entry.name).map((entry) => entry.name));
        const missing = [];

        for (const [target, platforms] of Object.entries(FORMATS)) {
          for (const [platform, formats] of Object.entries(platforms)) {
            for (const [format, spec] of Object.entries(formats)) {
              for (const key of spec.requires) {
                if (!names.has(key)) missing.push(`${target}.${platform}.${format}: ${key}`);
              }
            }
          }
        }

        ctx.expect(missing, 'a format cannot require a key the env schema does not declare').toEqual([]);
      },
    },

    {
      name: 'every listing id a format needs is a DECLARED config path (#893), never an env key',
      run: (ctx) => {
        const paths = new Set([...SHARED_SCHEMA, ...Object.values(TARGET_SCHEMAS).flat()].map((rule) => rule.path));
        const missing = [];

        for (const platforms of Object.values(FORMATS)) {
          for (const formats of Object.values(platforms)) {
            for (const spec of Object.values(formats)) {
              for (const path of spec.listing) {
                if (!paths.has(path)) missing.push(path);
              }
            }
          }
        }

        ctx.expect(missing).toEqual([]);
        ctx.expect(FORMATS.extension.chrome.store.listing).toEqual(['listings.chrome.id']);
        ctx.expect(FORMATS.extension.edge.store.listing).toEqual(['listings.edge.id']);
        ctx.expect(FORMATS.desktop.mac.dmg.listing).toEqual([]);

        // `listing` is what a store needs BEFORE it can accept an upload, so firefox
        // declares none: AMO takes the manifest's gecko id and the first publish
        // writes the id back (#893). An empty list is what keeps the walk from ever
        // asking a human for a value nothing but a publish can produce.
        ctx.expect(FORMATS.extension.firefox.store.listing).toEqual([]);
      },
    },

    {
      name: 'every store says what it is called and where its listing is created (#867)',
      run: (ctx) => {
        // The walk opens that page Enter-gated and the publish prints it in the
        // manual step it leaves behind, so both read ONE home.
        for (const [target, platforms] of Object.entries(FORMATS)) {
          for (const [platform, formats] of Object.entries(platforms)) {
            for (const [format, spec] of Object.entries(formats)) {
              if (spec.kind !== 'store') continue;

              ctx.expect(spec.label, `${target}.${platform}.${format} needs a label`).toBeTruthy();
              ctx.expect(spec.console, `${target}.${platform}.${format} needs the page that creates the listing`).toMatch(/^https:\/\//);
            }
          }
        }
      },
    },

    {
      name: 'every platform and format in the table is DECLARED in the config schema',
      run: (ctx) => {
        // The table and the schema are two files, so a format added to one and not
        // the other is a config key that validates as undeclared or a declaration
        // nothing ships.
        const paths = new Set([...SHARED_SCHEMA, ...Object.values(TARGET_SCHEMAS).flat()].map((rule) => rule.path));
        const missing = [];

        for (const [target, platforms] of Object.entries(FORMATS)) {
          for (const [platform, formats] of Object.entries(platforms)) {
            if (!paths.has(`platforms.${platform}`)) missing.push(`${target}: platforms.${platform}`);
            for (const format of Object.keys(formats)) {
              if (!paths.has(`platforms.${platform}.formats.${format}`)) missing.push(`${target}: platforms.${platform}.formats.${format}`);
            }
          }
        }

        ctx.expect(missing).toEqual([]);
      },
    },

    {
      name: 'each store names its own developer keys, and snap names its login',
      run: (ctx) => {
        ctx.expect(FORMATS.extension.chrome.store.requires).toEqual(['CHROME_CLIENT_ID', 'CHROME_CLIENT_SECRET', 'CHROME_REFRESH_TOKEN']);
        ctx.expect(FORMATS.extension.firefox.store.requires).toEqual(['FIREFOX_API_KEY', 'FIREFOX_API_SECRET']);
        ctx.expect(FORMATS.extension.edge.store.requires).toEqual(['EDGE_CLIENT_ID', 'EDGE_API_KEY']);
        ctx.expect(FORMATS.desktop.linux.snap.requires).toEqual(['SNAPCRAFT_STORE_CREDENTIALS']);
        // A zip needs nothing: it is built and attached, never authenticated
        ctx.expect(FORMATS.extension.chrome.zip.requires).toEqual([]);
      },
    },

    {
      name: 'the Windows signing keys come FROM the schema\'s own gates, never a second list',
      run: (ctx) => {
        const nsis = FORMATS.desktop.windows.nsis.requires;
        ctx.expect(nsis.includes('WIN_EV_TOKEN_PATH')).toBeTruthy();
        ctx.expect(nsis.includes('AZURE_TENANT_ID')).toBeTruthy();
        // Every one of them is a key the schema gates on exactly one Windows signing choice
        for (const key of nsis) {
          const entry = ENV_SCHEMA.find((candidate) => candidate.name === key);
          ctx.expect(gatedOn(entry).length, key).toBe(1);
          ctx.expect(entry.requiredWhen({}), `${key}: a brand with no desktop target owes nothing`).toBe(false);
        }
        // Self-hosted is the default strategy, so its pair is owed by a desktop target that writes none
        for (const key of ['WIN_EV_TOKEN_PATH', 'WIN_CSC_KEY_PASSWORD']) {
          ctx.expect(ENV_SCHEMA.find((candidate) => candidate.name === key).requiredWhen(DESKTOP), key).toBe(true);
        }
        // SIGNTOOL_PATH is the runner's own path, gated by nothing, so it is never a ship key
        ctx.expect(!nsis.includes('SIGNTOOL_PATH')).toBeTruthy();
      },
    },

    {
      name: 'formatKeys with a config keeps only the keys that config actually owes',
      run: (ctx) => {
        const selfHosted = signing({ strategy: 'self-hosted' });
        const cloud = signing({ strategy: 'cloud', cloud: { provider: 'azure' } });

        ctx.expect(formatKeys('desktop', 'windows', 'nsis', selfHosted).requires).toEqual(['WIN_EV_TOKEN_PATH', 'WIN_CSC_KEY_PASSWORD']);
        ctx.expect(formatKeys('desktop', 'windows', 'nsis', cloud).requires).toEqual(['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TRUSTED_SIGNING_ENDPOINT']);
        // The default strategy owes the same pair as the written one
        ctx.expect(formatKeys('desktop', 'windows', 'nsis', DESKTOP).requires).toEqual(['WIN_EV_TOKEN_PATH', 'WIN_CSC_KEY_PASSWORD']);
        // No config = the whole declared set, and the listing paths ride along
        ctx.expect(formatKeys('desktop', 'windows', 'nsis').requires.length).toBe(FORMATS.desktop.windows.nsis.requires.length);
        ctx.expect(formatKeys('extension', 'edge', 'store').listing).toEqual(['listings.edge.id']);
        // An unconditional key is never filtered away: the store keys carry no gate
        ctx.expect(formatKeys('extension', 'firefox', 'store', {}).requires).toEqual(['FIREFOX_API_KEY', 'FIREFOX_API_SECRET']);
        ctx.expect(formatKeys('desktop', 'linux', 'nope')).toEqual({ requires: [], listing: [] });
      },
    },

    {
      name: 'formatKeys: a desktop target owes the snap login for the default snap, until the snap or linux is turned off',
      run: (ctx) => {
        ctx.expect(formatKeys('desktop', 'linux', 'snap', DESKTOP).requires).toEqual(['SNAPCRAFT_STORE_CREDENTIALS']);
        ctx.expect(formatKeys('desktop', 'linux', 'snap', { ...DESKTOP, platforms: { linux: { formats: { snap: false } } } }).requires).toEqual([]);
        ctx.expect(formatKeys('desktop', 'linux', 'snap', { ...DESKTOP, platforms: { linux: false } }).requires).toEqual([]);
        ctx.expect(formatKeys('desktop', 'windows', 'nsis', { ...DESKTOP, platforms: { windows: false } }).requires).toEqual([]);
        // A brand with no desktop target owes none of it
        ctx.expect(formatKeys('desktop', 'linux', 'snap', {}).requires).toEqual([]);
        ctx.expect(formatKeys('desktop', 'windows', 'nsis', {}).requires).toEqual([]);
      },
    },

    {
      name: 'the Windows signing strategies and cloud providers are the ones the env schema gates on',
      run: (ctx) => {
        // Every declared choice owes credentials, and every signing key hangs off a declared choice
        const gated = new Set(ENV_SCHEMA.flatMap(gatedOn));
        ctx.expect([...gated].sort()).toEqual(Object.keys(SIGNING_CONFIGS).sort());
        ctx.expect(WINDOWS_SIGNING_STRATEGIES.includes('self-hosted')).toBeTruthy();
        ctx.expect(WINDOWS_SIGNING_STRATEGIES.includes('cloud')).toBeTruthy();
      },
    },

    {
      name: 'a cloud provider\'s keys are exactly the env schema entries gated on it',
      run: (ctx) => {
        for (const provider of WINDOWS_CLOUD_PROVIDERS) {
          const expected = ENV_SCHEMA
            .filter((entry) => gatedOn(entry).includes(provider))
            .map((entry) => entry.name);
          ctx.expect(expected.length > 0, provider).toBeTruthy();
          ctx.expect(windowsCloudProviderKeys(provider), provider).toEqual(expected);
        }
        ctx.expect(windowsCloudProviderKeys('imaginary')).toEqual([]);
      },
    },

    {
      name: 'windowsCloudProviderKeys still names DigiCert\'s two keys once the cloud keys ride signsWith',
      run: (ctx) => {
        ctx.expect(windowsCloudProviderKeys('digicert')).toEqual(['DIGICERT_API_KEY', 'DIGICERT_KEYPAIR_ALIAS']);
      },
    },

    {
      name: 'the Windows signing strategy defaults to self-hosted, and a configured one wins',
      run: (ctx) => {
        ctx.expect(DEFAULT_WINDOWS_SIGNING_STRATEGY).toBe('self-hosted');
        ctx.expect(WINDOWS_SIGNING_STRATEGIES.includes(DEFAULT_WINDOWS_SIGNING_STRATEGY)).toBeTruthy();
        ctx.expect(windowsSigningStrategy({})).toBe('self-hosted');
        ctx.expect(windowsSigningStrategy(undefined)).toBe('self-hosted');
        ctx.expect(windowsSigningStrategy({ platforms: { windows: { signing: { strategy: 'cloud' } } } })).toBe('cloud');
      },
    },

    {
      name: 'the config schema accepts the declared strategy and cloud provider sets, and refuses anything else',
      run: (ctx) => {
        const brand = { brand: { id: 'acme', name: 'Acme' } };
        const signing = (value) => ({ ...brand, platforms: { windows: { signing: value } } });
        const errors = (value) => validateConfig(signing(value), { target: 'desktop' }).errors;

        for (const strategy of WINDOWS_SIGNING_STRATEGIES) ctx.expect(errors({ strategy }), strategy).toEqual([]);
        for (const provider of WINDOWS_CLOUD_PROVIDERS) ctx.expect(errors({ strategy: 'cloud', cloud: { provider } }), provider).toEqual([]);

        const unknownStrategy = errors({ strategy: 'banana' });
        ctx.expect(unknownStrategy.length).toBe(1);
        ctx.expect(unknownStrategy[0]).toMatch(/platforms\.windows\.signing\.strategy "banana"/);
        const unknownProvider = errors({ strategy: 'cloud', cloud: { provider: 'imaginary' } });
        ctx.expect(unknownProvider.length).toBe(1);
        ctx.expect(unknownProvider[0]).toMatch(/platforms\.windows\.signing\.cloud\.provider "imaginary"/);
        ctx.expect(unknownProvider[0].includes(WINDOWS_CLOUD_PROVIDERS.join(', '))).toBeTruthy();
      },
    },

    // ─── the snap ────────────────────────────────────────────────────────────────

    {
      name: 'the snap is named brand.id, whatever the product is called',
      run: (ctx) => {
        ctx.expect(snapName({ brand: { id: 'acme-app', name: 'Acme Studio' }, app: { productName: 'Acme Studio Pro' } })).toBe('acme-app');
      },
    },

    {
      name: 'a brand.id holding `.` or `+` fails validation while the snap ships, naming both, and passes with the snap off',
      run: (ctx) => {
        // The brand's omega.json5: a desktop target, which ships the snap by default
        const brandConfig = (id, desktop = {}) => ({ brand: { id, name: 'Acme' }, targets: { desktop: { type: 'desktop', ...desktop } } });

        for (const id of ['acme.app', 'acme+app']) {
          const shipping = validateConfig(brandConfig(id)).errors;
          ctx.expect(shipping.length, id).toBe(1);
          ctx.expect(shipping[0], id).toContain('brand.id');
          ctx.expect(shipping[0], id).toContain('platforms.linux.formats.snap');

          const off = brandConfig(id, { platforms: { linux: { formats: { snap: false } } } });
          ctx.expect(validateConfig(off).errors, `${id} with the snap off`).toEqual([]);
        }
      },
    },

    {
      name: 'a store other than the snap is checked against its own keys, never the snap login',
      run: (ctx) => {
        const snapLogin = { SNAPCRAFT_STORE_CREDENTIALS: 'snap-blob' };
        const edgeKeys = { EDGE_CLIENT_ID: 'edge-client', EDGE_API_KEY: 'edge-key' };

        ctx.expect(formatKeysSet('extension', 'edge', 'store', snapLogin), 'the snap login sets no other store').toBe(false);
        ctx.expect(formatKeysSet('extension', 'edge', 'store', edgeKeys), 'its own keys set it, with no snap login').toBe(true);
        ctx.expect(formatKeysSet('desktop', 'linux', 'snap', edgeKeys), 'another store\'s keys never set the snap').toBe(false);
      },
    },

    {
      name: 'the snap login is set only by a non-empty SNAPCRAFT_STORE_CREDENTIALS',
      run: (ctx) => {
        const loggedIn = (env) => formatKeysSet('desktop', 'linux', 'snap', env);

        ctx.expect(loggedIn({})).toBe(false);
        ctx.expect(loggedIn({ SNAPCRAFT_STORE_CREDENTIALS: '' })).toBe(false);
        ctx.expect(loggedIn({ SNAPCRAFT_STORE_CREDENTIALS: 'snap-blob' })).toBe(true);
      },
    },

    // ─── the declaration ─────────────────────────────────────────────────────────

    {
      name: 'no declaration at all ships everything: every platform, every format',
      run: (ctx) => {
        ctx.expect(enabledFormats({}, 'desktop')).toEqual([
          { platform: 'mac', format: 'dmg', options: {} },
          { platform: 'windows', format: 'nsis', options: {} },
          { platform: 'linux', format: 'deb', options: {} },
          { platform: 'linux', format: 'appimage', options: {} },
          { platform: 'linux', format: 'snap', options: {} },
        ]);
        ctx.expect(enabledFormats({}, 'extension').length).toBe(6);
      },
    },

    {
      name: 'presence is the switch: `false` drops a platform or a format, nothing else does',
      run: (ctx) => {
        const config = {
          platforms: {
            mac: false,
            windows: {},
            linux: { formats: { snap: false } },
          },
        };

        ctx.expect(enabledFormats(config, 'desktop')).toEqual([
          { platform: 'windows', format: 'nsis', options: {} },
          { platform: 'linux', format: 'deb', options: {} },
          { platform: 'linux', format: 'appimage', options: {} },
        ]);
      },
    },

    {
      name: 'a format\'s own settings ride inside it, and declaring one drops nothing',
      run: (ctx) => {
        const config = { platforms: { mac: false, windows: false, linux: { formats: { snap: { channels: ['beta'] } } } } };

        ctx.expect(enabledFormats(config, 'desktop')).toEqual([
          { platform: 'linux', format: 'deb', options: {} },
          { platform: 'linux', format: 'appimage', options: {} },
          { platform: 'linux', format: 'snap', options: { channels: ['beta'] } },
        ]);
        ctx.expect(enabledFormats({ platforms: { chrome: { formats: { store: { channel: 'unlisted' } } }, firefox: false, edge: false } }, 'extension')).toEqual([
            { platform: 'chrome', format: 'zip', options: {} },
            { platform: 'chrome', format: 'store', options: { channel: 'unlisted' } },
          ]);
      },
    },

    {
      name: 'a platform or format nobody declared is not invented, and an unknown target ships nothing',
      run: (ctx) => {
        ctx.expect(enabledFormats({ platforms: { ios: {} } }, 'desktop').map((entry) => entry.platform)).toEqual(['mac', 'windows', 'linux', 'linux', 'linux']);
        ctx.expect(enabledFormats({ platforms: { linux: { formats: { msi: {} } } } }, 'desktop')
          .filter((entry) => entry.platform === 'linux').map((entry) => entry.format)).toEqual(['deb', 'appimage', 'snap']);
        ctx.expect(enabledFormats({}, 'web')).toEqual([]);
      },
    },

    // ─── the artifact names (#620, inherited) ────────────────────────────────────

    {
      name: 'an artifact name carries the platform, the FORMAT and no version',
      run: (ctx) => {
        ctx.expect(desktopArtifactName('Acme App', 'mac', 'dmg')).toBe('Acme-App-mac-dmg.dmg');
        ctx.expect(desktopArtifactName('Acme App', 'windows', 'nsis')).toBe('Acme-App-windows-nsis.exe');
        ctx.expect(desktopArtifactName('Acme App', 'linux', 'deb')).toBe('Acme-App-linux-deb.deb');
        ctx.expect(desktopArtifactName('Acme App', 'linux', 'appimage')).toBe('Acme-App-linux-appimage.AppImage');
        // A store format is never a file, so it has no name to spell
        ctx.expect(desktopArtifactName('Acme App', 'linux', 'snap')).toBe('');
      },
    },

    {
      name: 'an explicit ext builds an electron-builder TEMPLATE',
      run: (ctx) => {
        ctx.expect(desktopArtifactName('Acme App', 'mac', 'dmg', '${ext}')).toBe('Acme-App-mac-dmg.${ext}');
      },
    },

    {
      name: 'the product name is sanitized for a filename, never blank-guessed',
      run: (ctx) => {
        ctx.expect(sanitizeProductName('Deployment Playground')).toBe('Deployment-Playground');
        ctx.expect(sanitizeProductName('  Acme  //  App ')).toBe('Acme-App');
        ctx.expect(sanitizeProductName('')).toBe('');
        ctx.expect(desktopArtifactName('', 'mac', 'dmg'), 'nothing to name it after, no name').toBe('');
        ctx.expect(desktopArtifactName('Acme App', 'mac', 'nope'), 'a format nobody publishes has no name').toBe('');
        ctx.expect(desktopArtifactNames('')).toEqual({});
      },
    },

    {
      name: 'the product name is the packager\'s: app.productName, else brand.name',
      run: (ctx) => {
        ctx.expect(desktopProductName({ app: { productName: 'Acme Studio' }, brand: { name: 'Acme' } })).toBe('Acme Studio');
        ctx.expect(desktopProductName({ brand: { name: 'Acme' } })).toBe('Acme');
        ctx.expect(desktopProductName({})).toBe('');
        ctx.expect(desktopProductName(undefined)).toBe('');
      },
    },

    {
      name: 'the named artifacts are the ASSET formats only, because the site links files',
      run: (ctx) => {
        const names = desktopArtifactNames('Acme');
        ctx.expect(Object.keys(names)).toEqual(['mac', 'windows', 'linux']);
        ctx.expect(Object.keys(names.linux), 'the snap is the Snap Store\'s, never a release asset').toEqual(['deb', 'appimage']);
        ctx.expect(Object.keys(names.mac)).toEqual(['dmg']);
      },
    },
  ],
});
