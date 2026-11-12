/**
 * Test: Email validation library (libraries/email/validation.js)
 * Unit tests for format, local part, disposable domain, corporate domain, typo domain, DNS, and mailbox checks
 *
 * Format, local part, disposable, corporate, and typo tests always run (free, sync, offline-safe).
 * DNS negative tests against live DNS require TEST_EXTENDED_MODE; the two against a loopback DNS server always run.
 * Mailbox verification tests require TEST_EXTENDED_MODE + NEVERBOUNCE_API_KEY or ZEROBOUNCE_API_KEY.
 */
const dgram = require('node:dgram');
const dns = require('node:dns');
const { validate, isDisposable, isCorporate, DEFAULT_CHECKS, ALL_CHECKS } = require('../../dist/omega/libraries/email/validation.js');
const defineCases = require('../../dist/vendor/devkit/test/define-cases.js');

const HAS_MAILBOX_API_KEY = !!(process.env.NEVERBOUNCE_API_KEY || process.env.ZEROBOUNCE_API_KEY);

// DNS response codes the loopback server answers with.
const RCODE_SERVFAIL = 2;
const RCODE_NXDOMAIN = 3;

/**
 * A DNS reply to `query`: its own id and question, no records, and `rcode`.
 * @param {Buffer} query - The raw query packet.
 * @param {number} rcode - The response code to answer with.
 * @returns {Buffer} The reply packet.
 */
function dnsReply(query, rcode) {
  let end = 12;
  while (query[end] !== 0) end += query[end] + 1;
  // The root label's zero byte, then QTYPE and QCLASS.
  end += 5;

  const reply = Buffer.from(query.subarray(0, end));
  // QR and RA set; opcode and RD echoed from the query.
  reply.writeUInt16BE(0x8000 | (query.readUInt16BE(2) & 0x7900) | 0x0080 | rcode, 2);
  reply.writeUInt16BE(1, 4);
  reply.writeUInt16BE(0, 6);
  reply.writeUInt16BE(0, 8);
  reply.writeUInt16BE(0, 10);
  return reply;
}

/**
 * Start a real DNS server on loopback that answers every query with `rcode`, and
 * point node's resolver at it until the case ends.
 * @param {number} rcode - The response code every query gets.
 * @param {Function} after - The case's `after`, which restores the resolver and closes the server.
 * @returns {Promise<void>} Resolves once the server listens and the resolver points at it.
 */
async function pointDnsAtServerAnswering(rcode, after) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (query, from) => socket.send(dnsReply(query, rcode), from.port, from.address));
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));

  const servers = dns.getServers();
  after(async () => {
    dns.setServers(servers);
    await new Promise((resolve) => socket.close(resolve));
  });
  dns.setServers([`127.0.0.1:${socket.address().port}`]);
}

