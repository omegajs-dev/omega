/**
 * One function answers each sender's from address and from name.
 *
 * `senderFrom(key, { brandName, domain })` in the email constants is the one
 * place a SENDERS row becomes an address and a display name. The manager makes
 * a verified sender from it, and `prepare.resolveSender()` builds a send's
 * `from` from it, so the two can never name different addresses.
 *
 * Plain-node: the real constants and prepare modules, no emulator.
 */
const expect = require('../../dist/vendor/devkit/test/expect.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');
const { SENDERS, senderFrom } = require('../../dist/omega/libraries/email/constants.js');
const { resolveSender } = require('../../dist/omega/libraries/email/prepare.js');

const BRAND = { id: 'acme', name: 'Acme' };
const DOMAIN = 'acme.test';
const GROUPS = { orders: 1, hello: 2, account: 3, marketing: 4, security: 5, newsletter: 6, internal: 7 };

// What each row sends as for Acme at acme.test, and the group it attaches.
const ROWS = {
  orders: { email: 'orders@acme.test', name: 'Acme Orders', groupId: 1 },
  hello: { email: 'hello@acme.test', name: 'Acme', groupId: 2 },
  account: { email: 'account@acme.test', name: 'Acme Account', groupId: 3 },
  marketing: { email: 'offers@acme.test', name: 'Acme', groupId: 4 },
  security: { email: 'security@acme.test', name: 'Acme Security', groupId: 5 },
  newsletter: { email: 'newsletter@acme.test', name: 'Acme', groupId: 6 },
  internal: { email: 'alerts@acme.test', name: 'Acme Alerts', groupId: 7 },
};

const omega = { config: { marketing: { campaigns: { providers: { sendgrid: { groups: GROUPS } } } } } };

module.exports = defineCases({
  description: 'senderFrom answers every SENDERS row, and resolveSender sends as it',
  type: 'group',

  tests: [
    {
      name: 'every row answers its address and name, and resolveSender answers what it did before',

      run() {
        const keys = Object.keys(SENDERS);
        const fromRow = Object.fromEntries(keys.map((key) => [key, senderFrom(key, { brandName: BRAND.name, domain: DOMAIN })]));
        const resolved = Object.fromEntries(keys.map((key) => [key, resolveSender({ sender: key }, BRAND, DOMAIN, omega)]));

        expect(fromRow, 'senderFrom answers each row its address and name').toEqual(
          Object.fromEntries(Object.entries(ROWS).map(([key, { email, name }]) => [key, { email, name }])),
        );
        expect(resolved, 'resolveSender answers each row the from and group it answered before').toEqual(
          Object.fromEntries(Object.entries(ROWS).map(([key, { email, name, groupId }]) => [key, { from: { email, name }, groupId }])),
        );
        expect(senderFrom('nobody', { brandName: BRAND.name, domain: DOMAIN }), 'a key that is no row answers null').toBe(null);
      },
    },
  ],
});
