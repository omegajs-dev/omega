/**
 * translateSite integration — a handcrafted dist/ (no Eleventy needed) run
 * through the real pipeline with a fake provider: /{lang}/ copies, localized
 * chrome (lang/dir/canonical/og), link rewriting, exclusions (system + config
 * + socials + opt-out attr), hreflang stitching into originals, the committed
 * per-string cache (hits, human overrides), the only-filter, and per-page
 * failure fallback.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stripVTControlCharacters } = require('node:util');
const defineCases = require('@omega.js/devkit/test/define-cases');
const { withoutCI } = require('@omega.js/devkit/test/without-ci');

// A temp consumer's config load records its brand: keep that off the real ~/.omega
require('@omega.js/devkit/test/temp-home');

const { translateSite } = require('../src/translate/index.js');
const translateCommand = require('../src/commands/translate.js');
const { scaffoldDefaults } = require('../src/scaffold.js');
const { hashKey, CONTROL } = require('@omega.js/devkit/translate');

// This file is about the PROVIDER pass. The framework's own default pages ride
// a second, PACKAGED cache (#621) that would otherwise put copies under
// /es/signin here — every run below points at a packaged root that does not
// exist, so what these tests assert stays theirs alone.
// translate-packaged-defaults.test.js owns that lane.
const NO_PACKAGED = path.join(os.tmpdir(), 'omega-packaged-defaults-absent');
// A runner makes every pass cache-only, so a case that expects live calls runs with the CI flags lifted.
const translate = (options) => withoutCI(() => translateSite({ packagedRoot: NO_PACKAGED, ...options }));

const PAGE = (title, body, prefix = '') => `<!doctype html><html lang="en" dir="ltr"${prefix ? ` data-omega-path-prefix="${prefix}"` : ''}><head>
<title>${title}</title>
<meta name="description" content="A fine page"/>
<meta property="og:url" content="https://mini.co/"/>
<meta property="og:locale" content="en"/>
<link rel="canonical" href="https://mini.co/"/>
<link rel="alternate" href="https://mini.co/" hreflang="x-default"/>
<link rel="alternate" href="https://mini.co/" hreflang="en"/>
</head><body>${body}</body></html>`;

// The built sitemap as defaults/pages/sitemap.html emits it (source language
// only, entries in loc byte order, the home loc bare)
const SITEMAP_ENTRY = (loc, priority) => `  <url>
    <loc>${loc}</loc>
    <lastmod>2026-07-29T00:00:00.000Z</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${priority}</priority>
  </url>`;

const SITEMAP = (base = 'https://mini.co') => `<?xml version="1.0" encoding="UTF-8"?>
<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:xhtml="http://www.w3.org/1999/xhtml"
  >
${[
    SITEMAP_ENTRY(base, '1.0'),
    SITEMAP_ENTRY(`${base}/about`, '0.5'),
    SITEMAP_ENTRY(`${base}/signin`, '0.5'),
  ].join('\n')}
</urlset>
`;

/**
 * Stage a consumer root with a built dist. `prefix` stages what a MOUNTED
 * build (#355) emits: the base path stamped on <html>, every internal href
 * already carrying it, and the sitemap written from a `brand.url` that carries
 * it too (absolute URLs are built from brand.url — README: nothing prefixes
 * them twice). dist itself is the mount root, so file paths never carry it.
 */
