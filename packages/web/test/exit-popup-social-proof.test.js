/**
 * The exit popup's social proof (#44 item 21) — the "Join 10k+ happy
 * subscribers!" line renders its face stack again. Default: the four real
 * portraits the framework now SHIPS (legacy UJM hotlinked them from
 * i.pravatar.cc; they live in core/images/exit-popup and bridge to
 * /assets/images/core). A brand replaces them through
 * client.exitPopup.config.avatars, and an explicit empty list falls back to
 * neutral glyph slots.
 *
 * The same popup's heading order (#316): it mounts on every page, so a skip
 * inside it fails the heading-order rule on pages whose own content is clean.
 */
const fs = require('node:fs');
const path = require('node:path');
const defineCases = require('@omega.js/devkit/test/define-cases');
const expect = require('@omega.js/devkit/test/expect');

const { PATHS } = require('../src/paths.js');
const { resolveStaticDirs } = require('../src/static-assets.js');
const { buildWith, miniData } = require('./lib/build.js');

/** The social-proof row markup out of a rendered page. */
function socialProof(html) {
  const start = html.indexOf('<!-- Social proof');
  expect(start > -1, 'the exit popup renders a social-proof block').toBeTruthy();
  const end = html.indexOf('Join 10k+', start);
  expect(end > -1, 'the subscriber line is part of that block').toBeTruthy();
  return html.slice(start, html.indexOf('</div>', end));
}

/** The whole popup's markup out of a rendered page. */
function popup(html) {
  const start = html.indexOf('<div id="modal-exit-popup"');
  expect(start > -1, 'the page mounts the exit popup').toBeTruthy();
  const end = html.indexOf('<script type="module"', start);
  expect(end > -1, 'the popup closes before the foot\'s module bundles').toBeTruthy();
  return html.slice(start, end);
}

module.exports = defineCases({
  type: 'group',
  description: 'exit-popup-social-proof',
  tests: [
    {
      name: 'the popup\'s headings step one level at a time (#316)',
      run: async (ctx) => {
        const pages = await buildWith(miniData, {}, 'exit-popup-headings');
        const levels = [...popup(pages.get('/')).matchAll(/<h([1-6])\b/g)].map((match) => Number(match[1]));

        // The popup titles itself h3 (it is a dialog inside a page that owns h1/h2),
        // and the offer box is its one subsection.
        ctx.expect(levels, 'the offer title sits one level under the popup title, not two').toEqual([3, 4]);
      },
    },

    {
      name: 'unconfigured: the four shipped portraits stand beside the subscriber line',
      run: async (ctx) => {
        const pages = await buildWith(miniData, {}, 'exit-popup-default');
        const block = socialProof(pages.get('/'));

        ctx.expect((block.match(/modal-exit-avatar/g) || []).length, 'four faces, like the legacy row').toBe(4);
        ctx.expect((block.match(/me-n2/g) || []).length, 'every slot but the last overlaps the next').toBe(3);
        for (const n of [1, 2, 3, 4]) {
          ctx.expect(block.includes(`data-lazy="@src /assets/images/core/exit-popup/subscriber-${n}.jpg"`), `face ${n} lazy-loads the shipped photo`).toBeTruthy();
        }
        ctx.expect((block.match(/alt=""/g) || []).length, 'decorative: the line carries the meaning').toBe(4);
        ctx.expect(!block.includes('data-omega-fa="solid/user"'), 'real photos, not glyph slots').toBeTruthy();

        // The framework never hotlinks — every default face is a local path
        ctx.expect(!/data-lazy="@src https?:/.test(block), 'no external image URL, ever').toBeTruthy();
      },
    },

    {
      name: 'the shipped portraits exist on disk and reach the built site',
      run: async (ctx) => {
        for (const n of [1, 2, 3, 4]) {
          const file = path.join(PATHS.core, 'images', 'exit-popup', `subscriber-${n}.jpg`);
          ctx.expect(fs.existsSync(file), `${file} ships with the package`).toBeTruthy();
        }

        // The static channel carries core/images to the URL the include references
        const core = (await resolveStaticDirs({ brandRoot: null, assetsDir: path.join(PATHS.core, 'nope') }))
          .find((entry) => entry.dest === 'assets/images/core');
        ctx.expect(core, 'core images are a static-copy entry').toBeTruthy();
        ctx.expect(core.src).toBe(path.join(PATHS.core, 'images'));
      },
    },

    {
      name: 'an explicit empty list falls back to neutral glyph slots',
      run: async (ctx) => {
        const pages = await buildWith(
          {
            ...miniData,
            client: { ...miniData.client, exitPopup: { config: { avatars: [] } } },
          },
          {},
          'exit-popup-neutral',
        );
        const block = socialProof(pages.get('/'));

        ctx.expect((block.match(/modal-exit-avatar/g) || []).length, 'the row keeps its four slots').toBe(4);
        ctx.expect(!block.includes('<img'), 'opting out of faces means no image').toBeTruthy();
        ctx.expect(block.includes('data-omega-fa="solid/user"'), 'a neutral glyph fills the empty slot').toBeTruthy();
      },
    },

    {
      name: 'configured: the brand faces render lazily, decorative',
      run: async (ctx) => {
        const pages = await buildWith(
          {
            ...miniData,
            client: {
              ...miniData.client,
              exitPopup: { config: { avatars: ['/assets/images/a.jpg', '/assets/images/b.jpg'] } },
            },
          },
          {},
          'exit-popup-configured',
        );
        const block = socialProof(pages.get('/'));

        ctx.expect((block.match(/modal-exit-avatar/g) || []).length, 'exactly the configured faces, no padding').toBe(2);
        ctx.expect(block.includes('data-lazy="@src /assets/images/a.jpg"'), 'first face lazy-loads its configured source').toBeTruthy();
        ctx.expect(block.includes('data-lazy="@src /assets/images/b.jpg"'), 'second face too').toBeTruthy();
        ctx.expect((block.match(/alt=""/g) || []).length, 'decorative: the line carries the meaning').toBe(2);
        ctx.expect(!block.includes('data-omega-fa="solid/user"'), 'configured faces replace the neutral glyphs').toBeTruthy();
      },
    },
  ],
});
