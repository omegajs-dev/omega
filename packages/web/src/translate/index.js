/**
 * Site translation — post-build: reads built pages from dist/, translates
 * every text unit through @omega.js/devkit/translate (per-string committed
 * cache in <consumer>/translations/, provider from config), and writes
 * /{lang}/... copies with localized <html lang|dir>, canonical/og tags,
 * rewritten internal links, and hreflang alternates stitched into both the
 * copies and the originals, replacing any set an earlier pass left there
 * (only the languages actually produced — hreflang
 * never lies; a pair with no translation, cold or failed, ships the source
 * page unadvertised at its path rather than a mixed-language copy). No GitHub-branch cache, no separate
 * credentials: the cache is part of the repo, and the default claude provider
 * rides the local Claude Code install.
 *
 * The framework's OWN default pages are excluded from all of that — from the
 * PROVIDER, that is (#605). They still get their copies, from the translations
 * packaged with @omega.js/web (#621, ./packaged-defaults.js): the same chrome
 * on every brand is translated once, in the framework, and read back here for
 * free.
 *
 * dist/sitemap.xml is rewritten afterwards (./sitemap.js) so the produced
 * copies are listed with the same hreflang story the pages carry.
 */
const path = require('node:path');
const jetpack = require('fs-jetpack');
const cheerio = require('cheerio');
const {
  resolveProvider,
  resolveTranslationSettings,
  translateCached,
  ogLocale,
  isRTL,
  LANGUAGE_NAMES,
} = require('@omega.js/devkit/translate');
const { collectTextNodes } = require('./collect-text-nodes.js');
const { defaultExcludedRoutes } = require('./default-routes.js');
const { routeIncluded, includePatterns, readTranslateStamp } = require('./route-include.js');
const { packagedLanguages, loadPackaged, resolvePackaged, pageNamespace } = require('./packaged-defaults.js');
const { updateSitemap } = require('./sitemap.js');
const { readPathPrefixStamp, stripPathPrefix } = require('../path-prefix.js');
const { PATHS } = require('../paths.js');

// System folders never translated. The framework's default PAGES are derived
// from the defaults tree instead (./default-routes.js) — these are the folders
// whose contents the build generates or the brand fills, so no default page
// declares them.
const SYSTEM_EXCLUDED_FOLDERS = ['admin', 'test', 'team', 'updates', '__/auth'];

/**
 * A built file's route: 'about/index.html' → 'about', 'index.html' → ''.
 * @param {string} relPath - path relative to the output dir
 * @returns {string}
 */
function routeOf(relPath) {
  return relPath
    .replace(/\\/g, '/')
    .replace(/(^|\/)index\.html$/, '')
    .replace(/\.html$/, '')
    .replace(/\/+$/, '');
}

/**
 * The routes the FRAMEWORK never sends to a provider, whatever a brand says:
 * its own default pages (derived from the defaults tree, #605, each guarding
 * its subtree, since nothing under /app or /payment is marketing copy), the
 * socials redirects, the system folders, and every KNOWN language code as a
 * folder (not just the configured ones) so copies from a previous run are
 * never re-collected as source pages.
 * @param {object} config - resolved config (socials)
 * @returns {Function} (route: string) → boolean
 */
function buildFrameworkExclusionTest(config) {
  const frameworkRoutes = [...defaultExcludedRoutes()];
  const files = new Set([...frameworkRoutes, ...Object.keys(config.socials || {})]);
  const folders = [...SYSTEM_EXCLUDED_FOLDERS, ...frameworkRoutes, ...Object.keys(LANGUAGE_NAMES)];

  return (route) => {
    if (files.has(route)) {
      return true;
    }

    return folders.some((folder) => route === folder || route.startsWith(`${folder}/`));
  };
}

/**
 * Is this route one of the BRAND's own translated pages? The
 * `translation.include` globs decide (#858), unless the page stamped its own
 * answer on `<html>`, which wins. Framework routes are not this test's
 * business: buildExclusionTest asks that first.
 * @param {object} config - resolved config (translation.include)
 * @param {Map<string, boolean>} stamps - route → the page's own answer
 * @returns {Function} (route: string) → boolean
 */
