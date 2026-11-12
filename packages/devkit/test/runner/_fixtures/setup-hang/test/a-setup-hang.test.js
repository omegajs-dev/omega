const fs = require('node:fs');
const defineCases = require('../../../../../src/test/define-cases.js');

const record = (line) => fs.appendFileSync(process.env.FIXTURE_OUT, `${line}\n`);

module.exports = defineCases({
  type: 'suite',
  description: 'setup never settles',
  timeout: 300,
  setup: () => new Promise(() => {}),
  cleanup: () => record('cleanup'),
  tests: [
    { name: 'one', run: () => record('body') },
    { name: 'two', run: () => record('body') },
  ],
});
