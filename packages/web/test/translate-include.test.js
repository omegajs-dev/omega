/**
 * `translation.include`, the glob list that says which page routes get
 * translated ([#858](https://github.com/Omega-JS-Stack/omega/issues/858),
 * Ian 2026-09-13). It replaced `translation.exclude`, which named what to
 * skip and defaulted to nothing, so every brand that never thought about it
 * paid a provider for its whole blog.
 *
 * Two halves, both here:
 *   - the MATCHER (`routeIncluded`): gitignore order, so the LAST pattern that
 *     matches wins, `!` negates, no match at all is excluded;
 *   - the WIRING: the route list, the framework's own derived exclusions and
 *     the per-page `translation.include` stamp meeting in `translateSite`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const defineCases = require('@omega.js/devkit/test/define-cases');
const { withoutCI } = require('@omega.js/devkit/test/without-ci');

const { routeIncluded, includePatterns, readTranslateStamp } = require('../src/translate/route-include.js');
const { TRANSLATION_INCLUDE_DEFAULT } = require('@omega.js/config/schema');
const { translateSite } = require('../src/translate/index.js');
const { CONTROL } = require('@omega.js/devkit/translate');
const { buildSite, BARE } = require('./lib/build.js');

// ─── The wiring ──────────────────────────────────────────────────────────────

const NO_PACKAGED = path.join(os.tmpdir(), 'omega-packaged-defaults-absent');

const PAGE = (title, body, stamp = '') => `<!doctype html><html lang="en" dir="ltr"${stamp ? ` data-omega-translate="${stamp}"` : ''}><head>
<title>${title}</title>
<link rel="canonical" href="https://mini.co/"/>
</head><body>${body}</body></html>`;

/** Stage a dist with a home page, a docs page, a blog post and a stamped pair. */
function stage() {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omega-translate-include-')));
  const dist = path.join(scratch, 'dist');
  const write = (rel, html) => {
    fs.mkdirSync(path.join(dist, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dist, rel), html);
  };

  write('index.html', PAGE('Home', '<p>Welcome</p><a href="/blog/post-1">Post</a>'));
  write('docs/api/index.html', PAGE('API', '<p>The API</p>'));
  write('blog/post-1/index.html', PAGE('Post one', '<p>First post</p>'));
  write('blog/post-2/index.html', PAGE('Post two', '<p>Second post</p>', 'true'));
  write('docs/secret/index.html', PAGE('Secret', '<p>Not for translation</p>', 'false'));

  return { scratch, dist };
}

const CONFIG = (translation) => ({
  url: 'https://mini.co',
  brand: { name: 'MiniCo', url: 'https://mini.co' },
  translation: { languages: ['es'], ...translation },
});

/** Fake provider: suffixes each string with the target language. */
const send = async ({ user }) => {
  const lang = user.match(/^Target language: (\S+)/)[1];
  const payload = JSON.parse(user.slice(user.indexOf('\n\n') + 2));

  return { text: JSON.stringify(payload.map((value) => (value === CONTROL ? value : `${value.trim()}·${lang}`))), usage: { input: 1, output: 1 } };
};

// ─── The build half of the stamp ─────────────────────────────────────────────

const bareData = JSON.parse(fs.readFileSync(path.join(BARE, 'site-data.json'), 'utf8'));

/** A consumer whose `pages/` carries one page with the given frontmatter. */
function makePage(frontmatter) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-translate-page-'));
  const consumerDir = path.join(tmp, 'src');
  fs.mkdirSync(path.join(consumerDir, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(consumerDir, 'pages', 'index.html'), [
    '---',
    'layout: frontend/core/base',
    'permalink: /',
    ...frontmatter,
    '---',
    '<section><h2>Body</h2></section>',
    '',
  ].join('\n'));

  return { tmp, consumerDir };
}