function buildIncludeTest(config, stamps) {
  const patterns = includePatterns(config);

  return (route) => (stamps.has(route) ? stamps.get(route) : routeIncluded(route, patterns));
}

/**
 * Build the route-exclusion test from config + the framework's own sets.
 * `translation.include` is for BRAND pages only (#605): the framework's
 * default pages exclude themselves, and no list or page stamp puts one back.
 * Excluded here means excluded from PROVIDER calls: those default pages still
 * get copies, from the translations packaged with @omega.js/web (#621, the
 * default-page pass below).
 * @param {object} config - resolved config (translation.include, socials)
 * @param {Map<string, boolean>} stamps - route → the page's own answer
 * @returns {Function} (route: string) → boolean
 */
function buildExclusionTest(config, stamps = new Map()) {
  const frameworkExcluded = buildFrameworkExclusionTest(config);
  const included = buildIncludeTest(config, stamps);

  return (route) => frameworkExcluded(route) || !included(route);
}

/**
 * Every page that stamped its own `translation.include` on `<html>`, by route
 * (#858). The pass runs post-build over dist/ and `omega translate` runs with
 * no build at all, so the built page IS where a page's frontmatter answer is
 * readable, the same seam #355's base path uses. One read of the site's own
 * HTML, before any provider call.
 * @param {string} outDir - the build output dir
 * @param {string[]} files - built pages, relative to outDir
 * @returns {Map<string, boolean>} route → the page's own answer
 */
function readPageStamps(outDir, files) {
  const stamps = new Map();

  for (const relPath of files) {
    const stamp = readTranslateStamp(jetpack.read(path.join(outDir, relPath)));
    if (stamp !== null) stamps.set(routeOf(relPath), stamp);
  }

  return stamps;
}

/**
 * Rewrite same-site links on a translated page to their /{lang}/ versions.
 * On a MOUNTED site (#355) the hrefs already carry the base path: the route
 * is read underneath it, and the language segment goes back on AFTER it.
 * @param {object} $ - cheerio root
 * @param {string} lang - target language
 * @param {string} baseUrl - site origin
 * @param {Function} isExcluded - route exclusion test
 * @param {string} pathPrefix - the base path the site is served under ('' at the domain root)
 */
function rewriteLinks($, lang, baseUrl, isExcluded, pathPrefix) {
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');

    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      return;
    }

    try {
      const url = new URL(href, baseUrl);

      if (url.origin !== new URL(baseUrl).origin) {
        return;
      }

      const sitePath = stripPathPrefix(url.pathname, pathPrefix);
      const route = sitePath.replace(/^\/+|\/+$/g, '');
      if (isExcluded(route)) {
        return;
      }

      url.pathname = `${pathPrefix}/${lang}${sitePath}`;

      // Preserve relative-style hrefs as root-relative paths
      $(el).attr('href', href.startsWith('http') ? url.toString() : `${url.pathname}${url.search}${url.hash}`);
    } catch (e) {
      // Unparseable href — leave it alone
    }
  });
}

/**
 * Remove every language-chrome tag a translate pass stitches: each hreflang
 * alternate but the two head.html emits (x-default and the source language),
 * and every og:locale:alternate. A rerun over the same dist/ starts clean.
 * @param {object} $ - cheerio root
 * @param {string} defaultLang - source language code
 * @returns {boolean} whether anything was removed
 */
function stripAlternates($, defaultLang) {
  const stale = $('link[rel="alternate"][hreflang]')
    .filter((_, el) => !['x-default', defaultLang].includes($(el).attr('hreflang')))
    .add('meta[property="og:locale:alternate"]');

  // Each stitched tag went in behind its own newline: drop it too, so a
  // rerun is byte-equal to one pass
  stale.each((_, el) => {
    if (el.prev && el.prev.type === 'text' && !el.prev.data.trim()) {
      $(el.prev).remove();
    }
  });
  stale.remove();

  return stale.length > 0;
}

