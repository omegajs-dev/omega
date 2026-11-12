/**
 * Test: routes/admin/post/images.convertToJpeg + applyImageCDNParams, the
 * non-JPG ingest conversion and CDN pre-scale params of the admin/post route.
 *
 * Run (from the framework repo): npm test routes/admin/post-convert-image
 *
 * Contract:
 *   - png/webp become progressive JPEG at IMAGE_JPEG_QUALITY in place (path,
 *     filename and ext become .jpg; the original is removed), alpha on white.
 *   - applyImageCDNParams adds w/q params for Unsplash and w/auto for Pexels,
 *     keeping params already present, and leaves other hosts untouched.
 */
const os = require('os');
const path = require('path');
const jetpack = require('fs-jetpack');
const sharp = require('sharp');

const images = require('../../../dist/omega/routes/admin/post/images.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const { convertToJpeg, applyImageCDNParams, IMAGE_MAX_DIMENSION } = images;

// Generate a synthetic image of the given format and write it to a tmp path.
async function makeImage(format, options) {
  const filepath = path.join(os.tmpdir(), `backend-test-convert-${Date.now()}-${Math.random().toString(36).slice(2)}.${format}`);
  const buffer = await sharp({
    create: {
      width: 640,
      height: 480,
      channels: options?.alpha ? 4 : 3,
      background: options?.alpha
        ? { r: 200, g: 50, b: 50, alpha: 0.5 }
        : { r: 200, g: 50, b: 50 },
    },
  })[format]()
    .toBuffer();

  jetpack.write(filepath, buffer);
  return filepath;
}

// Minimal ctx stub — convertToJpeg only uses omega.require + log.
function makeAssistant() {
  return {
    log: () => {},
    omega: {
      require: (mod) => require(mod),
    },
  };
}

module.exports = defineCases({
  description: 'routes/admin/post/images.convertToJpeg + applyImageCDNParams',
  type: 'group',

  tests: [
    // ─── convertToJpeg ───

    {
      name: 'png-converts-to-jpg',
      async run({ expect }) {
        const filepath = await makeImage('png');
        const result = { path: filepath, filename: path.basename(filepath), ext: '.png' };

        await convertToJpeg(makeAssistant(), result);

        expect(result.ext, 'ext should become .jpg').toBe('.jpg');
        expect(result.path.endsWith('.jpg'), 'path should end with .jpg').toBeTruthy();
        expect(result.filename.endsWith('.jpg'), 'filename should end with .jpg').toBeTruthy();
        expect(jetpack.exists(result.path), 'converted file should exist').toBeTruthy();
        expect(jetpack.exists(filepath), 'original .png should be removed').toBe(false);

        const meta = await sharp(result.path).metadata();
        expect(meta.format, 'on-disk format should be JPEG').toBe('jpeg');
        expect(meta.width, 'dimensions should be preserved').toBe(640);

        jetpack.remove(result.path);
      },
    },

    {
      name: 'webp-converts-to-jpg',
      async run({ expect }) {
        const filepath = await makeImage('webp');
        const result = { path: filepath, filename: path.basename(filepath), ext: '.webp' };

        await convertToJpeg(makeAssistant(), result);

        expect(result.ext, 'ext should become .jpg').toBe('.jpg');
        const meta = await sharp(result.path).metadata();
        expect(meta.format, 'on-disk format should be JPEG').toBe('jpeg');
        expect(jetpack.exists(filepath), 'original .webp should be removed').toBe(false);

        jetpack.remove(result.path);
      },
    },

    {
      name: 'alpha-png-flattens-onto-white',
      async run({ expect }) {
        const filepath = await makeImage('png', { alpha: true });
        const result = { path: filepath, filename: path.basename(filepath), ext: '.png' };

        await convertToJpeg(makeAssistant(), result);

        const meta = await sharp(result.path).metadata();
        expect(meta.format, 'on-disk format should be JPEG').toBe('jpeg');
        expect(meta.channels, 'alpha channel should be gone').toBe(3);

        // 50%-alpha red over white ≈ light red — the green/blue channels must be
        // well above 0 (a black flatten would leave them near 25).
        const { channels } = await sharp(result.path).stats();
        expect(channels[1].mean > 100, `green mean should reflect a white flatten (got ${Math.round(channels[1].mean)})`).toBeTruthy();

        jetpack.remove(result.path);
      },
    },

    // ─── applyImageCDNParams ───

    {
      name: 'unsplash-gets-w-and-q-params',
      async run({ expect }) {
        const out = new URL(applyImageCDNParams('https://images.unsplash.com/photo-123'));
        expect(out.searchParams.get('w'), 'w param should be the max dimension').toBe(String(IMAGE_MAX_DIMENSION));
        expect(out.searchParams.get('q'), 'q param should be set').toBeTruthy();
      },
    },

    {
      name: 'pexels-gets-w-and-auto-params',
      async run({ expect }) {
        const out = new URL(applyImageCDNParams('https://images.pexels.com/photos/416405/pexels-photo-416405.jpeg'));
        expect(out.searchParams.get('w'), 'w param should be the max dimension').toBe(String(IMAGE_MAX_DIMENSION));
        expect(out.searchParams.get('auto'), 'auto=compress should be set').toBe('compress');
      },
    },

    {
      name: 'existing-params-are-not-clobbered',
      async run({ expect }) {
        const out = new URL(applyImageCDNParams('https://images.pexels.com/photos/1/a.jpeg?w=800'));
        expect(out.searchParams.get('w'), 'an existing w param should be preserved').toBe('800');
      },
    },

    {
      name: 'other-hosts-untouched',
      async run({ expect }) {
        const src = 'https://cdn.pixabay.com/photo/2024/01/01/example.jpg';
        expect(applyImageCDNParams(src), 'hosts without CDN param support should pass through unchanged').toBe(src);
      },
    },
  ],
});