module.exports = defineCases({
  description: 'Email validation',
  type: 'group',
  tests: [
    // --- Format checks ---

    {
      name: 'format-valid-email-passes',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('rachel.greene@gmail.com');

        expect(result.valid, 'Valid email should pass').toBe(true);
        expect(result, 'Format check should pass').toHaveProperty('checks.format.valid', true);
      },
    },

    {
      name: 'format-no-at-sign-fails',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('not-a-valid-email');

        expect(result.valid, 'Missing @ should fail').toBe(false);
        expect(result, 'Format check should fail').toHaveProperty('checks.format.valid', false);
      },
    },

    {
      name: 'format-no-domain-fails',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('user@');

        expect(result.valid, 'Missing domain should fail').toBe(false);
        expect(result, 'Format check should fail').toHaveProperty('checks.format.valid', false);
      },
    },

    {
      name: 'format-empty-string-fails',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('');

        expect(result.valid, 'Empty string should fail').toBe(false);
        expect(result, 'Format check should fail').toHaveProperty('checks.format.valid', false);
      },
    },

    {
      name: 'format-spaces-fails',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('user name@gmail.com');

        expect(result.valid, 'Spaces should fail').toBe(false);
        expect(result, 'Format check should fail').toHaveProperty('checks.format.valid', false);
      },
    },

    // --- Local part checks ---

    {
      name: 'localpart-test-blocked',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('test@gmail.com');

        expect(result.valid, '"test" local part should be blocked').toBe(false);
        expect(result, 'Should be flagged as blocked').toHaveProperty('checks.localPart.blocked', true);
        expect(result, 'Should include the local part').toHaveProperty('checks.localPart.localPart', 'test');
      },
    },

    {
      name: 'localpart-noreply-blocked',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('noreply@company.com');

        expect(result.valid, '"noreply" local part should be blocked').toBe(false);
        expect(result, 'Should be flagged as blocked').toHaveProperty('checks.localPart.blocked', true);
      },
    },

    {
      name: 'localpart-admin-allowed',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('admin@company.com');

        expect(result.valid, '"admin" local part should be allowed (team/role address)').toBe(true);
        expect(result, 'localPart check should pass').toHaveProperty('checks.localPart.valid', true);
      },
    },

    {
      name: 'localpart-all-numeric-allowed',
      timeout: 5000,

      async run({ expect }) {
        // All-numeric local parts are legitimate (QQ emails like 1549482839@qq.com,
        // student IDs) — the ^\d+$ pattern was removed in v5.5.6 after NeverBounce
        // confirmed real users were being blocked.
        const result = await validate('123456@gmail.com');

        expect(result.valid, 'All-numeric local part should be allowed').toBe(true);
        expect(result, 'localPart check should pass').toHaveProperty('checks.localPart.valid', true);
      },
    },

    {
      name: 'localpart-repeating-chars-blocked',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('aaaa@gmail.com');

        expect(result.valid, 'Repeating chars should be blocked').toBe(false);
        expect(result, 'Should be flagged as blocked').toHaveProperty('checks.localPart.blocked', true);
      },
    },

    {
      name: 'localpart-keyboard-walk-blocked',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('asdf@gmail.com');

        expect(result.valid, 'Keyboard walk should be blocked').toBe(false);
        expect(result, 'Should be flagged as blocked').toHaveProperty('checks.localPart.blocked', true);
      },
    },

    {
      name: 'localpart-test-prefix-blocked',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('test.user@gmail.com');

        expect(result.valid, '"test." prefix should be blocked').toBe(false);
        expect(result, 'Should be flagged as blocked').toHaveProperty('checks.localPart.blocked', true);
      },
    },

    {
      name: 'localpart-letter-plus-numbers-allowed',
      timeout: 5000,

      async run({ expect }) {
        // Short letter + numbers local parts are legitimate (real Gmail users like
        // mi1925973, hk9526802) — the ^[a-z]{1,2}\d+$ pattern was removed in v5.5.6
        // after NeverBounce confirmed real users were being blocked.
        const result = await validate('a123@gmail.com');

        expect(result.valid, 'Single letter + numbers should be allowed').toBe(true);
        expect(result, 'localPart check should pass').toHaveProperty('checks.localPart.valid', true);
      },
    },

    {
      name: 'localpart-plus-suffix-stripped-before-check',
      timeout: 5000,

      async run({ expect }) {
        // "test+something" → strips to "test" → blocked
        const result = await validate('test+newsletter@gmail.com');

        expect(result.valid, '"test+suffix" should still be blocked (strips +suffix first)').toBe(false);
        expect(result, 'Should be blocked after stripping suffix').toHaveProperty('checks.localPart.blocked', true);
      },
    },

    {
      name: 'localpart-backend-suffix-allowed-on-real-names',
      timeout: 5000,

      async run({ expect }) {
        // "rachel.greene+bem" → strips to "rachel.greene" → allowed
        const result = await validate('rachel.greene+bem@gmail.com');

        expect(result.valid, 'Real name with +bem suffix should pass').toBe(true);
        expect(result, 'Local part check should pass').toHaveProperty('checks.localPart.valid', true);
      },
    },

    {
      name: 'localpart-real-name-passes',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('john.smith@company.com');

        expect(result.valid, 'Real name should pass').toBe(true);
        expect(result, 'Local part check should pass').toHaveProperty('checks.localPart.valid', true);
      },
    },

    {
      name: 'localpart-single-real-name-passes',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('rachel@company.com');

        expect(result.valid, 'Single real name should pass').toBe(true);
        expect(result, 'Local part check should pass').toHaveProperty('checks.localPart.valid', true);
      },
    },

    // --- Disposable domain checks ---

    {
      name: 'disposable-mailinator-blocked',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('rachel.greene@mailinator.com');

        expect(result.valid, 'Mailinator should be invalid').toBe(false);
        expect(result, 'Should be flagged as blocked').toHaveProperty('checks.disposable.blocked', true);
        expect(result, 'Should include blocked domain').toHaveProperty('checks.disposable.domain', 'mailinator.com');
      },
    },

    {
      name: 'disposable-guerrillamail-blocked',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('rachel.greene@guerrillamail.com');

        expect(result.valid, 'GuerrillaMail should be invalid').toBe(false);
        expect(result, 'Should be flagged as blocked').toHaveProperty('checks.disposable.blocked', true);
      },
    },

    {
      name: 'disposable-tempmail-blocked',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('rachel.greene@temp-mail.org');

        expect(result.valid, 'temp-mail.org should be invalid').toBe(false);
        expect(result, 'Should be flagged as blocked').toHaveProperty('checks.disposable.blocked', true);
      },
    },

    {
      name: 'valid-gmail-passes-disposable',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('rachel.greene@gmail.com');

        expect(result.valid, 'Gmail should be valid').toBe(true);
        expect(result, 'Should pass disposable check').toHaveProperty('checks.disposable.valid', true);
        expect(result, 'Should not be blocked').toHaveProperty('checks.disposable.blocked', false);
      },
    },

    {
      name: 'valid-custom-domain-passes',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('ian@somiibo.com');

        expect(result.valid, 'Custom domain should be valid').toBe(true);
        expect(result, 'Should pass disposable check').toHaveProperty('checks.disposable.valid', true);
      },
    },

    // --- Corporate / social-media domain checks ---

    {
      name: 'corporate-meta-blocked',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('ian@meta.com');

        expect(result.valid, 'meta.com should be blocked').toBe(false);
        expect(result, 'Should be flagged as blocked').toHaveProperty('checks.corporate.blocked', true);
        expect(result, 'Should include blocked domain').toHaveProperty('checks.corporate.domain', 'meta.com');
        expect(result, 'Should have human-readable reason').toHaveProperty('checks.corporate.reason', 'Corporate/social-media domain');
      },
    },

    {
      name: 'corporate-instagram-blocked',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('rachel.greene@instagram.com');

        expect(result.valid, 'instagram.com should be blocked').toBe(false);
        expect(result, 'Should be flagged as blocked').toHaveProperty('checks.corporate.blocked', true);
      },
    },

    {
      name: 'corporate-soundcloud-blocked',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('user@soundcloud.com');

        expect(result.valid, 'soundcloud.com should be blocked').toBe(false);
        expect(result, 'Should be flagged as blocked').toHaveProperty('checks.corporate.blocked', true);
      },
    },

    {
      name: 'corporate-gmail-allowed',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('rachel.greene@gmail.com');

        expect(result.valid, 'gmail.com should NOT be flagged as corporate').toBe(true);
        expect(result, 'Corporate check should pass').toHaveProperty('checks.corporate.valid', true);
        expect(result, 'Should not be blocked').toHaveProperty('checks.corporate.blocked', false);
      },
    },

    {
      name: 'corporate-runs-before-localpart',
      timeout: 5000,

      async run({ expect }) {
        // "test@meta.com" would be blocked by BOTH corporate and localPart;
        // corporate runs first, so we should see corporate (not localPart) in the result.
        const result = await validate('test@meta.com');

        expect(result.valid, 'Should be blocked').toBe(false);
        expect(result, 'Corporate should be the failure reason').toHaveProperty('checks.corporate.blocked', true);
        expect(result.checks.localPart, 'localPart should not run after corporate fails').toBe(undefined);
      },
    },

    {
      name: 'corporate-can-be-skipped-via-checks-option',
      timeout: 5000,

      async run({ expect }) {
        // Allow a caller to bypass the corporate check (e.g., during signup, where Meta employees are real users)
        const result = await validate('ian@meta.com', { checks: ['format', 'disposable', 'localPart'] });

        expect(result.valid, 'Without corporate check, meta.com should pass').toBe(true);
        expect(result.checks.corporate, 'corporate should not run').toBe(undefined);
      },
    },

    // --- Typo domain checks ---

    {
      name: 'typo-gamil-blocked',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('rachel.greene@gamil.com');

        expect(result.valid, 'gamil.com should be blocked as a typo of gmail.com').toBe(false);
        expect(result, 'Typo check should fail').toHaveProperty('checks.typo.valid', false);
        expect(result, 'Should report the matched prefix').toHaveProperty('checks.typo.matchedPrefix', 'gamil.');
        expect(result, 'Should have human-readable reason').toHaveProperty('checks.typo.reason', 'Likely misspelled domain');
      },
    },

    {
      name: 'typo-gmail-con-blocked',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('rachel.greene@gmail.con');

        expect(result.valid, 'gmail.con should be blocked as a typo TLD').toBe(false);
        expect(result, 'Typo check should fail').toHaveProperty('checks.typo.valid', false);
      },
    },

    {
      name: 'typo-correct-domains-pass',
      timeout: 5000,

      async run({ expect }) {
        const gmail = await validate('rachel.greene@gmail.com');
        const hotmail = await validate('rachel.greene@hotmail.com');

        expect(gmail.valid, 'gmail.com should pass').toBe(true);
        expect(gmail, 'Typo check should pass for gmail.com').toHaveProperty('checks.typo.valid', true);
        expect(hotmail.valid, 'hotmail.com should pass').toBe(true);
        expect(hotmail, 'Typo check should pass for hotmail.com').toHaveProperty('checks.typo.valid', true);
      },
    },

    // --- isCorporate helper ---

    {
      name: 'isCorporate-social-domain-detected',
      timeout: 5000,

      async run({ expect }) {
        expect(isCorporate('user@meta.com'), 'meta.com should be corporate').toBe(true);
        expect(isCorporate('user@instagram.com'), 'instagram.com should be corporate').toBe(true);
        expect(isCorporate('user@soundcloud.com'), 'soundcloud.com should be corporate').toBe(true);
        expect(isCorporate('user@tiktok.com'), 'tiktok.com should be corporate').toBe(true);
        expect(isCorporate('user@linkedin.com'), 'linkedin.com should be corporate').toBe(true);
      },
    },

    {
      name: 'isCorporate-legitimate-domain-passes',
      timeout: 5000,

      async run({ expect }) {
        expect(isCorporate('user@gmail.com'), 'gmail.com should not be corporate').toBe(false);
        expect(isCorporate('user@somiibo.com'), 'Custom domain should not be corporate').toBe(false);
        expect(isCorporate('user@mailinator.com'), 'Disposable is a separate category').toBe(false);
      },
    },

    {
      name: 'isCorporate-accepts-domain-only',
      timeout: 5000,

      async run({ expect }) {
        expect(isCorporate('meta.com'), 'Should work with bare domain').toBe(true);
        expect(isCorporate('gmail.com'), 'Should work with bare domain').toBe(false);
      },
    },

    {
      name: 'isCorporate-handles-edge-cases',
      timeout: 5000,

      async run({ expect }) {
        expect(isCorporate(''), 'Empty string should return false').toBe(false);
        expect(isCorporate(null), 'Null should return false').toBe(false);
        expect(isCorporate(undefined), 'Undefined should return false').toBe(false);
      },
    },

    {
      name: 'isCorporate-case-insensitive',
      timeout: 5000,

      async run({ expect }) {
        expect(isCorporate('user@META.COM'), 'Should be case-insensitive').toBe(true);
        expect(isCorporate('USER@Instagram.Com'), 'Should be case-insensitive').toBe(true);
      },
    },

    // --- isDisposable helper ---

    {
      name: 'isDisposable-vendor-domain-detected',
      timeout: 5000,

      async run({ expect }) {
        expect(isDisposable('user@mailinator.com'), 'mailinator.com should be disposable').toBe(true);
        expect(isDisposable('user@guerrillamail.com'), 'guerrillamail.com should be disposable').toBe(true);
      },
    },

    {
      name: 'isDisposable-custom-domain-detected',
      timeout: 5000,

      async run({ expect }) {
        expect(isDisposable('user@sharebot.net'), 'Custom list domain should be disposable').toBe(true);
        expect(isDisposable('user@pickmemail.com'), 'Custom list domain should be disposable').toBe(true);
      },
    },

    {
      name: 'isDisposable-legitimate-domain-passes',
      timeout: 5000,

      async run({ expect }) {
        expect(isDisposable('user@gmail.com'), 'gmail.com should not be disposable').toBe(false);
        expect(isDisposable('user@somiibo.com'), 'Custom domain should not be disposable').toBe(false);
      },
    },

    {
      name: 'isDisposable-accepts-domain-only',
      timeout: 5000,

      async run({ expect }) {
        expect(isDisposable('mailinator.com'), 'Should work with bare domain').toBe(true);
        expect(isDisposable('gmail.com'), 'Should work with bare domain').toBe(false);
      },
    },

    {
      name: 'isDisposable-handles-edge-cases',
      timeout: 5000,

      async run({ expect }) {
        expect(isDisposable(''), 'Empty string should return false').toBe(false);
        expect(isDisposable(null), 'Null should return false').toBe(false);
        expect(isDisposable(undefined), 'Undefined should return false').toBe(false);
      },
    },

    // --- Selective checks ---

    {
      name: 'checks-format-only',
      timeout: 5000,

      async run({ expect }) {
        // "test@gmail.com" normally blocked by localPart, but only running format
        const result = await validate('test@gmail.com', { checks: ['format'] });

        expect(result.valid, 'Should pass with only format check').toBe(true);
        expect(result, 'Format should pass').toHaveProperty('checks.format.valid', true);
        expect(result.checks.localPart, 'localPart should not run').toBe(undefined);
        expect(result.checks.disposable, 'disposable should not run').toBe(undefined);
      },
    },

    {
      name: 'checks-format-and-disposable-skips-localpart',
      timeout: 5000,

      async run({ expect }) {
        // "test@gmail.com" would be blocked by localPart, but we only run format + disposable
        const result = await validate('test@gmail.com', { checks: ['format', 'disposable'] });

        expect(result.valid, 'Should pass without localPart check').toBe(true);
        expect(result, 'Format should pass').toHaveProperty('checks.format.valid', true);
        expect(result, 'Disposable should pass').toHaveProperty('checks.disposable.blocked', false);
        expect(result.checks.localPart, 'localPart should not run').toBe(undefined);
      },
    },

    {
      name: 'checks-format-and-disposable-still-blocks-disposable',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('rachel.greene@mailinator.com', { checks: ['format', 'disposable'] });

        expect(result.valid, 'Disposable should still fail').toBe(false);
        expect(result, 'Should be blocked').toHaveProperty('checks.disposable.blocked', true);
      },
    },

    {
      name: 'checks-default-matches-expected',
      timeout: 5000,

      async run({ expect }) {
        expect(DEFAULT_CHECKS, 'DEFAULT_CHECKS should be all free sync checks (no dns/mailbox)').toEqual(['format', 'disposable', 'corporate', 'localPart', 'typo']);
        expect(ALL_CHECKS, 'ALL_CHECKS should add dns + mailbox').toEqual(['format', 'disposable', 'corporate', 'localPart', 'typo', 'dns', 'mailbox']);
      },
    },

    // --- DNS check behavior ---

    {
      name: 'dns-not-in-default-checks',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('rachel.greene@gmail.com');

        expect(result.valid, 'Should be valid').toBe(true);
        expect(result.checks.dns, 'DNS should not run with default checks (async/slow — opt-in)').toBe(undefined);
      },
    },

    {
      name: 'dns-valid-domain-passes',
      timeout: 15000,

      async run({ expect }) {
        // Offline-safe: on network errors the dns check is skipped (valid stays true);
        // only definitive no-MX/NXDOMAIN answers block.
        const result = await validate('rachel.greene@gmail.com', { checks: ['format', 'dns'] });

        expect(result.valid, 'gmail.com should pass the DNS check').toBe(true);
        expect(result, 'Should have dns check result').toHaveProperty('checks.dns');
      },
    },

    {
      name: 'dns-nonexistent-domain-fails',
      timeout: 15000,
      skip: !process.env.TEST_EXTENDED_MODE
        ? 'TEST_EXTENDED_MODE not set (requires live DNS resolution)'
        : false,

      async run({ expect }) {
        const result = await validate('rachel.greene@thisdomaindoesnotexist99887766.com', { checks: ['format', 'dns'] });

        expect(result.valid, 'Nonexistent domain should fail the DNS check').toBe(false);
        expect(result, 'DNS check should fail').toHaveProperty('checks.dns.valid', false);
      },
    },

    {
      name: 'dns-server-failure-skips-the-check',

      async run({ expect, after }) {
        await pointDnsAtServerAnswering(RCODE_SERVFAIL, after);
        const result = await validate('rachel.greene@gmail.com', { checks: ['format', 'dns'] });

        expect(result.valid, 'A DNS server failure (SERVFAIL) should not block the address').toBe(true);
        expect(result.checks.dns, 'SERVFAIL should skip the DNS check').toEqual({ valid: true, skipped: true, reason: 'DNS error: ESERVFAIL' });
      },
    },

    {
      name: 'dns-nxdomain-answer-fails',

      async run({ expect, after }) {
        await pointDnsAtServerAnswering(RCODE_NXDOMAIN, after);
        const result = await validate('rachel.greene@gmail.com', { checks: ['format', 'dns'] });

        expect(result.valid, 'An NXDOMAIN answer should fail the DNS check').toBe(false);
        expect(result, 'NXDOMAIN should block with its reason').toHaveProperty('checks.dns.reason', 'DNS lookup failed: ENOTFOUND');
        expect(result, 'DNS check should fail').toHaveProperty('checks.dns.valid', false);
      },
    },

    // --- Mailbox verification behavior ---

    {
      name: 'mailbox-not-in-default-checks',
      timeout: 5000,

      async run({ expect }) {
        const result = await validate('rachel.greene@gmail.com');

        expect(result.valid, 'Should be valid').toBe(true);
        expect(result.checks.mailbox, 'Mailbox should not run with default checks').toBe(undefined);
      },
    },

    {
      name: 'mailbox-skipped-without-api-key',
      timeout: 5000,

      async run({ expect }) {
        const originalNB = process.env.NEVERBOUNCE_API_KEY;
        const originalZB = process.env.ZEROBOUNCE_API_KEY;
        delete process.env.NEVERBOUNCE_API_KEY;
        delete process.env.ZEROBOUNCE_API_KEY;

        try {
          const result = await validate('rachel.greene@gmail.com', { checks: ALL_CHECKS });

          expect(result.valid, 'Should still be valid').toBe(true);
          expect(result, 'Should have mailbox check').toHaveProperty('checks.mailbox');
          expect(result, 'Should be marked as skipped').toHaveProperty('checks.mailbox.skipped', true);
        } finally {
          if (originalNB) {
            process.env.NEVERBOUNCE_API_KEY = originalNB;
          }
          if (originalZB) {
            process.env.ZEROBOUNCE_API_KEY = originalZB;
          }
        }
      },
    },

    // --- Mailbox verification API checks (require TEST_EXTENDED_MODE + mailbox API key) ---

    {
      name: 'mailbox-valid-email-passes',
      timeout: 15000,
      skip: !process.env.TEST_EXTENDED_MODE || !HAS_MAILBOX_API_KEY
        ? 'TEST_EXTENDED_MODE or mailbox API key not set'
        : false,

      async run({ expect, skip }) {
        const result = await validate('disposable@gmail.com', { checks: ALL_CHECKS });

        // Provider errors fail open as { valid: true, error } with NO status field —
        // out of credits, bad key, timeouts. Nothing assertable; skip.
        if (result.checks.mailbox?.error) {
          skip(`Mailbox verification unavailable: ${result.checks.mailbox.error}`);
        }

        expect(result, 'Should have mailbox check').toHaveProperty('checks.mailbox');
        expect(result, 'Should have status').toHaveProperty('checks.mailbox.status');
      },
    },

    {
      name: 'mailbox-not-called-when-dns-fails',
      timeout: 15000,
      skip: !process.env.TEST_EXTENDED_MODE || !HAS_MAILBOX_API_KEY
        ? 'TEST_EXTENDED_MODE or mailbox API key not set'
        : false,

      async run({ expect, skip }) {
        const result = await validate('rachel.greene@thisfakedomain99999.com', { checks: ALL_CHECKS });

        // Transient resolver errors fail open (dns: { valid: true, skipped: true })
        // and let mailbox run — the short-circuit can't be observed that run.
        if (result.checks.dns?.skipped) {
          skip(`DNS lookup errored (${result.checks.dns.reason}) — cannot observe short-circuit`);
        }

        expect(result.valid, 'Fake domain should be invalid').toBe(false);
        expect(result, 'DNS check should fail (NXDOMAIN)').toHaveProperty('checks.dns.valid', false);
        expect(result.checks.mailbox, 'Mailbox must NOT run after dns fails — the short-circuit saves a paid API call').toBe(undefined);
      },
    },

    {
      name: 'mailbox-nonexistent-mailbox-not-valid',
      timeout: 15000,
      skip: !process.env.TEST_EXTENDED_MODE || !HAS_MAILBOX_API_KEY
        ? 'TEST_EXTENDED_MODE or mailbox API key not set'
        : false,

      async run({ expect, skip }) {
        // Real-MX domain (gmail passes dns) with a fabricated local part — this is
        // the case that actually reaches the paid mailbox provider.
        const result = await validate('rachel.greene.zk84qx@gmail.com', { checks: ALL_CHECKS });

        expect(result, 'Should have mailbox check').toHaveProperty('checks.mailbox');

        const mb = result.checks.mailbox;

        // Provider errors fail open as { valid: true, error } with NO status; skip.
        if (mb.error) {
          skip(`Mailbox verification unavailable: ${mb.error}`);
        }

        expect(mb, 'Should have status').toHaveProperty('status');
        expect(mb.status, 'Fabricated gmail mailbox should not verify as valid').not.toBe('valid');
      },
    },
  ],
});