/**
 * Set the hreflang + og:locale:alternate tags for the given languages: it
 * replaces the set (stripAlternates first), so a rerun never accumulates
 * tags for languages this pass did not produce.
 * @param {object} $ - cheerio root
 * @param {string[]} languages - translated languages for THIS page
 * @param {string} defaultLang - source language code
 * @param {string} route - the page's route
 * @param {string} baseUrl - site origin (on a MOUNTED site brand.url carries
 *   the base path already — absolute URLs are never prefixed a second time)
 * @returns {boolean} whether anything was stripped or inserted
 */
function insertAlternates($, languages, defaultLang, route, baseUrl) {
  const urlFor = (lang) => `${baseUrl}/${lang}${route ? `/${route}` : ''}`;
  let changed = stripAlternates($, defaultLang);

  const anchor = $('head link[rel="alternate"][hreflang]').last();
  for (const lang of languages) {
    if ($(`head link[rel="alternate"][hreflang="${lang}"]`).length) {
      continue;
    }

    const tag = `<link rel="alternate" href="${urlFor(lang)}" hreflang="${lang}"/>`;
    if (anchor.length) {
      anchor.after(`\n${tag}`);
    } else {
      $('head').append(`\n${tag}`);
    }
    changed = true;
  }

  // A page with no produced language advertises no other locale either
  const ogLocaleTag = $('head meta[property="og:locale"]');
  if (ogLocaleTag.length && languages.length) {
    const currentLocale = ogLocaleTag.attr('content');
    for (const lang of [defaultLang, ...languages]) {
      const locale = ogLocale(lang);
      if (locale === currentLocale || $(`head meta[property="og:locale:alternate"][content="${locale}"]`).length) {
        continue;
      }

      ogLocaleTag.after(`\n<meta property="og:locale:alternate" content="${locale}"/>`);
      changed = true;
    }
  }

  return changed;
}

/**
 * Build one translated copy on a fresh DOM: apply the translations
 * positionally over the collector's walk, then localize the document chrome
 * and rewrite the internal links.
 * @param {object} options
 * @param {string} options.sourceHtml - the built source page
 * @param {Array<string|undefined>} options.translated - translations aligned with
 *   collectTextNodes order; undefined leaves that node in the source language
 * @param {string} options.lang - target language
 * @param {string} options.defaultLang - source language code
 * @param {string} options.route - the page's route
 * @param {string} options.baseUrl - site origin (carries the base path when mounted)
 * @param {Function} options.isExcluded - route exclusion test
 * @param {string} options.pathPrefix - the base path the site is served under
 * @param {string} [options.textLang] - the language the copy's TEXT is in
 *   (default: lang); an untranslated copy passes the source language, so its
 *   <html lang|dir> and og:locale name the text a reader actually gets (#953)
 * @returns {object} cheerio root, ready for alternates + write
 */
function renderCopy(options) {
  const { sourceHtml, translated, lang, defaultLang, route, baseUrl, isExcluded, pathPrefix } = options;
  const textLang = options.textLang || lang;
  const $ = cheerio.load(sourceHtml);

  // An original an earlier pass stitched carries its alternates; a copy
  // starts from only the build's own
  stripAlternates($, defaultLang);

  collectTextNodes($).forEach((n, i) => {
    const value = translated[i];
    if (value === undefined) {
      return;
    }

    if (n.type === 'data') {
      n.reference.data = value;
    } else if (n.type === 'text') {
      n.node.text(value);
    } else if (n.type === 'attr') {
      n.node.attr(n.attr, value);
    }
  });

  // Localize the document chrome
  const pageUrl = `${baseUrl}/${lang}${route ? `/${route}` : ''}`;
  $('html').attr('lang', textLang);
  $('html').attr('dir', isRTL(textLang) ? 'rtl' : 'ltr');
  $('meta[property="og:locale"]').attr('content', ogLocale(textLang));

  // An untranslated copy duplicates the source page, so its canonical and
  // og:url stay the source's (as the page wrote them); only a translated
  // copy is its own canonical page
  if (textLang === lang) {
    $('link[rel="canonical"]').attr('href', pageUrl);
    $('meta[property="og:url"]').attr('content', pageUrl);
  }

  rewriteLinks($, lang, baseUrl, isExcluded, pathPrefix);

  return $;
}

