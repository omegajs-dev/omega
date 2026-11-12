/**
 * Resolve every icon slot per platform, copy (or derive) the winner into
 * dist/config/icons/, and return the paths electron-builder.yml needs.
 *
 * The order is devkit's resolveBrandImage: config/icons/<platform>/, then
 * config/icons/global/, then (Linux only) config/icons/windows/; the app slot
 * then takes the brand's assets/logo/brandmark.svg, rasterized; then the bundled
 * default. Retina slots take the @2x source and derive the @1x sibling, and the
 * mac tray is written as trayTemplate.png for dark-mode inversion. A missing
 * Windows tray takes the Windows app icon; Linux takes the Windows paths.
 * The full contract: docs/desktop/icons.md.
 */

const path    = require('path');
const jetpack = require('fs-jetpack');
const sharp   = require('sharp');
const { resolveBrandImage } = require('@omega.js/devkit/brand-image');
const { rasterizeBrandmark } = require('@omega.js/devkit/brand-image-raster');

// The one slot the brand's brandmark can fill, and the side it is rasterized to.
const BRANDMARK_SLOT = 'app';
const BRANDMARK_ICON_SIZE = 1024;

// Slot defs: per platform, a list of { slot, file, outFile, retina } entries.
//   slot    = key under resolved[platform] (e.g. 'app' → resolved.mac.app)
//   file    = INPUT filename — what consumers ship in config/icons/<platform>/ (or global/)
//   outFile = OUTPUT filename written into dist/config/icons/<platform>/.
//             Defaults to `file`. Diverges only when the on-disk runtime name
//             carries magic meaning (e.g. macOS tray icons must end in
//             `Template.png` for the OS to auto-invert them in dark mode —
//             @omega.js/desktop owns that detail so consumers can just call it `tray.png`).
//   retina  = if set, the SOURCE file is treated as @2x (native). @omega.js/desktop downscales it
//             to produce the @1x sibling. Both files are written into dist/.
// The platform keys are OMEGA's vocabulary (#867): `mac`, never `macos`, both
// as the consumer's `config/icons/<platform>/` dir and as the dist output dir.
const SLOTS = {
  mac: [
    { slot: 'app',   file: 'icon.png' },
    { slot: 'tray',  file: 'tray.png', outFile: 'trayTemplate.png', retina: true },
    { slot: 'dmg',   file: 'dmg.png',                                retina: true },
  ],
  windows: [
    { slot: 'app',   file: 'icon.png' },
    { slot: 'tray',  file: 'tray.png' },        // optional; falls back to app icon if missing
  ],
  linux: [
    { slot: 'app',   file: 'icon.png' },
    { slot: 'tray',  file: 'tray.png' },
  ],
};

// Given a non-retina file path, return its @2x sibling (`foo.png` → `foo@2x.png`).
function retinaSibling(p) {
  const dir  = path.dirname(p);
  const ext  = path.extname(p);
  const base = path.basename(p, ext);
  return path.join(dir, `${base}@2x${ext}`);
}

// Resolve a slot on a platform through the shared brand-image order: the
// consumer's own files (platform, then global, then on Linux the Windows dir),
// then the brand's brandmark for the app slot, then the bundled default (Linux
// trying the Windows default too). Answers resolveBrandImage's { path, from }.
function resolveSource({ slot, file }, platform, opts) {
  const { projectRoot, emDefaultsRoot, brandRoot = null } = opts;
  const iconsDir = path.join(projectRoot, 'config', 'icons');
  const dirs = platform === 'linux' ? [platform, 'windows'] : [platform];

  const own = [path.join(iconsDir, platform, file), path.join(iconsDir, 'global', file)];
  if (platform === 'linux') own.push(path.join(iconsDir, 'windows', file));

  const fallback = dirs
    .map((dir) => path.join(emDefaultsRoot, 'icons', dir, file))
    .find((candidate) => jetpack.exists(candidate) === 'file') || null;

  return resolveBrandImage({ own, brandRoot: slot === BRANDMARK_SLOT ? brandRoot : null, fallback });
}

// Downscale an @2x source to its @1x sibling. Source is written as the @2x output,
// and a half-sized copy is written alongside as the @1x output. Returns { ref1x, ref2x }.
async function emitRetinaPair(src, dest) {
  const dest2x = retinaSibling(dest);

  // @2x output is a straight copy of the native source.
  jetpack.copy(src, dest2x, { overwrite: true });

  // @1x output is the source downscaled by 50%.
  const meta = await sharp(src).metadata();
  const w1x = Math.max(1, Math.round((meta.width  || 2) / 2));
  const h1x = Math.max(1, Math.round((meta.height || 2) / 2));
  await sharp(src)
    .resize(w1x, h1x, { fit: 'fill' })
    .toFile(dest);

  return { ref1x: dest, ref2x: dest2x };
}

// Resolve all icons, copy into dist/config/icons/, return the wiring object that
// build-config consumes.
// `brandRoot` is null for a framework used alone, which skips the brandmark step.
async function resolveAndCopy({ config, projectRoot, distRoot, emDefaultsRoot, brandRoot = null }) {
  const distIconsRoot = path.join(distRoot, 'config', 'icons');
  jetpack.dir(distIconsRoot);

  const resolved = { mac: {}, windows: {}, linux: {} };

  // First pass: resolve each platform/slot. For retina slots, source file is treated as
  // @2x; @omega.js/desktop emits both <slot>.png (downscaled) and <slot>@2x.png (the source) into dist.
  for (const platform of Object.keys(SLOTS)) {
    for (const def of SLOTS[platform]) {
      const { path: src, from } = resolveSource(def, platform, { projectRoot, emDefaultsRoot, brandRoot });
      if (!src) continue;

      const outFile = def.outFile || def.file;
      const dest = path.join(distIconsRoot, platform, outFile);
      jetpack.dir(path.dirname(dest));

      if (from === 'brand') {
        await rasterizeBrandmark({ source: src, outFile: dest, size: BRANDMARK_ICON_SIZE });
        resolved[platform][def.slot] = dest;
      } else if (def.retina) {
        const { ref1x, ref2x } = await emitRetinaPair(src, dest);
        resolved[platform][def.slot]            = ref1x;
        resolved[platform][`${def.slot}2x`]     = ref2x;
      } else {
        jetpack.copy(src, dest, { overwrite: true });
        resolved[platform][def.slot] = dest;
      }
    }
  }

  // Special fallbacks:
  //   - Windows tray → Windows app icon if tray didn't resolve.
  if (!resolved.windows.tray && resolved.windows.app) {
    resolved.windows.tray = resolved.windows.app;
  }
  //   - Linux entirely follows Windows resolved paths if its own chain produced nothing.
  for (const slot of ['app', 'tray']) {
    if (!resolved.linux[slot] && resolved.windows[slot]) {
      resolved.linux[slot] = resolved.windows[slot];
    }
  }

  return resolved;
}

module.exports = {
  SLOTS,
  retinaSibling,
  emitRetinaPair,
  resolveAndCopy,
};
