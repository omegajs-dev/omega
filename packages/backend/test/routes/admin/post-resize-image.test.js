/**
 * Test: routes/admin/post/images.resizeImage, the in-place image resize of
 * the admin/post route. Run: npx omega test routes/admin/post-resize-image
 *
 * Contract:
 *   - Images with both dimensions <= IMAGE_MAX_DIMENSION pass through untouched.
 *   - Images with either dimension > IMAGE_MAX_DIMENSION are resized in place,
 *     preserving aspect ratio, with the long edge clamped to IMAGE_MAX_DIMENSION.
 *   - Resize re-encodes as JPEG at IMAGE_JPEG_QUALITY (lossy is expected).
 *   - The file at the original path is overwritten with the resized bytes.
 */
const os = require('os');
const path = require('path');
const jetpack = require('fs-jetpack');
const sharp = require('sharp');

const images = require('../../../dist/omega/routes/admin/post/images.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const { resizeImage, IMAGE_MAX_DIMENSION, IMAGE_JPEG_QUALITY } = images;

// Generate a synthetic JPEG of the given dimensions and write it to a tmp path.
// Returns the absolute path on disk.
async function makeJpeg(width, height) {
  const filepath = path.join(os.tmpdir(), `backend-test-resize-${Date.now()}-${width}x${height}.jpg`);
  const buffer = await sharp({
    create: {
      width: width,
      height: height,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();

  jetpack.write(filepath, buffer);
  return filepath;
}

// Minimal ctx stub — resizeImage only uses omega.require + log.
function makeAssistant() {
  return {
    log: () => {},
    omega: {
      require: (mod) => require(mod),
    },
  };
}

module.exports = defineCases({
  description: 'routes/admin/post/images.resizeImage',
  type: 'group',

  tests: [
    // ─── Constants exposed ───

    {
      name: 'exports-constants',
      async run({ expect }) {
        expect(IMAGE_MAX_DIMENSION, 'IMAGE_MAX_DIMENSION should be 2048').toBe(2048);
        expect(IMAGE_JPEG_QUALITY, 'IMAGE_JPEG_QUALITY should be 80').toBe(80);
        expect(resizeImage, 'resizeImage should be exported as a function').toBeTypeOf('function');
      },
    },

    // ─── Pass-through: image already within bounds ───

    {
      name: 'small-image-passes-through-untouched',
      async run({ expect }) {
        const filepath = await makeJpeg(800, 600);
        const sizeBefore = jetpack.inspect(filepath).size;

        const result = await resizeImage(makeAssistant(), filepath);

        expect(result.resized, 'Small image should not be resized').toBe(false);
        expect(result.width, 'Width should be reported as-is').toBe(800);
        expect(result.height, 'Height should be reported as-is').toBe(600);

        const sizeAfter = jetpack.inspect(filepath).size;
        expect(sizeAfter, 'File on disk should be byte-identical (no re-encode)').toBe(sizeBefore);

        jetpack.remove(filepath);
      },
    },

    {
      name: 'image-exactly-at-max-passes-through',
      async run({ expect }) {
        const filepath = await makeJpeg(IMAGE_MAX_DIMENSION, 1000);

        const result = await resizeImage(makeAssistant(), filepath);

        expect(result.resized, 'Image exactly at the limit should not be resized').toBe(false);
        expect(result.width, 'Width unchanged').toBe(IMAGE_MAX_DIMENSION);

        jetpack.remove(filepath);
      },
    },

    // ─── Resize: landscape (width > height) ───

    {
      name: 'landscape-oversized-is-resized-to-max-width',
      async run({ expect }) {
        // 8000x4000 landscape → long edge is width → clamp to 2048, height scales to 1024
        const filepath = await makeJpeg(8000, 4000);

        const result = await resizeImage(makeAssistant(), filepath);

        expect(result.resized, 'Oversized landscape should be resized').toBe(true);
        expect(result.width, 'Width clamped to IMAGE_MAX_DIMENSION').toBe(IMAGE_MAX_DIMENSION);
        expect(result.height, 'Height scaled proportionally').toBe(IMAGE_MAX_DIMENSION / 2);

        const meta = await sharp(filepath).metadata();
        expect(meta.width, 'On-disk width matches reported width').toBe(IMAGE_MAX_DIMENSION);
        expect(meta.height, 'On-disk height matches reported height').toBe(IMAGE_MAX_DIMENSION / 2);
        expect(meta.format, 'On-disk format is JPEG').toBe('jpeg');

        jetpack.remove(filepath);
      },
    },

    // ─── Resize: portrait (height > width) ───

    {
      name: 'portrait-oversized-is-resized-to-max-height',
      async run({ expect }) {
        // 4000x8000 portrait → long edge is height → clamp to 2048, width scales to 1024
        const filepath = await makeJpeg(4000, 8000);

        const result = await resizeImage(makeAssistant(), filepath);

        expect(result.resized, 'Oversized portrait should be resized').toBe(true);
        expect(result.width, 'Width scaled proportionally').toBe(IMAGE_MAX_DIMENSION / 2);
        expect(result.height, 'Height clamped to IMAGE_MAX_DIMENSION').toBe(IMAGE_MAX_DIMENSION);

        jetpack.remove(filepath);
      },
    },

    // ─── Resize: huge image (the bug we are guarding against) ───

    {
      name: 'huge-image-is-resized-down',
      async run({ expect }) {
        // 16384x10576 — the actual size from post-1779087609.
        const filepath = await makeJpeg(16384, 10576);
        const sizeBefore = jetpack.inspect(filepath).size;

        const result = await resizeImage(makeAssistant(), filepath);

        expect(result.resized, 'Huge image should be resized').toBe(true);
        expect(result.width, 'Long edge clamped to IMAGE_MAX_DIMENSION').toBe(IMAGE_MAX_DIMENSION);
        // 16384:10576 ratio → height = 2048 * (10576/16384) = 1322
        expect(result.height, 'Height scaled proportionally (within rounding)').toBeGreaterThanOrEqual(1321);
        expect(result.height, 'Height scaled proportionally (within rounding)').toBeLessThanOrEqual(1323);

        const sizeAfter = jetpack.inspect(filepath).size;
        expect(sizeAfter < sizeBefore, 'Resized file on disk should be smaller than original').toBeTruthy();

        jetpack.remove(filepath);
      },
    },

    // ─── Square images ───

    {
      name: 'square-oversized-is-resized-to-square',
      async run({ expect }) {
        const filepath = await makeJpeg(8000, 8000);

        const result = await resizeImage(makeAssistant(), filepath);

        expect(result.resized, 'Oversized square should be resized').toBe(true);
        expect(result.width, 'Width clamped').toBe(IMAGE_MAX_DIMENSION);
        expect(result.height, 'Height clamped').toBe(IMAGE_MAX_DIMENSION);

        jetpack.remove(filepath);
      },
    },
  ],
});
