// Build-layer tests for gulp/tasks/icons.js: the icon sizes come from the
// target's own config/icon.*, else the brand's assets/logo/brandmark.svg, and
// the build writes only into dist/. Each test stages a real project and runs the
// task fresh inside it (utils/package-project.js), sharp included.

require('@omega.js/devkit/test/temp-home');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const gulp  = require('gulp');
const sharp = require('sharp');
const jetpack = require('fs-jetpack');
const defineCases = require('@omega.js/devkit/test/define-cases');
const { stageProject, inProject } = require('../../utils/package-project.js');

const RGB = { red: { r: 255, g: 0, b: 0 }, green: { r: 0, g: 255, b: 0 }, blue: { r: 0, g: 0, b: 255 } };

// The lane keys the task's build module reads at load, saved and restored around each run.
const LANE_KEYS = ['OMEGA_BUILD_MODE', 'OMEGA_ENVIRONMENT'];

/**
 * Run the icons task in `dir`, in build mode so its watcher stands down.
 * @param {string} dir - The target project to run in.
 * @returns {Promise<*>} what the task completed with: an error, or nothing.
 */
async function runIcons(dir) {
  const previous = Object.fromEntries(LANE_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.OMEGA_ENVIRONMENT;
  process.env.OMEGA_BUILD_MODE = 'true';
  // A failed task is also emitted on the gulp instance, where gulp's CLI listens;
  // with no listener the emit throws instead of the series completing with it
  const listener = () => {};
  gulp.on('error', listener);
  try {
    return await inProject(dir, (task) => new Promise((resolve) => task(resolve)), 'gulp/tasks/icons.js');
  } finally {
    gulp.off('error', listener);
    for (const key of LANE_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

// An SVG painted edge to edge in one colour, `width` by `height`.
function brandmarkSvg(colour, width = 100, height = 100) {
  const { r, g, b } = RGB[colour];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="rgb(${r},${g},${b})"/></svg>`;
}

// An extension target inside a brand monorepo whose brandmark is red and wider than tall.
function stageBrand() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-icons-brand-'));
  const projectRoot = path.join(root, 'targets', 'extension');
  jetpack.write(path.join(root, 'config', 'omega.json5'), `{ brand: { id: 'staged', name: 'Staged' }, targets: { extension: { type: 'extension' } } }`);
  jetpack.write(path.join(root, 'assets', 'logo', 'brandmark.svg'), brandmarkSvg('red', 150, 100));
  jetpack.write(path.join(projectRoot, 'package.json'), '{ "name": "staged-ext", "version": "1.0.0" }');
  return { root, projectRoot };
}

// A solid-colour PNG of the target's own at config/icon.png.
async function ownPng(projectRoot, colour) {
  jetpack.dir(path.join(projectRoot, 'config'));
  await sharp({ create: { width: 256, height: 256, channels: 4, background: { ...RGB[colour], alpha: 1 } } })
    .png().toFile(path.join(projectRoot, 'config', 'icon.png'));
}

// The colour name of the pixel at the given share of the width and height
// (the centre by default): its strongest channel, or 'clear'.
async function colourAt(file, x = 0.5, y = 0.5) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (Math.floor(info.height * y) * info.width + Math.floor(info.width * x)) * 4;
  const [r, g, b, alpha] = data.subarray(at, at + 4);
  if (alpha < 128) return 'clear';
  if (r > g && r > b) return 'red';
  return g > b ? 'green' : 'blue';
}

// Every file in the target's source tree (all but dist/) with its bytes.
function sourceTree(projectRoot) {
  return fs.readdirSync(projectRoot, { recursive: true })
    .filter((rel) => rel.split(path.sep)[0] !== 'dist' && fs.statSync(path.join(projectRoot, rel)).isFile())
    .sort()
    .map((rel) => [rel, fs.readFileSync(path.join(projectRoot, rel)).toString('base64')]);
}

const icon = (projectRoot, size) => path.join(projectRoot, 'dist', 'assets', 'images', 'icons', `icon-${size}x.png`);

module.exports = defineCases({
  type: 'group',
  layer: 'build',
  description: 'icons task: config/icon.* wins, else the brand brandmark, and only dist/ is written',
  tests: [
    {
      name: 'no config/icon.*: the icon sizes come from the brand brandmark, square, the mark contained on a clear ground',
      run: async (ctx) => {
        const { root, projectRoot } = stageBrand();
        try {
          const failure = await runIcons(projectRoot);

          ctx.expect(failure).toBeFalsy();
          for (const size of [16, 128]) {
            const { width, height } = await sharp(icon(projectRoot, size)).metadata();
            ctx.expect([width, height]).toEqual([size, size]);
            ctx.expect(await colourAt(icon(projectRoot, size))).toBe('red');
            ctx.expect(await colourAt(icon(projectRoot, size), 0.5, 0)).toBe('clear');
          }
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'config/icon.png is the source over the brand brandmark',
      run: async (ctx) => {
        const { root, projectRoot } = stageBrand();
        try {
          await ownPng(projectRoot, 'green');

          const failure = await runIcons(projectRoot);

          ctx.expect(failure).toBeFalsy();
          ctx.expect(await colourAt(icon(projectRoot, 128))).toBe('green');
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'config/icon.svg and config/icon.png both present: the svg is the source',
      run: async (ctx) => {
        const { root, projectRoot } = stageBrand();
        try {
          jetpack.write(path.join(projectRoot, 'config', 'icon.svg'), brandmarkSvg('blue'));
          await ownPng(projectRoot, 'green');

          const failure = await runIcons(projectRoot);

          ctx.expect(failure).toBeFalsy();
          ctx.expect(await colourAt(icon(projectRoot, 128))).toBe('blue');
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'no brand root and no config/icon.*: the build does not fail',
      run: async (ctx) => {
        const tmp = stageProject({});
        try {
          ctx.expect(await runIcons(tmp)).toBeFalsy();
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'deriving from the brand brandmark writes nothing into the target source tree',
      run: async (ctx) => {
        const { root, projectRoot } = stageBrand();
        try {
          const before = sourceTree(projectRoot);

          const failure = await runIcons(projectRoot);

          ctx.expect(failure).toBeFalsy();
          ctx.expect(sourceTree(projectRoot)).toEqual(before);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    },
  ],
});
