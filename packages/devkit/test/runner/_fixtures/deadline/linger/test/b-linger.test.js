const fs = require('node:fs');
const net = require('node:net');
const defineCases = require('../../../../../../src/test/define-cases.js');

fs.appendFileSync(process.env.FIXTURE_OUT, `pid:${process.pid}\n`);

module.exports = defineCases({
  type: 'group',
  description: 'linger',
  tests: [
    {
      name: 'leaves a server listening',
      run: () => new Promise((resolve) => {
        net.createServer().listen(0, '127.0.0.1', resolve);
      }),
    },
  ],
});
