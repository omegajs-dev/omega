/**
 * The brand-SHAPE corpus (cp197, Ian 2026-07-17: "do corpus") — tier A of
 * `npm run test:corpus`, and part of root `npm test` through it.
 *
 * Every cell births a brand through the REAL onboard (in-process, flags
 * mode) in a temp dir, proves the config validates and git initializes,
 * and — for web cells — runs the REAL build the way `omega build` does
 * (ensureTarget, then buildSite with the whole asset lane, writing a real
 * dist/), then reads the BUILT FILES back for its invariants: branded
 * homepage, active theme id, /blog, sitemap + robots meta-files, font
 * preloads, and post listing for the content cell.
 *
 * The build is the point: rendering Eleventy against a hand-built asset
 * manifest proved the fixture, not the product — the font-preload list comes
 * off the compiled sheet (#765), so a stub could only fake it and every web
 * cell failed the invariant
 * ([#776](https://github.com/Omega-JS-Stack/omega/issues/776)).
 *
 * Fully OFFLINE by construction: no npm installs, no emulators, no live
 * calls (Ian's corpus stance — real code against real local infra only;
 * the outside-monorepo install/boot/manage story is the journey lane's job).
 *
 * Future axes live here: add a cell, not a new harness (company-mode child,
 * extra content shapes, more themes as they're born).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Machine state (the brand registry, Claude Code's config) lives in a temp
// home for this run, before onboard is loaded.
require('@omega.js/devkit/test/temp-home');

const MONOREPO_ROOT = path.join(__dirname, '..');
const { runOnboard } = require(path.join(MONOREPO_ROOT, 'packages', 'manager', 'src', 'onboard.js'));
const { ONBOARD_TARGETS } = require(path.join(MONOREPO_ROOT, 'packages', 'manager', 'src', 'lib', 'default-targets.js'));
const { configureOmega, loadSiteData } = require('@omega.js/web');
const { setEnvironment } = require('@omega.js/config/environment');

// One row per brand shape. targets: null takes the onboard default (the
// website alone); theme flips the seeded config; post drops a real _posts
// entry before the build.

// twoWeb adds a SECOND named web target and proves the sweep across siblings
// (structure, per-target compose, port offsets, deploy-record keys, both
// builds). themeOverride drops a consumer-local tier-2 theme over the seeded
// one and proves the cascade through a REAL production build (proveThemeOverride).
const CELLS = [
  { id: 'shape-web-only', targets: 'web' },
  { id: 'shape-default-derivation', targets: null },
  { id: 'shape-all-four', targets: 'web,backend,desktop,extension' },
  { id: 'shape-newsflash', targets: 'web,backend', theme: 'newsflash' },
  { id: 'shape-backend-only', targets: 'backend' },
  { id: 'shape-desktop-extension', targets: 'desktop,extension' },
  { id: 'shape-with-post', targets: 'web', post: true },
  { id: 'shape-web-two-targets', targets: 'web', twoWeb: true },
  { id: 'shape-theme-override', targets: 'web', themeOverride: true },
];

const POST_MARKER = 'Corpus Post Alpha';

// The tier-2 override fixture the themeOverride cell installs into
// `<src>/themes/<active id>/` — one marker per FILE KIND the cascade resolves,
// each invisible to a reader, and each read back out of the BUILT output by
// proveThemeOverride:
//   _layouts/frontend/core/base.html      data-corpus-override="layout"
//   _includes/core/body.html              data-corpus-override="include"
//   _theme.scss                           --corpus-override: css
//   _sections/marketing/stats/            data-corpus-override="section-html"
//                                         + its own section.js (window.__corpusOverride)
//   _sections/marketing/newsletter-cta/   inherit: ['js'] — the base section's
//                                         js keeps riding the bundle
//
// What it deliberately does NOT ship is half the point. No `_theme.js`: base's
// is the floor every chain ends at. No `fonts/`: the hatch in `_theme.scss`
// inherits the packaged skin's faces, and the fonts lane follows a shadowing
// theme with the dir it shadows, so the files arrive with the rules. Both were
// build-breaking gaps this cell found, fixed upstream under
// [#773](https://github.com/Omega-JS-Stack/omega/issues/773) — the fixture
// omitting them is what keeps those fixes pinned here.
const THEME_OVERRIDE_FIXTURE = path.join(__dirname, 'corpus-fixtures', 'theme-override');

function deriveName(id) {
  return id.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function expectedTargets(cell) {
  return cell.targets ? cell.targets.split(',') : ONBOARD_TARGETS;
}

/** Flip the seeded theme id in the cell's config (scaffold seeds classy). */
function flipTheme(brandRoot, themeId) {
  const configPath = path.join(brandRoot, 'config', 'omega.json5');
  const raw = fs.readFileSync(configPath, 'utf8');
  const flipped = raw.replace(/id: "classy"/, `id: "${themeId}"`);
  if (flipped === raw) {
    throw new Error(`could not flip theme to ${themeId} — the scaffold's classy seed line moved`);
  }
  fs.writeFileSync(configPath, flipped);
}