/**
 * Where a language copy lands.
 *
 * Canonical URLs are extensionless (about.html ↔ /about), so the language HOME
 * must land as <lang>.html for /es to resolve as a FILE. An es/index.html
 * forces GitHub Pages' directory redirect (/es → /es/), which fights the zone's
 * strip-trailing-slash rule into a 301 loop (live find, launch night
 * 2026-07-19).
 * @param {string} relPath - the source page's path relative to the output dir
 * @param {string} lang - target language
 * @returns {string} path relative to the output dir
 */
function copyTargetRel(relPath, lang) {
  return relPath === 'index.html' ? `${lang}.html` : path.join(lang, relPath);
}

/**
 * Produce /{lang}/ copies of the framework's OWN default pages from the
 * translations PACKAGED with @omega.js/web (#621).
 *
 * These routes stay excluded from provider calls — the auth, account, payment
 * and portal chrome never costs a brand a token — but the copy the framework
 * wrote is copy the framework already translated, so the copies ship anyway,
 * offline, from the committed package cache. A string the package does not
 * carry (copy the consumer overrode, a page the framework has not regenerated
 * for) stays in the source language and is COUNTED, never guessed at; a route
 * the package carries nothing for at all (the legal boilerplate, by design)
 * gets no copy, so hreflang keeps telling the truth.
 * @param {object} options
 * @param {string} options.outDir - built site dir
 * @param {string[]} options.files - default-route pages, relative to outDir
 * @param {object} options.settings - resolved translation settings
 * @param {string} options.brand - the consuming brand's name (sentinel swap)
 * @param {string} options.baseUrl - site origin
 * @param {Function} options.isExcluded - route exclusion test
 * @param {string} options.pathPrefix - the base path the site is served under
 * @param {string} options.packagedRoot - the packaged translations root
 * @param {object} options.logger - devkit logger
 * @returns {{ produced: Map<string, string[]>, pages: number, strings: number, misses: number }}
 */
function translateDefaultPages(options) {
  const { outDir, files, settings, brand, baseUrl, isExcluded, pathPrefix, packagedRoot, logger } = options;
  const produced = new Map();
  const outcome = { produced, pages: 0, strings: 0, misses: 0 };

  if (!brand) {
    logger.warn('Default pages: brand.name is not set, so the packaged translations cannot be brand-swapped — default pages stay untranslated');
    return outcome;
  }

  // What the package actually ships is the FOLDERS it ships, never a list.
  const shipped = packagedLanguages(packagedRoot);
  const missing = settings.languages.filter((lang) => !shipped.includes(lang));
  const languages = settings.languages.filter((lang) => shipped.includes(lang));

  if (missing.length) {
    logger.log(`Default pages: @omega.js/web ships no translations for ${missing.join(', ')} — those copies stay in ${settings.default}`);
  }

  if (!languages.length) {
    return outcome;
  }

  for (const relPath of files) {
    const route = routeOf(relPath);
    const sourceHtml = jetpack.read(path.join(outDir, relPath));
    const strings = collectTextNodes(cheerio.load(sourceHtml)).map((n) => n.text);
    const producedLangs = [];
    const copies = [];

    for (const lang of languages) {
      const { translated, hits, misses } = resolvePackaged({
        strings,
        brand,
        cache: loadPackaged(packagedRoot, lang, route),
      });

      if (!hits) {
        logger.log(`⊘ [${lang}] /${route} — no packaged translations for this default page`);
        continue;
      }

      logger.log(`✓ [${lang}] /${route} — ${hits} packaged string(s)${misses ? `, ${misses} not packaged (left in ${settings.default})` : ''}`);
      outcome.strings += hits;
      outcome.misses += misses;

      copies.push({
        targetRel: copyTargetRel(relPath, lang),
        $: renderCopy({ sourceHtml, translated, lang, defaultLang: settings.default, route, baseUrl, isExcluded, pathPrefix }),
      });
      producedLangs.push(lang);
    }

    for (const { targetRel, $ } of copies) {
      insertAlternates($, producedLangs, settings.default, route, baseUrl);
      jetpack.write(path.join(outDir, targetRel), $.html());
    }

    if (producedLangs.length) {
      produced.set(relPath, producedLangs);
      outcome.pages++;
    }
  }

  return outcome;
}

