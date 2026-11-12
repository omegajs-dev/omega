/**
 * The VISIBLE logo prefers the shipped svg. `brand.images.brandmark` stays a
 * RASTER (payment providers and OG cards read it); every template rendering
 * the visible lockup (nav, footer, sidebar, auth cards, launch mark, checkout
 * head, email-preferences portal, extension installed page, download cards)
 * takes `assets/images/brand/brandmark.svg` when the build ships one, else the
 * configured raster. "When the build ships one" is a BUILD-TIME fact, resolved the way the
 * favicon links resolve theirs: the static lane reports what it is about to
 * ship, the build records it on the asset manifest, and the template reads
 * `assetManifest.brandmarkSvg`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const defineCases = require('@omega.js/devkit/test/define-cases');
const expect = require('@omega.js/devkit/test/expect');
const jetpack = require('fs-jetpack');

const { resolveStaticDirs, brandmarkSvgUrl } = require('../src/static-assets.js');
const { buildSite, buildWith, miniData, MINI, PKG } = require('./lib/build.js');

const SVG_URL = '/assets/images/brand/brandmark.svg';
const PNG_URL = '/assets/images/brand/brandmark.png';

// The mini fixture with a configured RASTER brandmark — the shape every
// in-repo brand config ships.
const rasterData = { ...miniData, brand: { ...miniData.brand, images: { brandmark: PNG_URL } } };

/**
 * The fixture asset manifest, optionally carrying the shipped svg url
 * (critical-css.test.js's manifestWith, same reason: the head's own links
 * ride along so nothing else in the page changes between cases).
 * @param {string|null} [brandmarkSvg]
 * @returns {object}
 */
function manifestWith(brandmarkSvg) {
  return {
    js: {
      main: '/assets/js/main-TEST.js',
      firstPaint: '/assets/js/first-paint-TEST.js',
      pages: {},
      layouts: { 'modules/utilities/redirect': ['/assets/js/layouts/modules/utilities/redirect-TEST.js'] },
    },
    css: { main: '/assets/css/main-TEST.css', pages: {}, layouts: {} },
    brandmarkSvg: brandmarkSvg || null,
  };
}