function writePost(webTargetDir) {
  // `src/` is the Eleventy input dir (#776 — the corpus builds the way the verb
  // does now), so the collection lives there like a real brand's does.
  const postPath = path.join(webTargetDir, 'src', '_posts', '2026', '2026-07-01-corpus-post.md');
  fs.mkdirSync(path.dirname(postPath), { recursive: true });
  fs.writeFileSync(postPath, [
    '---',
    'layout: blueprint/blog/post',
    'post:',
    `  title: "${POST_MARKER}"`,
    '  description: "A corpus content-shape post"',
    '  author: corpus',
    '  id: 1000001',
    '  tags: ["corpus"]',
    '  categories: ["Corpus"]',
    '---',
    'Corpus post body.',
    '',
  ].join('\n'));
}

/**
 * The REAL build of a cell's web target — what `omega build` runs, in this
 * process: the local `ensureTarget` scaffold, then `buildSite` from the target
 * root, writing a real `dist/`.
 *
 * It used to render Eleventy in memory against a hand-built asset-manifest
 * stub, which is why every web cell failed `font preload links present`
 * ([#776](https://github.com/Omega-JS-Stack/omega/issues/776)): the preload
 * list is produced by the asset lane from the COMPILED sheet (#765), so a
 * stub can only ever fake it. A corpus cell that renders against a fixture is
 * proving the fixture — the invariant is truthful again because the build is.
 *
 * Offline like the rest of the corpus: ensureTarget is copy-if-missing and
 * marker-merge with nothing on the network, and every dependency resolves from
 * the monorepo (no installs).
 * @param {string} brandRoot - the born brand
 * @param {string} [targetDirName] - the target dir (a sibling web cell passes its own)
 * @returns {Promise<Map<string, string>>} url → built file content
 */
async function buildWebTarget(brandRoot, targetDirName = 'web') {
  const { buildSite, resolveClientEntry, consumerPaths } = require('@omega.js/web');
  const { ensureTarget } = require(path.join(MONOREPO_ROOT, 'packages', 'web', 'src', 'commands', 'lib', 'ensure-target.js'));

  const paths = consumerPaths(path.join(brandRoot, 'targets', targetDirName));
  // Step one of every verb (#675). Inside a brand it is layer-aware: no
  // target-level config seed, so the brand root's config stays the only one.
  ensureTarget({ projectDir: paths.root });

  // A real verb runs from the target root, and the engine's machinery ignores
  // are cwd-relative globs — so the corpus stands where the verb stands.
  const cwd = process.cwd();
  process.chdir(paths.root);
  try {
    await buildSite({
      consumerDir: paths.src,
      siteAssetsDir: paths.assets,
      siteData: loadSiteData(paths.root), // the REAL config chain (throws on invalid)
      outDir: paths.out,
      clientEntry: resolveClientEntry(),
      // No `environment: 'production'` on purpose: production MINIFIES the html
      // (attribute quotes and all) and the invariants read quoted attributes.
      // Every lane that matters here — layers, sass, esbuild — runs either way.
    });
  } finally {
    process.chdir(cwd);
  }

  return readDist(paths.out);
}