module.exports = defineCases({
  type: 'group',
  description: 'translate-include',
  tests: [
    // ─── The matcher ─────────────────────────────────────────────────────────────

    {
      name: 'routeIncluded: the framework default translates everything but the blog',
      run: (ctx) => {
        const patterns = TRANSLATION_INCLUDE_DEFAULT;

        ctx.expect(routeIncluded('', patterns), 'the home page').toBe(true);
        ctx.expect(routeIncluded('docs/api', patterns)).toBe(true);
        ctx.expect(routeIncluded('pricing', patterns)).toBe(true);

        // `blog/**` covers the folder ITSELF, not only what is under it: the same
        // subtree semantics the exclusion sets have always had.
        ctx.expect(routeIncluded('blog', patterns), 'the listing itself').toBe(false);
        ctx.expect(routeIncluded('blog/post-1', patterns)).toBe(false);
        ctx.expect(routeIncluded('blog/page/2', patterns)).toBe(false);
        ctx.expect(routeIncluded('blogroll', patterns), 'a SEGMENT, never a bare prefix').toBe(true);
      },
    },

    {
      name: 'routeIncluded: a brand list replaces the default outright, nothing else is translated',
      run: (ctx) => {
        const patterns = ['docs/**'];

        ctx.expect(routeIncluded('docs', patterns)).toBe(true);
        ctx.expect(routeIncluded('docs/api', patterns)).toBe(true);
        ctx.expect(routeIncluded('', patterns), 'the home page is out when the list does not name it').toBe(false);
        ctx.expect(routeIncluded('pricing', patterns)).toBe(false);
      },
    },

    {
      name: 'routeIncluded: the LAST matching pattern wins, in either direction',
      run: (ctx) => {
        // A negation after a positive excludes…
        ctx.expect(routeIncluded('blog/post-1', ['**', '!blog/**'])).toBe(false);
        // …and a positive after a negation puts one subtree back.
        ctx.expect(routeIncluded('blog/post-1', ['**', '!blog/**', 'blog/post-1'])).toBe(true);
        ctx.expect(routeIncluded('blog/post-2', ['**', '!blog/**', 'blog/post-1'])).toBe(false);
      },
    },

    {
      name: 'routeIncluded: routes and patterns normalize the same way, slashes and all',
      run: (ctx) => {
        ctx.expect(routeIncluded('/docs/api/', ['docs/**'])).toBe(true);
        ctx.expect(routeIncluded('docs/api', ['/docs/**'])).toBe(true);
        ctx.expect(routeIncluded('docs', ['!/docs', '**']), 'order, not specificity').toBe(true);
      },
    },

    {
      name: 'includePatterns: an absent list is the framework default, an empty one translates nothing',
      run: (ctx) => {
        ctx.expect(includePatterns({})).toEqual(TRANSLATION_INCLUDE_DEFAULT);
        ctx.expect(includePatterns({ translation: {} })).toEqual(TRANSLATION_INCLUDE_DEFAULT);
        ctx.expect(includePatterns({ translation: { include: ['docs/**'] } })).toEqual(['docs/**']);
        ctx.expect(routeIncluded('anything', includePatterns({ translation: { include: [] } }))).toBe(false);
      },
    },

    // ─── The page stamp ──────────────────────────────────────────────────────────

    {
      name: 'readTranslateStamp: the <html> stamp a page carrying `translation.include` ships',
      run: (ctx) => {
        ctx.expect(readTranslateStamp('<!doctype html><html lang="en" data-omega-translate="true">')).toBe(true);
        ctx.expect(readTranslateStamp('<!doctype html><html lang="en" data-omega-translate="false">')).toBe(false);
        ctx.expect(readTranslateStamp('<!doctype html><html data-omega-translate=false>'), 'minified, unquoted').toBe(false);
        ctx.expect(readTranslateStamp('<!doctype html><html lang="en">'), 'no stamp is no opinion').toBe(null);
      },
    },

    {
      name: '#858: the default list keeps the blog off the provider and translates everything else',
      run: async (ctx) => {
        const { scratch, dist } = stage();
        const stats = await withoutCI(() => translateSite({ root: scratch, outDir: dist, config: CONFIG(), send, packagedRoot: NO_PACKAGED }));

        // The language HOME lands as es.html, a FILE (translate/index.js), never
        // an es/index.html.
        ctx.expect(fs.existsSync(path.join(dist, 'es.html')), 'the home page is translated').toBeTruthy();
        ctx.expect(fs.existsSync(path.join(dist, 'es', 'docs', 'api', 'index.html')), 'a docs page is translated').toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(dist, 'es', 'blog', 'post-1')), 'the blog is out by default').toBeTruthy();
        ctx.expect(stats.pages > 0, 'the pass ran').toBeTruthy();

        // A link to an excluded route is left alone, the same guard the framework
        // routes get.
        const es = fs.readFileSync(path.join(dist, 'es.html'), 'utf8');
        ctx.expect(es.includes('href="/blog/post-1"'), 'the excluded route link is not rewritten').toBeTruthy();
      },
    },

    {
      name: '#858: a page\'s own `translation.include` wins over the list, both directions',
      run: async (ctx) => {
        const { scratch, dist } = stage();
        await withoutCI(() => translateSite({ root: scratch, outDir: dist, config: CONFIG(), send, packagedRoot: NO_PACKAGED }));

        ctx.expect(fs.existsSync(path.join(dist, 'es', 'blog', 'post-2', 'index.html')), 'an opted-IN blog post is translated').toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(dist, 'es', 'docs', 'secret')), 'an opted-OUT docs page is not').toBeTruthy();
      },
    },

    {
      name: '#858: a brand list REPLACES the default, so only what it names is translated',
      run: async (ctx) => {
        const { scratch, dist } = stage();
        await withoutCI(() => translateSite({ root: scratch, outDir: dist, config: CONFIG({ include: ['blog/**'] }), send, packagedRoot: NO_PACKAGED }));

        ctx.expect(fs.existsSync(path.join(dist, 'es', 'blog', 'post-1', 'index.html')), 'the named subtree is in').toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(dist, 'es.html')), 'the home page is out: the list replaced the default').toBeTruthy();
        ctx.expect(!fs.existsSync(path.join(dist, 'es', 'docs', 'api')), 'and so is docs').toBeTruthy();
      },
    },

    {
      name: '#858: a page\'s `translation.include` reaches the built page as the <html> stamp',
      run: async (ctx) => {
        for (const [value, expected] of [['false', false], ['true', true]]) {
          const { tmp, consumerDir } = makePage(['translation:', `  include: ${value}`]);

          try {
            const built = await buildSite(consumerDir, bareData, {}, `translate-stamp-${value}`);
            ctx.expect(readTranslateStamp(built.get('/')), `include: ${value} stamps the page`).toBe(expected);
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
        }
      },
    },

    {
      name: '#858: a page that says nothing carries no stamp, so the list decides',
      run: async (ctx) => {
        const { tmp, consumerDir } = makePage([]);

        try {
          const built = await buildSite(consumerDir, bareData, {}, 'translate-stamp-absent');
          ctx.expect(readTranslateStamp(built.get('/'))).toBe(null);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },

    // `include` is the ONE key the bare `translation:` opens: the rest of the
    // section is omega.json5 config, and a page restating it bare would reach
    // nothing at all.
    {
      name: '#858: a SCALAR `translation:` fails the build, naming the shape (C8)',
      run: async (ctx) => {
        const { tmp, consumerDir } = makePage(['translation: false']);

        try {
          await ctx.expect((() => buildSite(consumerDir, bareData, {}, 'translate-stamp-scalar'))()).rejects.toThrow((error) => {
              const parts = [];
              for (let node = error; node; node = node.originalError || node.cause) parts.push(node.message);
              const message = parts.join(' | ');
              ctx.expect(message, 'the error names the shape').toMatch(/translation: \{ include: true\|false \}/);
              return true;
            });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },

    {
      name: '#858: any other key under a page\'s bare `translation:` fails the build',
      run: async (ctx) => {
        const { tmp, consumerDir } = makePage(['translation:', '  languages: ["es"]']);

        try {
          await ctx.expect((() => buildSite(consumerDir, bareData, {}, 'translate-stamp-stray'))()).rejects.toThrow((error) => {
              const parts = [];
              for (let node = error; node; node = node.originalError || node.cause) parts.push(node.message);
              const message = parts.join(' | ');
              ctx.expect(message, 'the error names the stray key').toMatch(/`languages`/);
              ctx.expect(message, 'and the lane it belongs in').toMatch(/config:/);
              return true;
            });
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
  ],
});
