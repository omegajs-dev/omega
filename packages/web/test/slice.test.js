/**
 * Engine invariants against the mini-site fixture, rendered through the REAL
 * packaged content (B2): layered layouts (virtual AND farm), the blueprint →
 * theme dispatch chain, default pages + consumer suppression, resolved
 * deep-merge (site seed + layout chain + page), frontmatter Liquid, Jekyll
 * conventions, blog + taxonomy generators, and template-kit tags inside
 * Eleventy.
 */
const fs = require('node:fs');
const path = require('node:path');
const defineCases = require('@omega.js/devkit/test/define-cases');
// The lane NAMES the environment
// ([#817](https://github.com/Omega-JS-Stack/omega/issues/817)): the engine reads
// that ONE input instead of a loose `options.environment`, and a fixture build
// with no verb above it is a development build, which is what it always was.
const { setEnvironment } = require('@omega.js/config/environment');
const { configureOmega } = require('../src/index.js');
const { readBuildJson } = require('./lib/build.js');

const PKG = path.resolve(__dirname, '..');
const MINI = path.join(__dirname, 'fixtures', 'mini-site');
const siteData = JSON.parse(fs.readFileSync(path.join(MINI, 'site-data.json'), 'utf8'));

/**
 * Run Eleventy programmatically over the mini site and index results by URL.
 * @param {object} [overrides] - configureOmega option overrides
 * @returns {Promise<Map<string, string>>} url → rendered content
 */
async function buildMini(overrides = {}) {
  setEnvironment('development');
  const Eleventy = require('@11ty/eleventy').default;
  const elev = new Eleventy(MINI, path.join(PKG, '.omega', 'test-out'), {
    quietMode: true,
    configPath: false,
    config: (eleventyConfig) => {
      // Multiple builds share one process here — Eleventy's module-level
      // layout cache is keyed by inputDir+layout and would leak the first
      // theme's compiled layouts into later builds
      eleventyConfig.setUseTemplateCache(false);
      return configureOmega(eleventyConfig, {
        consumerDir: MINI,
        siteData,
        farmDir: path.join(PKG, '.omega', 'layout-farm'),
        assetManifest: {
          js: {
            main: '/assets/js/main-TEST.js',
            // One key, every layer's bundle, in load order (#624)
            pages: {
              'signin/index': ['/assets/js/pages/signin/index-CORE.js', '/assets/js/pages/signin/index.classy-THEME.js', '/assets/js/pages/signin/index.site-TEST.js'],
              'blog/[slug]': ['/assets/js/pages/blog/[slug]-TEST.js'],
            },
            layouts: {},
          },
          css: {
            main: '/assets/css/main-TEST.css',
            pages: { 'signin/index': [{ href: '/assets/css/pages/signin/index-CORE.css' }, { href: '/assets/css/pages/signin/index.classy-THEME.css' }] },
            layouts: {},
          },
          favicons: true,
        },
        ...overrides,
      });
    },
  });

  const results = await elev.toJSON();
  const indexed = new Map(results.map((r) => [r.url, r.content]));

  // The build snapshot is a FILE the engine writes on the way into the run
  // (#743), served at `/build.js` like any other artifact.
  const buildJs = path.join(PKG, '.omega', 'test-out', 'build.js');
  if (fs.existsSync(buildJs)) indexed.set('/build.js', fs.readFileSync(buildJs, 'utf8'));

  return indexed;
}

let pages;