/**
 * A built `dist/` as the url → content map the invariants read.
 * `index.html` files answer to their directory url, everything else to its own
 * path, so `/`, `/blog`, `/sitemap.xml` and `/robots.txt` all address the way
 * they did when this was an in-memory render.
 * @param {string} outDir - the build output dir
 * @returns {Map<string, string>} url → file content
 */
function readDist(outDir) {
  const pages = new Map();

  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) { walk(file); continue; }
      if (!/\.(html|xml|txt)$/.test(item.name)) continue;
      const rel = path.relative(outDir, file).split(path.sep).join('/');
      const url = rel.endsWith('index.html') ? `/${rel.slice(0, -'index.html'.length)}`.replace(/\/$/, '') || '/' : `/${rel}`;
      pages.set(url, fs.readFileSync(file, 'utf8'));
    }
  };
  walk(outDir);

  return pages;
}

function assertWebInvariants(cell, pages) {
  const name = deriveName(cell.id);
  const theme = cell.theme || 'classy';
  const failures = [];
  const need = (condition, label) => { if (!condition) failures.push(label); };

  const home = pages.get('/');
  need(home, 'homepage at /');
  if (home) {
    need(home.includes(name), `homepage branded "${name}"`);
    need(home.includes(`data-theme-id="${theme}"`), `theme ${theme} active`);
  }
  need([...pages.keys()].some((url) => url.startsWith('/blog')), '/blog present');
  need(pages.has('/sitemap.xml'), 'sitemap.xml');
  need(pages.has('/robots.txt'), 'robots.txt');

  if (home) {
    need(home.includes('rel="preload"') && home.includes('as="font"'), 'font preload links present');
  }

  if (cell.post) {
    const blogUrl = [...pages.keys()].find((url) => url.startsWith('/blog'));
    need(blogUrl && pages.get(blogUrl).includes(POST_MARKER), `blog lists "${POST_MARKER}"`);

    // The build stamp both modified-date surfaces read (#613). A post is the
    // page that declares one, and it shipped EMPTY on every brand until
    // `site.time` became a real build fact — so the shape lane pins the VALUE,
    // not just the tag.
    const post = [...pages.values()].find((html) => html && html.includes(POST_MARKER) && html.includes('article:modified_time'));
    const modified = post && post.match(/article:modified_time" content="([^"]*)"/);
    need(modified && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(modified[1]), 'post carries a real article:modified_time (#613)');
  }

  return failures;
}

/**
 * The sibling-web-target proof (#886): give the born brand a SECOND web target,
 * named `admin`, and exercise the whole sweep through the REAL mechanisms, the
 * workspace structure op's per-target dir expectations, per-target compose (the
 * admin entry overrides brand shared for admin ONLY), deterministic dev-port
 * offsets, deploy-record keying by target name, and a real Eleventy build of
 * BOTH targets.
 */
async function proveTwoWebTargets(brandRoot, cell) {
  const JSON5 = require('json5');
  const { loadConfig, targetPortOffset } = require('@omega.js/config');
  const { loadBrand } = require(path.join(MONOREPO_ROOT, 'packages', 'manager', 'src', 'lib', 'brand.js'));
  const structureOp = require(path.join(MONOREPO_ROOT, 'packages', 'manager', 'src', 'services', 'workspace', 'ensure', 'structure.js'));
  const { websiteWantedPort } = require(path.join(MONOREPO_ROOT, 'packages', 'web', 'src', 'commands', 'dev.js'));
  const { recordDeploy } = require('@omega.js/devkit/deploy-record');

  const failures = [];
  const need = (condition, label) => { if (!condition) failures.push(label); };
  const baseName = deriveName(cell.id);
  const adminName = `${baseName} Admin`;

  // Declare the sibling: a second web target NAMED admin, overriding brand.name
  // for ITS target only (comments are corpus-expendable)
  const configPath = path.join(brandRoot, 'config', 'omega.json5');
  const data = JSON5.parse(fs.readFileSync(configPath, 'utf8'));
  data.targets.admin = { type: 'web', url: `https://admin.${cell.id}.invalid`, brand: { name: adminName } };
  fs.writeFileSync(configPath, JSON5.stringify(data, null, 2));

  // Structure op (quiet — its console lines are not corpus output): the
  // declared admin target without its dir is the create-this-dir error
  const runStructure = async () => {
    const log = console.log;
    console.log = () => {};
    try {
      const brand = loadBrand(brandRoot);
      return await structureOp({ brandRoot, brand, targets: brand.targets });
    } finally {
      console.log = log;
    }
  };
  const missing = await runStructure();
  need(missing.status === 'error' && /create targets\/admin\//.test(missing.error || ''), 'structure errors on the missing target dir');

  // Birth the admin target as a copy of the web dir, then structure heals
  const mainDir = path.join(brandRoot, 'targets', 'web');
  const adminDir = path.join(brandRoot, 'targets', 'admin');
  fs.cpSync(mainDir, adminDir, { recursive: true });
  const healed = await runStructure();
  need(healed.status !== 'error', `structure passes with both target dirs (${healed.error || 'ok'})`);

  // Per-target compose: the admin entry is scoped to targets/admin
  const main = loadConfig(mainDir, 'web');
  const admin = loadConfig(adminDir, 'web');
  need(main.errors.length === 0 && admin.errors.length === 0, 'both targets validate');
  need(main.name === 'web' && admin.name === 'admin', 'target dirs resolve their names');
  need(main.config.brand.name === baseName, 'web keeps the brand-shared name');
  need(admin.config.brand.name === adminName, 'the admin entry overrides brand shared for admin only');
  need(admin.config.url === `https://admin.${cell.id}.invalid`, 'admin carries its own url');

  // Dev-port offsets: side-by-side capable, deterministic off the same base
  need(targetPortOffset(data, 'admin') === 1, 'admin offsets by its position among the web targets');
  need(websiteWantedPort(adminDir) - websiteWantedPort(mainDir) === 1, 'admin wants the next port beside web');

  // Deploy records key by target NAME: `web` and `admin`, never one stamp
  recordDeploy({ dir: mainDir, target: 'web', detail: { method: 'corpus' } });
  recordDeploy({ dir: adminDir, target: 'admin', detail: { method: 'corpus' } });
  const state = JSON.parse(fs.readFileSync(path.join(brandRoot, '.omega', 'state.json'), 'utf8'));
  need(!!(state.deploy?.web && state.deploy?.admin), 'deploy records key per target name');

  // Real Eleventy build of BOTH targets: each branded as ITS target
  const mainPages = await buildWebTarget(brandRoot, 'web');
  const adminPages = await buildWebTarget(brandRoot, 'admin');
  failures.push(...assertWebInvariants(cell, mainPages));
  const mainHome = mainPages.get('/') || '';
  const adminHome = adminPages.get('/') || '';
  need(!mainHome.includes(adminName), 'the web homepage never leaks the admin branding');
  need(adminHome.includes(adminName), `admin homepage branded "${adminName}"`);

  return failures;
}

/**
 * The tier-2 cascade proof ([#773](https://github.com/Omega-JS-Stack/omega/issues/773)):
 * a consumer-local theme at `<src>/themes/<active id>` shadows the PACKAGED
 * theme of the same id, and every file kind the cascade resolves is proven in
 * the built output rather than in the layer list.
 *
 * The build is the shared one every web cell runs now (#776); what is singular
 * here is the FIXTURE it installs first and the marker set it reads back —
 * the shared invariants still apply on top, so a cascade that renders the
 * markers but breaks the page fails this cell like any other.
 * @param {string} brandRoot - the born brand
 * @param {object} cell - the CELLS row
 * @returns {Promise<string[]>} failures
 */
async function proveThemeOverride(brandRoot, cell) {
  const { consumerPaths } = require('@omega.js/web');

  const failures = [];
  const need = (condition, label) => { if (!condition) failures.push(label); };
  const paths = consumerPaths(path.join(brandRoot, 'targets', 'web'));
  const themeId = cell.theme || 'classy';

  // The override lands where the LAYERS code probes — resolveThemeLayers reads
  // `<consumerDir>/themes/<id>`, and consumerDir is the Eleventy input dir
  // (`paths.src`), exactly as `omega build` passes it.
  fs.cpSync(path.join(THEME_OVERRIDE_FIXTURE, 'theme'), path.join(paths.src, 'themes', themeId), { recursive: true });

  // The same real build every other web cell runs, so this cell keeps every
  // shared invariant (branded home, theme id, /blog, sitemap, robots, font
  // preloads) on TOP of its own.
  const pages = await buildWebTarget(brandRoot);
  failures.push(...assertWebInvariants(cell, pages));

  // Every built asset of a kind, concatenated — the bundles are content-hashed,
  // so the marker is what is named here, never a filename.
  const readAssets = (kind, extension) => {
    const dir = path.join(paths.out, 'assets', kind);
    if (!fs.existsSync(dir)) return '';
    // Recursive: the theme entry is a dynamic import, so it rides its own
    // code-split chunk under chunks/ rather than the main bundle.
    const read = (from, out = []) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const file = path.join(from, entry.name);
        if (entry.isDirectory()) read(file, out);
        else if (entry.name.endsWith(extension)) out.push(fs.readFileSync(file, 'utf8'));
      }
      return out;
    };
    return read(dir).join('\n');
  };
  const home = pages.get('/') || '';
  const css = readAssets('css', '.css');
  const js = readAssets('js', '.js');

  // HTML — the layout lane (shadowing BASE's layout), the include lane
  // (shadowing CORE's include) and the section markup lane (shadowing BASE's
  // section), all three from the one consumer-local theme layer.
  need(home.includes('data-corpus-override="layout"'), 'layout override reached the built home page');
  need(home.includes('data-corpus-override="include"'), 'include override reached the built home page');
  need(home.includes('data-corpus-override="section-html"'), 'section html override reached the built home page');

  // CSS — the theme scss entry, through the real sass + purge lanes. The
  // minifier closes the space up, so both spellings count.
  need(/--corpus-override:\s*css/.test(css), 'theme scss entry reached the compiled stylesheet');

  // JS — the §7 section-js lane, both halves: the override folder's own js,
  // and the base js an `inherit: ['js']` folder deliberately left to the chain
  // (its POST target is the string only the base module carries).
  need(js.includes('__corpusOverride'), 'override section js reached the built bundle');
  need(js.includes('/omega/marketing/contact'), "inherit: ['js'] kept the base section's js in the bundle");

  // The theme ENTRY lane, the js twin of the scss hatch: the fixture ships no
  // `_theme.js`, so the packaged classy module it shadows is what must ride the
  // bundle — `#hero-demo-form` is a literal in themes/classy/js/hero-demo-form.js,
  // which only classy's `_theme.js` imports (a literal survives minification;
  // an identifier does not).
  need(js.includes('#hero-demo-form'), 'the shadowed packaged theme js reached the built bundle');

  return failures;
}

async function runCell(cell) {
  const tempRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'omega-corpus-'));
  const brandRoot = path.join(tempRoot, cell.id);
  fs.mkdirSync(brandRoot);
  const failures = [];
  let buildSeconds = 0;

  try {
    const report = await runOnboard(brandRoot, {
      id: cell.id,
      url: `https://${cell.id}.invalid`,
      ...(cell.targets ? { targets: cell.targets } : {}),
      manage: false,
    });

    if (!report.valid) failures.push('config invalid');
    if (!report.git?.initialized) failures.push('git not initialized');

    const targets = expectedTargets(cell);
    for (const target of targets) {
      // The onboard wizard names a brand's first target of a type for the type
      // itself, and the name IS the folder (#886)
      if (!fs.existsSync(path.join(brandRoot, 'targets', target, 'package.json'))) {
        failures.push(`targets/${target} missing for target ${target}`);
      }
    }
    const scaffoldedDirs = fs.readdirSync(path.join(brandRoot, 'targets'));
    if (scaffoldedDirs.length !== targets.length) {
      failures.push(`expected ${targets.length} target dirs, found ${scaffoldedDirs.length} (${scaffoldedDirs.join(', ')})`);
    }

    // The build half is timed on its own: a web cell now runs a REAL build
    // (#776), so the line says what that costs.
    const buildStarted = process.hrtime.bigint();
    if (cell.twoWeb) {
      failures.push(...await proveTwoWebTargets(brandRoot, cell));
    } else if (cell.themeOverride) {
      failures.push(...await proveThemeOverride(brandRoot, cell));
    } else if (targets.includes('web')) {
      if (cell.theme) flipTheme(brandRoot, cell.theme);
      if (cell.post) writePost(path.join(brandRoot, 'targets', 'web'));
      failures.push(...assertWebInvariants(cell, await buildWebTarget(brandRoot)));
    }
    if (targets.includes('web')) {
      buildSeconds = Number(process.hrtime.bigint() - buildStarted) / 1e9;
    }
  } catch (error) {
    failures.push(`crashed: ${error.message}`);
  }

  // The temp root is NOT removed here even on a pass — main() sweeps it after
  // the last cell. esbuild's node API snapshots process.cwd() ONCE, at module
  // load, and sends it as `absWorkingDir` on every build; a web cell builds
  // from its target root, so deleting the first passing cell's tree left every
  // later build dying with "Could not resolve" on paths that plainly exist
  // ([#776](https://github.com/Omega-JS-Stack/omega/issues/776)). The devkit
  // bundle composer now pins `absWorkingDir` per call
  // ([#777](https://github.com/Omega-JS-Stack/omega/issues/777)), so the
  // deferral is hygiene, not a requirement.
  return { cell, failures, brandRoot, buildSeconds, tempRoot };
}