/** The nav's brand `<img src>` (cachebreak query stripped). */
function navLogo(html) {
  const match = html.match(/<a class="navbar-brand omega-nav__brand[^"]*"[^>]*>\s*<img src="([^"?]+)/);
  expect(match, 'the nav renders a brand image').toBeTruthy();
  return match[1];
}

/** The footer's brand image url — lazy-mounted, so it rides `data-lazy`. */
function footerLogo(html) {
  const match = html.match(/<footer class="omega-footer[\s\S]*?data-lazy="@src ([^"]+)"/);
  expect(match, 'the footer renders a brand image').toBeTruthy();
  return match[1];
}

/** The auth card's brand `<img src>` — signin/signup/reset/token and the connections callback share it. */
function authLogo(html) {
  const match = html.match(/omega-auth__brand">\s*<img src="([^"?]+)/);
  expect(match, 'the auth card renders a brand image').toBeTruthy();
  return match[1];
}

/** The checkout head's brand `<img src>` (our own page chrome, not the provider's product image). */
function checkoutLogo(html) {
  const match = html.match(/omega-checkout__brand"[\s\S]*?<img src="([^"?]+)/);
  expect(match, 'the checkout head renders a brand image').toBeTruthy();
  return match[1];
}

/** A download-page brandmark url — lazy-mounted like the footer's, so it rides `data-lazy`. */
function downloadLogo(html) {
  const match = html.match(/data-lazy="@src ([^"]+)" class="brandmark"/);
  expect(match, 'the download page renders a brand image').toBeTruthy();
  return match[1];
}

/** The redirect chrome's brand mark (core/_layouts/modules/utilities/redirect.html). */
function redirectLogo(html) {
  const match = html.match(/class="omega-redirect__mark"[^>]*>\s*<img src="([^"?]+)/);
  expect(match, 'the redirect page renders its brand mark').toBeTruthy();
  return match[1];
}

/** Every mini page for a given manifest brandmark value. */
function sitePages(brandmarkSvg, name, siteData = rasterData) {
  return buildWith(siteData, { assetManifest: manifestWith(brandmarkSvg) }, name);
}

/** The mini fixture's home page for a given manifest brandmark value. */
async function home(brandmarkSvg, name, siteData = rasterData) {
  const pages = await sitePages(brandmarkSvg, name, siteData);

  return pages.get('/');
}

// ─── The build-time fact ─────────────────────────────────────────────────────

/** A scratch root seeded by `files` (path → contents). */
function scratchRoot(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-web-brandmark-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const [relative, contents] of Object.entries(files)) jetpack.write(path.join(root, relative), contents);

  return root;
}

module.exports = defineCases({
  type: 'group',
  description: 'brandmark-svg',
  tests: [
    {
      name: "#467: a consumer's own src/assets svg counts — it wins the same collision",
      run: async (ctx) => {
        const root = scratchRoot(ctx, { 'src/assets/images/brand/brandmark.svg': '<svg/>' });

        const dirs = await resolveStaticDirs({ brandRoot: null, assetsDir: path.join(root, 'src', 'assets') });

        ctx.expect(brandmarkSvgUrl(dirs)).toBe(SVG_URL);
      },
    },

    // ─── The read ────────────────────────────────────────────────────────────────

    {
      name: '#467: nav and footer take the shipped svg when the build ships one',
      run: async (ctx) => {
        const html = await home(SVG_URL, 'brandmark-svg-present');

        ctx.expect(navLogo(html), 'nav logo is the vector').toBe(SVG_URL);
        ctx.expect(footerLogo(html), 'footer logo is the vector').toBe(SVG_URL);
      },
    },

    {
      name: '#467: no shipped svg → both fall back to the configured raster',
      run: async (ctx) => {
        const html = await home(null, 'brandmark-svg-absent');

        ctx.expect(navLogo(html), 'nav logo is the configured raster').toBe(PNG_URL);
        ctx.expect(footerLogo(html), 'footer logo is the configured raster').toBe(PNG_URL);
      },
    },

    {
      name: '#467: the config value stays the raster — OG and payment still read it',
      run: async (ctx) => {
        const html = await home(SVG_URL, 'brandmark-svg-og');

        const og = html.match(/<meta property="og:image" content="([^"?]+)/);
        ctx.expect(og, 'the page carries an og:image').toBeTruthy();
        ctx.expect(og[1], 'social cards keep the raster').toBe(`${miniData.url}${PNG_URL}`);
      },
    },

    {
      name: '#467: a section-data logo.src still outranks both',
      run: async (ctx) => {
        // The fixture copy lives UNDER cwd: Eleventy matches its `**/_layouts/**`
        // ignores against cwd-relative paths, and a `../../`-relative input dir
        // slips past them (the farm gotcha engine.js documents).
        const root = path.join(PKG, '.omega', `brandmark-override-site-${process.pid}`);
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        jetpack.copy(MINI, root, { overwrite: true });
        for (const section of ['nav', 'footer']) {
          jetpack.write(
            path.join(root, '_includes', 'frontend', 'sections', `${section}.json`),
            JSON.stringify({ logo: { src: '/custom/mark.svg', href: '/', text: 'MiniCo' } }),
          );
        }

        const pages = await buildSite(root, rasterData, { assetManifest: manifestWith(SVG_URL) }, 'brandmark-svg-override');
        const html = pages.get('/');

        ctx.expect(navLogo(html), 'the authored nav logo wins').toBe('/custom/mark.svg');
        ctx.expect(footerLogo(html), 'the authored footer logo wins').toBe('/custom/mark.svg');
      },
    },

    // ─── The one home of the rule ───────────────────────────────────────────────

    {
      name: 'the brandmark-src include answers the manifest svg when the build ships one, else the config brandmark',
      run: async (ctx) => {
        // A consumer page standing in for any template that reads the rule. The
        // include either assigns `brandmark_src` or renders the url, so the
        // probe reads whichever it did.
        const root = path.join(PKG, '.omega', `brandmark-src-site-${process.pid}`);
        ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));

        jetpack.copy(MINI, root, { overwrite: true });
        jetpack.write(path.join(root, 'pages', 'brandmark-probe.html'), [
          '---',
          'layout: frontend/core/minimal',
          'permalink: /brandmark-probe',
          'meta:',
          '  title: "Brandmark probe"',
          '  index: false',
          '---',
          '{% capture brandmark_rendered %}{% include core/brandmark-src.html %}{% endcapture %}',
          '<div id="brandmark-probe">{{ brandmark_src | default: brandmark_rendered | strip }}</div>',
          '',
        ].join('\n'));

        const probe = async (brandmarkSvg, name) => {
          const pages = await buildSite(root, rasterData, { assetManifest: manifestWith(brandmarkSvg) }, name);
          const match = pages.get('/brandmark-probe').match(/<div id="brandmark-probe">([^<]*)<\/div>/);
          ctx.expect(match, 'the probe page renders its brandmark').toBeTruthy();
          return match[1];
        };

        ctx.expect(await probe(SVG_URL, 'brandmark-src-svg'), 'the shipped svg wins').toBe(SVG_URL);
        ctx.expect(await probe(null, 'brandmark-src-raster'), 'no svg on disk, the configured raster answers').toBe(PNG_URL);
      },
    },

    // ─── The rest of the visible lockups ─────────────────────────────────────────

    {
      name: '#467: the other visible lockups take the shipped svg too',
      run: async (ctx) => {
        const pages = await sitePages(SVG_URL, 'brandmark-svg-lockups');

        ctx.expect(authLogo(pages.get('/signin')), 'the auth card is the vector').toBe(SVG_URL);
        ctx.expect(checkoutLogo(pages.get('/payment/checkout')), 'the checkout head is the vector').toBe(SVG_URL);
        ctx.expect(downloadLogo(pages.get('/download')), 'the download cards are the vector').toBe(SVG_URL);
        ctx.expect(redirectLogo(pages.get('/careers')), 'the redirect chrome mark is the vector').toBe(SVG_URL);
      },
    },

    {
      name: '#467: and every one of them falls back to the configured raster',
      run: async (ctx) => {
        const pages = await sitePages(null, 'brandmark-svg-lockups-absent');

        ctx.expect(authLogo(pages.get('/signin')), 'the auth card is the configured raster').toBe(PNG_URL);
        ctx.expect(checkoutLogo(pages.get('/payment/checkout')), 'the checkout head is the configured raster').toBe(PNG_URL);
        ctx.expect(downloadLogo(pages.get('/download')), 'the download cards are the configured raster').toBe(PNG_URL);
        ctx.expect(redirectLogo(pages.get('/careers')), 'the redirect chrome mark is the configured raster').toBe(PNG_URL);
      },
    },
  ],
});
