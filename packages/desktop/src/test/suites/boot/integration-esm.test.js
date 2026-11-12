// Boot-layer self-test: the fixture consumer's three integrations under
// src/integrations/ are ES modules (`export default`, an `import`, and
// `import.meta.dirname`), loaded by the real app through `require()`. Each one's
// default export adds an item named for its folder, so finding the item is the
// proof that the file loaded and its default export ran. Bodies are serialized
// into the booted main process: no closures.

const defineCases = require('@omega.js/devkit/test/define-cases');

module.exports = defineCases({
  type: 'group',
  layer: 'boot',
  description: 'ES module integrations load and run in the real app',
  tests: [
    {
      name: 'the tray integration loaded and its default export ran',
      run: (ctx) => {
        ctx.expect(ctx.omega.tray.has('tray-esm')).toBe(true);
        ctx.expect(ctx.omega.tray.has('quit'), 'the useDefaults() call before it ran too').toBe(true);
      },
    },
    {
      name: 'the menu integration loaded and its default export ran',
      run: (ctx) => {
        ctx.expect(ctx.omega.menu.isRendered()).toBe(true);
        ctx.expect(ctx.omega.menu.has('menu-esm/probe')).toBe(true);
      },
    },
    {
      name: 'the context-menu integration loaded and its default export runs on a right-click',
      run: (ctx) => {
        ctx.expect(ctx.omega.contextMenu.hasCustomDefinition()).toBe(true);

        const ids = ctx.omega.contextMenu.buildItems({}).map((item) => item.id);
        ctx.expect(ids).toContain('context-menu-esm');
      },
    },
  ],
});