async function main() {
  // This lane stands where `omega test` stands and builds in process, so it
  // names the environment for the whole process the way that verb does
  // ([#817](https://github.com/Omega-JS-Stack/omega/issues/817)): every read
  // below answers `testing`, and production's html minify stays off.
  setEnvironment('testing');

  console.log(`\nBrand-shape corpus — ${CELLS.length} cells (offline: real onboard + real web builds, no installs)\n`);
  const outcomes = [];

  const started = process.hrtime.bigint();

  for (const [index, cell] of CELLS.entries()) {
    const outcome = await runCell(cell);
    outcomes.push(outcome);
    // Sequential by design — never parallelize: the cells share one process and
    // one Eleventy template cache, and a real build is where the time goes.
    const timing = outcome.buildSeconds > 0 ? ` (build ${outcome.buildSeconds.toFixed(1)}s)` : '';
    const label = `[${index + 1}/${CELLS.length}] ${cell.id}${timing}`;
    if (outcome.failures.length === 0) {
      console.log(`  ✓ ${label}`);
    } else {
      console.log(`  ✗ ${label}\n      ${outcome.failures.join('\n      ')}\n      kept: ${outcome.brandRoot}`);
    }
  }

  const total = (Number(process.hrtime.bigint() - started) / 1e9).toFixed(1);
  const failed = outcomes.filter((outcome) => outcome.failures.length > 0);

  // Sweep the passing cells now that no build will run again (see runCell).
  // A failing cell keeps its tree for autopsy, as it always has.
  for (const outcome of outcomes) {
    if (outcome.failures.length === 0) fs.rmSync(outcome.tempRoot, { recursive: true, force: true });
  }
  console.log(failed.length === 0
    ? `\n  Shape corpus PASSED (${CELLS.length}/${CELLS.length}) in ${total}s\n`
    : `\n  Shape corpus FAILED — ${failed.length}/${CELLS.length} cells (${total}s)\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nShape corpus crashed: ${error.stack}\n`);
  process.exitCode = 1;
});
