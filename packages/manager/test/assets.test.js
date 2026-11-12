/**
 * Assets service tests — the REAL pipeline (sharp, png2icons, opentype.js)
 * against temp brand roots; nothing is faked because nothing leaves the
 * machine. Proves skip semantics, full generation from a brandmark, the
 * mtime idempotency that replaced omega-manager's --onboarding gate
 * (converged rerun = zero writes), staleness regeneration, the dry-run
 * zero-write guarantee, wordmark/combomark generation from a
 * programmatically-built font (missing-only — never overwritten), the
 * de-ITW'd no-packaged-font behavior, the svg-to-black conversion, and the
 * `--reset-assets` force refresh that clears the cache so a converged brand
 * rebuilds anyway (#214).
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const opentype = require('opentype.js');

const { recordBrand } = require('@omega.js/config');

// The machine registry is per-machine state: this file's fixtures write into a
// temp home, never the developer's ~/.omega (#677).
require('@omega.js/devkit/test/temp-home');

const { SERVICE_ORDER, OPERATIONS, DEFAULTS } = require('../src/config.js');
const { convertSvgToBlack } = require('../src/services/assets/lib/svg-to-black.js');
const service = require('../src/services/assets/index.js');

const BRANDMARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" rx="16" fill="#e63946"/></svg>';


// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Stage a temp brand root; brandmark included unless disabled. */
function stageBrand({ brandmark = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-assets-test-'));
  fs.mkdirSync(path.join(root, 'assets', 'logo'), { recursive: true });
  if (brandmark) {
    fs.writeFileSync(path.join(root, 'assets', 'logo', 'brandmark.svg'), BRANDMARK_SVG);
  }
  return root;
}

function brandConfig({ assets = {}, font } = {}) {
  return {
    brand: { id: 'fixture-brand', name: 'AB', url: 'https://fixture-brand.test', ...(font ? { font } : {}) },
    assets: assets === false ? false : { ...structuredClone(DEFAULTS.assets), ...assets },
    targets: { web: { type: 'web' } },
  };
}

function runService(root, config, { options = {}, context = {} } = {}) {
  return service.run({
    brandId: 'fixture-brand',
    brandRoot: root,
    brandConfig: config,
    brand: { id: 'fixture-brand', config, enabledTargets: ['web'], targets: [] },
    targets: [],
    operations: OPERATIONS.assets,
    options,
    serviceData: {},
    ...context,
  });
}

/** Every file under .omega/assets/, relative, sorted. */
function derivedFiles(root) {
  const base = path.join(root, '.omega', 'assets');
  if (!fs.existsSync(base)) {
    return [];
  }
  const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
  return walk(base).sort();
}

function mtimes(root, files) {
  return files.map((file) => fs.statSync(path.join(root, '.omega', 'assets', file)).mtimeMs);
}

/** Build a real minimal font (glyphs for A + B) and stage it in the brand. */
function stageFont(root) {
  const box = (width) => {
    const p = new opentype.Path();
    p.moveTo(0, 0);
    p.lineTo(0, 700);
    p.lineTo(width, 700);
    p.lineTo(width, 0);
    p.close();
    return p;
  };
  const glyphs = [
    new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 650, path: new opentype.Path() }),
    new opentype.Glyph({ name: 'A', unicode: 65, advanceWidth: 550, path: box(500) }),
    new opentype.Glyph({ name: 'B', unicode: 66, advanceWidth: 550, path: box(450) }),
  ];
  const font = new opentype.Font({
    familyName: 'TestFont', styleName: 'Regular', unitsPerEm: 1000, ascender: 800, descender: -200, glyphs,
  });
  fs.mkdirSync(path.join(root, 'assets', 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'fonts', 'TestFont-Regular.otf'), Buffer.from(font.toArrayBuffer()));
}

// ─── PSD templates (seed from the company + layer replacement + exports) ─────

const { readPsd, writePsdBuffer, initializeCanvas } = require('ag-psd');
const { createCanvas } = require('canvas');
const { TEMPLATE_CONFIG } = require('../src/services/assets/lib/assets-config.js');

initializeCanvas(createCanvas);

function filledCanvas(w, h, color) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return c;
}

/** A fixture PSD in the template layer convention (Main/Logo/Logo + optional text layers). */
function fixturePsd(width, height, { textLayers = [] } = {}) {
  return writePsdBuffer({
    width,
    height,
    children: [
      { name: 'Background', canvas: filledCanvas(width, height, '#ffffff'), left: 0, top: 0 },
      {
        name: 'Main',
        children: [
          {
            name: 'Logo',
            children: [
              { name: 'Logo', canvas: filledCanvas(200, 200, '#00ff00'), left: 100, top: 100 },
            ],
          },
          ...(textLayers.length > 0 ? [{
            name: 'Text',
            children: textLayers.map((name, i) => ({
              name,
              canvas: filledCanvas(300, 60, '#0000ff'),
              left: 50,
              top: 400 + i * 80,
              text: { text: 'PLACEHOLDER', style: { fontSize: 48 } },
            })),
          }] : []),
        ],
      },
    ],
  });
}