/**
 * Translate the built site into every configured language.
 * @param {object} options
 * @param {string} options.root - consumer project root (translations/ cache home)
 * @param {string} options.outDir - built site dir (dist)
 * @param {object} options.config - resolved config (translation, brand, socials, url)
 * @param {object} [options.logger] - devkit logger (silent when omitted)
 * @param {Function} [options.send] - provider send override (tests)
 * @param {string} [options.only] - translate only the page whose route/relPath matches
 * @param {boolean} [options.cachedOnly] - never call the provider: a page
 *   with any cold (uncached) string ships its copy UNTRANSLATED, unadvertised
 *   (listed in stats.skippedCold), instead of a mixed-language one; `omega build`
 *   runs this way, explicit `omega translate` owns live-LLM translation (friction #24)
 * @param {string} [options.packagedRoot] - the default-page translations
 *   packaged with @omega.js/web (#621); default: the ones in this install
 * @returns {Promise<object>} stats: { skipped?, pages, languages, newStrings,
 *   cachedStrings, failures (page-language pairs shipped untranslated), usage,
 *   skippedCold, defaultPages, packagedStrings, packagedMisses }
 */
async function translateSite(options) {
  const { root, outDir, config } = options;
  const logger = options.logger || { log: () => {}, warn: () => {}, error: () => {} };

  const settings = resolveTranslationSettings(config);
  if (!settings.enabled) {
    return { skipped: true };
  }

  const provider = options.send
    ? { name: 'custom', model: '', send: options.send }
    : resolveProvider({ provider: settings.provider, model: settings.model });

  const baseUrl = (config.url || config.brand?.url || 'http://localhost').replace(/\/+$/, '');
  const brand = config.brand?.name;
  const cacheRoot = path.join(root, 'translations');

  // Collect translatable pages
  const allHtml = jetpack.find(outDir, { matching: '**/*.html' })
    .map((file) => path.relative(outDir, file));

  // The per-page overrides (#858), read off the BRAND's own pages: a framework
  // default page is never in anyone's hands, so its HTML is not read for one.
  const frameworkExcluded = buildFrameworkExclusionTest(config);
  const stamps = readPageStamps(outDir, allHtml.filter((relPath) => !frameworkExcluded(routeOf(relPath))));
  const isExcluded = buildExclusionTest(config, stamps);

  const onlyFilter = (relPath) => relPath === options.only || routeOf(relPath) === options.only.replace(/^\/+|\/+$/g, '');
  const allFiles = allHtml.filter((relPath) => !isExcluded(routeOf(relPath)));
  const files = options.only ? allFiles.filter(onlyFilter) : allFiles;

  // The framework's OWN default pages (#621): excluded above from provider
  // calls, collected here for the packaged-cache pass. A system folder, a
  // language folder from a previous run and a route collision are out; the
  // BRAND's include list is not consulted at all, because the framework's
  // default pages are the framework's and its list scopes its own pages (the
  // #858 ruling). The chrome is translated once, on the framework side.
  const guardedFolders = [...SYSTEM_EXCLUDED_FOLDERS, ...Object.keys(LANGUAGE_NAMES)];
  const defaultRoutes = defaultExcludedRoutes();
  const allDefaultFiles = allHtml.filter((relPath) => {
    const route = routeOf(relPath);

    return defaultRoutes.has(route)
      && !guardedFolders.some((folder) => route === folder || route.startsWith(`${folder}/`));
  });
  const defaultFiles = options.only ? allDefaultFiles.filter(onlyFilter) : allDefaultFiles;

  // Base path (#355): the build stamped the mount point on every page it
  // emitted, so the pass reads it off the site itself — no caller plumbing,
  // and `omega translate` run on its own gets it too. dist IS the mount root,
  // so only the URLs carry it; the copies' file paths never do (#359).
  const prefixSource = files[0] || defaultFiles[0];
  const pathPrefix = prefixSource ? readPathPrefixStamp(jetpack.read(path.join(outDir, prefixSource))) : '';

  logger.log(`Translating ${files.length} pages into ${settings.languages.length} language(s): ${settings.languages.join(', ')} (provider: ${provider.name}${provider.model ? `/${provider.model}` : ''})`);

  const stats = { pages: 0, languages: settings.languages, newStrings: 0, cachedStrings: 0, failures: [], usage: { input: 0, output: 0 }, skippedCold: [], defaultPages: 0, packagedStrings: 0, packagedMisses: 0 };
  const translatedRoutes = new Map(); // relPath → langs successfully produced
  const total = files.length * settings.languages.length;
  let done = 0;

  for (const relPath of files) {
    const route = routeOf(relPath);
    const sourceHtml = jetpack.read(path.join(outDir, relPath));
    const namespace = pageNamespace(route);

    // Source strings (collected once per page from a throwaway DOM)
    const strings = collectTextNodes(cheerio.load(sourceHtml)).map((n) => n.text);
    const producedLangs = [];
    const copies = [];

    // A pair with no translation still lands the SOURCE page at its path
    // (#953): every produced copy of another page links there, so a missing
    // file is a dead link. It is untranslated, so it is never advertised: it
    // joins neither producedLangs (hreflang) nor translatedRoutes (sitemap).
    // `translated: []` leaves every node untouched (the collector normalizes
    // whitespace, so writing `strings` back would reflow the source)
    const writeUntranslated = (lang) => {
      const $ = renderCopy({ sourceHtml, translated: [], lang, defaultLang: settings.default, textLang: settings.default, route, baseUrl, isExcluded, pathPrefix });
      jetpack.write(path.join(outDir, copyTargetRel(relPath, lang)), $.html());
    };

    for (const lang of settings.languages) {
      done++;
      const logTag = `[${done}/${total}] [${lang}] /${route}`;

      // Keyed by position, so the answer lines up with the collector's walk
      let outcome;
      try {
        outcome = await translateCached({
          strings: { ...strings },
          language: lang,
          namespace,
          settings,
          cachedOnly: options.cachedOnly,
          rootDir: cacheRoot,
          send: provider.send,
          brand,
        });
      } catch (e) {
        // Ship the pair untranslated, exactly like a cold cache under
        // cachedOnly: a half-translated copy would ship silently behind full
        // language chrome, and no copy at all is a dead link
        stats.failures.push(`${lang} /${route}: ${e.message}`);
        logger.warn(`✗ ${logTag}: ${e.message}; ${lang} copy shipped untranslated`);
        writeUntranslated(lang);
        continue;
      }

      const { translated, cold, fresh, usage } = outcome;
      stats.cachedStrings += strings.length - cold.length - fresh.length;

      // Cold strings under cachedOnly: no translated copy for this pair, since
      // a partially translated page is worse than an untranslated one
      if (cold.length) {
        stats.skippedCold.push(`${lang} /${route}`);
        logger.log(`⊘ ${logTag}: ${cold.length} cold string(s), shipped untranslated`);
        writeUntranslated(lang);
        continue;
      }

      if (fresh.length) {
        stats.newStrings += fresh.length;
        stats.usage.input += usage.input;
        stats.usage.output += usage.output;
        logger.log(`✓ ${logTag}: ${fresh.length} new + ${strings.length - fresh.length} cached`);
      } else {
        logger.log(`✓ ${logTag}: all ${strings.length} strings cached`);
      }

      copies.push({
        targetRel: copyTargetRel(relPath, lang),
        $: renderCopy({ sourceHtml, translated, lang, defaultLang: settings.default, route, baseUrl, isExcluded, pathPrefix }),
      });
      producedLangs.push(lang);
    }

    // Copies land after the page's whole language pass so their alternates
    // name only the languages actually produced: an untranslated pair (cold
    // cache or provider failure) is never advertised (hreflang never lies)
    for (const { targetRel, $ } of copies) {
      insertAlternates($, producedLangs, settings.default, route, baseUrl);
      jetpack.write(path.join(outDir, targetRel), $.html());
    }

    if (producedLangs.length) {
      translatedRoutes.set(relPath, producedLangs);
      stats.pages++;
    }
  }

  // The framework's own default pages, from the cache packaged with
  // @omega.js/web (#621) — zero provider calls, so this runs on every pass,
  // cachedOnly included. Their copies join translatedRoutes, which is what
  // gives them hreflang alternates and sitemap entries like any other page.
  const defaults = translateDefaultPages({
    outDir,
    files: defaultFiles,
    settings,
    brand,
    baseUrl,
    isExcluded,
    pathPrefix,
    packagedRoot: options.packagedRoot || PATHS.translations,
    logger,
  });

  stats.defaultPages = defaults.pages;
  stats.packagedStrings = defaults.strings;
  stats.packagedMisses = defaults.misses;
  defaults.produced.forEach((langs, relPath) => translatedRoutes.set(relPath, langs));

  if (defaults.pages) {
    logger.log(`Default pages: ${defaults.pages} translated from the packaged cache (${defaults.strings} strings${defaults.misses ? `, ${defaults.misses} not packaged` : ''})`);
  }

  // Stitch alternates into the ORIGINALS of every page this pass covered: one
  // that produced nothing keeps only the build's own tags, so an earlier
  // pass's alternates never name a copy that is now untranslated
  for (const relPath of [...files, ...defaultFiles]) {
    const file = path.join(outDir, relPath);
    const $ = cheerio.load(jetpack.read(file));
    const langs = translatedRoutes.get(relPath) || [];

    if (insertAlternates($, langs, settings.default, routeOf(relPath), baseUrl)) {
      jetpack.write(file, $.html());
    }
  }

  // The sitemap tells the same story: the produced copies join it with their
  // hreflang alternates, and a skipped pair is listed nowhere
  const sitemapUrls = updateSitemap({
    outDir,
    baseUrl,
    defaultLang: settings.default,
    produced: new Map([...translatedRoutes].map(([relPath, langs]) => [routeOf(relPath), langs])),
    logger,
  });

  if (sitemapUrls !== null) {
    stats.sitemapUrls = sitemapUrls;
    logger.log(`Sitemap: ${sitemapUrls} translated URL(s) with hreflang alternates`);
  }

  return stats;
}

/**
 * The one cold warning a cache-only pass prints, for `omega build` and
 * `omega translate` alike: the page-language pairs shipped untranslated.
 * @param {object} stats - translateSite's answer
 * @param {object} logger - devkit logger
 */
function warnSkippedCold(stats, logger) {
  if (!stats.skippedCold.length) return;

  const preview = stats.skippedCold.slice(0, 10).join(', ');
  const more = stats.skippedCold.length > 10 ? ` (+${stats.skippedCold.length - 10} more)` : '';
  logger.warn(`translation: ${stats.skippedCold.length} page-language pair(s) shipped untranslated (cold cache): ${preview}${more}`);
  logger.warn('translation: run `omega translate` on your own machine (or a local build without --cached-only) and commit translations/ to fill them');
}

module.exports = { translateSite, warnSkippedCold, routeOf, collectTextNodes, SYSTEM_EXCLUDED_FOLDERS };
