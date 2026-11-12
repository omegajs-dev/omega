// Build-layer tests for lib/sign-helpers/resolve-icons.js: convention waterfall
// (platform > global > linux-via-windows > brand brandmark for the app slot >
// bundled) + retina derivation.

const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const jetpack = require('fs-jetpack');
const sharp   = require('sharp');
const defineCases = require('@omega.js/devkit/test/define-cases');

function stage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-icons-'));
  const projectRoot    = path.join(root, 'project');
  const distRoot       = path.join(root, 'project', 'dist');
  const emDefaultsRoot = path.join(root, 'desktop-defaults');
  jetpack.dir(projectRoot);
  jetpack.dir(distRoot);
  jetpack.dir(emDefaultsRoot);
  return { root, projectRoot, distRoot, emDefaultsRoot };
}

// Emit a real PNG so sharp can read metadata (used for retina slots).
async function realPng(p, width, height) {
  jetpack.dir(path.dirname(p));
  await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  }).png().toFile(p);
}

// Minimal PNG signature for slots that don't need sharp metadata (non-retina).
function fakePng(p) {
  jetpack.dir(path.dirname(p));
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
}

const RGB = { red: { r: 255, g: 0, b: 0 }, green: { r: 0, g: 255, b: 0 }, blue: { r: 0, g: 0, b: 255 } };

// A real solid-colour PNG, so a resolved icon can be told apart by its pixels.
async function solidPng(p, colour, size = 64) {
  jetpack.dir(path.dirname(p));
  await sharp({ create: { width: size, height: size, channels: 4, background: { ...RGB[colour], alpha: 1 } } }).png().toFile(p);
}

// A brandmark SVG painted edge to edge in one colour.
function brandmark(p, colour) {
  const { r, g, b } = RGB[colour];
  jetpack.write(p, `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="rgb(${r},${g},${b})"/></svg>`);
}

// The colour name of the image's centre pixel: its strongest channel, or 'clear'.
async function centreColour(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;
  const [r, g, b, alpha] = data.subarray(at, at + 4);
  if (alpha < 128) return 'clear';
  if (r > g && r > b) return 'red';
  return g > b ? 'green' : 'blue';
}

// A desktop target inside a brand monorepo whose brandmark is red, with blue bundled defaults.
async function stageBrand() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-icons-brand-'));
  const brandRoot      = path.join(root, 'brand');
  const projectRoot    = path.join(brandRoot, 'targets', 'desktop');
  const distRoot       = path.join(projectRoot, 'dist');
  const emDefaultsRoot = path.join(root, 'desktop-defaults');
  jetpack.write(path.join(brandRoot, 'config', 'omega.json5'), `{ brand: { id: 'staged', name: 'Staged' }, targets: { desktop: { type: 'desktop' } } }`);
  brandmark(path.join(brandRoot, 'assets', 'logo', 'brandmark.svg'), 'red');
  jetpack.write(path.join(projectRoot, 'package.json'), '{ "name": "staged-desktop", "version": "1.0.0" }');
  jetpack.dir(distRoot);
  await solidPng(path.join(emDefaultsRoot, 'icons', 'mac', 'icon.png'), 'blue');
  await solidPng(path.join(emDefaultsRoot, 'icons', 'windows', 'icon.png'), 'blue');
  return { root, brandRoot, projectRoot, distRoot, emDefaultsRoot };
}

// Every file in the target's source tree (all but dist/) with its bytes.
function sourceTree(projectRoot) {
  return fs.readdirSync(projectRoot, { recursive: true })
    .filter((rel) => rel.split(path.sep)[0] !== 'dist' && fs.statSync(path.join(projectRoot, rel)).isFile())
    .sort()
    .map((rel) => [rel, fs.readFileSync(path.join(projectRoot, rel)).toString('base64')]);
}

