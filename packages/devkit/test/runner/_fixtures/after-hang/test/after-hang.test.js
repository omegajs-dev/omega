const fs = require('node:fs');
const defineCases = require('../../../../../src/test/define-cases.js');

const record = (line) => fs.appendFileSync(process.env.FIXTURE_OUT, `${line}\n`);

module.exports = defineCases({
  type: 'group',
  description: 'after never settles',
  tests: [
    {
      name: 'an after that never settles',
      timeout: 300,
      run(ctx) {
        ctx.after(() => record('older after'));
        ctx.after(() => new Promise(() => {}));
        record('body');
      },
    },
    { name: 'the next case', run: () => record('next case') },
  ],
});
