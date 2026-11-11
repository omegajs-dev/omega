/**
 * email-providers.test.js: the ONE row per email provider.
 *
 * The backend's send, sync and prune paths and the manager's two marketing
 * services reach a provider through its role, so the rows are pinned here as
 * literal values: a row that drifts fails this file rather than quietly moving
 * every caller at once.
 */

const defineCases = require('@omega.js/devkit/test/define-cases');
const { EMAIL_PROVIDERS, emailProvider, emailProviderForRole } = require('../src/index.js');

const ROLES = ['campaigns', 'newsletter'];

const rows = () => Object.values(EMAIL_PROVIDERS);

module.exports = defineCases({
  type: 'group',
  description: 'email-providers',
  tests: [
    {
      name: 'the rulings, row by row: the role each provider serves and the env key that turns it on',
      run: (ctx) => {
        const sendgrid = emailProvider('sendgrid');
        const beehiiv = emailProvider('beehiiv');

        ctx.expect({ id: sendgrid.id, role: sendgrid.role, envKey: sendgrid.envKey }).toEqual({ id: 'sendgrid', role: 'campaigns', envKey: 'SENDGRID_API_KEY' });
        ctx.expect({ id: beehiiv.id, role: beehiiv.role, envKey: beehiiv.envKey }).toEqual({ id: 'beehiiv', role: 'newsletter', envKey: 'BEEHIIV_API_KEY' });
        ctx.expect(rows().map((row) => row.id).sort()).toEqual(['beehiiv', 'sendgrid']);
      },
    },

    {
      name: 'the fields each provider stores natively are the lists today',
      run: (ctx) => {
        // SendGrid keeps first/last name in its reserved contact columns; Beehiiv
        // tracks country and UTM source itself.
        ctx.expect([...emailProvider('sendgrid').nativeFields].sort()).toEqual(['user_personal_name_first', 'user_personal_name_last']);
        ctx.expect([...emailProvider('beehiiv').nativeFields].sort()).toEqual(['user_attribution_utm_source', 'user_personal_country']);
      },
    },

    {
      name: 'every row names the operations its role\'s callers use',
      run: (ctx) => {
        for (const row of rows()) {
          ctx.expect(Array.isArray(row.operations) && row.operations.length > 0, `${row.id} lists its operations`).toBeTruthy();
          row.operations.forEach((name) => ctx.expect(typeof name, `${row.id} operation names are strings`).toBe('string'));
        }
      },
    },

    {
      name: 'each role is served by exactly one provider, and the role lookup answers that row',
      run: (ctx) => {
        ctx.expect([...new Set(rows().map((row) => row.role))].sort()).toEqual(ROLES);

        for (const role of ROLES) {
          const serving = rows().filter((row) => row.role === role);

          ctx.expect(serving.length, `${role} has one provider`).toBe(1);
          ctx.expect(emailProviderForRole(role), `${role} answers its one row`).toBe(serving[0]);
        }
      },
    },

    {
      name: 'emailProvider() answers a known id with its row',
      run: (ctx) => {
        for (const row of rows()) {
          ctx.expect(emailProvider(row.id)).toBe(row);
        }
      },
    },

    {
      name: 'an unknown id or role answers null',
      run: (ctx) => {
        ctx.expect(emailProvider('mailchimp')).toBe(null);
        ctx.expect(emailProvider(undefined)).toBe(null);
        // A provider id is not a role word, and a role word is not a provider id
        ctx.expect(emailProviderForRole('sendgrid')).toBe(null);
        ctx.expect(emailProvider('campaigns')).toBe(null);
        ctx.expect(emailProviderForRole('transactional')).toBe(null);
        ctx.expect(emailProviderForRole(undefined)).toBe(null);
        // A request names the provider, so an inherited property is never one
        ctx.expect(emailProvider('constructor')).toBe(null);
        ctx.expect(emailProviderForRole('__proto__')).toBe(null);
      },
    },

    {
      name: 'the rows are frozen: no caller can edit a provider at runtime',
      run: (ctx) => {
        ctx.expect(Object.isFrozen(EMAIL_PROVIDERS)).toBeTruthy();

        for (const row of rows()) {
          ctx.expect(Object.isFrozen(row), `${row.id} is frozen`).toBeTruthy();
          ctx.expect(Object.isFrozen(row.nativeFields), `${row.id}.nativeFields is frozen`).toBeTruthy();
          ctx.expect(Object.isFrozen(row.operations), `${row.id}.operations is frozen`).toBeTruthy();
        }
      },
    },
  ],
});
