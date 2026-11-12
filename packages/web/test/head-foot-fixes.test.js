/**
 * Wave-3 head/foot fixes — built-page pins for the shared Liquid:
 *   W8  — og:locale + the language hreflang carry the translation default
 *         (the interpolated variable was never assigned; every page shipped
 *         content="" and an invalid hreflang="").
 *   W11 — config strings interpolated into ld+json are JSON-escaped: a brand
 *         description carrying a double quote still yields parseable schema.
 *   W13 — the Giscus embed is gated on comments.giscus.repo: unconfigured
 *         brands (every scaffold) never inject the client script with an
 *         empty data-repo.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');

const { buildWith: sharedBuildWith, miniData } = require('./lib/build.js');

const buildWith = (siteData, overrides) => sharedBuildWith(siteData, overrides, 'head-foot-test');

module.exports = defineCases({
  type: 'group',
  description: 'head-foot-fixes',
  tests: [
    {
      name: 'W8 + W11: og:locale/hreflang carry the default language; quoted brand strings keep JSON-LD parseable',
      run: async (ctx) => {
        const pages = await buildWith({
          ...miniData,
          brand: { ...miniData.brand, description: 'Mini "quoted" \\ brand' },
        });
        const html = pages.get('/blog');

        ctx.expect(html.includes('property="og:locale" content="en_US"'), 'og:locale carries the Open Graph language_TERRITORY form of the default language').toBeTruthy();
        ctx.expect(!html.includes('property="og:locale" content=""'), 'og:locale never empty').toBeTruthy();
        ctx.expect(!html.includes('hreflang=""'), 'no invalid empty hreflang annotation').toBeTruthy();

        const match = html.match(/<script id="omega-schema-brand"[^>]*>([\s\S]*?)<\/script>/);
        ctx.expect(match, 'brand schema block present').toBeTruthy();
        const schema = JSON.parse(match[1]);
        ctx.expect(schema.description, 'quote and backslash survive escaping intact').toBe('Mini "quoted" \\ brand');
      },
    },

    {
      name: 'W16 (Ian 2026-07-23): synthesized aggregateRating count is seeded into 10k-30k',
      run: async (ctx) => {
        // `schema` is page MACHINERY, not config (#607): the /download blueprint is
        // the framework surface that switches SoftwareApplication on.
        const pages = await buildWith(miniData, {}, 'head-foot-schema');
        const html = pages.get('/download');

        const match = html.match(/<script id="omega-schema-software-application"[^>]*>([\s\S]*?)<\/script>/);
        ctx.expect(match, 'SoftwareApplication schema block present when enabled').toBeTruthy();
        const schema = JSON.parse(match[1]);
        const count = Number(schema.aggregateRating.ratingCount);
        ctx.expect(count >= 10000 && count < 30000, `ratingCount ${count} inside the seeded 10k-30k band`).toBeTruthy();
        ctx.expect(['4.8', '4.9'].includes(schema.aggregateRating.ratingValue), 'rating value stays 4.8/4.9').toBeTruthy();
      },
    },

    {
      name: '#606: an unconfigured provider gets NO inline stub — the transport guards every call',
      run: async (ctx) => {
        // foot.html used to define empty `gtag`/`fbq`/`ttq` when a provider had no
        // id, so #306's guarded wrappers would read a stub as "present". The
        // transport (@omega.js/analytics/transports/browser) checks `typeof` per
        // provider and silently no-ops on a missing global, so the stubs were dead
        // weight that only made a blocked pixel look loaded.
        const pages = await buildWith(miniData, {}, 'head-foot-no-stubs');
        const html = pages.get('/');

        ctx.expect(!/function\s+gtag\s*\(/.test(html), 'no gtag stub').toBeTruthy();
        ctx.expect(!/function\s+fbq\s*\(/.test(html), 'no fbq stub').toBeTruthy();
        ctx.expect(!/window\.ttq\s*=/.test(html), 'no ttq stub').toBeTruthy();
      },
    },

    {
      name: 'W13: unconfigured comments never inject the Giscus client script',
      run: async (ctx) => {
        const pages = await buildWith(miniData);
        const postUrl = [...pages.keys()].find((url) => /^\/blog\/.+/.test(url) && !url.includes('categories'));
        ctx.expect(postUrl, 'fixture has a blog post page').toBeTruthy();
        ctx.expect(!pages.get(postUrl).includes('giscus.app/client.js'), 'no giscus injection without comments.giscus.repo').toBeTruthy();
      },
    },

    // #251 — the chatsy preconnect gated on `resolved.client.chatsy.enabled`, a key
    // nothing writes: the SSOT is `resolved.inbound.chat.providers.chatsy.enabled`
    // (the head's OMEGA_BUILD_JSON snapshot and @omega.js/client's loader both read it),
    // so the hint never fired for any chatsy-enabled brand.
    {
      name: '#251: the chatsy preconnect follows the inbound.chat SSOT',
      run: async (ctx) => {
        const chatsy = (enabled) => ({
          ...miniData,
          inbound: { chat: { providers: { chatsy: { enabled, agentId: 'agent-1' } } } },
        });

        const on = await buildWith(chatsy(true), {}, 'head-foot-chatsy-on');
        const html = on.get('/blog');
        ctx.expect(html.includes('<link rel="preconnect" href="https://chatsy.ai" crossorigin/>'), 'a chatsy-enabled brand gets the preconnect').toBeTruthy();
        ctx.expect(html.includes('<link rel="dns-prefetch" href="https://chatsy.ai"/>'), 'and the dns-prefetch beside it').toBeTruthy();

        const off = await buildWith(chatsy(false), {}, 'head-foot-chatsy-off');
        ctx.expect(!off.get('/blog').includes('chatsy.ai'), 'a disabled brand emits neither hint').toBeTruthy();
      },
    },

    // Two retired web sections had readers in this shared Liquid: `favicon.path`
    // overrode the favicon set's folder, `favicon.theme-color` fed the chrome meta.
    // The shipped set is the ONE favicon source, and the chrome paints
    // `brand.color`, the one place a brand states its hex.
    {
      name: '#850: theme-color paints brand.color, and no favicon path override survives',
      run: async (ctx) => {
        const branded = {
          ...miniData,
          brand: { ...miniData.brand, color: '#3366ff' },
          // The retired shapes, authored: neither may reach the page.
          favicon: { path: 'https://cdn.retired.test/favicon', 'theme-color': '#ff0000' },
        };

        const html = (await buildWith(branded, {}, 'head-foot-theme-color')).get('/');

        ctx.expect(html.includes('<meta name="theme-color" content="#3366ff"/>'), 'the chrome color is the brand color').toBeTruthy();
        ctx.expect(!html.includes('#ff0000'), 'the retired favicon.theme-color reaches nothing').toBeTruthy();
        ctx.expect(!html.includes('cdn.retired.test'), 'and the retired favicon.path overrides no favicon link').toBeTruthy();
      },
    },

    {
      name: '#850: a brand with no color emits no theme-color meta at all',
      run: async (ctx) => {
        // An empty `content=""` paints nothing and is invalid metadata: the meta is
        // gated on the ramp the brand color produced (mini declares no color).
        const html = (await buildWith(miniData, {}, 'head-foot-theme-color-none')).get('/');

        ctx.expect(!/name="theme-color"/.test(html), 'no brand color, no meta').toBeTruthy();
      },
    },

    {
      name: 'the pricing page carries the Product schema with its lowest plan as the Offer; the home page carries none',
      run: async (ctx) => {
        const pages = await buildWith({
          ...miniData,
          payment: {
            currency: 'EUR',
            products: [
              { id: 'starter', name: 'Starter', type: 'subscription', prices: { monthly: 12 } },
              { id: 'team', name: 'Team', type: 'subscription', prices: { monthly: 29 } },
            ],
          },
        }, { activeTheme: 'classy' }, 'head-foot-product');
        const productBlock = (html) => html.match(/<script id="omega-schema-product"[^>]*>([\s\S]*?)<\/script>/);

        const match = productBlock(pages.get('/pricing'));
        ctx.expect(match, 'the pricing page emits the Product block').toBeTruthy();
        const product = JSON.parse(match[1]);
        ctx.expect(product['@type']).toBe('Product');
        ctx.expect(Number(product.offers.price), 'the Offer is the lowest plan price the page shows').toBe(12);
        ctx.expect(product.offers.priceCurrency, 'in the catalog\'s own currency').toBe('EUR');

        ctx.expect(productBlock(pages.get('/')), 'the home page sells nothing').toBe(null);
      },
    },

    // #271 — every built page shipped one JSON-LD block with `"@type": ""`: the
    // brand block's type is `site.brand.type`, a key OMEGA's config never declares
    // and the port left without the framework default UJM supplied. Empty-type
    // JSON-LD is invalid structured data, and the empty value also flowed into
    // every `#<type>` @id anchor the other blocks cross-reference.
    {
      name: '#271: no built page carries an empty-@type JSON-LD block; the brand block stays valid',
      run: async (ctx) => {
        const pages = await buildWith(miniData, {}, 'head-foot-schema-type');

        for (const [url, html] of pages) {
          if (!html.includes('application/ld+json')) continue;
          for (const block of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
            ctx.expect(!/"@type":\s*""/.test(block[1]), `${url}: no JSON-LD block with an empty @type`).toBeTruthy();
          }
        }

        const html = pages.get('/blog');
        const brand = JSON.parse(html.match(/<script id="omega-schema-brand"[^>]*>([\s\S]*?)<\/script>/)[1]);
        ctx.expect(brand['@type'], 'a brand with no configured type falls back to Organization').toBe('Organization');
        ctx.expect(brand['@id'], 'the @id anchor carries the same type').toBe(`${miniData.url}#Organization`);

        const website = JSON.parse(html.match(/<script id="omega-schema-website"[^>]*>([\s\S]*?)<\/script>/)[1]);
        ctx.expect(website.publisher['@id'], 'the WebSite block still points at the brand node').toBe(brand['@id']);
      },
    },

    // #613: `site.time` was READ by both modified-date surfaces and set by
    // nothing, so `article:modified_time` and the JSON-LD `dateModified` shipped
    // empty on every page — a search engine reading either got a blank value.
    {
      name: '#613: site.time is a build fact — both dateModified surfaces render a real xmlschema date',
      run: async (ctx) => {
        const pages = await buildWith(miniData, {}, 'head-foot-time');
        // Both readers sit inside the POST gate — a post is the page that has a
        // modified date to declare.
        const html = pages.get('/blog/first-post');

        const XMLSCHEMA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/;

        const modified = html.match(/<meta property="article:modified_time" content="([^"]*)"/);
        ctx.expect(modified, 'the head still emits article:modified_time').toBeTruthy();
        ctx.expect(modified[1], 'article:modified_time carries the build stamp, not an empty string').toMatch(XMLSCHEMA);

        const posting = JSON.parse(html.match(/<script id="omega-schema-blog"[^>]*>([\s\S]*?)<\/script>/)[1]);
        ctx.expect(String(posting.dateModified), 'the JSON-LD dateModified carries it too').toMatch(XMLSCHEMA);
        ctx.expect(posting.dateModified, 'ONE stamp per build — the two surfaces can never disagree').toBe(modified[1]);

        // …and it is the same instant the rest of the build stamp names.
        ctx.expect(Math.abs(Date.parse(modified[1]) - Date.now()) < 10 * 60 * 1000, 'the stamp is this build, not a fixed date baked into a template').toBeTruthy();
      },
    },
  ],
});
