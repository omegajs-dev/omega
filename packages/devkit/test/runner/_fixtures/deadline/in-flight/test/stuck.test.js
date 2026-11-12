const fs = require('node:fs');
const defineCases = require('../../../../../../src/test/define-cases.js');

fs.appendFileSync(process.env.FIXTURE_OUT, `pid:${process.pid}\n`);

module.exports = defineCases({
  type: 'group',
  description: 'in flight',
  tests: [
    { name: 'a case that reports first', run: (ctx) => ctx.expect(1).toBe(1) },
    {
      name: 'waits on a reply that never comes',
      timeout: 600000,
      run: () => new Promise(() => {
        setInterval(() => {}, 60000);
      }),
    },
  ],
});
