const fs = require('node:fs');
const defineCases = require('../../../../../../src/test/define-cases.js');

fs.appendFileSync(process.env.FIXTURE_OUT, `pid:${process.pid}\n`);
process.on('SIGTERM', () => {});

module.exports = defineCases({
  type: 'group',
  description: 'deaf',
  tests: [
    {
      name: 'ignores the terminate signal and stays',
      run: () => {
        setInterval(() => {}, 60000);
      },
    },
  ],
});
