/**
 * site-global.test.js — toSiteGlobal() shaping of resolved configs.
 */

const defineCases = require('@omega.js/devkit/test/define-cases');
const { toSiteGlobal } = require('../src/site-global.js');

module.exports = defineCases({
  type: 'group',
  description: 'site-global',
  tests: [
    {
      name: 'identity-maps content keys and strips machinery',
      run: (ctx) => {
        const resolved = {
          brand: { id: 'somiibo', name: 'Somiibo', url: 'https://somiibo.com' },
          theme: { id: 'classy', appearance: 'dark' },
          meta: { title: 'T', description: 'D' },
          analytics: { providers: { google: { id: 'G-1' } } },
          socials: { twitter: 'somiibo' },
          translation: { default: 'en', languages: ['en', 'es'] },
          customKey: { anything: true },
          targets: { web: { type: 'web' }, backend: { type: 'backend' } },
          enabled: true,
        };

        const site = toSiteGlobal(resolved);

        ctx.expect(site.brand.name).toBe('Somiibo');
        ctx.expect(site.theme.id).toBe('classy');
        ctx.expect(site.socials.twitter).toBe('somiibo');
        ctx.expect(site.customKey.anything).toBe(true); // any-key passthrough
        // Raw machinery never passes through — site.targets is the CURATED view (#85)
        ctx.expect(site.targets).not.toBe(resolved.targets);
        ctx.expect(site.targets).toEqual({ web: { enabled: true }, backend: { enabled: true } });
        ctx.expect(site.enabled).toBe(undefined);
      },
    },

    {
      name: 'derives url from brand.url with explicit url winning',
      run: (ctx) => {
        ctx.expect(toSiteGlobal({ brand: { url: 'https://a.com' } }).url).toBe('https://a.com');
        ctx.expect(toSiteGlobal({ url: 'https://explicit.com', brand: { url: 'https://a.com' } }).url).toBe('https://explicit.com');
        ctx.expect(toSiteGlobal({}).url).toBe('');
        ctx.expect(toSiteGlobal({}).baseurl).toBe('');
        ctx.expect(toSiteGlobal({ baseurl: '/sub' }).baseurl).toBe('/sub');
      },
    },

    {
      name: 'does not mutate the input config',
      run: (ctx) => {
        const resolved = { brand: { url: 'https://a.com' }, targets: { web: { type: 'web' } } };
        const before = JSON.stringify(resolved);
        toSiteGlobal(resolved);
        ctx.expect(JSON.stringify(resolved)).toBe(before);
      },
    },

    // ── curated site.targets (#85) ────────────────────────────────────────────

    {
      name: 'exposes curated site.targets: presence + enabled, machinery absent',
      run: (ctx) => {
        const site = toSiteGlobal({
          brand: { id: 'acme' },
          targets: {
            web: { type: 'web' },
            backend: { type: 'backend' },
            desktop: { type: 'desktop', platforms: { win: { signing: { strategy: 'local' } } }, app: { category: 'utilities' } },
          },
        });

        ctx.expect(Object.keys(site.targets).sort()).toEqual(['backend', 'desktop', 'web']);
        ctx.expect(site.targets.web.enabled).toBe(true);
        ctx.expect(site.targets.desktop.enabled).toBe(true);
        // Raw machinery never leaks through the curated view
        ctx.expect(site.targets.desktop.platforms).toBe(undefined);
        ctx.expect(site.targets.desktop.app).toBe(undefined);
      },
    },

    {
      name: 'derives the desktop releases URL: the brand\'s ONE releases repo (#799)',
      run: (ctx) => {
        const site = toSiteGlobal({
          brand: { id: 'omega-playground' },
          repo: { owner: 'Omega-JS-Stack' },
          targets: { desktop: { type: 'desktop', releases: {} } },
        });

        // `<brand.id>-releases`, the default @omega.js/config's releasesRepo owns: the
        // same address the desktop build bakes into app-update.yml.
        ctx.expect(site.targets.desktop.releasesUrl).toBe('https://github.com/Omega-JS-Stack/omega-playground-releases/releases/latest');
      },
    },

    {
      name: 'desktop releases URL: the address derives, with no override left to disagree with it (#883)',
      run: (ctx) => {
        const site = toSiteGlobal({
          brand: { id: 'acme', name: 'Acme App' },
          repo: { owner: 'Acme-Org' },
          // The retired owner/repo keys are inert: a config still carrying them (the
          // validator fails it) never moves the download surface.
          targets: { desktop: { type: 'desktop', releases: { owner: 'Acme-Binaries', repo: 'acme-bins' } } },
        });

        // The hub and every direct-download URL come from the same releasesRepo call
        // @omega.js/desktop bakes into the publish block, so they cannot disagree.
        ctx.expect(site.targets.desktop.releasesUrl).toBe('https://github.com/Acme-Org/acme-releases/releases/latest');
        ctx.expect(site.targets.desktop.downloads.mac.dmg).toBe('https://github.com/Acme-Org/acme-releases/releases/latest/download/Acme-App-mac-dmg.dmg');
      },
    },

    {
      name: 'desktop releases URL omitted without a repo owner',
      run: (ctx) => {
        const site = toSiteGlobal({ brand: { id: 'acme' }, targets: { desktop: { type: 'desktop', releases: {} } } });
        ctx.expect(site.targets.desktop.enabled).toBe(true);
        ctx.expect(site.targets.desktop.releasesUrl).toBe(undefined);
      },
    },

    // ── per-format direct downloads (#620, #867) ─────────────────────────────

    {
      name: 'derives a download URL per FORMAT, beside the releases hub',
      run: (ctx) => {
        const site = toSiteGlobal({
          brand: { id: 'acme', name: 'Acme App' },
          repo: { owner: 'Acme-Org' },
          targets: { desktop: { type: 'desktop', releases: {} } },
        });

        // /releases/latest/download/<asset> resolves only because the asset name
        // carries no version — the whole point of #620.
        ctx.expect(site.targets.desktop.downloads).toEqual({
          mac: { dmg: 'https://github.com/Acme-Org/acme-releases/releases/latest/download/Acme-App-mac-dmg.dmg' },
          windows: { nsis: 'https://github.com/Acme-Org/acme-releases/releases/latest/download/Acme-App-windows-nsis.exe' },
          linux: {
            deb: 'https://github.com/Acme-Org/acme-releases/releases/latest/download/Acme-App-linux-deb.deb',
            appimage: 'https://github.com/Acme-Org/acme-releases/releases/latest/download/Acme-App-linux-appimage.AppImage',
            // A store format links the store, because the store holds the file, under brand.id
            snap: 'https://snapcraft.io/acme',
          },
        });
        ctx.expect(site.targets.desktop.releasesUrl, 'the hub stays — the direct URLs sit BESIDE it').toBe('https://github.com/Acme-Org/acme-releases/releases/latest');
      },
    },

    {
      name: 'the artifact names are the packager\'s own — app.productName wins over brand.name',
      run: (ctx) => {
        const { desktopArtifactNames } = require('../src/platforms.js');
        const site = toSiteGlobal({
          brand: { id: 'acme', name: 'Acme App' },
          repo: { owner: 'Acme-Org' },
          targets: { desktop: { type: 'desktop', app: { productName: 'Acme Studio' }, releases: {} } },
        });

        // One rule, two readers: @omega.js/desktop's build-config writes THESE names
        // into electron-builder.yml.
        const names = desktopArtifactNames('Acme Studio');
        ctx.expect(site.targets.desktop.downloads.mac.dmg.endsWith(`/${names.mac.dmg}`)).toBeTruthy();
        ctx.expect(names.mac.dmg).toBe('Acme-Studio-mac-dmg.dmg');
      },
    },

    {
      name: 'no product name, no direct URLs — a guessed filename is a dead button',
      run: (ctx) => {
        const site = toSiteGlobal({
          brand: { id: 'acme' },
          repo: { owner: 'Acme-Org' },
          targets: { desktop: { type: 'desktop', releases: {} } },
        });

        ctx.expect(site.targets.desktop.downloads).toBe(undefined);
        ctx.expect(site.targets.desktop.releasesUrl, 'the hub still answers').toBeTruthy();
      },
    },

    {
      name: 'the direct URLs survive the second toSiteGlobal pass',
      run: (ctx) => {
        const once = toSiteGlobal({
          brand: { id: 'acme', name: 'Acme App' },
          repo: { owner: 'Acme-Org' },
          targets: { desktop: { type: 'desktop', releases: {} } },
        });
        const twice = toSiteGlobal(once);

        // Pass two sees the curated view: no app block, no brand-derived product
        // name to re-derive from. The curated URLs are the authority.
        ctx.expect(twice).toEqual(once);
      },
    },

    // ── the releases opt-in gate (#124) ───────────────────────────────────────

    {
      name: 'a bare desktop target derives nothing — no releases config, no links',
      run: (ctx) => {
        const site = toSiteGlobal({
          brand: { id: 'acme' },
          repo: { owner: 'Acme-Org' },
          targets: { desktop: { type: 'desktop', app: { category: 'utilities' } } },
        });

        ctx.expect(site.targets.desktop).toEqual({ enabled: true });
        ctx.expect(site.download).toBe(undefined);
      },
    },

    {
      name: 'a present releases block opts in (enabled defaults true)',
      run: (ctx) => {
        const url = 'https://github.com/Acme-Org/acme-releases/releases/latest';
        const base = { brand: { id: 'acme' }, repo: { owner: 'Acme-Org' } };

        for (const releases of [{}, { enabled: true }, { repo: 'acme-releases' }]) {
          const site = toSiteGlobal({ ...base, targets: { desktop: { type: 'desktop', releases } } });
          ctx.expect(site.targets.desktop.releasesUrl).toBe(url);
        }
      },
    },

    {
      name: 'releases.enabled false always suppresses the derivation',
      run: (ctx) => {
        const site = toSiteGlobal({
          brand: { id: 'acme' },
          repo: { owner: 'Acme-Org' },
          targets: { desktop: { type: 'desktop', releases: { enabled: false, repo: 'update-server' } } },
        });

        ctx.expect(site.targets.desktop, 'no releasesUrl — the download page has nothing to point at').toEqual({ enabled: true });
      },
    },

    {
      name: 'double application is idempotent for a bare and a suppressed desktop target',
      run: (ctx) => {
        for (const desktop of [{}, { releases: { enabled: false, repo: 'update-server' } }]) {
          const once = toSiteGlobal({
            brand: { id: 'acme' },
            repo: { owner: 'Acme-Org' },
            targets: { desktop },
          });
          const twice = toSiteGlobal(once);

          ctx.expect(once.targets.desktop.releasesUrl).toBe(undefined);
          ctx.expect(twice).toEqual(once);
        }
      },
    },

    {
      name: '#886: the curated facts key off the entry TYPE, not the name',
      run: (ctx) => {
        // A brand may name its desktop target anything; the type is what says which
        // facts it carries, so the renamed target still derives its downloads.
        const config = {
          brand: { id: 'acme', name: 'Acme' },
          repo: { owner: 'Acme-Org' },
          targets: {
            web: { type: 'web' },
            app: { type: 'desktop', releases: {} },
            addon: { type: 'extension', listings: { chrome: { url: 'https://store/x' } } },
          },
        };

        const site = toSiteGlobal(config);

        ctx.expect(site.targets.app.releasesUrl).toBe('https://github.com/Acme-Org/acme-releases/releases/latest');
        ctx.expect(site.targets.app.downloads.mac.dmg.endsWith('.dmg')).toBeTruthy();
        ctx.expect(site.targets.addon.listings).toEqual({ chrome: { url: 'https://store/x' } });
        ctx.expect(site.targets.web).toEqual({ enabled: true });
        ctx.expect(site.targets.desktop, 'nothing is keyed by the type word').toBe(undefined);

        // ...and the second pass over the curated view keeps them (idempotence)
        ctx.expect(toSiteGlobal(site)).toEqual(site);
      },
    },

    {
      name: 'exposes extension listings on site.targets.extension',
      run: (ctx) => {
        const site = toSiteGlobal({
          brand: { id: 'acme' },
          targets: {
            extension: { type: 'extension',
              listings: {
                chrome: { url: 'https://chromewebstore.google.com/detail/x', state: 'live' },
                firefox: { url: 'https://addons.mozilla.org/x' },
              },
            },
          },
        });

        ctx.expect(site.targets.extension.listings.chrome.url).toBe('https://chromewebstore.google.com/detail/x');
        ctx.expect(site.targets.extension.listings.chrome.state).toBe('live');
        ctx.expect(site.targets.extension.listings.firefox.url).toBe('https://addons.mozilla.org/x');
      },
    },

    // ── the curated view is the ONE home (#610): no derived page maps ──

    {
      name: '#610: the site data carries NO download or extension page map — site.targets is the only home',
      run: (ctx) => {
        const site = toSiteGlobal({
          brand: { id: 'omega-playground' },
          repo: { owner: 'Omega-JS-Stack' },
          targets: {
            desktop: { type: 'desktop', releases: {} },
            extension: { type: 'extension', listings: { chrome: { url: 'https://chromewebstore.google.com/detail/x', state: 'live' } } },
          },
        });

        // Two homes for one fact is what #610 closed: the /download page, the
        // /extension page and the shortlink generator all read site.targets now.
        ctx.expect(site.download, 'no derived download map').toBe(undefined);
        ctx.expect(site.extension, 'no derived extension map').toBe(undefined);
        ctx.expect(site.targets.desktop.releasesUrl, 'the desktop releases URL is the ONE download fact').toBe('https://github.com/Omega-JS-Stack/omega-playground-releases/releases/latest');
        ctx.expect(site.targets.extension.listings, 'the store listings are the ONE extension fact').toEqual({ chrome: { url: 'https://chromewebstore.google.com/detail/x', state: 'live' } });
      },
    },

    {
      name: '#610: a config still carrying the legacy keys keeps nothing — they are not site data',
      run: (ctx) => {
        const site = toSiteGlobal({
          brand: { id: 'acme' },
          download: { mac: { dmg: 'https://acme.com/dl/mac' } },
          extension: { chrome: 'https://acme.com/ext' },
          targets: { desktop: { type: 'desktop', releases: {} } },
        });

        // The identity map still copies whatever the config carries — the validator
        // is what refuses the keys; nothing DERIVES into them any more.
        ctx.expect(site.targets.desktop.enabled).toBe(true);
      },
    },

    {
      name: 'double application is idempotent — the build pipeline applies toSiteGlobal twice',
      run: (ctx) => {
        const resolved = {
          brand: { id: 'acme' },
          repo: { owner: 'Acme-Org' },
          targets: {
            desktop: { type: 'desktop', releases: {} },
            extension: { type: 'extension', listings: { chrome: { url: 'https://store/x', state: 'live' } } },
          },
        };

        const once = toSiteGlobal(resolved);
        const twice = toSiteGlobal(once);

        // The derived URL must survive the second pass: the raw releases block is
        // gone by then, so a re-derivation off the curated view would drop the links.
        ctx.expect(once.targets.desktop.releasesUrl).toBe('https://github.com/Acme-Org/acme-releases/releases/latest');
        ctx.expect(twice).toEqual(once);
      },
    },

    {
      name: 'array-form (multi-instance) targets derive nothing — presence only',
      run: (ctx) => {
        const site = toSiteGlobal({
          brand: { id: 'acme' },
          repo: { owner: 'Acme-Org' },
          targets: {
            desktop: [{ id: 'main', releases: { repo: 'update-server' } }],
            extension: [{ id: 'main', listings: { chrome: { url: 'https://store/x' } } }],
          },
        });

        // Which instance's facts belong on the site is ambiguous — never guess a URL.
        ctx.expect(site.targets.desktop).toEqual({ enabled: true });
        ctx.expect(site.targets.extension).toEqual({ enabled: true });
      },
    },

    {
      name: 'empty listing entries stay absent from the curated view',
      run: (ctx) => {
        const site = toSiteGlobal({
          targets: { extension: { type: 'extension', listings: { chrome: {}, firefox: { url: 'https://addons.mozilla.org/x' } } } },
        });

        ctx.expect(site.targets.extension.listings.chrome).toBe(undefined);
        ctx.expect(site.targets.extension.listings.firefox.url).toBe('https://addons.mozilla.org/x');
      },
    },

    {
      name: 'a listing with no url still rides the curated view — its state is the page\'s answer',
      run: (ctx) => {
        const site = toSiteGlobal({ targets: { extension: { type: 'extension', listings: { chrome: { state: 'pending' } } } } });

        ctx.expect(site.targets.extension.listings).toEqual({ chrome: { state: 'pending' } });
      },
    },
  ],
});
