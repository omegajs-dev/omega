const defineCases = require('../../../../../../src/test/define-cases.js');

module.exports = defineCases({
  type: 'group',
  description: 'quick',
  tests: [
    { name: 'a quick file passes and exits', run: (ctx) => ctx.expect(1).toBe(1) },
  ],
});