function stage(prefix = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-wtr-'));
  const dist = path.join(root, 'dist');

  const write = (rel, html) => {
    const file = path.join(dist, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
  };

  write('index.html', PAGE('Welcome home', `
    <p>Grow faster with MiniCo</p>
    <a href="${prefix}/about">About us</a>
    <a href="${prefix}/signin">Sign in</a>
    <a href="https://external.example/x">External</a>
    <span data-omega-no-translate>Do Not Touch</span>
    <input type="submit" value="Send it"/>
    <input type="hidden" value="csrf-token-123"/>`, prefix));
  write('about/index.html', PAGE('About - MiniCo', '<p>The consumer about page</p>', prefix));
  write('signin/index.html', PAGE('Sign in', '<p>Email address</p>', prefix));
  write('admin/panel/index.html', PAGE('Admin', '<p>Secret admin copy</p>', prefix));
  write('skipme/index.html', PAGE('Skipped', '<p>User-excluded page</p>', prefix));
  write('twitter.html', PAGE('Social redirect', '<p>Social</p>', prefix));
  write('sitemap.xml', SITEMAP(`https://mini.co${prefix}`));

  return { root, dist };
}

const CONFIG = {
  brand: { name: 'MiniCo', url: 'https://mini.co' },
  socials: { twitter: 'minico' },
  // `include` is the route list (#858): the default ['**', '!blog/**'] plus one
  // brand page kept out by hand, the successor of the old `exclude: ['skipme']`.
  translation: { languages: ['es', 'ar'], include: ['**', '!blog/**', '!skipme'] },
};

// The same brand served as a project site under /workkit: brand.url carries
// the mount point, exactly as the base-path contract describes it.
const MOUNTED_CONFIG = { ...CONFIG, brand: { ...CONFIG.brand, url: 'https://mini.co/workkit' } };

/** Fake provider: suffixes each string with ·<lang>, tracks calls per lang. */
function fakeSend(calls) {
  return async ({ user }) => {
    const lang = user.match(/^Target language: (\S+)/)[1];
    calls.push(lang);
    const payload = JSON.parse(user.slice(user.indexOf('\n\n') + 2));
    return { text: JSON.stringify(payload.map((s) => (s === CONTROL ? s : `${s.trim()}·${lang}`))), usage: { input: 1, output: 1 } };
  };
}

/**
 * Every language-prefixed internal link in every copy under dist/<lang>
 * resolves to a file (#953): a produced copy links its siblings at /<lang>/…,
 * so a pair with no file there ships a dead link. /es → es.html (the language
 * home is a file), /es/about → es/about/index.html.
 */
function danglingLanguageLinks(dist, langs) {
  const copies = langs.flatMap((lang) => [
    `${lang}.html`,
    ...(fs.existsSync(path.join(dist, lang)) ? fs.readdirSync(path.join(dist, lang), { recursive: true }).map((rel) => path.join(lang, rel)) : []),
  ]).filter((rel) => rel.endsWith('.html') && fs.existsSync(path.join(dist, rel)));

  return copies.flatMap((rel) => [...fs.readFileSync(path.join(dist, rel), 'utf8').matchAll(/href="\/([a-z]{2})(\/[^"#?]*)?"/g)]
    .filter(([, lang]) => langs.includes(lang))
    .map(([href, lang, sub]) => ({ from: rel, href, file: sub ? path.join(lang, sub, 'index.html') : `${lang}.html` }))
    .filter(({ file }) => !fs.existsSync(path.join(dist, file))));
}

/**
 * The language chrome a page advertises, every occurrence kept so a duplicate
 * shows: its hreflang codes and its og:locale:alternate locales, each sorted.
 */
function alternatesOf(dist, rel) {
  const html = fs.readFileSync(path.join(dist, rel), 'utf8');
  const hreflang = [...html.matchAll(/<link\b[^>]*\bhreflang="([^"]+)"[^>]*>/g)].map((m) => m[1]).sort();
  const locales = [...html.matchAll(/<meta\b[^>]*property="og:locale:alternate"[^>]*>/g)]
    .map(([tag]) => tag.match(/content="([^"]*)"/)[1])
    .sort();
  return { hreflang, locales };
}

module.exports = defineCases({
  type: 'group',
  description: 'translate',
  tests: [
    {
      name: 'translateSite: copies, chrome, links, exclusions, alternates, cache',
      run: async (ctx) => {
        const { root, dist } = stage();
        const calls = [];

        const stats = await translate({ root, outDir: dist, config: CONFIG, send: fakeSend(calls) });

        // Copies exist for translatable pages only. The language HOME lands as
        // <lang>.html (a FILE, matching the extensionless canonical /es) — an
        // es/index.html would force Pages' directory redirect (/es → /es/) into
        // a 301 loop with the zone's strip-trailing-slash rule.
        ctx.expect(fs.existsSync(path.join(dist, 'es.html'))).toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(dist, 'es', 'index.html')), 'language home is a file, not a directory index').toBeTruthy();
        ctx.expect(fs.existsSync(path.join(dist, 'es', 'about', 'index.html'))).toBeTruthy();
        ctx.expect(fs.existsSync(path.join(dist, 'ar.html'))).toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(dist, 'es', 'signin')), 'framework default page excluded from the provider pass').toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(dist, 'es', 'admin')), 'system folder excluded').toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(dist, 'es', 'skipme')), 'the include list\'s negation honored').toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(dist, 'es', 'twitter.html')), 'socials redirect excluded').toBeTruthy();
        ctx.expect(stats.pages).toBe(2);

        const es = fs.readFileSync(path.join(dist, 'es.html'), 'utf8');

        // Text + title + meta translated; opt-out and hidden input untouched
        ctx.expect(es.includes('Welcome home·es'), 'title translated').toBeTruthy();
        ctx.expect(es.includes('Grow faster with MiniCo·es'), 'body text translated').toBeTruthy();
        ctx.expect(es.includes('A fine page·es'), 'meta description translated').toBeTruthy();
        ctx.expect(es.includes('Send it·es'), 'submit value translated').toBeTruthy();
        ctx.expect(es.includes('Do Not Touch'), 'data-omega-no-translate kept').toBeTruthy();
        ctx.expect(!es.includes('Do Not Touch·es'), 'opt-out really skipped').toBeTruthy();
        ctx.expect(es.includes('csrf-token-123'), 'hidden input value untouched').toBeTruthy();
        ctx.expect(!es.includes('csrf-token-123·es'), 'hidden input value never translated').toBeTruthy();

        // Localized chrome
        ctx.expect(es.includes('lang="es"')).toBeTruthy();
        ctx.expect(es.includes('dir="ltr"')).toBeTruthy();
        ctx.expect(es.includes('<link rel="canonical" href="https://mini.co/es"')).toBeTruthy();
        ctx.expect(es.includes('content="https://mini.co/es"'), 'og:url localized').toBeTruthy();
        ctx.expect(es.includes('property="og:locale" content="es_ES"'), 'og:locale in Open Graph language_TERRITORY form').toBeTruthy();
        ctx.expect(es.includes('og:locale:alternate" content="en_US"')).toBeTruthy();
        ctx.expect(es.includes('og:locale:alternate" content="ar_AR"')).toBeTruthy();
        ctx.expect(!es.includes('og:locale:alternate" content="es"'), 'no bare-code locale alternates').toBeTruthy();

        // Links: internal rewritten, excluded + external untouched
        ctx.expect(es.includes('href="/es/about"')).toBeTruthy();
        ctx.expect(es.includes('href="/signin"'), 'excluded route link not rewritten').toBeTruthy();
        ctx.expect(es.includes('https://external.example/x')).toBeTruthy();

        // RTL
        const ar = fs.readFileSync(path.join(dist, 'ar.html'), 'utf8');
        ctx.expect(ar.includes('lang="ar"') && ar.includes('dir="rtl"')).toBeTruthy();

        // Originals gained hreflang alternates for exactly the produced languages
        const original = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
        ctx.expect(original.includes('hreflang="es"')).toBeTruthy();
        ctx.expect(original.includes('hreflang="ar"')).toBeTruthy();
        ctx.expect(original.includes('https://mini.co/es'), 'alternate href points at the copy').toBeTruthy();

        // Committed cache exists and is a hash → string map
        const cacheFile = path.join(root, 'translations', 'es', 'pages', 'home.json');
        ctx.expect(fs.existsSync(cacheFile)).toBeTruthy();
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        ctx.expect(cache[hashKey('Welcome home')]).toBe('Welcome home·es');

        // Second run: fully cached — the provider must never be called
        const rerun = await translate({
          root, outDir: dist, config: CONFIG,
          send: async () => { throw new Error('provider must not be called on a warm cache'); },
        });
        ctx.expect(rerun.newStrings).toBe(0);
        ctx.expect(rerun.cachedStrings > 0).toBeTruthy();
        ctx.expect(rerun.failures).toEqual([]);

        // Human override: hand-edit a cached value → it wins on rebuild
        cache[hashKey('Welcome home')] = 'Bienvenido a casa';
        fs.writeFileSync(cacheFile, JSON.stringify(cache));
        await translate({ root, outDir: dist, config: CONFIG, send: async () => { throw new Error('no calls'); } });
        const esAgain = fs.readFileSync(path.join(dist, 'es.html'), 'utf8');
        ctx.expect(esAgain.includes('Bienvenido a casa'), 'hand-edited cache value sticks').toBeTruthy();

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: '#605: the framework keeps its own default pages off the provider with no config exclude at all',
      run: async (ctx) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-wtr-'));
        const dist = path.join(root, 'dist');
        const write = (rel, html) => {
          fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
          fs.writeFileSync(path.join(dist, rel), html);
        };

        // The framework's own plumbing, as the build emits it…
        for (const route of ['signin', 'app', 'account', 'dashboard/account', 'payment/checkout', 'portal/email-preferences']) {
          write(`${route}/index.html`, PAGE(route, `<p>Framework ${route}</p>`));
        }
        // …and a page the BRAND wrote.
        write('guides/getting-started/index.html', PAGE('Getting started', '<p>Brand-authored guide</p>'));

        const stats = await translate({
          root,
          outDir: dist,
          // No route list whatsoever: a brand should not have to name any of this
          config: { brand: { name: 'MiniCo', url: 'https://mini.co' }, translation: { languages: ['es'] } },
          send: fakeSend([]),
        });

        // Never a provider call, and (this run points at no packaged cache) never a
        // copy either — the ONE thing #605 owns. What a packaged cache does for these
        // routes is translate-packaged-defaults.test.js's story (#621).
        for (const route of ['signin', 'app', 'account', 'dashboard/account', 'payment/checkout', 'portal/email-preferences']) {
          ctx.expect(!fs.existsSync(path.join(dist, 'es', route)), `/${route} is a framework default page — never sent to the provider`).toBeTruthy();
        }
        ctx.expect(fs.existsSync(path.join(dist, 'es', 'guides', 'getting-started', 'index.html')), 'the brand page still translates').toBeTruthy();
        ctx.expect(stats.pages, 'exactly one page was translatable').toBe(1);

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'translateSite: only-filter limits the run to one page',
      run: async (ctx) => {
        const { root, dist } = stage();
        const calls = [];

        const stats = await translate({ root, outDir: dist, config: CONFIG, send: fakeSend(calls), only: 'about' });

        ctx.expect(stats.pages).toBe(1);
        ctx.expect(fs.existsSync(path.join(dist, 'es', 'about', 'index.html'))).toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(dist, 'es.html')), 'home not translated under only-filter').toBeTruthy();

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'translateSite: provider failure ships the pair untranslated, unadvertised, and warns loudly (#953)',
      run: async (ctx) => {
        const { root, dist } = stage();
        const warnings = [];

        const stats = await translate({
          root, outDir: dist, config: CONFIG,
          logger: { log: () => {}, warn: (m) => warnings.push(m), error: () => {} },
          send: async ({ user }) => {
            const lang = user.match(/^Target language: (\S+)/)[1];
            if (lang === 'ar') {
              throw new Error('boom');
            }
            const payload = JSON.parse(user.slice(user.indexOf('\n\n') + 2));
            return { text: JSON.stringify(payload.map((s) => (s === CONTROL ? s : `${s.trim()}·es`))), usage: {} };
          },
        });

        ctx.expect(stats.failures.length >= 1).toBeTruthy();
        ctx.expect(stats.failures.every((f) => f.startsWith('ar ')), 'only ar failed').toBeTruthy();

        // No mixed-language copy, and no dead link either: the ar pair lands the
        // SOURCE page at its path, like a cold cache under cachedOnly, with its
        // <html lang dir> naming the text it carries (English, so ltr, not ar's rtl)
        for (const rel of ['ar.html', path.join('ar', 'about', 'index.html')]) {
          const copy = fs.readFileSync(path.join(dist, rel), 'utf8');
          ctx.expect(!copy.includes('·'), `${rel}: source text only, never half-translated`).toBeTruthy();
          ctx.expect(copy.includes('<html lang="en" dir="ltr"'), `${rel}: lang and dir name the source text`).toBeTruthy();
          ctx.expect(!copy.includes('hreflang="ar"') && !copy.includes('hreflang="es"'), `${rel}: an untranslated copy advertises nothing`).toBeTruthy();
        }
        const arHome = fs.readFileSync(path.join(dist, 'ar.html'), 'utf8');
        ctx.expect(arHome.includes('Grow faster with MiniCo'), 'the source copy').toBeTruthy();
        ctx.expect(arHome.includes('href="/ar/about"'), 'its links stay in the ar link graph').toBeTruthy();
        ctx.expect(danglingLanguageLinks(dist, ['es', 'ar']), 'no language link dangles').toEqual([]);

        // The failure is loud, naming the page and the language
        const loud = warnings.filter((m) => m.includes('[ar]') && m.includes('boom') && /untranslated/i.test(m));
        ctx.expect(loud.length, 'both translatable pages warn by page + language').toBe(2);
        ctx.expect(stats.failures.length).toBe(2);

        // es still ships, and it never advertises the language that failed
        const es = fs.readFileSync(path.join(dist, 'es.html'), 'utf8');
        ctx.expect(es.includes('Grow faster with MiniCo·es')).toBeTruthy();
        ctx.expect(es.includes('hreflang="es"')).toBeTruthy();
        ctx.expect(!es.includes('hreflang="ar"'), 'a failed language is never advertised').toBeTruthy();

        const original = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
        ctx.expect(!original.includes('hreflang="ar"'), 'the original stays honest too').toBeTruthy();

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'translateSite: a copy advertises only the languages actually produced',
      run: async (ctx) => {
        const { root, dist } = stage();
        const refuse = async () => { throw new Error('cachedOnly must never call the provider'); };

        // Warm es for /about only, then run cachedOnly with ar configured but cold
        await translate({ root, outDir: dist, config: { ...CONFIG, translation: { languages: ['es'] } }, send: fakeSend([]), only: 'about' });
        const stats = await translate({ root, outDir: dist, config: CONFIG, cachedOnly: true, send: refuse });

        ctx.expect(stats.pages).toBe(1);
        ctx.expect(stats.skippedCold.includes('ar /about'), 'ar is cold for about').toBeTruthy();

        const copy = fs.readFileSync(path.join(dist, 'es', 'about', 'index.html'), 'utf8');
        ctx.expect(copy.includes('hreflang="es"'), 'the copy advertises itself').toBeTruthy();
        ctx.expect(!copy.includes('hreflang="ar"'), 'the copy never advertises a language that was not produced').toBeTruthy();
        ctx.expect(!copy.includes('og:locale:alternate" content="ar_AR"'), 'no og:locale alternate for a skipped language').toBeTruthy();

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'translateSite: a warm second pass leaves every copy one alternate per language (#964)',
      run: async (ctx) => {
        const { root, dist } = stage();
        const warm = async () => { throw new Error('a warm cache never calls the provider'); };

        await translate({ root, outDir: dist, config: CONFIG, send: fakeSend([]) });
        const rerun = await translate({ root, outDir: dist, config: CONFIG, send: warm });
        ctx.expect(rerun.failures, 'es and ar are produced on the second pass too').toEqual([]);

        const others = { es: ['ar_AR', 'en_US'], ar: ['en_US', 'es_ES'] };
        for (const lang of ['es', 'ar']) {
          for (const rel of [`${lang}.html`, path.join(lang, 'about', 'index.html')]) {
            const { hreflang, locales } = alternatesOf(dist, rel);
            ctx.expect(hreflang, `${rel}: x-default, en, es and ar exactly once each`).toEqual(['ar', 'en', 'es', 'x-default']);
            ctx.expect(locales, `${rel}: one og:locale:alternate per other locale, exactly once`).toEqual(others[lang]);
          }
        }

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'translateSite: a second pass with ar gone cold leaves its untranslated copy unadvertised (#964)',
      run: async (ctx) => {
        const { root, dist } = stage();
        const refuse = async () => { throw new Error('cachedOnly must never call the provider'); };

        await translate({ root, outDir: dist, config: CONFIG, send: fakeSend([]) });
        const first = alternatesOf(dist, 'index.html').hreflang;
        ctx.expect(first.includes('es') && first.includes('ar'), 'the original carries es and ar after the first pass').toBeTruthy();

        // ar's cache is gone, so the cachedOnly pass ships ar untranslated
        fs.rmSync(path.join(root, 'translations', 'ar'), { recursive: true, force: true });
        const stats = await translate({ root, outDir: dist, config: CONFIG, cachedOnly: true, send: refuse });
        ctx.expect(stats.skippedCold.includes('ar /'), 'ar is cold for the home').toBeTruthy();
        ctx.expect(stats.skippedCold.includes('ar /about'), 'ar is cold for about').toBeTruthy();

        for (const rel of ['ar.html', path.join('ar', 'about', 'index.html')]) {
          const { hreflang, locales } = alternatesOf(dist, rel);
          ctx.expect(hreflang, `${rel}: only the x-default and en tags the build emits`).toEqual(['en', 'x-default']);
          ctx.expect(locales, `${rel}: no og:locale:alternate`).toEqual([]);
        }

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'translateSite: a second pass whose config dropped ar advertises ar nowhere (#964)',
      run: async (ctx) => {
        const { root, dist } = stage();
        const warm = async () => { throw new Error('a warm cache never calls the provider'); };

        await translate({ root, outDir: dist, config: CONFIG, send: fakeSend([]) });
        ctx.expect(alternatesOf(dist, 'index.html').hreflang.includes('ar'), 'the original carries ar after the first pass').toBeTruthy();

        await translate({ root, outDir: dist, config: { ...CONFIG, translation: { ...CONFIG.translation, languages: ['es'] } }, send: warm });

        for (const rel of ['index.html', 'es.html']) {
          const { hreflang, locales } = alternatesOf(dist, rel);
          ctx.expect(!hreflang.includes('ar'), `${rel}: no hreflang="ar"`).toBeTruthy();
          ctx.expect(!locales.includes('ar_AR'), `${rel}: no og:locale:alternate for ar`).toBeTruthy();
          ctx.expect(hreflang.includes('es'), `${rel}: es is still advertised`).toBeTruthy();
        }

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'translateSite: a second pass with every language cold leaves the originals advertising only x-default and en (#964)',
      run: async (ctx) => {
        const { root, dist } = stage();
        const refuse = async () => { throw new Error('cachedOnly must never call the provider'); };

        await translate({ root, outDir: dist, config: CONFIG, send: fakeSend([]) });
        const first = alternatesOf(dist, 'index.html').hreflang;
        ctx.expect(first.includes('es') && first.includes('ar'), 'the original carries es and ar after the first pass').toBeTruthy();

        // Both caches gone, so the cachedOnly pass produces no language at all
        for (const lang of ['es', 'ar']) {
          fs.rmSync(path.join(root, 'translations', lang), { recursive: true, force: true });
        }
        const stats = await translate({ root, outDir: dist, config: CONFIG, cachedOnly: true, send: refuse });
        ctx.expect(stats.pages, 'nothing translated on the cold pass').toBe(0);

        for (const rel of ['index.html', path.join('about', 'index.html')]) {
          const { hreflang, locales } = alternatesOf(dist, rel);
          ctx.expect(hreflang, `${rel}: only the x-default and en tags the build emits`).toEqual(['en', 'x-default']);
          ctx.expect(locales, `${rel}: no og:locale:alternate`).toEqual([]);
        }

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'translateSite: a warm third pass leaves the pages byte-identical to the second (#964)',
      run: async (ctx) => {
        const { root, dist } = stage();
        const warm = async () => { throw new Error('a warm cache never calls the provider'); };
        const read = (rel) => fs.readFileSync(path.join(dist, rel), 'utf8');

        await translate({ root, outDir: dist, config: CONFIG, send: fakeSend([]) });
        await translate({ root, outDir: dist, config: CONFIG, send: warm });
        const second = { original: read('index.html'), es: read('es.html') };

        await translate({ root, outDir: dist, config: CONFIG, send: warm });
        ctx.expect(read('index.html'), 'index.html: a rerun changes nothing').toBe(second.original);
        ctx.expect(read('es.html'), 'es.html: a rerun changes nothing').toBe(second.es);

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'translateSite: disabled config skips cleanly',
      run: async (ctx) => {
        const { root, dist } = stage();

        const stats = await translate({ root, outDir: dist, config: { brand: { name: 'X' } }, send: async () => {} });
        ctx.expect(stats.skipped).toBe(true);

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'translateSite: cachedOnly never calls the provider and ships cold pairs untranslated, unadvertised (friction #24, #953)',
      run: async (ctx) => {
        const { root, dist } = stage();
        const refuse = async () => { throw new Error('cachedOnly must never call the provider'); };
        const wipeCopies = () => ['es', 'ar', 'es.html', 'ar.html'].forEach((rel) => fs.rmSync(path.join(dist, rel), { recursive: true, force: true }));

        // Everything cold: nothing translated, zero provider calls, yet every pair
        // lands the SOURCE page at its path, so no produced link can dangle
        const cold = await translate({ root, outDir: dist, config: CONFIG, cachedOnly: true, send: refuse });
        ctx.expect(cold.pages).toBe(0);
        ctx.expect(cold.newStrings).toBe(0);
        ctx.expect(cold.skippedCold.includes('es /about'), 'about is reported cold for es').toBeTruthy();
        ctx.expect(cold.skippedCold.includes('ar /'), 'home is reported cold for ar').toBeTruthy();
        for (const rel of ['es.html', 'ar.html', path.join('es', 'about', 'index.html'), path.join('ar', 'about', 'index.html')]) {
          ctx.expect(fs.existsSync(path.join(dist, rel)), `${rel}: a cold pair still lands a copy`).toBeTruthy();
        }

        // Warm ONE page (the explicit `omega translate` path), wipe its copies…
        const calls = [];
        await translate({ root, outDir: dist, config: CONFIG, send: fakeSend(calls), only: 'about' });
        ctx.expect(calls.length > 0).toBeTruthy();
        wipeCopies();

        // …then cachedOnly translates the warm page and ships the cold home untranslated
        const warm = await translate({ root, outDir: dist, config: CONFIG, cachedOnly: true, send: refuse });
        ctx.expect(warm.pages, 'only the warmed page counts as translated').toBe(1);
        ctx.expect(warm.skippedCold.includes('es /'), 'cold home still reported').toBeTruthy();

        // The warm page: its translated copy, advertising every produced language
        const about = fs.readFileSync(path.join(dist, 'es', 'about', 'index.html'), 'utf8');
        ctx.expect(about.includes('The consumer about page·es'), 'the warm page is translated').toBeTruthy();
        ctx.expect(about.includes('lang="es"')).toBeTruthy();
        ctx.expect(about.includes('hreflang="es"') && about.includes('hreflang="ar"'), 'the warm copy carries its alternates').toBeTruthy();

        // The cold home: the SOURCE text at the translated path, in the language's
        // link graph, honest about its language, and advertised nowhere
        const home = fs.readFileSync(path.join(dist, 'es.html'), 'utf8');
        ctx.expect(home.includes('Grow faster with MiniCo') && !home.includes('·es'), 'the source text, untranslated').toBeTruthy();
        ctx.expect(home.includes('<html lang="en" dir="ltr"'), '<html lang> names the source language the text is in').toBeTruthy();
        ctx.expect(home.includes('property="og:locale" content="en_US"'), 'og:locale is honest too').toBeTruthy();
        ctx.expect(home.includes('<link rel="canonical" href="https://mini.co/"'), 'canonical stays the source page: the copy duplicates it').toBeTruthy();
        ctx.expect(home.includes('href="/es/about"'), 'internal links rewritten into the language').toBeTruthy();
        ctx.expect(home.includes('href="/signin"'), 'excluded route link untouched').toBeTruthy();
        ctx.expect(!home.includes('hreflang="es"') && !home.includes('hreflang="ar"'), 'the untranslated copy advertises no alternates').toBeTruthy();
        ctx.expect(danglingLanguageLinks(dist, ['es', 'ar']), 'no language link dangles').toEqual([]);

        const original = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
        ctx.expect(!original.includes('hreflang="es"') && !original.includes('hreflang="ar"'), 'the original never advertises an untranslated copy').toBeTruthy();

        const locs = [...fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
        ctx.expect(locs.includes('https://mini.co/es/about'), 'the translated copy is listed').toBeTruthy();
        ctx.expect(!locs.includes('https://mini.co/es') && !locs.includes('https://mini.co/ar'), 'an untranslated copy is never listed').toBeTruthy();

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'translateSite: on a runner (CI set, no cachedOnly) the pass is cache-only',
      run: async (ctx) => {
        const { root, dist } = stage();
        const saved = process.env.CI;
        process.env.CI = 'true';

        try {
          const stats = await translateSite({
            root, outDir: dist, config: CONFIG, packagedRoot: NO_PACKAGED,
            logger: { log: () => {}, warn: () => {}, error: () => {} },
            send: async () => { throw new Error('a runner must never call the provider'); },
          });

          ctx.expect(stats.failures, 'no provider call was attempted').toEqual([]);
          ctx.expect(stats.newStrings).toBe(0);
          ctx.expect(stats.skippedCold.includes('es /'), 'the cold home is reported for es').toBeTruthy();
          ctx.expect(stats.skippedCold.includes('ar /about'), 'the cold about is reported for ar').toBeTruthy();
          const home = fs.readFileSync(path.join(dist, 'es.html'), 'utf8');
          ctx.expect(home.includes('Grow faster with MiniCo') && !home.includes('·'), 'the cold copy ships the source text').toBeTruthy();
        } finally {
          if (saved === undefined) delete process.env.CI;
          else process.env.CI = saved;
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },

    {
      name: '`omega translate` on a runner warns about the cold page by language, as the build does',
      run: async (ctx) => {
        const { root, dist } = stage();
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-website', private: true, dependencies: { '@omega.js/web': '*' } }));
        fs.mkdirSync(path.join(root, 'config'));
        fs.writeFileSync(path.join(root, 'config', 'omega.json5'), "{ brand: { id: 'minico', name: 'MiniCo', url: 'https://mini.co' }, translation: { languages: ['es'] }, targets: { web: { type: 'web' } } }");

        // The default provider's SDK, stubbed so a call is counted and fails, never reaching the service
        const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk', { paths: [path.dirname(require.resolve('@omega.js/devkit/translate'))] });
        let sdkCalls = 0;
        require.cache[sdkPath] = {
          id: sdkPath, filename: sdkPath, loaded: true,
          exports: { query: () => (async function* () { sdkCalls++; yield { type: 'result', subtype: 'error_during_execution', result: 'a runner must never call the provider' }; })() },
        };
        const saved = { CI: process.env.CI, cwd: process.cwd(), warn: console.warn, exit: process.exit, exitCode: process.exitCode };
        const warnings = [];
        process.env.CI = 'true';
        console.warn = (...args) => warnings.push(stripVTControlCharacters(args.join(' ')));
        process.exit = (code) => { throw new Error(`the command exited ${code}`); };
        process.chdir(root);

        try {
          await translateCommand({ logFile: false });
        } finally {
          process.chdir(saved.cwd);
          process.exit = saved.exit;
          process.exitCode = saved.exitCode;
          console.warn = saved.warn;
          delete require.cache[sdkPath];
          if (saved.CI === undefined) delete process.env.CI;
          else process.env.CI = saved.CI;
        }

        try {
          ctx.expect(sdkCalls, 'a runner never calls the provider').toBe(0);
          ctx.expect(
            warnings.some((line) => /\bes\b/.test(line) && line.includes('about')),
            `a warning names the language and the cold page: ${JSON.stringify(warnings)}`
          ).toBeTruthy();
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'translateSite: a live pass over a warm page and a cold page sends only the cold strings and translates both',
      run: async (ctx) => {
        const { root, dist } = stage();
        const sent = [];
        const send = async (request) => {
          const payload = JSON.parse(request.user.slice(request.user.indexOf('\n\n') + 2));
          sent.push(...payload);
          return fakeSend([])(request);
        };

        // Warm /about only, then hand-edit its es entry so a cache hit is told apart from a live call
        await translate({ root, outDir: dist, config: CONFIG, send: fakeSend([]), only: 'about' });
        const aboutCache = path.join(root, 'translations', 'es', 'pages', 'about.json');
        const cache = JSON.parse(fs.readFileSync(aboutCache, 'utf8'));
        cache[hashKey('The consumer about page')] = 'La página de la empresa';
        fs.writeFileSync(aboutCache, JSON.stringify(cache));

        const stats = await translate({ root, outDir: dist, config: CONFIG, send });

        ctx.expect(stats.failures).toEqual([]);
        ctx.expect(stats.pages).toBe(2);
        ctx.expect(sent.includes('Grow faster with MiniCo'), 'the cold home went to the provider').toBeTruthy();
        ctx.expect(!sent.includes('The consumer about page') && !sent.includes('About - MiniCo'), 'the warm page never did').toBeTruthy();

        const about = fs.readFileSync(path.join(dist, 'es', 'about', 'index.html'), 'utf8');
        ctx.expect(about.includes('La página de la empresa'), 'the warm page reads its saved text').toBeTruthy();
        const home = fs.readFileSync(path.join(dist, 'es.html'), 'utf8');
        ctx.expect(home.includes('Grow faster with MiniCo·es'), 'the cold page is translated live').toBeTruthy();
        const homeCache = JSON.parse(fs.readFileSync(path.join(root, 'translations', 'es', 'pages', 'home.json'), 'utf8'));
        ctx.expect(homeCache[hashKey('Grow faster with MiniCo')], 'the live result is saved for the commit').toBe('Grow faster with MiniCo·es');

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'the scaffolded build workflow carries no AI key, even with one in the target .env',
      run: (ctx) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-wtr-workflow-'));
        fs.writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY="sk-fixture"\nANTHROPIC_API_KEY="sk-ant-fixture"\nFIXTURE_OWN_KEY="own"\n');

        try {
          scaffoldDefaults({ outputDir: root, logger: { log: () => {}, warn: () => {}, error: () => {} } });
          const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build.yml'), 'utf8');

          // The control: the target's own .env reached the generated secrets block
          ctx.expect(workflow).toContain('FIXTURE_OWN_KEY: ${{ secrets.FIXTURE_OWN_KEY }}');
          ctx.expect(workflow.includes('OPENAI_API_KEY'), 'no OpenAI key reaches the runner').toBe(false);
          ctx.expect(workflow.includes('ANTHROPIC_API_KEY'), 'no Anthropic key reaches the runner').toBe(false);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'translateSite: the sitemap gains every produced language URL with xhtml:link alternates',
      run: async (ctx) => {
        const { root, dist } = stage();
        const sitemapFile = path.join(dist, 'sitemap.xml');

        await translate({ root, outDir: dist, config: CONFIG, send: fakeSend([]) });

        const xml = fs.readFileSync(sitemapFile, 'utf8');
        const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

        // Every produced copy is listed, and only produced ones
        ctx.expect(locs.includes('https://mini.co/es'), 'es language home listed').toBeTruthy();
        ctx.expect(locs.includes('https://mini.co/ar'), 'ar language home listed').toBeTruthy();
        ctx.expect(locs.includes('https://mini.co/es/about'), 'es about listed').toBeTruthy();
        ctx.expect(locs.includes('https://mini.co/ar/about'), 'ar about listed').toBeTruthy();
        ctx.expect(!locs.some((loc) => loc.includes('/signin') && loc.includes('/es/')), 'excluded route gets no copy entry').toBeTruthy();
        ctx.expect(locs, 'entries stay in loc byte order (cp227)').toEqual([...locs].sort());

        // Every entry of a translated set carries the full alternate set, x-default
        // at the source language — sitemap and page-level hreflang tell one story
        const entry = (loc) => xml.match(new RegExp(`<url>\\s*<loc>${loc.replace(/\//g, '\\/')}</loc>[\\s\\S]*?</url>`))[0];
        for (const loc of ['https://mini.co', 'https://mini.co/es', 'https://mini.co/ar']) {
          const block = entry(loc);
          ctx.expect(block, `${loc}: x-default`).toMatch(/<xhtml:link rel="alternate" hreflang="x-default" href="https:\/\/mini\.co"\/>/);
          ctx.expect(block, `${loc}: en`).toMatch(/<xhtml:link rel="alternate" hreflang="en" href="https:\/\/mini\.co"\/>/);
          ctx.expect(block, `${loc}: es`).toMatch(/<xhtml:link rel="alternate" hreflang="es" href="https:\/\/mini\.co\/es"\/>/);
          ctx.expect(block, `${loc}: ar`).toMatch(/<xhtml:link rel="alternate" hreflang="ar" href="https:\/\/mini\.co\/ar"\/>/);
        }
        ctx.expect(entry('https://mini.co/es/about'), 'about copy names its sibling').toMatch(/hreflang="ar" href="https:\/\/mini\.co\/ar\/about"\/>/);

        // An untranslated page keeps a plain entry
        ctx.expect(!entry('https://mini.co/signin').includes('xhtml:link'), 'untranslated page gets no alternates').toBeTruthy();

        // Copies inherit the source entry's metadata
        ctx.expect(entry('https://mini.co/es'), 'language home inherits the home priority').toMatch(/<priority>1\.0<\/priority>/);

        // Idempotent: a second pass neither duplicates entries nor alternates
        await translate({ root, outDir: dist, config: CONFIG, send: async () => { throw new Error('warm cache'); } });
        const second = fs.readFileSync(sitemapFile, 'utf8');
        ctx.expect([...second.matchAll(/<loc>https:\/\/mini\.co\/es<\/loc>/g)].length, 'no duplicate copy entry').toBe(1);
        ctx.expect([...second.matchAll(/hreflang="es" href="https:\/\/mini\.co\/es"/g)].length, 'no duplicate alternates').toBe(3);

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'translateSite: an unproduced language appears nowhere in the sitemap',
      run: async (ctx) => {
        const { root, dist } = stage();
        const sitemapFile = path.join(dist, 'sitemap.xml');

        // ar fails at the provider; es ships
        await translate({
          root, outDir: dist, config: CONFIG,
          send: async ({ user }) => {
            const lang = user.match(/^Target language: (\S+)/)[1];
            if (lang === 'ar') {
              throw new Error('boom');
            }
            const payload = JSON.parse(user.slice(user.indexOf('\n\n') + 2));
            return { text: JSON.stringify(payload.map((s) => (s === CONTROL ? s : `${s.trim()}·es`))), usage: {} };
          },
        });

        const xml = fs.readFileSync(sitemapFile, 'utf8');
        ctx.expect(xml.includes('<loc>https://mini.co/es</loc>'), 'the produced language is listed').toBeTruthy();
        ctx.expect(!xml.includes('/ar'), 'a failed language is never listed or advertised').toBeTruthy();
        ctx.expect(!xml.includes('hreflang="ar"'), 'no alternate for a language that was never written').toBeTruthy();

        // A stale copy entry from an earlier run is dropped when the language stops
        // being produced (the sitemap owns no lie either)
        await translate({
          root, outDir: dist, config: { ...CONFIG, translation: { languages: ['ar'] } },
          cachedOnly: true, send: async () => { throw new Error('no calls'); },
        });
        const after = fs.readFileSync(sitemapFile, 'utf8');
        ctx.expect(!after.includes('/es'), 'entries for a no-longer-produced language are removed').toBeTruthy();

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'translateSite: a MOUNTED site composes prefix-then-lang in hrefs, alternates and the sitemap (#359)',
      run: async (ctx) => {
        const { root, dist } = stage('/workkit');

        await translate({ root, outDir: dist, config: MOUNTED_CONFIG, send: fakeSend([]) });

        // 1. Page hrefs: the lang segment goes AFTER the base path, and an excluded
        //    route is still recognized through the prefix
        const es = fs.readFileSync(path.join(dist, 'es.html'), 'utf8');
        ctx.expect(es.includes('href="/workkit/es/about"'), 'a mounted link keeps its prefix and gains the lang after it').toBeTruthy();
        ctx.expect(es.includes('href="/workkit/signin"'), 'the excluded route is recognized under the prefix, link untouched').toBeTruthy();
        ctx.expect(!es.includes('/es/workkit'), 'the lang segment never lands at the domain root').toBeTruthy();
        ctx.expect(es.includes('href="https://external.example/x"'), 'external links stay external').toBeTruthy();

        // 2. Localized chrome + hreflang alternates, on the copy and stitched back
        //    into the original
        ctx.expect(es.includes('<link rel="canonical" href="https://mini.co/workkit/es"'), 'canonical mounted').toBeTruthy();
        ctx.expect(es.includes('content="https://mini.co/workkit/es"'), 'og:url mounted').toBeTruthy();
        ctx.expect(es.includes('href="https://mini.co/workkit/ar" hreflang="ar"'), 'the copy names its sibling under the base path').toBeTruthy();

        const original = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
        ctx.expect(original.includes('href="https://mini.co/workkit/es" hreflang="es"'), 'the original advertises the mounted copy').toBeTruthy();
        ctx.expect(!original.includes('https://mini.co/es'), 'no alternate points at the domain root').toBeTruthy();
        ctx.expect(!/workkit\/workkit/.test(`${es}${original}`), 'an absolute URL is never prefixed twice — it comes from brand.url').toBeTruthy();

        // 3. The sitemap tells the same story, and re-running does not duplicate it
        //    (a mounted copy entry is recognized as one on the next pass)
        const sitemapFile = path.join(dist, 'sitemap.xml');
        const xml = fs.readFileSync(sitemapFile, 'utf8');
        const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
        ctx.expect(locs.includes('https://mini.co/workkit/es/about'), 'the copy is listed under the base path').toBeTruthy();
        ctx.expect(locs.includes('https://mini.co/workkit/ar'), 'the language home too').toBeTruthy();
        ctx.expect(!locs.some((loc) => loc.includes('/es/workkit')), 'never the wrong way round').toBeTruthy();
        ctx.expect(xml, 'sitemap alternates mounted').toMatch(/hreflang="es" href="https:\/\/mini\.co\/workkit\/es"\/>/);
        ctx.expect(!xml.includes('workkit/workkit'), 'sitemap URLs are never prefixed twice either').toBeTruthy();

        await translate({ root, outDir: dist, config: MOUNTED_CONFIG, send: async () => { throw new Error('warm cache'); } });
        const second = fs.readFileSync(sitemapFile, 'utf8');
        ctx.expect([...second.matchAll(/<loc>https:\/\/mini\.co\/workkit\/es<\/loc>/g)].length, 'no duplicate copy entry on a second pass').toBe(1);

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'translateSite: an UNMOUNTED site composes exactly as it always has (#359 regression pin)',
      run: async (ctx) => {
        const { root, dist } = stage();

        await translate({ root, outDir: dist, config: CONFIG, send: fakeSend([]) });

        const es = fs.readFileSync(path.join(dist, 'es.html'), 'utf8');
        ctx.expect(es.includes('href="/es/about"'), 'href: the lang segment sits at the site root').toBeTruthy();
        ctx.expect(es.includes('href="/signin"'), 'excluded route link untouched').toBeTruthy();
        ctx.expect(es.includes('<link rel="canonical" href="https://mini.co/es"'), 'canonical unchanged').toBeTruthy();
        ctx.expect(es.includes('href="https://mini.co/ar" hreflang="ar"'), 'alternate unchanged').toBeTruthy();

        const xml = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8');
        ctx.expect(xml.includes('<loc>https://mini.co/es/about</loc>'), 'sitemap entry unchanged').toBeTruthy();
        ctx.expect(xml, 'sitemap alternate unchanged').toMatch(/hreflang="es" href="https:\/\/mini\.co\/es"\/>/);

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    {
      name: 'updateSitemap: a loc with query-string ampersands stays valid XML, and an unproduced prefixed entry is dropped with a warning',
      run: (ctx) => {
        const { updateSitemap } = require('../src/translate/sitemap.js');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-sitemap-'));
        const sitemapFile = path.join(root, 'sitemap.xml');
        fs.writeFileSync(sitemapFile, [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
          SITEMAP_ENTRY('https://mini.co/search?a=1&amp;b=2', '0.5'),
          SITEMAP_ENTRY('https://mini.co/it/legacy', '0.5'),
          '</urlset>',
          '',
        ].join('\n'));

        const warns = [];
        const count = updateSitemap({
          outDir: root,
          baseUrl: 'https://mini.co',
          defaultLang: 'en',
          produced: new Map([['search?a=1&b=2', ['es']]]),
          logger: { warn: (message) => warns.push(message) },
        });

        const xml = fs.readFileSync(sitemapFile, 'utf8');
        ctx.expect(count).toBe(1);
        ctx.expect(xml.includes('<loc>https://mini.co/es/search?a=1&amp;b=2</loc>'), 'the cloned loc re-escapes the ampersand').toBeTruthy();
        ctx.expect(xml.includes('href="https://mini.co/es/search?a=1&amp;b=2"'), 'alternate hrefs re-escape too').toBeTruthy();
        ctx.expect(!/&(?!amp;|lt;|gt;|quot;|#)/.test(xml), 'no bare ampersand survives anywhere').toBeTruthy();
        ctx.expect(warns.length, 'the dropped, never-re-emitted /it/legacy entry warns').toBe(1);
        ctx.expect(warns[0].includes('https://mini.co/it/legacy'), 'the warning names the lost loc').toBeTruthy();

        fs.rmSync(root, { recursive: true, force: true });
      },
    },
  ],
});