module.exports = defineCases({
  type: 'suite',
  layer: 'build',
  description: 'resolve-icons — convention waterfall + retina derivation',
  tests: [
    {
      name: 'falls back to @omega.js/desktop bundled defaults when consumer has nothing',
      run: async (ctx) => {
        const { root, projectRoot, distRoot, emDefaultsRoot } = stage();
        try {
          fakePng(path.join(emDefaultsRoot, 'icons', 'mac', 'icon.png'));
          fakePng(path.join(emDefaultsRoot, 'icons', 'windows', 'icon.png'));

          const { resolveAndCopy } = require(path.join(__dirname, '..', '..', '..', 'lib', 'sign-helpers', 'resolve-icons.js'));
          const out = await resolveAndCopy({ config: {}, projectRoot, distRoot, emDefaultsRoot });

          ctx.expect(out.mac.app).toBe(path.join(distRoot, 'config', 'icons', 'mac', 'icon.png'));
          ctx.expect(out.windows.app).toBe(path.join(distRoot, 'config', 'icons', 'windows', 'icon.png'));
          ctx.expect(jetpack.exists(out.mac.app)).toBeTruthy();
          ctx.expect(jetpack.exists(out.windows.app)).toBeTruthy();
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'platform-specific override beats bundled default',
      run: async (ctx) => {
        const { root, projectRoot, distRoot, emDefaultsRoot } = stage();
        try {
          fakePng(path.join(emDefaultsRoot, 'icons', 'mac', 'icon.png'));
          const consumerIcon = path.join(projectRoot, 'config', 'icons', 'mac', 'icon.png');
          fakePng(consumerIcon);
          fs.writeFileSync(consumerIcon, Buffer.from('consumer-bytes'));

          const { resolveAndCopy } = require(path.join(__dirname, '..', '..', '..', 'lib', 'sign-helpers', 'resolve-icons.js'));
          const out = await resolveAndCopy({ config: {}, projectRoot, distRoot, emDefaultsRoot });

          const bytes = fs.readFileSync(out.mac.app);
          ctx.expect(bytes.toString()).toBe('consumer-bytes');
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'global/ fallback covers all platforms when no platform-specific override exists',
      run: async (ctx) => {
        const { root, projectRoot, distRoot, emDefaultsRoot } = stage();
        try {
          // Bundled defaults exist for all three platforms — but consumer-global wins.
          fakePng(path.join(emDefaultsRoot, 'icons', 'mac', 'icon.png'));
          fakePng(path.join(emDefaultsRoot, 'icons', 'windows', 'icon.png'));

          // Consumer ships ONE file at the global path. All three platforms pick it up.
          const globalIcon = path.join(projectRoot, 'config', 'icons', 'global', 'icon.png');
          fakePng(globalIcon);
          fs.writeFileSync(globalIcon, Buffer.from('global-bytes'));

          const { resolveAndCopy } = require(path.join(__dirname, '..', '..', '..', 'lib', 'sign-helpers', 'resolve-icons.js'));
          const out = await resolveAndCopy({ config: {}, projectRoot, distRoot, emDefaultsRoot });

          for (const platform of ['mac', 'windows', 'linux']) {
            ctx.expect(out[platform].app).toBeDefined();
            const bytes = fs.readFileSync(out[platform].app);
            ctx.expect(bytes.toString()).toBe('global-bytes');
          }
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'platform-specific override beats global fallback',
      run: async (ctx) => {
        const { root, projectRoot, distRoot, emDefaultsRoot } = stage();
        try {
          fakePng(path.join(emDefaultsRoot, 'icons', 'windows', 'icon.png'));

          // Global file exists.
          const globalIcon = path.join(projectRoot, 'config', 'icons', 'global', 'icon.png');
          fakePng(globalIcon);
          fs.writeFileSync(globalIcon, Buffer.from('global-bytes'));

          // Mac-specific override exists — should win for macOS.
          const macIcon = path.join(projectRoot, 'config', 'icons', 'mac', 'icon.png');
          fakePng(macIcon);
          fs.writeFileSync(macIcon, Buffer.from('mac-specific-bytes'));

          const { resolveAndCopy } = require(path.join(__dirname, '..', '..', '..', 'lib', 'sign-helpers', 'resolve-icons.js'));
          const out = await resolveAndCopy({ config: {}, projectRoot, distRoot, emDefaultsRoot });

          ctx.expect(fs.readFileSync(out.mac.app).toString()).toBe('mac-specific-bytes');
          ctx.expect(fs.readFileSync(out.windows.app).toString()).toBe('global-bytes');
          ctx.expect(fs.readFileSync(out.linux.app).toString()).toBe('global-bytes');
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'Windows tray falls back to Windows app icon when no tray.png exists',
      run: async (ctx) => {
        const { root, projectRoot, distRoot, emDefaultsRoot } = stage();
        try {
          fakePng(path.join(emDefaultsRoot, 'icons', 'windows', 'icon.png'));
          // No windows/tray.png anywhere.

          const { resolveAndCopy } = require(path.join(__dirname, '..', '..', '..', 'lib', 'sign-helpers', 'resolve-icons.js'));
          const out = await resolveAndCopy({ config: {}, projectRoot, distRoot, emDefaultsRoot });

          ctx.expect(out.windows.tray).toBeDefined();
          ctx.expect(out.windows.tray).toBe(out.windows.app);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'Linux resolves through Windows bundled defaults when no Linux source exists',
      run: async (ctx) => {
        const { root, projectRoot, distRoot, emDefaultsRoot } = stage();
        try {
          fakePng(path.join(emDefaultsRoot, 'icons', 'windows', 'icon.png'));
          // No Linux bundled dir anywhere — Linux must walk the chain through Windows bundled.

          const { resolveAndCopy } = require(path.join(__dirname, '..', '..', '..', 'lib', 'sign-helpers', 'resolve-icons.js'));
          const out = await resolveAndCopy({ config: {}, projectRoot, distRoot, emDefaultsRoot });

          // Linux gets its own dist path (icon copied INTO linux/), populated from the
          // Windows bundled source.
          ctx.expect(out.linux.app).toBe(path.join(distRoot, 'config', 'icons', 'linux', 'icon.png'));
          ctx.expect(jetpack.exists(out.linux.app)).toBeTruthy();
          // Tray: no tray source anywhere → linux.tray falls back to windows.tray, which
          // itself fell back to windows.app (the Windows-tray-to-Windows-app special case).
          ctx.expect(out.linux.tray).toBe(out.windows.app);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'Linux: consumer windows/ override beats bundled (legacy linux→windows fallback)',
      run: async (ctx) => {
        const { root, projectRoot, distRoot, emDefaultsRoot } = stage();
        try {
          fakePng(path.join(emDefaultsRoot, 'icons', 'linux', 'icon.png'));
          // No bundled linux defaults; consumer ships a windows/ override.
          const winIcon = path.join(projectRoot, 'config', 'icons', 'windows', 'icon.png');
          fakePng(winIcon);
          fs.writeFileSync(winIcon, Buffer.from('win-consumer-bytes'));

          const { resolveAndCopy } = require(path.join(__dirname, '..', '..', '..', 'lib', 'sign-helpers', 'resolve-icons.js'));
          const out = await resolveAndCopy({ config: {}, projectRoot, distRoot, emDefaultsRoot });

          // Linux pulled from the consumer's windows/ dir (legacy fallback), not bundled linux/.
          ctx.expect(fs.readFileSync(out.linux.app).toString()).toBe('win-consumer-bytes');
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'retina slots: source treated as @2x, @1x derived at half size',
      run: async (ctx) => {
        const { root, projectRoot, distRoot, emDefaultsRoot } = stage();
        try {
          fakePng(path.join(emDefaultsRoot, 'icons', 'mac', 'icon.png'));
          // Input source files at retina (native) size. @omega.js/desktop should emit both @1x + @2x in dist.
          // Tray input is `tray.png`; @omega.js/desktop renames the dist output to `trayTemplate.png` (macOS magic).
          await realPng(path.join(emDefaultsRoot, 'icons', 'mac', 'tray.png'), 32, 32);
          await realPng(path.join(emDefaultsRoot, 'icons', 'mac', 'dmg.png'), 1080, 760);

          const { resolveAndCopy } = require(path.join(__dirname, '..', '..', '..', 'lib', 'sign-helpers', 'resolve-icons.js'));
          const out = await resolveAndCopy({ config: {}, projectRoot, distRoot, emDefaultsRoot });

          // Both @1x and @2x slots populated.
          ctx.expect(out.mac.tray).toBeDefined();
          ctx.expect(out.mac.tray2x).toBeDefined();
          ctx.expect(out.mac.dmg).toBeDefined();
          ctx.expect(out.mac.dmg2x).toBeDefined();
          // app slot has no retina flag.
          ctx.expect(out.mac.app2x).toBeUndefined();

          // Tray output filename is trayTemplate.png (renamed for macOS auto-inversion magic).
          ctx.expect(path.basename(out.mac.tray)).toBe('trayTemplate.png');
          ctx.expect(path.basename(out.mac.tray2x)).toBe('trayTemplate@2x.png');

          // @1x derived at half the @2x dimensions.
          const tray1xMeta = await sharp(out.mac.tray).metadata();
          const tray2xMeta = await sharp(out.mac.tray2x).metadata();
          ctx.expect(tray1xMeta.width).toBe(16);
          ctx.expect(tray1xMeta.height).toBe(16);
          ctx.expect(tray2xMeta.width).toBe(32);
          ctx.expect(tray2xMeta.height).toBe(32);

          const dmg1xMeta = await sharp(out.mac.dmg).metadata();
          const dmg2xMeta = await sharp(out.mac.dmg2x).metadata();
          ctx.expect(dmg1xMeta.width).toBe(540);
          ctx.expect(dmg1xMeta.height).toBe(380);
          ctx.expect(dmg2xMeta.width).toBe(1080);
          ctx.expect(dmg2xMeta.height).toBe(760);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'consumer single-file retina source overrides bundled default',
      run: async (ctx) => {
        const { root, projectRoot, distRoot, emDefaultsRoot } = stage();
        try {
          fakePng(path.join(emDefaultsRoot, 'icons', 'mac', 'icon.png'));
          await realPng(path.join(emDefaultsRoot, 'icons', 'mac', 'tray.png'), 32, 32);
          // Consumer ships ONE file as `tray.png` (at @2x native size).
          const consumerTray = path.join(projectRoot, 'config', 'icons', 'mac', 'tray.png');
          await realPng(consumerTray, 32, 32);

          const { resolveAndCopy } = require(path.join(__dirname, '..', '..', '..', 'lib', 'sign-helpers', 'resolve-icons.js'));
          const out = await resolveAndCopy({ config: {}, projectRoot, distRoot, emDefaultsRoot });

          ctx.expect(out.mac.tray).toBeDefined();
          ctx.expect(out.mac.tray2x).toBeDefined();
          // Output is still trayTemplate.png regardless of input name.
          ctx.expect(path.basename(out.mac.tray)).toBe('trayTemplate.png');
          const tray1xMeta = await sharp(out.mac.tray).metadata();
          ctx.expect(tray1xMeta.width).toBe(16);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'global/ retina source covers all platforms (tray)',
      run: async (ctx) => {
        const { root, projectRoot, distRoot, emDefaultsRoot } = stage();
        try {
          fakePng(path.join(emDefaultsRoot, 'icons', 'mac', 'icon.png'));
          fakePng(path.join(emDefaultsRoot, 'icons', 'windows', 'icon.png'));

          // Consumer ships ONE tray file under global/.
          await realPng(path.join(projectRoot, 'config', 'icons', 'global', 'tray.png'), 32, 32);

          const { resolveAndCopy } = require(path.join(__dirname, '..', '..', '..', 'lib', 'sign-helpers', 'resolve-icons.js'));
          const out = await resolveAndCopy({ config: {}, projectRoot, distRoot, emDefaultsRoot });

          ctx.expect(out.mac.tray).toBeDefined();
          ctx.expect(out.mac.tray2x).toBeDefined();
          ctx.expect(out.windows.tray).toBeDefined();
          ctx.expect(out.linux.tray).toBeDefined();

          // macOS @1x derived at half size from the global @2x source.
          const macTrayMeta = await sharp(out.mac.tray).metadata();
          ctx.expect(macTrayMeta.width).toBe(16);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'no app icon of its own: every platform takes the brand brandmark over the bundled default',
      run: async (ctx) => {
        const { root, brandRoot, projectRoot, distRoot, emDefaultsRoot } = await stageBrand();
        try {
          const { resolveAndCopy } = require(path.join(__dirname, '..', '..', '..', 'lib', 'sign-helpers', 'resolve-icons.js'));
          const out = await resolveAndCopy({ config: {}, projectRoot, distRoot, emDefaultsRoot, brandRoot });

          for (const platform of ['mac', 'windows', 'linux']) {
            ctx.expect(await centreColour(out[platform].app)).toBe('red');
          }
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'config/icons/mac/icon.png beats the brand brandmark on mac',
      run: async (ctx) => {
        const { root, brandRoot, projectRoot, distRoot, emDefaultsRoot } = await stageBrand();
        try {
          const macIcon = path.join(projectRoot, 'config', 'icons', 'mac', 'icon.png');
          await solidPng(macIcon, 'green');

          const { resolveAndCopy } = require(path.join(__dirname, '..', '..', '..', 'lib', 'sign-helpers', 'resolve-icons.js'));
          const out = await resolveAndCopy({ config: {}, projectRoot, distRoot, emDefaultsRoot, brandRoot });

          ctx.expect(fs.readFileSync(out.mac.app).equals(fs.readFileSync(macIcon))).toBe(true);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'no brand root: a brandmark-shaped file in a standalone project is ignored and the bundled default applies',
      run: async (ctx) => {
        const { root, projectRoot, distRoot, emDefaultsRoot } = stage();
        try {
          await solidPng(path.join(emDefaultsRoot, 'icons', 'mac', 'icon.png'), 'blue');
          await solidPng(path.join(emDefaultsRoot, 'icons', 'windows', 'icon.png'), 'blue');
          brandmark(path.join(projectRoot, 'assets', 'logo', 'brandmark.svg'), 'red');

          const { resolveAndCopy } = require(path.join(__dirname, '..', '..', '..', 'lib', 'sign-helpers', 'resolve-icons.js'));
          const out = await resolveAndCopy({ config: {}, projectRoot, distRoot, emDefaultsRoot, brandRoot: null });

          for (const platform of ['mac', 'windows', 'linux']) {
            ctx.expect(await centreColour(out[platform].app)).toBe('blue');
          }
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'resolving from the brand brandmark writes nothing into the target source tree',
      run: async (ctx) => {
        const { root, brandRoot, projectRoot, distRoot, emDefaultsRoot } = await stageBrand();
        try {
          await solidPng(path.join(projectRoot, 'config', 'icons', 'mac', 'tray.png'), 'green', 32);
          const before = sourceTree(projectRoot);

          const { resolveAndCopy } = require(path.join(__dirname, '..', '..', '..', 'lib', 'sign-helpers', 'resolve-icons.js'));
          await resolveAndCopy({ config: {}, projectRoot, distRoot, emDefaultsRoot, brandRoot });

          ctx.expect(sourceTree(projectRoot)).toEqual(before);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
  ],
});
