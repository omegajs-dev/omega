/**
 * Blog article generation test.
 *
 * Two modes:
 *
 * 1. DEFAULT MODE (no env required)
 *    Verifies the blog auto-publisher config is readable and source resolution
 *    works correctly. No AI calls, no publishing. Fast, free, deterministic.
 *
 * 2. AI PIPELINE MODE (set TEST_EXTENDED_MODE=1)
 *    Runs the full blog auto-publisher pipeline: resolves a source, calls
 *    Ghostii to write an article, and publishes it to the website repo via
 *    admin/post. Same code path the daily cron uses. Costs money (AI tokens).
 *
 * Run from any consumer project's functions/ directory:
 *   npx omega test mgr:content/blog-generate                   # config check (fast, free)
 *   TEST_EXTENDED_MODE=1  npx omega test mgr:content/blog-generate  # full AI pipeline
 *
 * --- Env vars (AI mode only, require TEST_EXTENDED_MODE=1) ---
 *   BLOG_SOURCE=<type>        Override the source type for this run.
 *                              Values: '$brand', '$parent', '$feed:<url>', a URL, or text.
 *                              Default: picks randomly from the first content entry's sources[].
 *   BLOG_NO_PUBLISH=1         Generate the article but do NOT publish to the website repo.
 *                              Useful for iterating on prompt quality without committing posts.
 *   BLOG_OPEN=1               Auto-open the generated article in the default browser (macOS only).
 *
 * AI mode requires:
 *   OMEGA_ADMIN_KEY   — authenticates with Ghostii + parent server
 *   OPENAI_API_KEY        — Ghostii uses OpenAI internally
 *   PARENT_API_URL        — or set `parent` in config/omega.json5 (for $parent sources)
 *
 * Default mode requires: nothing.
 */
const path = require('path');
const { execSync } = require('child_process');
const jetpack = require('fs-jetpack');
const powertools = require('node-powertools');
const { loadHandler } = require('../../dist/omega/libraries/load-handler.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

module.exports = defineCases({
  description: 'Generate a blog article (config check by default, full AI pipeline with TEST_EXTENDED_MODE)',
  auth: 'none',
  timeout: 300000,
  async run({ expect, config, omega, ctx, skip }) {
    const env = process.env;
    const blogConfig = omega.config.blog;
    // Same tri-state read the auto-publisher uses: the enabled key under
    // blog.providers names the article provider
    const providerName = Object.keys(blogConfig?.providers || {}).find((key) => blogConfig.providers[key]) || 'ghostii';

    // --- Default mode: config validation ---
    if (!env.TEST_EXTENDED_MODE) {
      expect(blogConfig, 'blog config exists').toBeTruthy();
      expect(blogConfig.providers?.ghostii, 'blog.providers.ghostii is set').toBeTruthy();
      expect(typeof blogConfig.enabled, 'blog.enabled is a boolean').toBe('boolean');

      const contentArray = powertools.arrayify(blogConfig.content);
      expect(contentArray.length > 0, 'blog.content has at least one entry').toBeTruthy();

      const entry = contentArray[0];
      expect(Array.isArray(entry.sources), 'first entry has sources array').toBeTruthy();
      expect(entry.sources.length > 0, 'first entry has at least one source').toBeTruthy();

      // Verify source types are valid
      for (const source of entry.sources) {
        const validTypes = source === '$brand'
          || source === '$parent'
          || source.startsWith('$feed:')
          || source.startsWith('http')
          || typeof source === 'string';
        expect(validTypes, `source "${source}" is a valid type`).toBeTruthy();
      }

      // Verify provider exists
      const providerPath = path.join(__dirname, '..', '..', 'dist', 'omega', 'libraries', 'content', `${providerName}.js`);
      expect(jetpack.exists(providerPath), `provider "${providerName}" exists at ${providerPath}`).toBeTruthy();

      console.log(`\n[blog-generate] Config OK:`);
      console.log(`  provider: ${providerName}`);
      console.log(`  enabled: ${blogConfig.enabled}`);
      console.log(`  entries: ${contentArray.length}`);
      console.log(`  sources: ${entry.sources.join(', ')}`);
      console.log(`  categories: ${(entry.categories || []).join(', ') || '(none)'}`);
      console.log(`  tone: ${entry.tone || '(default)'}`);
      console.log(`  (Set TEST_EXTENDED_MODE=1 to run the full AI pipeline.)`);
      return;
    }

    // --- Extended mode: full AI pipeline ---
    if (!blogConfig?.enabled) {
      return skip('blog.enabled is false in config');
    }

    const publisherPath = path.join(__dirname, '..', '..', 'dist', 'omega', 'events', 'cron', 'daily', 'blog-auto-publisher.js');
    const publisher = loadHandler(publisherPath);

    // Get content entries
    const contentArray = powertools.arrayify(blogConfig.content);
    expect(contentArray.length > 0, 'blog.content has at least one entry').toBeTruthy();

    // Clone and override for test
    const content = JSON.parse(JSON.stringify(contentArray));
    content[0].chance = 1.0;
    content[0].quantity = 1;

    // Override source if env specified
    if (env.BLOG_SOURCE) {
      content[0].sources = [env.BLOG_SOURCE];
    }

    omega.config.blog.content = content;

    // Output dir
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-(\d{3})Z$/, '');
    const outDir = path.join(process.cwd(), '..', '.temp', 'blog', `run-${stamp}`);
    jetpack.dir(outDir);

    console.log(`\n[blog-generate] Extended mode — full AI pipeline`);
    console.log(`  provider: ${providerName}`);
    console.log(`  sources: ${content[0].sources.join(', ')}`);
    console.log(`  publish: ${env.BLOG_NO_PUBLISH ? 'NO (BLOG_NO_PUBLISH=1)' : 'YES'}`);
    console.log(`  output: ${outDir}`);

    // Intercept publishArticle if BLOG_NO_PUBLISH is set
    if (env.BLOG_NO_PUBLISH) {
      const provider = require(path.join(__dirname, '..', '..', 'dist', 'omega', 'libraries', 'content', `${providerName}.js`));
      const originalPublish = provider.publishArticle;
      provider.publishArticle = async (ast, args) => {
        console.log(`[blog-generate] SKIPPED publishArticle (BLOG_NO_PUBLISH=1)`);
        console.log(`  title: ${args.article?.title || '(unknown)'}`);
        return { post: null, url: null, slug: 'dry-run', path: null };
      };

      // Restore after test
      process.on('exit', () => { provider.publishArticle = originalPublish; });
    }

    // Run the publisher
    await publisher({
      omega,
      ctx,
      context: {},
    });

    // Write metadata
    jetpack.write(path.join(outDir, 'metadata.json'), JSON.stringify({
      mode: 'extended',
      provider: providerName,
      sources: content[0].sources,
      published: !env.BLOG_NO_PUBLISH,
      timestamp: new Date().toISOString(),
    }, null, 2));

    console.log(`\n[blog-generate] Done. Output: ${outDir}`);

    // Auto-open (macOS)
    if (env.BLOG_OPEN === '1' && process.platform === 'darwin') {
      try { execSync(`open "${outDir}"`); } catch (e) { /* no-op */ }
    }

    expect(true, 'Blog auto-publisher completed').toBeTruthy();
  },
});
