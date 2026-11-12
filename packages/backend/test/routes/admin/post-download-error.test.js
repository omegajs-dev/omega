/**
 * Test: routes/admin/post/images.formatImageDownloadError, the readable
 * image-download error messages of the admin/post route.
 *
 * Run (from the framework repo): npm test routes/admin/post-download-error
 *
 * Contract:
 *   - Raw HTML error bodies (CDN 404 pages) are stripped to their text, so
 *     consumers surface "Could not download image (<url>): 404", not markup.
 *   - The failing image URL is always included, naming WHICH image broke.
 *   - Long reasons are truncated; empty reasons fall back to "unknown error".
 */
const images = require('../../../dist/omega/routes/admin/post/images.js');
const defineCases = require('../../../dist/vendor/devkit/test/define-cases.js');

const { formatImageDownloadError } = images;

const SRC = 'https://images.unsplash.com/photos/ux-prism-qv5lQ4DwOS8';

module.exports = defineCases({
  description: 'routes/admin/post/images.formatImageDownloadError',
  type: 'group',

  tests: [
    {
      name: 'strips-html-404-body',
      async run({ expect }) {
        // The exact CDN response body from a real failed sponsorship publish
        const err = new Error('<html><body>404</body></html>');

        expect(formatImageDownloadError(SRC, err), 'HTML tags are stripped, the status text and image URL survive').toBe(`Could not download image (${SRC}): 404`);
      },
    },

    {
      name: 'plain-message-passes-through',
      async run({ expect }) {
        expect(formatImageDownloadError(SRC, new Error('socket hang up')), 'Plain reasons are included as-is').toBe(`Could not download image (${SRC}): socket hang up`);
      },
    },

    {
      name: 'truncates-long-reasons',
      async run({ expect }) {
        const result = formatImageDownloadError(SRC, new Error('x'.repeat(500)));

        expect(result.endsWith('...'), 'Truncated reasons end with an ellipsis').toBeTruthy();
        expect(result.length < 300, 'Reason is capped well below the raw length').toBeTruthy();
      },
    },

    {
      name: 'empty-reason-falls-back',
      async run({ expect }) {
        expect(formatImageDownloadError(SRC, new Error('<html></html>')), 'Tag-only bodies fall back to a generic reason').toBe(`Could not download image (${SRC}): unknown error`);
        expect(formatImageDownloadError(SRC, new Error('')), 'Empty messages fall back to a generic reason (not the stringified "Error")').toBe(`Could not download image (${SRC}): unknown error`);
      },
    },

    {
      name: 'handles-non-error-values',
      async run({ expect }) {
        expect(formatImageDownloadError(SRC, 'ECONNRESET'), 'Plain string rejections are handled').toBe(`Could not download image (${SRC}): ECONNRESET`);
      },
    },
  ],
});
