const defineCases = require('../../../../../src/test/define-cases.js');

module.exports = defineCases({
  type: 'suite',
  description: 'cleanup never settles',
  timeout: 300,
  cleanup: () => new Promise(() => {}),
  tests: [
    { name: 'first', run: (ctx) => ctx.expect(1).toBe(1) },
    { name: 'second', run: (ctx) => ctx.expect(1).toBe(1) },
  ],
});