/**
 * The company brand, its `company/` tree carrying the shared templates, and
 * the brand's ONE key naming it (#677): the seed resolves through the same
 * `file('assets/templates')` rule every inherited file does.
 */
function stageCompany(brandRoot, templates) {
  const companyBrandRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-assets-company-'));
  const templatesDir = path.join(companyBrandRoot, 'company', 'assets', 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });
  for (const [name, buffer] of Object.entries(templates)) {
    fs.writeFileSync(path.join(templatesDir, `${name}.psd`), buffer);
  }

  writeBrandConfig(brandRoot, { company: { id: 'fixture-co' } });
  // The line the company brand's own run writes, nobody maintains it
  recordBrand({ id: 'fixture-co', root: companyBrandRoot, name: 'Fixture Co', url: 'https://fixture-co.test' });

  return companyBrandRoot;
}

/** The brand's authored config on disk: what the company resolver reads. */
function writeBrandConfig(brandRoot, extra = {}) {
  fs.mkdirSync(path.join(brandRoot, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(brandRoot, 'config', 'omega.json5'),
    JSON.stringify({ brand: { id: 'fixture-brand', name: 'AB', url: 'https://fixture-brand.test' }, ...extra }, null, 2),
  );
}

function readBrandPsd(root, name) {
  return readPsd(fs.readFileSync(path.join(root, 'assets', 'templates', `${name}.psd`)));
}

// ─── AI brandmark generation (MrLogo product ladder) ────────────────────────

const http = require('node:http');
const { openTtyPrompt } = require('./lib/interactive.js');

// Tests must never see real MrLogo credentials from the shell environment
const MRLOGO_ENV_VARS = ['MRLOGO_SERVICE_ACCOUNT', 'MRLOGO_API_KEY', 'MRLOGO_API_URL', 'LOGO_API_ID_TOKEN'];
for (const key of MRLOGO_ENV_VARS) {
  delete process.env[key];
}

const GENERATED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#1d3557"/></svg>';

/** A local logo API: POST /logos → mono SVG URL; GET /mono.svg → the SVG. */
function startLogoApi() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (req.method === 'POST' && req.url === '/logos') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ iteration: { files: { monoSvg: { url: `http://127.0.0.1:${server.address().port}/mono.svg` } } } }));
      } else if (req.url === '/mono.svg') {
        res.end(GENERATED_SVG);
      } else {
        res.statusCode = 404;
        res.end('not found');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/logos` }));
  });
}

// ─── Force refresh (#214) ────────────────────────────────────────────────────

const { resolveResetKinds, resetAssetsCache } = require('../src/services/assets/lib/reset.js');

module.exports = defineCases({
  type: 'group',
  description: 'assets',
  tests: [
    // ─── Registry / defaults pins ────────────────────────────────────────────────

    {
      name: 'assets: registered after directory with the six operations in dependency order',
      run: (ctx) => {
        ctx.expect(SERVICE_ORDER[SERVICE_ORDER.indexOf('directory') + 1]).toBe('assets');
        // templates before icons — icons prefers the composited icon.png it makes;
        // reconcile last, so everything this walk generated is already derived
        ctx.expect(OPERATIONS.assets.map((o) => o.name)).toEqual(['logo-gen', 'process', 'templates', 'icons', 'social-icons', 'reconcile']);
      },
    },

    {
      name: 'assets: defaults are enabled-only',
      run: (ctx) => {
        ctx.expect(DEFAULTS.assets).toEqual({ enabled: true });
      },
    },

    // ─── Setup / skip semantics ──────────────────────────────────────────────────

    {
      name: 'assets: assets.enabled = false skips the service',
      run: async (ctx) => {
        const root = stageBrand();
        const result = await runService(root, brandConfig({ assets: { enabled: false } }));
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/assets\.enabled/);
      },
    },

    {
      name: 'assets: scalar assets: false skips the service',
      run: async (ctx) => {
        const root = stageBrand();
        const result = await runService(root, brandConfig({ assets: false }));
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/assets\.enabled/);
      },
    },

    {
      name: 'assets: no brandmark.svg skips the service with guidance',
      run: async (ctx) => {
        const root = stageBrand({ brandmark: false });
        const result = await runService(root, brandConfig());
        ctx.expect(result.status).toBe('skipped');
        ctx.expect(result.reason).toMatch(/brandmark\.svg/);
        ctx.expect(derivedFiles(root)).toEqual([]);
      },
    },

    // ─── Full real generation ────────────────────────────────────────────────────

    {
      name: 'assets: a brandmark generates the full derived set for real',
      run: async (ctx) => {
        const root = stageBrand();
        const result = await runService(root, brandConfig());

        ctx.expect(result.status).toBe('success');

        const files = derivedFiles(root);
        // 20 logo files (2 SVGs + 9 color + 9 black PNGs), 2 app icons,
        // 4 social icons; the favicon set is each web build's own now
        ctx.expect(files.length).toBe(26);
        for (const expected of [
          'logo/brandmark/color-x.svg', 'logo/brandmark/black-x.svg',
          'logo/brandmark/color-16.png', 'logo/brandmark/color-2048.png', 'logo/brandmark/black-1024.png',
          'app/macos/icon.icns', 'app/windows/icon.ico',
          'social/brandmark/color-x.svg', 'social/brandmark/color-2048.png',
        ]) {
          ctx.expect(files.includes(expected), `missing ${expected}`).toBeTruthy();
        }

        // No wordmark/combomark sources → no derived dirs for them
        ctx.expect(!files.some((file) => file.startsWith('logo/wordmark/') || file.startsWith('logo/combomark/'))).toBeTruthy();

        // The black variant is actually black — the source color is gone
        const blackSvg = fs.readFileSync(path.join(root, '.omega', 'assets', 'logo', 'brandmark', 'black-x.svg'), 'utf8');
        ctx.expect(blackSvg.includes('fill="#000000"')).toBeTruthy();
        ctx.expect(!blackSvg.includes('#e63946')).toBeTruthy();

        // The color variant is the source verbatim
        const colorSvg = fs.readFileSync(path.join(root, '.omega', 'assets', 'logo', 'brandmark', 'color-x.svg'), 'utf8');
        ctx.expect(colorSvg).toBe(BRANDMARK_SVG);

        // Container formats carry their magic bytes
        const icns = fs.readFileSync(path.join(root, '.omega', 'assets', 'app', 'macos', 'icon.icns'));
        ctx.expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
      },
    },

    // ─── Idempotency (the upgrade that replaced the --onboarding gate) ───────────

    {
      name: 'assets: a converged rerun regenerates nothing',
      run: async (ctx) => {
        const root = stageBrand();
        await runService(root, brandConfig());

        const files = derivedFiles(root);
        const before = mtimes(root, files);

        const result = await runService(root, brandConfig());

        ctx.expect(result.status).toBe('success');
        ctx.expect(mtimes(root, files)).toEqual(before);
        ctx.expect(result.output.process.synced).toBe(true);
        ctx.expect(result.output.icons.synced).toBe(true);
        ctx.expect(result.output.socialIcons.synced).toBe(true);
      },
    },

    {
      name: 'assets: a touched brandmark regenerates its derived files',
      run: async (ctx) => {
        const root = stageBrand();
        await runService(root, brandConfig());

        const files = derivedFiles(root);
        const before = mtimes(root, files);

        // Source newer than every derived file → everything brandmark-derived is stale
        const future = new Date(Date.now() + 10000);
        fs.utimesSync(path.join(root, 'assets', 'logo', 'brandmark.svg'), future, future);

        const result = await runService(root, brandConfig());

        ctx.expect(result.status).toBe('success');
        const after = mtimes(root, files);
        const changed = files.filter((_, index) => after[index] !== before[index]);
        // Every derived file comes from the brandmark, so every one regenerates
        ctx.expect(changed).toEqual(files);
      },
    },

    // ─── Dry run ─────────────────────────────────────────────────────────────────

    {
      name: 'assets: dry run on a fresh brand writes nothing and reports the plan',
      run: async (ctx) => {
        const root = stageBrand();
        const result = await runService(root, brandConfig(), { options: { dryRun: true } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(derivedFiles(root)).toEqual([]);
        ctx.expect(result.output.process.planned).toBe(20);
        ctx.expect(result.output.icons.planned).toBe(2);
        ctx.expect(result.output.socialIcons.planned).toBe(4);
      },
    },

    // ─── logo-gen ────────────────────────────────────────────────────────────────

    {
      name: 'assets: no brand.font → wordmark/combomark noted, everything else proceeds',
      run: async (ctx) => {
        const root = stageBrand();
        const result = await runService(root, brandConfig());

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.logos).toEqual({ skipped: 'no brand.font' });
        ctx.expect(!fs.existsSync(path.join(root, 'assets', 'logo', 'wordmark.svg'))).toBeTruthy();
      },
    },

    {
      name: 'assets: brand.font + a real font file generates wordmark and combomark',
      run: async (ctx) => {
        const root = stageBrand();
        stageFont(root);

        const result = await runService(root, brandConfig({ font: 'TestFont-Regular' }));

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.logos.generated).toEqual(['wordmark', 'combomark']);

        const wordmark = fs.readFileSync(path.join(root, 'assets', 'logo', 'wordmark.svg'), 'utf8');
        ctx.expect(wordmark).toMatch(/<path d="M/); // text as path outlines
        const combomark = fs.readFileSync(path.join(root, 'assets', 'logo', 'combomark.svg'), 'utf8');
        ctx.expect(combomark.includes('<rect')).toBeTruthy(); // the embedded brandmark content
        ctx.expect(combomark).toMatch(/<path d="M/);

        // …and process derived their variant sets too
        const files = derivedFiles(root);
        ctx.expect(files.includes('logo/wordmark/color-x.svg')).toBeTruthy();
        ctx.expect(files.includes('logo/combomark/black-2048.png')).toBeTruthy();
      },
    },

    {
      name: 'assets: existing wordmark/combomark are never regenerated (missing-only)',
      run: async (ctx) => {
        const root = stageBrand();
        stageFont(root);
        await runService(root, brandConfig({ font: 'TestFont-Regular' }));

        const wordmarkPath = path.join(root, 'assets', 'logo', 'wordmark.svg');
        const before = fs.statSync(wordmarkPath).mtimeMs;

        // Even a newer brandmark must not clobber a (possibly hand-tuned) wordmark
        const future = new Date(Date.now() + 10000);
        fs.utimesSync(path.join(root, 'assets', 'logo', 'brandmark.svg'), future, future);

        const result = await runService(root, brandConfig({ font: 'TestFont-Regular' }));

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.logos.synced).toBe(true);
        ctx.expect(fs.statSync(wordmarkPath).mtimeMs).toBe(before);
      },
    },

    {
      name: 'assets: a configured font that cannot be found is an error',
      run: async (ctx) => {
        const root = stageBrand();
        const result = await runService(root, brandConfig({ font: 'Missing-Font' }));

        ctx.expect(result.status).toBe('error');
        ctx.expect(result.error).toMatch(/font "Missing-Font" not found/);
      },
    },

    {
      name: 'assets: dry run reports the planned wordmark/combomark without a font file',
      run: async (ctx) => {
        // The plan is reported before font resolution — dry run needs no font
        const root = stageBrand();
        const result = await runService(root, brandConfig({ font: 'Missing-Font' }), { options: { dryRun: true } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.logos.planned).toEqual(['wordmark', 'combomark']);
        ctx.expect(!fs.existsSync(path.join(root, 'assets', 'logo', 'wordmark.svg'))).toBeTruthy();
      },
    },

    // ─── svg-to-black ────────────────────────────────────────────────────────────

    {
      name: 'svg-to-black: fills, strokes, style values, and defs all go black',
      run: (ctx) => {
        const svg = [
          '<svg xmlns="http://www.w3.org/2000/svg">',
          '<defs><linearGradient id="g"><stop stop-color="#ff0000"/></linearGradient></defs>',
          '<rect fill="url(#g)" stroke="#00ff00"/>',
          '<circle style="fill:rgb(1,2,3);stroke:blue"/>',
          '<path fill="none" stroke="none"/>',
          '</svg>',
        ].join('');

        const black = convertSvgToBlack(svg);

        ctx.expect(!black.includes('<defs>')).toBeTruthy();
        ctx.expect(black.includes('fill="#000000" stroke="#000000"')).toBeTruthy();
        ctx.expect(black.includes('style="fill:#000000;stroke:#000000"')).toBeTruthy();
        // none is a deliberate absence, not a color
        ctx.expect(black.includes('fill="none" stroke="none"')).toBeTruthy();
        ctx.expect(!black.includes('ff0000') && !black.includes('00ff00')).toBeTruthy();
      },
    },

    {
      name: 'templates: seeded from the company, logo layer re-rastered, PNG exported, icons consume the composite',
      run: async (ctx) => {
        const root = stageBrand();
        stageCompany(root, { 'app-macos-icon': fixturePsd(1024, 1024) });

        const result = await runService(root, brandConfig());
        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.templates.seeded).toBe(1);
        ctx.expect(result.output.templates.processed).toBe(1);
        ctx.expect(result.output.templates.missing.length).toBe(Object.keys(TEMPLATE_CONFIG).length - 1);

        // The seeded PSD is now brand collateral with the brandmark in its logo layer
        const psd = readBrandPsd(root, 'app-macos-icon');
        const logo = psd.children.find((l) => l.name === 'Main')
          .children.find((l) => l.name === 'Logo').children[0];
        const logoSize = Math.floor(0.575 * 1024);
        ctx.expect(logo.canvas.width).toBe(logoSize);
        ctx.expect(logo.canvas.height).toBe(logoSize);
        // Centered inside the configured bounds — not the fixture's 100,100
        ctx.expect(logo.left > 79 && logo.top > 90, `logo at ${logo.left},${logo.top}`).toBeTruthy();
        // The re-raster carries the brandmark's red, not the fixture's green
        const px = logo.canvas.getContext('2d').getImageData(logoSize / 2, logoSize / 2, 1, 1).data;
        ctx.expect(px[0] > 200 && px[1] < 100, `center pixel rgb(${px[0]},${px[1]},${px[2]})`).toBeTruthy();

        // The export composite exists at template dimensions
        const iconPng = path.join(root, '.omega', 'assets', 'app', 'macos', 'icon.png');
        ctx.expect(fs.existsSync(iconPng)).toBeTruthy();
        const sharp = require('sharp');
        const meta = await sharp(iconPng).metadata();
        ctx.expect(meta.width).toBe(1024);
        ctx.expect(meta.height).toBe(1024);

        // The icons op ran AFTER templates and used the composited icon.png
        // (its .icns must be newer than the composite it derives from)
        const icns = path.join(root, '.omega', 'assets', 'app', 'macos', 'icon.icns');
        ctx.expect(fs.statSync(icns).mtimeMs >= fs.statSync(iconPng).mtimeMs).toBeTruthy();
      },
    },

    {
      name: 'templates: text layers take brandConfig values and overflow shrinks the font',
      run: async (ctx) => {
        const root = stageBrand();
        stageCompany(root, {
          'social-og-image': fixturePsd(1200, 630, { textLayers: ['Brand Name', 'Brand Tagline'] }),
        });

        const config = brandConfig();
        config.brand.tagline = 'A very long fixture tagline that cannot possibly fit inside seventy percent of the canvas width without shrinking quite a lot first';

        const result = await runService(root, config);
        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.templates.processed).toBe(1);

        const psd = readBrandPsd(root, 'social-og-image');
        const textFolder = psd.children.find((l) => l.name === 'Main').children.find((l) => l.name === 'Text');
        const nameLayer = textFolder.children.find((l) => l.name === 'Brand Name');
        const taglineLayer = textFolder.children.find((l) => l.name === 'Brand Tagline');

        ctx.expect(nameLayer.text.text).toBe('AB');
        ctx.expect(taglineLayer.text.text).toBe(config.brand.tagline);
        // 'AB' fits at 48pt; the long tagline had to shrink
        ctx.expect(nameLayer.text.style.fontSize).toBe(48);
        ctx.expect(taglineLayer.text.style.fontSize < 48, `tagline still ${taglineLayer.text.style.fontSize}pt`).toBeTruthy();

        const meta = await require('sharp')(path.join(root, '.omega', 'assets', 'social', 'og-image.png')).metadata();
        ctx.expect(meta.width).toBe(1200);
        ctx.expect(meta.height).toBe(630);
      },
    },

    {
      name: 'templates: converged rerun is zero-work; a touched PSD reprocesses',
      run: async (ctx) => {
        const root = stageBrand();
        stageCompany(root, { 'app-macos-icon': fixturePsd(1024, 1024) });
        await runService(root, brandConfig());

        const psdPath = path.join(root, 'assets', 'templates', 'app-macos-icon.psd');
        const pngPath = path.join(root, '.omega', 'assets', 'app', 'macos', 'icon.png');
        const before = [fs.statSync(psdPath).mtimeMs, fs.statSync(pngPath).mtimeMs];

        const rerun = await runService(root, brandConfig());
        ctx.expect(rerun.output.templates.processed).toBe(0);
        ctx.expect(rerun.output.templates.seeded).toBe(0);
        ctx.expect(rerun.output.templates.fresh).toBe(1);
        ctx.expect([fs.statSync(psdPath).mtimeMs, fs.statSync(pngPath).mtimeMs]).toEqual(before);

        // A manual Photoshop edit (mtime bump) → the logo refresh + export rerun
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(psdPath, future, future);
        const touched = await runService(root, brandConfig());
        ctx.expect(touched.output.templates.processed).toBe(1);
        ctx.expect(fs.statSync(pngPath).mtimeMs > before[1]).toBeTruthy();
      },
    },

    {
      name: 'templates: dry-run plans the seed + process and writes nothing',
      run: async (ctx) => {
        const root = stageBrand();
        stageCompany(root, { 'app-macos-icon': fixturePsd(1024, 1024) });

        const result = await runService(root, brandConfig(), { options: { dryRun: true } });
        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.templates.planned).toEqual(['app-macos-icon (seed + process)']);
        ctx.expect(!fs.existsSync(path.join(root, 'assets', 'templates'))).toBeTruthy();
        ctx.expect(derivedFiles(root)).toEqual([]);
      },
    },

    {
      name: 'templates: no PSDs anywhere is a quiet note, never a warn',
      run: async (ctx) => {
        const root = stageBrand(); // no company marker, no brand templates
        const result = await runService(root, brandConfig());

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.templates.missing.length).toBe(Object.keys(TEMPLATE_CONFIG).length);
        ctx.expect(result.output.templates.processed).toBe(0);
      },
    },

    {
      name: 'brandmark: interactive generation via the logo API roots the whole derived set',
      run: async (ctx) => {
        const api = await startLogoApi();
        const root = stageBrand({ brandmark: false });
        const config = brandConfig();
        config.brand.description = 'A fixture brand';

        process.env.MRLOGO_API_URL = api.url;
        process.env.LOGO_API_ID_TOKEN = 'test-token-123';
        const tty = openTtyPrompt();
        try {
          const running = runService(root, config);
          await tty.answer('Logo prompt', 'geometric fox\r');
          const result = await running;

          ctx.expect(result.status).toBe('success');

          // The generated SVG landed as committed brand collateral
          ctx.expect(fs.readFileSync(path.join(root, 'assets', 'logo', 'brandmark.svg'), 'utf8')).toBe(GENERATED_SVG);

          // The request carried the token + the brand identity + the typed direction
          const post = api.requests.find((r) => r.method === 'POST');
          ctx.expect(post.authorization).toBe('Bearer test-token-123');
          ctx.expect(post.body.brandName).toBe('AB');
          ctx.expect(post.body.mode).toBe('brandmark');
          ctx.expect(post.body.description).toBe('A fixture brand. geometric fox');
          ctx.expect(post.body.colors).toEqual(['#000000']);

          // And the rest of the service derived from it in the same run
          const colorSvg = fs.readFileSync(path.join(root, '.omega', 'assets', 'logo', 'brandmark', 'color-x.svg'), 'utf8');
          ctx.expect(colorSvg).toBe(GENERATED_SVG);
        } finally {
          tty.close();
          delete process.env.MRLOGO_API_URL;
          delete process.env.LOGO_API_ID_TOKEN;
          api.server.close();
        }
      },
    },

    {
      name: 'brandmark: no credentials skips with the ladder guidance — no API call',
      run: async (ctx) => {
        const api = await startLogoApi();
        const root = stageBrand({ brandmark: false });

        // No MRLOGO_SERVICE_ACCOUNT / MRLOGO_API_KEY / LOGO_API_ID_TOKEN → nothing to mint with
        process.env.MRLOGO_API_URL = api.url;
        const tty = openTtyPrompt();
        try {
          const result = await runService(root, brandConfig());

          ctx.expect(result.status).toBe('skipped');
          ctx.expect(result.reason).toMatch(/brandmark\.svg/);
          ctx.expect(result.reason).toMatch(/MRLOGO_SERVICE_ACCOUNT/);
          ctx.expect(api.requests.length).toBe(0);
          ctx.expect(!fs.existsSync(path.join(root, 'assets', 'logo', 'brandmark.svg'))).toBeTruthy();
        } finally {
          tty.close();
          delete process.env.MRLOGO_API_URL;
          api.server.close();
        }
      },
    },

    {
      name: 'brandmark: dry runs never generate; non-interactive runs GENERATE when credentialed',
      run: async (ctx) => {
        const api = await startLogoApi();
        process.env.MRLOGO_API_URL = api.url;
        process.env.LOGO_API_ID_TOKEN = 'test-token-123';
        try {
          // Dry run: interactive TTY, credential present — still no attempt
          const tty = openTtyPrompt();
          try {
            const dry = await runService(stageBrand({ brandmark: false }), brandConfig(), { options: { dryRun: true } });
            ctx.expect(dry.status).toBe('skipped');
            ctx.expect(api.requests.length).toBe(0);
          } finally {
            tty.close();
          }

          // Headless with a credential: setting it IS the consent — the brandmark
          // mints and the whole leg runs to success. This is the pipeline story.
          const headless = await runService(stageBrand({ brandmark: false }), brandConfig());
          ctx.expect(headless.status).toBe('success');
          const mint = api.requests.find((request) => request.url === '/logos');
          ctx.expect(mint, 'the logo API was called').toBeTruthy();
          ctx.expect(mint.body.brandName).toBe('AB');
        } finally {
          delete process.env.MRLOGO_API_URL;
          delete process.env.LOGO_API_ID_TOKEN;
          api.server.close();
        }
      },
    },

    {
      name: 'brandmark: MRLOGO_API_KEY rides the same Bearer transport (BEM resolves non-JWTs by api.privateKey)',
      run: async (ctx) => {
        const api = await startLogoApi();
        const root = stageBrand({ brandmark: false });

        process.env.MRLOGO_API_URL = api.url;
        process.env.MRLOGO_API_KEY = 'k'.repeat(43);
        try {
          const result = await runService(root, brandConfig());

          ctx.expect(result.status).toBe('success');
          const post = api.requests.find((r) => r.method === 'POST');
          ctx.expect(post.authorization).toBe(`Bearer ${'k'.repeat(43)}`);
          ctx.expect(fs.readFileSync(path.join(root, 'assets', 'logo', 'brandmark.svg'), 'utf8')).toBe(GENERATED_SVG);
        } finally {
          delete process.env.MRLOGO_API_URL;
          delete process.env.MRLOGO_API_KEY;
          api.server.close();
        }
      },
    },

    {
      name: 'reset: the flag resolves to kinds: bare = both, a value = that kind, unknown throws',
      run: (ctx) => {
        ctx.expect(resolveResetKinds(undefined)).toEqual([]);
        ctx.expect(resolveResetKinds(true)).toEqual(['logos', 'templates']);
        ctx.expect(resolveResetKinds('templates')).toEqual(['templates']);
        ctx.expect(resolveResetKinds('templates,logos')).toEqual(['logos', 'templates']);
        ctx.expect(() => resolveResetKinds('logo')).toThrow(/Unknown --reset-assets kind\(s\): logo/);
      },
    },

    {
      name: 'reset: clearing one kind leaves the other kind and the brand sources alone',
      run: async (ctx) => {
        const root = stageBrand();
        stageCompany(root, { 'app-macos-icon': fixturePsd(1024, 1024) });
        await runService(root, brandConfig());
        const outDir = path.join(root, '.omega', 'assets');

        const logos = resetAssetsCache({ outDir, kinds: ['logos'] });

        ctx.expect(logos.removed.includes('logo/brandmark')).toBeTruthy();
        ctx.expect(logos.removed.includes('social/brandmark')).toBeTruthy();
        ctx.expect(logos.removed.includes(path.join('app', 'macos', 'icon.icns'))).toBeTruthy();
        // The templates kind's export survives; only it is left
        ctx.expect(derivedFiles(root)).toEqual(['app/macos/icon.png']);

        const templates = resetAssetsCache({ outDir, kinds: ['templates'] });

        ctx.expect(templates.removed.includes(path.join('app', 'macos', 'icon.png'))).toBeTruthy();
        ctx.expect(derivedFiles(root)).toEqual([]);

        // Only .omega/assets/ is cache: the brand's committed sources are never touched
        ctx.expect(fs.existsSync(path.join(root, 'assets', 'logo', 'brandmark.svg'))).toBeTruthy();
        ctx.expect(fs.existsSync(path.join(root, 'assets', 'templates', 'app-macos-icon.psd'))).toBeTruthy();
      },
    },

    {
      name: 'assets: --reset-assets regenerates the derived set a converged rerun skips',
      run: async (ctx) => {
        const root = stageBrand();
        await runService(root, brandConfig());

        const files = derivedFiles(root);
        const before = mtimes(root, files);

        // Timestamps alone: the rerun has nothing to do
        const converged = await runService(root, brandConfig());
        ctx.expect(converged.output.process.synced).toBe(true);
        ctx.expect(mtimes(root, files)).toEqual(before);

        // Forced: the cache is cleared, so the same walk rebuilds every file
        const forced = await runService(root, brandConfig(), { options: { resetAssets: true } });

        ctx.expect(forced.status).toBe('success');
        ctx.expect(derivedFiles(root)).toEqual(files);
        ctx.expect(forced.output.process.generated).toBe(20);
        ctx.expect(forced.output.icons.generated).toBe(2);
        ctx.expect(forced.output.socialIcons.generated).toBe(4);
        const after = mtimes(root, files);
        ctx.expect(files.filter((_, index) => after[index] === before[index]).length).toBe(0);
      },
    },

    {
      name: 'assets: --reset-assets=templates re-exports the PSD and leaves the logo variants fresh',
      run: async (ctx) => {
        const root = stageBrand();
        stageCompany(root, { 'app-macos-icon': fixturePsd(1024, 1024) });
        await runService(root, brandConfig());

        const logoSvg = path.join(root, '.omega', 'assets', 'logo', 'brandmark', 'color-x.svg');
        const iconPng = path.join(root, '.omega', 'assets', 'app', 'macos', 'icon.png');
        const before = { logo: fs.statSync(logoSvg).mtimeMs, icon: fs.statSync(iconPng).mtimeMs };

        const result = await runService(root, brandConfig(), { options: { resetAssets: 'templates' } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.templates.processed).toBe(1);
        // The PSD is brand collateral, not cache: it is re-processed, never re-seeded
        ctx.expect(result.output.templates.seeded).toBe(0);
        ctx.expect(result.output.process.synced).toBe(true);
        ctx.expect(fs.statSync(logoSvg).mtimeMs).toBe(before.logo);
        ctx.expect(fs.statSync(iconPng).mtimeMs > before.icon).toBeTruthy();
      },
    },

    {
      name: 'assets: a dry run reports the reset and deletes nothing',
      run: async (ctx) => {
        const root = stageBrand();
        await runService(root, brandConfig());

        const files = derivedFiles(root);
        const before = mtimes(root, files);

        const result = await runService(root, brandConfig(), { options: { resetAssets: true, dryRun: true } });

        ctx.expect(result.status).toBe('success');
        ctx.expect(derivedFiles(root)).toEqual(files);
        ctx.expect(mtimes(root, files)).toEqual(before);
      },
    },

    // ─── Reconcile: writes delete what the sources no longer derive (#636) ───────

    {
      name: 'reconcile: a stray inside an output dir goes, the derived set stays',
      run: async (ctx) => {
        const root = stageBrand();
        await runService(root, brandConfig());
        const files = derivedFiles(root);

        // Leftovers of an older shape, inside two operations' own output dirs
        fs.writeFileSync(path.join(root, '.omega', 'assets', 'logo', 'brandmark', 'color-64.webp'), 'stray');
        fs.writeFileSync(path.join(root, '.omega', 'assets', 'social', 'brandmark', 'color-64.png'), 'stray');

        const result = await runService(root, brandConfig());

        ctx.expect(result.status).toBe('success');
        ctx.expect(result.output.reconcile.removed).toBe(2);
        ctx.expect(derivedFiles(root)).toEqual(files);
      },
    },

    {
      name: 'reconcile: only the operations\' own output dirs are swept',
      run: async (ctx) => {
        const root = stageBrand();
        await runService(root, brandConfig());

        // Inside .omega/assets/ but outside every output dir — out of boundary
        const outside = path.join(root, '.omega', 'assets', 'notes.txt');
        fs.writeFileSync(outside, 'not the assets service\'s');

        const result = await runService(root, brandConfig());

        ctx.expect(result.output.reconcile.removed).toBe(0);
        ctx.expect(fs.existsSync(outside)).toBeTruthy();
      },
    },

    {
      name: 'reconcile: dropping a logo source removes everything it derived, and only that',
      run: async (ctx) => {
        const root = stageBrand();
        stageFont(root);
        await runService(root, brandConfig({ font: 'TestFont-Regular' }));
        ctx.expect(derivedFiles(root).some((file) => file.startsWith('logo/wordmark/'))).toBeTruthy();

        // The brand drops the wordmark source; no brand.font, so logo-gen (missing-only)
        // has nothing to regenerate it from
        fs.rmSync(path.join(root, 'assets', 'logo', 'wordmark.svg'));

        const result = await runService(root, brandConfig());

        ctx.expect(result.status).toBe('success');
        // 2 SVGs + 5 sizes × 2 variants
        ctx.expect(result.output.reconcile.removed).toBe(12);
        const files = derivedFiles(root);
        ctx.expect(!files.some((file) => file.startsWith('logo/wordmark/'))).toBeTruthy();
        ctx.expect(files.some((file) => file.startsWith('logo/combomark/'))).toBeTruthy();
        ctx.expect(files.includes('logo/brandmark/color-x.svg')).toBeTruthy();
      },
    },

    {
      name: 'reconcile: a removed PSD takes its exports with it, the app icon stays',
      run: async (ctx) => {
        const root = stageBrand();
        stageCompany(root, { 'app-macos-icon': fixturePsd(1024, 1024) });
        await runService(root, brandConfig());
        ctx.expect(derivedFiles(root).includes('app/macos/icon.png')).toBeTruthy();

        // Drop the brand's PSD and the company key that would re-seed it
        fs.rmSync(path.join(root, 'assets', 'templates', 'app-macos-icon.psd'));
        writeBrandConfig(root);

        const result = await runService(root, brandConfig());

        ctx.expect(result.output.reconcile.removed).toBe(1);
        const files = derivedFiles(root);
        ctx.expect(!files.includes('app/macos/icon.png')).toBeTruthy();
        ctx.expect(files.includes('app/macos/icon.icns')).toBeTruthy();
      },
    },

    {
      name: 'reconcile: set → unset → rerun converges once and stays converged',
      run: async (ctx) => {
        const root = stageBrand();
        stageFont(root);
        await runService(root, brandConfig({ font: 'TestFont-Regular' }));

        fs.rmSync(path.join(root, 'assets', 'logo', 'wordmark.svg'));
        const unset = await runService(root, brandConfig());
        ctx.expect(unset.output.reconcile.removed).toBe(12);

        const files = derivedFiles(root);
        const before = mtimes(root, files);
        const rerun = await runService(root, brandConfig());

        ctx.expect(rerun.output.reconcile.removed).toBe(0);
        ctx.expect(derivedFiles(root)).toEqual(files);
        ctx.expect(mtimes(root, files)).toEqual(before);
      },
    },

    {
      name: 'reconcile: a dry run names the leftovers and deletes nothing',
      run: async (ctx) => {
        const root = stageBrand();
        await runService(root, brandConfig());

        const stray = path.join(root, '.omega', 'assets', 'social', 'brandmark', 'legacy-touch-icon.png');
        fs.writeFileSync(stray, 'stray');

        const result = await runService(root, brandConfig(), { options: { dryRun: true } });

        ctx.expect(result.output.reconcile.planned).toBe(1);
        ctx.expect(fs.existsSync(stray)).toBeTruthy();
      },
    },

    {
      name: 'brandmark: operator SA ensures the brand\'s own product user and generates with ITS api key',
      run: async (ctx) => {
        const api = await startLogoApi();
        const root = stageBrand({ brandmark: false });
        const config = brandConfig();
        config.brand.contact = { email: 'support@fixture-brand.test' };

        // Injected seams stand in for MRLOGO_SERVICE_ACCOUNT (the trio pattern):
        // the user already exists on MrLogo, its doc carries the private key
        const lookups = [];
        const reads = [];
        const context = {
          mrlogoAuthAdmin: {
            getUserByEmail: async (email) => { lookups.push(email); return { uid: 'mrlogo-uid-1' }; },
          },
          mrlogoDb: {
            getDoc: async (docPath) => { reads.push(docPath); return { api: { privateKey: 'pk-fixture-brand-key' } }; },
          },
        };

        process.env.MRLOGO_API_URL = api.url;
        try {
          const result = await runService(root, config, { context });

          ctx.expect(result.status).toBe('success');
          ctx.expect(lookups).toEqual(['support@fixture-brand.test']);
          ctx.expect(reads).toEqual(['users/mrlogo-uid-1']);
          const post = api.requests.find((r) => r.method === 'POST');
          ctx.expect(post.authorization).toBe('Bearer pk-fixture-brand-key');
        } finally {
          delete process.env.MRLOGO_API_URL;
          api.server.close();
        }
      },
    },
  ],
});
