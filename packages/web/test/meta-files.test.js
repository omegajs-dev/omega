/**
 * cp139 — the site meta-files (UJM parity, gap-audit closure): sitemap.xml,
 * RSS + JSON feeds (the /feeds/posts.xml link every page's head carries
 * stops dangling), robots.txt, ads.txt, humans.txt, opensearch.xml,
 * pages.json, .well-known/security.txt — all default pages (consumer files
 * at the same URL suppress them like any other default page).
 *
 * Correctness upgrades over legacy pinned here: JSON outputs are VALID BY
 * CONSTRUCTION (omega_json_escape + first-flag commas — legacy's trailing-comma
 * bug when the last item was skipped is impossible), and the machine files
 * exclude each other (legacy pages.json listed robots.txt as a search hit).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const defineCases = require('@omega.js/devkit/test/define-cases');
const { buildSite, buildWith, miniData, BARE, MINI, PKG } = require('./lib/build.js');

const bareData = JSON.parse(fs.readFileSync(path.join(BARE, 'site-data.json'), 'utf8'));

// The link lines under one `## <heading>` of llms.txt, or null when the heading is absent.
const llmsSection = (llms, heading) => {
  const section = llms.split(/^## /m).find((part) => part.split('\n')[0].trim() === heading);
  return section === undefined ? null : section.split('\n').slice(1).filter((line) => line.startsWith('- '));
};

let pages;

module.exports = defineCases({
  type: 'group',
  description: 'meta-files',
  setup: async () => {
    pages = await buildWith({
      ...miniData,
      advertising: { providers: { adsense: { client: 'ca-pub-1234567890' } } },
      // The string form is a HANDLE: omega_social derives the profile URL from it.
      socials: { twitter: 'minico' },
    }, {}, 'meta-files');
  },
  tests: [
    {
      name: 'sitemap.xml: real pages in, machine/redirect/test pages out',
      run: (ctx) => {
        const xml = pages.get('/sitemap.xml');
        ctx.expect(xml.includes('<urlset'), 'sitemap renders').toBeTruthy();

        // Real pages with absolute locs; the root page collapses to the bare url
        ctx.expect(xml.includes('<loc>https://mini.example.com</loc>'), 'root page, no trailing slash').toBeTruthy();
        ctx.expect(xml.includes('<loc>https://mini.example.com/about</loc>'), 'consumer page listed').toBeTruthy();
        ctx.expect(xml.includes('<loc>https://mini.example.com/pricing</loc>'), 'default-page channel listed').toBeTruthy();
        ctx.expect(/<priority>1.0<\/priority>/.test(xml), 'root priority 1.0').toBeTruthy();
        ctx.expect(/<changefreq>weekly<\/changefreq>/.test(xml), 'default changefreq').toBeTruthy();
        ctx.expect(/<lastmod>\d{4}-\d{2}-\d{2}T/.test(xml), 'build-stamp lastmod').toBeTruthy();

        // Exclusions, ALL of them the one resolved meta.index flag (#564): redirect
        // stubs, test pages, admin, the meta files themselves
        ctx.expect(!xml.includes('/login'), 'auth redirects excluded').toBeTruthy();
        ctx.expect(!xml.includes('/test/'), 'test pages excluded').toBeTruthy();
        ctx.expect(!xml.includes('/admin/'), 'admin pages excluded').toBeTruthy();
        ctx.expect(!xml.includes('sitemap.xml</loc>') && !xml.includes('robots.txt'), 'machine files exclude themselves').toBeTruthy();
      },
    },

    {
      name: 'robots.txt: blocks admin/test, points at the sitemap',
      run: (ctx) => {
        const robots = pages.get('/robots.txt');
        ctx.expect(robots.includes('Disallow: /admin/')).toBeTruthy();
        ctx.expect(robots.includes('Disallow: /test/')).toBeTruthy();
        ctx.expect(robots.includes('Sitemap: https://mini.example.com/sitemap.xml')).toBeTruthy();
      },
    },

    {
      name: 'feeds/posts.xml: RSS with every fixture post, absolute guids, rendered content',
      run: (ctx) => {
        const rss = pages.get('/feeds/posts.xml');
        ctx.expect(rss.includes('<rss'), 'RSS envelope').toBeTruthy();
        ctx.expect(rss.includes('MiniCo Blog'), 'channel title from brand').toBeTruthy();

        const items = rss.match(/<item>/g) || [];
        ctx.expect(items.length, 'every fixture post in the feed (2 + the 15-post cp214 enrichment)').toBe(17);
        ctx.expect(rss.includes('First post') && rss.includes('Second post'), 'post titles').toBeTruthy();
        ctx.expect(/<guid isPermaLink="true">\s*https:\/\/mini\.example\.com\/blog\//.test(rss), 'absolute post guids').toBeTruthy();
        ctx.expect(rss.includes('Alpha bravo charlie'), 'rendered post content in content:encoded').toBeTruthy();
        ctx.expect(/<pubDate>\w{3}, \d{2} \w{3} \d{4}/.test(rss), 'RFC822-style pubDate').toBeTruthy();
        ctx.expect(rss.includes('<category><![CDATA[ Growth ]]></category>'), 'first category').toBeTruthy();
      },
    },

    {
      name: 'feeds/posts.json: VALID JSON Feed (legacy trailing-comma bug impossible)',
      run: (ctx) => {
        const feed = JSON.parse(pages.get('/feeds/posts.json'));
        ctx.expect(feed.version).toBe('https://jsonfeed.org/version/1');
        ctx.expect(feed.title).toBe('MiniCo Blog');
        ctx.expect(feed.items.length).toBe(17);

        const first = feed.items[0];
        ctx.expect(first.url.startsWith('https://mini.example.com/blog/')).toBeTruthy();
        ctx.expect(first.content_text.length > 0, 'text content present').toBeTruthy();
        ctx.expect(first.content_html.length > 0, 'html content present').toBeTruthy();
        ctx.expect(first.date_published).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        ctx.expect(Array.isArray(first.tags), 'tags from post categories').toBeTruthy();
      },
    },

    {
      name: 'pages.json: VALID search index — real pages with titles, machine files out',
      run: (ctx) => {
        const index = JSON.parse(pages.get('/pages.json'));
        ctx.expect(Array.isArray(index) && index.length > 0).toBeTruthy();

        const urls = index.map((entry) => entry.url);
        ctx.expect(urls.includes('https://mini.example.com/about'), 'consumer page indexed').toBeTruthy();
        ctx.expect(!urls.some((url) => url.includes('robots.txt') || url.includes('sitemap.xml')), 'machine files not search hits').toBeTruthy();
        ctx.expect(!urls.some((url) => url.includes('/test/') || url.includes('/admin/')), 'test/admin out of the index').toBeTruthy();

        const post = index.find((entry) => entry.type === 'post');
        ctx.expect(post, 'posts carry type post').toBeTruthy();
        ctx.expect(post.title.length > 0, 'post title populated').toBeTruthy();
      },
    },

    // #141 — the meta-file lane emitted LAYOUT-contributed meta values verbatim:
    // blueprint/updates/update's `meta.title: "Version {{ page.update.version }} …"`
    // reached pages.json and llms.txt as raw Liquid source. Layout frontmatter is
    // rendered per page in the `resolved` computed, so the meta files read the
    // rendered twin — no template output may carry Liquid delimiters.
    {
      name: 'pages.json + llms.txt: no unrendered Liquid survives the meta-file lane (#141)',
      run: (ctx) => {
        for (const file of ['/pages.json', '/llms.txt']) {
          const body = pages.get(file);
          ctx.expect(!body.includes('{{'), `${file} carries no unrendered Liquid output`).toBeTruthy();
          ctx.expect(!body.includes('{%'), `${file} carries no unrendered Liquid tags`).toBeTruthy();
        }

        // The wildcard /updates/* family is the reproducer: per-page refs and all.
        const update = JSON.parse(pages.get('/pages.json')).find((entry) => entry.url.endsWith('/updates/v1.0.0'));
        ctx.expect(update, 'the update page is indexed').toBeTruthy();
        ctx.expect(update.breadcrumb, 'per-page refs render against the item').toBe('v1.0.0');
        ctx.expect(update.desc.includes('The first public release'), 'the page description renders').toBeTruthy();
      },
    },

    // #564's posture is ONE decision for THREE machine files: sitemap.xml read
    // `resolved.meta.index`, llms.txt and pages.json did not — so a page the site
    // tells crawlers not to index was still handed to an LLM and to site search.
    {
      name: 'llms.txt + pages.json: a noindexed page is out of EVERY machine file, not just the sitemap',
      run: (ctx) => {
        const hub = 'https://mini.example.com/blog/tags';
        ctx.expect(pages.get('/blog/tags').includes('<meta name="robots" content="noindex'), 'the tag hub is noindex (thin taxonomy)').toBeTruthy();

        ctx.expect(!pages.get('/llms.txt').includes(`(${hub})`), 'the noindexed hub is absent from llms.txt').toBeTruthy();
        ctx.expect(!JSON.parse(pages.get('/pages.json')).some((entry) => entry.url === hub), 'and from pages.json').toBeTruthy();
      },
    },

    // The dev-surface exclusion is a path SEGMENT, not a bare prefix — the same
    // rule engine.js applies (DEV_ONLY_URL_RE). A bare `/test` prefix silently ate
    // every brand page whose URL merely starts with those five characters.
    {
      name: 'sitemap + llms.txt + pages.json: /testimonials ships, /test does not (segment, not prefix)',
      run: async (ctx) => {
        const consumerDir = path.join(PKG, '.omega', 'meta-files-segment-src');
        fs.rmSync(consumerDir, { recursive: true, force: true });
        fs.cpSync(BARE, consumerDir, { recursive: true });
        fs.writeFileSync(path.join(consumerDir, 'pages', 'testimonials.html'), [
          '---',
          'layout: frontend/core/base',
          'permalink: /testimonials',
          'meta:',
          '  title: "Testimonials"',
          '---',
          '<section><h2>What they say</h2></section>',
          '',
        ].join('\n'));

        try {
          const built = await buildSite(consumerDir, bareData, {}, 'meta-files-segment');
          ctx.expect(built.get('/testimonials'), 'the brand page builds').toBeTruthy();

          ctx.expect(built.get('/sitemap.xml').includes(`<loc>${bareData.url}/testimonials</loc>`), 'sitemap lists it').toBeTruthy();
          ctx.expect(built.get('/llms.txt').includes(`(${bareData.url}/testimonials)`), 'llms.txt lists it').toBeTruthy();
          ctx.expect(JSON.parse(built.get('/pages.json')).some((entry) => entry.url === `${bareData.url}/testimonials`), 'pages.json indexes it').toBeTruthy();

          // …and the dev surface it was mistaken for is still out of all three.
          ctx.expect(built.get('/test'), 'the framework dev index builds in a dev build').toBeTruthy();
          ctx.expect(!built.get('/sitemap.xml').includes(`<loc>${bareData.url}/test</loc>`), '/test itself stays out of the sitemap').toBeTruthy();
          ctx.expect(!built.get('/llms.txt').includes(`(${bareData.url}/test)`), 'and out of llms.txt').toBeTruthy();
          ctx.expect(!JSON.parse(built.get('/pages.json')).some((entry) => entry.url === `${bareData.url}/test`), 'and out of pages.json').toBeTruthy();
        } finally {
          fs.rmSync(consumerDir, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'ads.txt: renders the configured AdSense client with the ca- prefix stripped',
      run: (ctx) => {
        ctx.expect(pages.get('/ads.txt')).toMatch(/^google\.com, pub-1234567890, DIRECT, f08c47fec0942fa0$/m);
        // #556 — the record is the FIRST byte: the gate tag was left-stripped only,
        // so the newline after it opened every brand's file with a blank line.
        ctx.expect(pages.get('/ads.txt'), 'the file opens on the record, no leading blank line').toMatch(/^google\.com, /);
      },
    },

    {
      name: 'humans.txt + opensearch.xml + security.txt: brand-derived, no empties',
      run: (ctx) => {
        const humans = pages.get('/humans.txt');
        ctx.expect(humans.includes('Website: MiniCo')).toBeTruthy();
        ctx.expect(humans.includes('Twitter: minico'), 'socials render when configured').toBeTruthy();
        ctx.expect(humans.includes('OMEGA (@omega.js/web)'), 'honest framework credit').toBeTruthy();

        const opensearch = pages.get('/opensearch.xml');
        ctx.expect(opensearch.includes('<ShortName>MiniCo</ShortName>')).toBeTruthy();
        ctx.expect(opensearch.includes('https://mini.example.com/assets/images/favicon/favicon-32x32.png'), 'the favicon set\'s path').toBeTruthy();

        const security = pages.get('/.well-known/security.txt');
        ctx.expect(security.includes('Contact: https://mini.example.com/contact')).toBeTruthy();
        const expires = security.match(/Expires: (\d{4})-12-31/);
        ctx.expect(Number(expires[1]), 'expires one year out').toBe(new Date().getFullYear() + 1);
      },
    },

    // #4 — llms.txt (llmstxt.org): the machine-readable site brief an LLM reads
    // instead of crawling. Same channel as every other meta file: a default page,
    // generated from site metadata, suppressed by a consumer file at the same URL.
    {
      name: 'llms.txt: llmstxt.org shape — brand heading, summary, pages and posts as markdown links',
      run: (ctx) => {
        const llms = pages.get('/llms.txt');
        ctx.expect(llms, 'llms.txt emitted').toBeTruthy();

        ctx.expect(llms, 'H1 is the brand name').toMatch(/^# MiniCo$/m);
        ctx.expect(llms, 'blockquote summary from site meta').toMatch(/^> /m);
        ctx.expect(llms, 'pages section').toMatch(/^## Pages$/m);
        ctx.expect(llms, 'posts section (fixture site has a blog)').toMatch(/^## Posts$/m);

        // Real pages as absolute markdown links…
        ctx.expect(llms, 'consumer page listed').toMatch(/^- \[.+\]\(https:\/\/mini\.example\.com\/about\)/m);
        ctx.expect(llms, 'posts listed under Posts').toMatch(/^- \[.+\]\(https:\/\/mini\.example\.com\/blog\//m);

        // …and the same exclusions every other meta file honors.
        ctx.expect(!llms.includes('/test/'), 'test pages excluded').toBeTruthy();
        ctx.expect(!llms.includes('/admin/'), 'admin pages excluded').toBeTruthy();
        ctx.expect(!llms.includes('robots.txt') && !llms.includes('sitemap.xml'), 'machine files excluded').toBeTruthy();
        ctx.expect(!llms.includes('llms.txt'), 'llms.txt does not list itself').toBeTruthy();
      },
    },

    // #821: the file is a brand summary, not a sitemap: name, summary, then a
    // free-text paragraph with the tagline and the contact email, then the links.
    {
      name: 'llms.txt: opens on the brand name, the summary, then a paragraph with the tagline and contact email (#821)',
      run: async (ctx) => {
        const built = await buildWith({
          ...miniData,
          brand: { ...miniData.brand, tagline: 'Tiny tools for tiny teams', contact: { email: 'hello@mini.example.com' } },
        }, {}, 'meta-files-llms-summary');
        const llms = built.get('/llms.txt');
        const blocks = llms.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);

        ctx.expect(llms, 'the file opens on the H1').toMatch(/^# MiniCo\n/);
        ctx.expect(blocks[0], 'the H1 is the brand name').toBe('# MiniCo');
        ctx.expect(blocks[1], 'then the blockquote summary from the description').toBe('> Mini test brand');
        ctx.expect(blocks[2], 'then a free-text paragraph, not a heading, quote or list').toMatch(/^[^#>\-\s]/);
        ctx.expect(blocks[2].includes('Tiny tools for tiny teams'), 'the paragraph carries the tagline').toBeTruthy();
        ctx.expect(blocks[2].includes('hello@mini.example.com'), 'and the contact email').toBeTruthy();
        ctx.expect(blocks[3].split('\n')[0], 'then the Pages section').toBe('## Pages');
      },
    },

    {
      name: 'llms.txt: each configured social is one line under `## Social`; no socials, no heading (#821)',
      run: async (ctx) => {
        const social = llmsSection(pages.get('/llms.txt'), 'Social');
        ctx.expect(social, 'the suite\'s twitter social prints a Social section').toBeTruthy();
        ctx.expect(social.length, 'one line per configured social').toBe(1);
        ctx.expect(social[0], 'the line links the profile URL, with a note').toMatch(/^- \[[^\]]+\]\(https:\/\/twitter\.com\/minico\): \S/);

        const bare = await buildWith(miniData, {}, 'meta-files-llms-no-socials');
        ctx.expect(bare.get('/llms.txt'), 'no socials, no Social heading').not.toMatch(/^## Social/m);
      },
    },

    {
      name: 'llms.txt: a desktop download is one line under `## Downloads`; no downloads, no heading (#821)',
      run: async (ctx) => {
        // One platform and format: the shortlink suite's desktop staging, with
        // windows and linux switched off so only mac/dmg derives.
        const built = await buildWith({
          ...miniData,
          repo: { provider: 'github', owner: 'mini-org' },
          targets: {
            web: { type: 'web' },
            desktop: { type: 'desktop', releases: {}, platforms: { windows: false, linux: false } },
          },
        }, {}, 'meta-files-llms-downloads');

        const downloads = llmsSection(built.get('/llms.txt'), 'Downloads');
        ctx.expect(downloads, 'a declared download prints a Downloads section').toBeTruthy();
        ctx.expect(downloads.length, 'one line for the one platform and format').toBe(1);
        ctx.expect(downloads[0].startsWith('- ['), 'a markdown link line').toBeTruthy();
        ctx.expect(downloads[0], 'linking the download, with a note').toMatch(/\]\(https:\/\/github\.com\/mini-org\/mini-releases\/releases\/latest\/download\/MiniCo-mac-dmg\.dmg\): \S/);

        ctx.expect(pages.get('/llms.txt'), 'no desktop target, no Downloads heading').not.toMatch(/^## Downloads/m);
      },
    },

    {
      name: 'llms.txt: an extension store listing is one line under `## Downloads` (#821)',
      run: async (ctx) => {
        // One store, staged as the shortlink suite stages its listings.
        const built = await buildWith({
          ...miniData,
          targets: {
            web: { type: 'web' },
            extension: { type: 'extension', listings: { chrome: { url: 'https://chromewebstore.google.com/detail/abc', state: 'live' } } },
          },
        }, {}, 'meta-files-llms-listings');

        const downloads = llmsSection(built.get('/llms.txt'), 'Downloads');
        ctx.expect(downloads, 'a store listing prints a Downloads section').toBeTruthy();
        ctx.expect(downloads.length, 'one line for the one store').toBe(1);
        ctx.expect(downloads[0].startsWith('- ['), 'a markdown link line').toBeTruthy();
        ctx.expect(downloads[0], 'linking the store listing, with a note').toMatch(/\]\(https:\/\/chromewebstore\.google\.com\/detail\/abc\): \S/);
      },
    },

    {
      name: 'llms.txt: site-level `meta.index: false` empties every section, socials and downloads included (#821/#564)',
      run: async (ctx) => {
        const built = await buildWith({
          ...miniData,
          meta: { index: false },
          socials: { twitter: 'minico' },
          repo: { provider: 'github', owner: 'mini-org' },
          targets: {
            web: { type: 'web' },
            desktop: { type: 'desktop', releases: {}, platforms: { windows: false, linux: false } },
          },
        }, {}, 'meta-files-llms-site-off');
        const llms = built.get('/llms.txt');

        ctx.expect(llms, 'the brand heading still opens the file').toMatch(/^# MiniCo$/m);
        ctx.expect(llms, 'no section heading of any kind').not.toMatch(/^## /m);
        ctx.expect(llms, 'and no link line at all').not.toMatch(/^- \[/m);
      },
    },

    // #731: the Posts walk filtered on its own rule list, so a post the brand took
    // OUT of the machine files could be dropped from the sitemap and pages.json and
    // still handed to an LLM. One flag, every file: #564 retired `sitemap.include`
    // outright, so the opt-out a post writes is `meta.index: false`, the same key
    // every other page writes. Inside the package, not os.tmpdir; see the
    // index-posture consumer test.
    {
      name: 'llms.txt: a post with `meta.index: false` is out of llms.txt, the sitemap and pages.json (#731/#564)',
      run: async (ctx) => {
        const consumerDir = path.join(PKG, '.omega', 'meta-files-post-excluded-src');
        fs.rmSync(consumerDir, { recursive: true, force: true });
        fs.cpSync(MINI, consumerDir, { recursive: true });
        fs.writeFileSync(path.join(consumerDir, '_posts', '2024', '2024-03-01-excluded-post.md'), [
          '---',
          'layout: blueprint/blog/post',
          'meta:',
          '  index: false',
          'post:',
          '  title: "Excluded post"',
          '  description: "Written, published, and not for the machines"',
          '  author: jane doe',
          '  id: 1000099',
          '---',
          '',
          'Kilo lima mike november oscar papa.',
          '',
        ].join('\n'));

        try {
          const built = await buildSite(consumerDir, miniData, {}, 'meta-files-post-excluded');
          const excluded = `${miniData.url}/blog/excluded-post`;
          const kept = `${miniData.url}/blog/first-post`;
          ctx.expect(built.get('/blog/excluded-post'), `the post itself still builds: ${[...built.keys()].filter((url) => url.startsWith('/blog/')).join(', ')}`).toBeTruthy();

          const llms = built.get('/llms.txt');
          ctx.expect(llms.includes(`(${kept})`), 'a normal post is still listed under Posts').toBeTruthy();
          ctx.expect(!llms.includes(`(${excluded})`), 'the excluded post is not handed to an LLM').toBeTruthy();

          // The two files that already honored the flag, as the parity proof.
          ctx.expect(!built.get('/sitemap.xml').includes(`<loc>${excluded}</loc>`), 'and it stays out of the sitemap').toBeTruthy();
          ctx.expect(!JSON.parse(built.get('/pages.json')).some((entry) => entry.url === excluded), 'and out of pages.json').toBeTruthy();
        } finally {
          fs.rmSync(consumerDir, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'llms.txt: a consumer file at the same URL wins (default-page shadowing)',
      run: async (ctx) => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-llms-'));
        const consumerDir = path.join(tmp, 'src');
        fs.mkdirSync(path.join(consumerDir, 'pages'), { recursive: true });
        fs.writeFileSync(path.join(consumerDir, 'pages', 'llms.md'), [
          '---',
          'permalink: /llms.txt',
          'meta:',
          '  index: false',
          '---',
          'CONSUMER LLMS BRIEF',
          '',
        ].join('\n'));

        try {
          const shadowed = await buildSite(consumerDir, miniData, {}, 'meta-files-llms-shadow');
          const llms = shadowed.get('/llms.txt');
          // The unshadowed build DOES carry the default's section — so the absence
          // below proves suppression, not a missing default page.
          ctx.expect(pages.get('/llms.txt').includes('## Pages'), 'the default page exists unshadowed').toBeTruthy();
          ctx.expect(llms.includes('CONSUMER LLMS BRIEF'), 'the consumer file renders').toBeTruthy();
          ctx.expect(!llms.includes('## Pages'), 'the default page is suppressed, not merged').toBeTruthy();
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'sitemap.xml + pages.json: entries in URL byte order (deterministic emission, cp227)',
      run: (ctx) => {
        // Eleventy's collections.all order varies run-to-run — the meta templates
        // iterate the URL-sorted allByUrl collection so two builds of the same
        // tree emit identical bytes. Sorted output is the observable proof.
        const locs = [...pages.get('/sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
        ctx.expect(locs.length > 5, 'sitemap has real entries').toBeTruthy();
        ctx.expect(locs, 'sitemap locs in byte order').toEqual([...locs].sort());

        const urls = JSON.parse(pages.get('/pages.json')).map((entry) => entry.url);
        ctx.expect(urls.length > 5, 'pages.json has real entries').toBeTruthy();
        ctx.expect(urls, 'pages.json urls in byte order').toEqual([...urls].sort());
      },
    },

    // #527 — the adsense block has ONE switch: the client id. A site that names
    // one sells inventory through it, so ads.txt declares it — the split gates
    // (`units`, a provider `enabled`) are deleted, and a config still carrying
    // them is an undeclared key that changes nothing about this file.
    {
      name: 'ads.txt: the client id alone decides the record (#527)',
      run: async (ctx) => {
        const gated = await buildWith({
          ...miniData,
          advertising: { providers: { adsense: { client: 'ca-pub-1234567890', units: false, enabled: false } } },
        }, {}, 'meta-files-adsense-gates');

        ctx.expect(gated.get('/ads.txt'), 'no second gate takes a configured client id out of the market').toMatch(/^google\.com, pub-1234567890, DIRECT, f08c47fec0942fa0$/m);

        // The presence gate itself is unchanged (the `before` build).
        ctx.expect(pages.get('/ads.txt')).toMatch(/^google\.com, pub-1234567890, DIRECT, f08c47fec0942fa0$/m);
      },
    },

    {
      name: 'ads.txt without advertising config: honest comment, never a broken record',
      run: async (ctx) => {
        const bare = await buildWith(miniData, {}, 'meta-files-bare');
        ctx.expect(bare.get('/ads.txt')).toMatch(/^# No advertising providers configured$/m);
        ctx.expect(bare.get('/ads.txt'), 'the else branch opens on its comment too (#556)').toMatch(/^# No advertising/);
        ctx.expect(!bare.get('/ads.txt').includes('google.com,'), 'no fabricated AdSense line').toBeTruthy();

        // And humans.txt drops the socials line instead of rendering an empty field
        ctx.expect(!bare.get('/humans.txt').includes('Twitter:'), 'unconfigured socials line dropped').toBeTruthy();
      },
    },
  ],
});