module.exports = defineCases({
  type: 'group',
  description: 'slice',
  setup: async () => {
    pages = await buildMini();
  },
  tests: [
    {
      name: 'plain layout name resolves through the real chain (root → classy base)',
      run: (ctx) => {
        const html = pages.get('/');
        ctx.expect(html.includes('data-theme-id="classy"'), 'core/root chrome present with active theme id').toBeTruthy();
        ctx.expect(html.includes('<nav class="navbar'), 'classy nav include rendered').toBeTruthy();
        ctx.expect(html.includes('Grow faster with MiniCo'), 'body Liquid rendered against site global').toBeTruthy();
        ctx.expect(html.includes('<title>MiniCo - Home of Mini</title>'), 'frontmatter {{ site.meta.title }} rendered').toBeTruthy();
      },
    },

    {
      name: 'a bracket layout value no longer resolves — the build fails loudly (#148)',
      run: async (ctx) => {
        // The alias table that accepted `themes/[ site.theme.id ]/…` spellings is
        // gone: plain layout names are the one form, and the migrate codemod
        // (`omega migrate`, bracket-layout rule) is the sanctioned converter.
        const os = require('node:os');
        const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bracket-site-'));
        try {
          fs.mkdirSync(path.join(legacy, 'pages'), { recursive: true });
          fs.writeFileSync(
            path.join(legacy, 'pages', 'index.html'),
            '---\nlayout: themes/[ site.theme.id ]/frontend/core/base\npermalink: /\n---\n<p>legacy</p>\n',
          );

          const Eleventy = require('@11ty/eleventy').default;
          const elev = new Eleventy(legacy, path.join(PKG, '.omega', 'test-out-bracket'), {
            quietMode: true,
            configPath: false,
            config: (eleventyConfig) => {
              eleventyConfig.setUseTemplateCache(false);
              return configureOmega(eleventyConfig, {
                consumerDir: legacy,
                siteData,
                farmDir: path.join(PKG, '.omega', 'layout-farm'),
                assetManifest: {
                  js: { main: '/assets/js/main-TEST.js', pages: {} },
                  css: { main: '/assets/css/main-TEST.css', pages: {}, layouts: {} },
                },
              });
            },
          });

          await ctx.expect((() => elev.toJSON())()).rejects.toThrow(/Problem creating an Eleventy Layout/);
        } finally {
          fs.rmSync(legacy, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'meta-only page: layout voice renders, meta consumed (no content lane)',
      run: (ctx) => {
        const html = pages.get('/about');
        // The 2026-07-19 rule: page frontmatter carries NO content — the layout's
        // own composition voice renders (same hero as '/', which shares the
        // blueprint), and meta.title is the surviving frontmatter lane. The page
        // writes no body, because a body REPLACES that composition and #607 deleted
        // the `append:` flag that used to keep both (the guard test owns the
        // rejection side; customize.test.js owns the replace lane).
        ctx.expect(html.includes('The platform for'), 'section-default hero.headline renders — no consumer override lane').toBeTruthy();
        ctx.expect(html.includes('Site-wide directory-data override'), 'directory data (the surviving site-wide lane) still feeds the band').toBeTruthy();
        ctx.expect(html.includes('<title>About - MiniCo</title>'), 'frontmatter Liquid in meta.title (the sanctioned lane)').toBeTruthy();
      },
    },

    {
      name: 'site-wide defaults layer: root directory data beats layout frontmatter, loses to page frontmatter',
      run: (ctx) => {
        // mini-site.11tydata.json — Eleventy's root directory data file is the
        // consumer's ONE-PLACE site-wide override for layout sample content: it sits
        // ABOVE layout frontmatter and BELOW each page's own frontmatter — the same
        // layer jekyll-uj-powertools 1.8.1 gave Jekyll sites via _config.yml
        // `defaults:` (the N4 parked verify this test closes).
        const html = pages.get('/about');
        ctx.expect(html.includes('Site-wide directory-data override'), 'directory data replaces layout hero.description site-wide').toBeTruthy();
        ctx.expect(!html.includes('AI automation for modern businesses'), 'layout sample content loses').toBeTruthy();
        ctx.expect(html.includes('<title>About - MiniCo</title>'), 'page frontmatter still beats directory data (meta.title)').toBeTruthy();
        ctx.expect(html.includes('success'), 'sibling layout keys survive the deep merge (hero.headline_accent)').toBeTruthy();
      },
    },

    {
      name: 'consumer about.md SUPPRESSES the framework default about page',
      run: (ctx) => {
        const html = pages.get('/about');
        // The default about page dispatches blueprint/about → classy about layout
        // (hero "About us"); the consumer page uses blueprint/index — if the
        // default leaked, both would target /about and the omega-about hero
        // would render.
        ctx.expect(!html.includes('headline_accent">us<'), 'default about must not leak').toBeTruthy();
      },
    },

    {
      name: 'default pages render when the consumer has no same-URL file',
      run: (ctx) => {
        const signin = pages.get('/signin');
        ctx.expect(signin.includes('id="auth-form"'), 'real classy signin form present').toBeTruthy();
        ctx.expect(signin.includes('/assets/js/pages/signin/index.site-TEST.js'), 'pageAssets script from the manifest').toBeTruthy();
        ctx.expect(pages.get('/signup').includes('id="auth-form"'), 'signup default').toBeTruthy();
        ctx.expect(pages.get('/404').includes('id="page-url"'), '404 default (flat url, 404.html file)').toBeTruthy();
      },
    },

    // #624 — the ONE rule reaches the markup: the page links every layer's asset
    // for its URL, in LOAD order, which for module scripts IS execution order and
    // for stylesheets IS the cascade.
    {
      name: '#624: every layer\'s page asset is emitted, in layer order',
      run: (ctx) => {
        const signin = pages.get('/signin');

        const at = (url) => {
          const index = signin.indexOf(url);
          ctx.expect(index, `${url} is on the page`).not.toBe(-1);
          return index;
        };

        const main = at('/assets/js/main-TEST.js');
        const core = at('/assets/js/pages/signin/index-CORE.js');
        const theme = at('/assets/js/pages/signin/index.classy-THEME.js');
        const consumer = at('/assets/js/pages/signin/index.site-TEST.js');
        ctx.expect(main < core && core < theme && theme < consumer, 'main, then core, then the theme, then the consumer').toBeTruthy();

        const mainCss = at('/assets/css/main-TEST.css');
        const coreCss = at('/assets/css/pages/signin/index-CORE.css');
        const themeCss = at('/assets/css/pages/signin/index.classy-THEME.css');
        ctx.expect(mainCss < coreCss && coreCss < themeCss, 'the sheets follow the same order — the theme wins the cascade by loading last').toBeTruthy();
      },
    },

    {
      name: 'wildcard page modules emit for every URL in the family (spec §7, asset_path is dead)',
      run: (ctx) => {
        // Every sample post URL rides the ONE blog/[slug] manifest entry — resolved
        // from the URL alone at render time, emitted verbatim (brackets included).
        // (`[^/.]+` keeps the blog's machine file, /blog/index.json, out of the family)
        const posts = [...pages.keys()].filter((url) => /^\/blog\/[^/.]+$/.test(url) && !url.includes('page'));
        ctx.expect(posts.length >= 3, `sample posts rendered (${posts.length})`).toBeTruthy();
        for (const url of posts) {
          ctx.expect(pages.get(url).includes('/assets/js/pages/blog/[slug]-TEST.js'), `${url} links the wildcard module`).toBeTruthy();
        }
        // …and the family boundary holds: the blog LIST page never matches [slug]
        ctx.expect(!pages.get('/blog').includes('[slug]-TEST.js'), 'the list page does not match the wildcard').toBeTruthy();
      },
    },

    {
      name: 'zero-page consumer still gets a homepage at / (cp194 wizard-rehearsal catch)',
      run: async (ctx) => {
        // A wizard-born brand has NO consumer pages at all — the first thing its
        // owner sees must be the branded default homepage, not a 404. (The mini
        // fixture owns /, so the suite's first test doubles as the suppression pin.)
        const os = require('node:os');
        const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-bare-site-'));
        try {
          const Eleventy = require('@11ty/eleventy').default;
          const elev = new Eleventy(bare, path.join(PKG, '.omega', 'test-out-bare'), {
            quietMode: true,
            configPath: false,
            config: (eleventyConfig) => {
              eleventyConfig.setUseTemplateCache(false);
              return configureOmega(eleventyConfig, {
                consumerDir: bare,
                siteData,
                farmDir: path.join(PKG, '.omega', 'layout-farm'),
                assetManifest: {
                  js: { main: '/assets/js/main-TEST.js', pages: {} },
                  css: { main: '/assets/css/main-TEST.css', pages: {}, layouts: {} },
                },
              });
            },
          });
          const results = await elev.toJSON();
          const home = results.find((r) => r.url === '/');
          ctx.expect(home, 'default homepage exists at /').toBeTruthy();
          ctx.expect(home.content.includes('MiniCo'), 'homepage branded from site config').toBeTruthy();
          ctx.expect(home.content.includes('data-theme-id="classy"'), 'rides the active theme').toBeTruthy();
          // No favicon set → the head renders zero dangling favicon links
          ctx.expect(!home.content.includes('site.webmanifest'), 'no manifest link without a favicon set').toBeTruthy();
          ctx.expect(!home.content.includes('favicon-32x32'), 'no icon links without a favicon set').toBeTruthy();
          // …while the mini build (favicons: true) carries the full set
          ctx.expect(pages.get('/').includes('site.webmanifest'), 'a shipped set renders the manifest link').toBeTruthy();
          ctx.expect(pages.get('/').includes('favicon-32x32'), 'a shipped set renders the icon links').toBeTruthy();
        } finally {
          fs.rmSync(bare, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'resolved site seed: site sections surface as resolved.* (the OMEGA_BUILD_JSON snapshot)',
      run: (ctx) => {
        const config = readBuildJson(pages).config;
        ctx.expect(config.brand.id, 'resolved.brand rides the snapshot from the site seed').toEqual('mini');
        ctx.expect(config.brand.name).toEqual('MiniCo');
        // An absent section is ABSENT (#894): the subset never invents an empty one
        ctx.expect(config.captcha, 'a section the brand never declared is not in the snapshot').toBe(undefined);
        ctx.expect(pages.get('/').includes('src="/assets/js/main-TEST.js"'), 'main bundle from the manifest').toBeTruthy();
      },
    },

    {
      name: 'pricing: template-default hero copy renders (layout frontmatter knobs are gone)',
      run: (ctx) => {
        const html = pages.get('/pricing');
        ctx.expect(html.includes('The right plans,'), 'classy pricing hero default').toBeTruthy();
        ctx.expect(html.includes('for the right price'), 'hero accent').toBeTruthy();
      },
    },

    {
      name: 'posts: Jekyll filename convention, readtime, taxonomy links',
      run: (ctx) => {
        const html = pages.get('/blog/first-post');
        ctx.expect(html, 'date stripped from URL (fileSlug)').toBeTruthy();
        ctx.expect(html.includes('First post'), 'post.title').toBeTruthy();
        ctx.expect(/[1-9]\d* min read/.test(html), 'omega_readtime').toBeTruthy();
        ctx.expect(html.includes('/blog/tags/growth-hacks'), 'tag link slugified (real /tags/ URLs)').toBeTruthy();
      },
    },

    {
      name: 'blog index: paginator compat over Eleventy pagination',
      run: (ctx) => {
        const html = pages.get('/blog');
        ctx.expect(html.includes('First post') && html.includes('Second post'), 'both posts listed via paginator.posts').toBeTruthy();
      },
    },

    {
      name: '#598: the blog hub featured card reads the post\'s REAL read time',
      run: (ctx) => {
        // The featured slot does not go through post-card.html, and the flattened
        // Jekyll doc it renders from carried no `content` — so the hub printed
        // "1 min read" for a long post while the post's own page printed the truth.
        const hub = pages.get('/blog');
        const start = hub.indexOf('<article class="omega-featured-post');
        ctx.expect(start > -1, 'page 1 leads with the featured card').toBeTruthy();
        const card = hub.slice(start, hub.indexOf('</article>', start));

        ctx.expect(card.includes('Second post'), 'the newest post is the feature').toBeTruthy();
        const onCard = (card.match(/(\d+) min read/) || [])[1];
        const onPost = (pages.get('/blog/second-post').match(/(\d+) min read/) || [])[1];

        ctx.expect(onPost, 'the fixture post is a 1,012-word read').toBe('4');
        ctx.expect(onCard, 'the hub card agrees with the post page').toBe(onPost);
      },
    },

    {
      name: 'taxonomy pages generated from post.categories / post.tags',
      run: (ctx) => {
        const growth = pages.get('/blog/categories/growth');
        ctx.expect(growth.includes('First post') && growth.includes('Second post'), 'category aggregates').toBeTruthy();
        const marketing = pages.get('/blog/categories/marketing');
        ctx.expect(marketing.includes('Second post') && !marketing.includes('First post'), 'category filters').toBeTruthy();
        ctx.expect(pages.get('/blog/tags/automation').includes('Second post'), 'tag page').toBeTruthy();
      },
    },

    {
      name: '#504: the root chrome stamps no attribute from a key the schema never had',
      run: (ctx) => {
        // `data-theme-target` interpolated `resolved.theme.target` — a legacy UJM
        // key the omega schema does not know, read by no CSS selector and no JS. A
        // brand that correctly drops it rendered the attribute empty.
        for (const url of ['/', '/pricing', '/blog/first-post']) {
          ctx.expect(!pages.get(url).includes('data-theme-target'), `${url}: the dead attribute is gone`).toBeTruthy();
        }
        ctx.expect(pages.get('/').includes('data-theme-id="classy"'), 'the LIVE theme stamps stay').toBeTruthy();
      },
    },

    {
      name: '#488: a term with `&` links the slug its own page is generated at',
      run: (ctx) => {
        // Two slugifiers used to answer this term: Eleventy's universal `slugify`
        // filter (`&` → "and") where posts and the tag cloud LINK it, template-kit's
        // where the taxonomy page is GENERATED. Every term containing `&` shipped a
        // guaranteed dead link, and `omega test`'s own link check failed the build on
        // framework output. ONE slugifier answers both sides now.
        const post = pages.get('/blog/first-post');
        const linked = [...post.matchAll(/href="(\/blog\/tags\/[^"]+)"/g)].map((m) => m[1]);

        ctx.expect(linked.includes('/blog/tags/a-r'), `the post links the term at ${linked.join(', ')}`).toBeTruthy();
        ctx.expect(!linked.includes('/blog/tags/a-and-r'), 'no "and" spelling survives on the link side').toBeTruthy();
        ctx.expect(pages.has('/blog/tags/a-r'), 'and that is the page the build wrote').toBeTruthy();
      },
    },

    {
      name: 'alternatives collection: permalink convention + comparison content',
      run: (ctx) => {
        const html = pages.get('/alternatives/acme-growth');
        ctx.expect(html.includes('MiniCo vs'), 'site brand in the layout-default hero headline').toBeTruthy();
        ctx.expect(html.includes('Acme Growth'), 'competitor name via resolved-templated layout defaults').toBeTruthy();
        ctx.expect(html.includes('Automation depth'), 'comparison rows').toBeTruthy();
        // resolved refs in layout FRONTMATTER VALUES are per-page: the hero accent
        // is `{{ resolved.alternative.competitor.name }}` in alternative.html's
        // frontmatter — it must render THIS page's competitor, not empty/cached.
        ctx.expect(html.includes('<em>Acme Growth</em>'), 'resolved-ref frontmatter value renders per page (hero accent)').toBeTruthy();
        ctx.expect(html.includes('Looking for a Acme Growth alternative'), 'resolved-ref inside a longer frontmatter value').toBeTruthy();
      },
    },

    {
      name: 'cover layout: page-level theme.main.align templates into main via resolved',
      run: (ctx) => {
        // checkout asks for top alignment (theme.main.align: start); the cover
        // layout's class template `align-items-{{ resolved.theme.main.align |
        // default: 'center' }}` must see the page's merged value…
        ctx.expect(/<main[^>]*align-items-start/.test(pages.get('/payment/checkout')), 'checkout main is top-aligned').toBeTruthy();
        // …while pages that set no align keep the cover default.
        ctx.expect(/<main[^>]*align-items-center/.test(pages.get('/signin')), 'signin main stays centered').toBeTruthy();
      },
    },

    {
      name: 'signed-in URL scheme: user app under /dashboard, staff app rooted at /admin',
      run: (ctx) => {
        // the account page is a page IN the user app: app shell + its rail contract
        const account = pages.get('/dashboard/account');
        ctx.expect(account, 'account serves at /dashboard/account').toBeTruthy();
        ctx.expect(account.includes('omega-shell'), 'account wears the app shell').toBeTruthy();
        ctx.expect(account.includes('id="account-nav"'), 'section rail contract intact').toBeTruthy();
        // cp183: the account interior speaks the admin dialect — the rail reuses
        // the shell sidebar recipe, sections open with the page-header anatomy,
        // cards wear admin caps, and the marketing serif voice is gone.
        ctx.expect(account.includes('omega-side__item'), 'rail speaks the shell sidebar dialect').toBeTruthy();
        ctx.expect(account.includes('page-title'), 'sections open with the admin page-header anatomy').toBeTruthy();
        ctx.expect(account.includes('card-header'), 'cards wear admin caps').toBeTruthy();
        ctx.expect(!account.includes('omega-display--section'), 'marketing display voice does not leak into the app').toBeTruthy();
        // cp185: one skeleton on every section — the rail/content row fills the
        // panel and the rail column draws its full-height lane divider (the rail
        // box must not track whichever column happens to be tallest).
        ctx.expect(account.includes('row flex-grow-1'), 'the rail/content row fills the panel').toBeTruthy();
        ctx.expect(/col-lg-3[^"]*hairline-end/.test(account), 'the rail draws its full-height lane divider').toBeTruthy();
        // the staff overview serves AT its root
        const admin = pages.get('/admin');
        ctx.expect(admin && admin.includes('omega-shell'), 'admin overview serves at /admin').toBeTruthy();
        ctx.expect(admin.includes('id="stat-total-users"'), 'overview content present (stat cards)').toBeTruthy();
        // permanent redirects keep every old link alive (module reads data-url)
        ctx.expect(pages.get('/account').includes('data-url="/dashboard/account"'), '/account redirects to the new home').toBeTruthy();
        ctx.expect(pages.get('/dashboard').includes('data-url="/dashboard/account"'), 'default /dashboard forwards to account (brand homepage suppresses)').toBeTruthy();
        ctx.expect(pages.get('/admin/dashboard').includes('data-url="/admin"'), '/admin/dashboard redirects to the root overview').toBeTruthy();
      },
    },

    {
      name: 'admin verts card serves at /admin/verts (docs/web/ads-system.md phase 3)',
      run: (ctx) => {
        const verts = pages.get('/admin/verts');
        ctx.expect(verts, 'verts card serves at /admin/verts').toBeTruthy();
        ctx.expect(verts.includes('omega-shell'), 'verts card wears the app shell (admin/core/minimal gate)').toBeTruthy();
        ctx.expect(verts.includes('id="verts-table"'), 'inventory table present').toBeTruthy();
        ctx.expect(verts.includes('id="vert-editor-modal"'), 'create/edit modal present').toBeTruthy();
        // The editor form covers the verts collection shape (docs/backend/verts.md)
        for (const field of ['vert.enabled', 'vert.title', 'vert.description', 'vert.button', 'vert.link', 'vert.image', 'vert.footer', 'vert.weight', 'vert.targeting.sites', 'vert.targeting.categories', 'vert.targeting.keywords', 'vert.whitelist', 'vert.blacklist']) {
          ctx.expect(verts.includes(`name="${field}"`), `editor form field ${field}`).toBeTruthy();
        }
        // Image rides the posts-editor convention: a plain URL field, no upload lane
        ctx.expect(/<input type="url"[^>]*name="vert\.image"/.test(verts), 'image is a URL field').toBeTruthy();
      },
    },

    {
      name: 'icons inline and template-kit tags render inside Eleventy (urlmatches nav)',
      run: (ctx) => {
        ctx.expect(pages.get('/').includes('data-omega-fa='), 'native fa-* markup is inlined at build').toBeTruthy();
        ctx.expect(pages.get('/').includes('navbar'), 'nav include renders from the packaged nav.json data').toBeTruthy();
      },
    },

    {
      name: 'neobrutalism theme: layered overrides win, base fills the gaps',
      run: async (ctx) => {
        const neo = await buildMini({ activeTheme: 'neobrutalism' });
        ctx.expect(neo.get('/').includes('data-theme-id="neobrutalism"'), 'site.theme.id reflects active theme').toBeTruthy();
        // #177 phase 3: the pricing fork is gone. The base page serves (no
        // catalog in the mini fixture → the honest empty state).
        ctx.expect(neo.get('/pricing').includes('id="pricing-empty"'), 'neobrutalism pricing falls through to the base page').toBeTruthy();
        ctx.expect(!neo.get('/pricing').includes('pricing-title'), 'no trace of the deleted fork vocabulary').toBeTruthy();
        ctx.expect(neo.get('/signin').includes('id="auth-form"'), 'base signin fills the gap').toBeTruthy();
      },
    },

    {
      name: 'farm mode (symlinks, dev): identical output to virtual mode',
      run: async (ctx) => {
        const farm = await buildMini({ layoutMode: 'farm' });
        ctx.expect(farm.get('/404.html'), '404 byte-identical').toBe(pages.get('/404.html'));
        ctx.expect(farm.get('/pricing'), 'pricing byte-identical').toBe(pages.get('/pricing'));
        const link = path.join(PKG, '.omega', 'layout-farm', 'frontend', 'core', 'base.html');
        ctx.expect(fs.lstatSync(link).isSymbolicLink(), 'farm is symlinks, not copies').toBeTruthy();
      },
    },

    {
      name: 'dev chrome (N7): the snapshot\'s dev map is null by default, the resolved ports map when omega dev injects it',
      run: async (ctx) => {
        ctx.expect(readBuildJson(pages).config.dev, 'default builds carry no dev map (client falls back to classics)').toBe(null);

        const dev = await buildMini({ environment: 'development', dev: { ports: { website: 4001, hosting: 5003 } } });
        const config = readBuildJson(dev).config;
        ctx.expect(config.environment, 'dev environment in the bake').toBe('development');
        ctx.expect(config.dev.ports.website, 'resolved website port baked into the dev chrome').toBe(4001);
        ctx.expect(config.dev.ports.hosting, 'sibling emulator ports ride along').toBe(5003);
      },
    },
  ],
});
