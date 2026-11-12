// Tests for src/lib/service-input.js (#608) — the ONE setup contract every
// service asks its inputs through: present → proceed; missing +
// non-interactive → a LOUD skip line with the machine-readable missingEnv
// list; missing + interactive → the uniform Provide / Skip this run / Disable
// permanently gate, whose Disable lands the service's `enabled: false` in
// omega.json5 so it never asks again. Plus the sweep: every credential the env
// schema (#581) says a service acquires is declared in the registry, every
// service with declared inputs routes through this helper, and the gate's
// wording has exactly one home.

const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ENV_SCHEMA, envFileGroups, generatedEnvKeys, envSchemaEntry, isMachineLocal } = require('@omega.js/config/env-schema');
const { FORMATS } = require('@omega.js/config');
const { REQUIRES, SERVICE_ORDER, OPERATIONS, serviceInputSpec } = require('../src/config.js');
const { requestServiceInput } = require('../src/lib/service-input.js');
const { makeBrandRoot, readConfigSource } = require('./lib/config-fixture.js');
const { openTtyPrompt } = require('./lib/interactive.js');

const VAR = 'OMEGA_TEST_FAKE_INPUT';
const VAR2 = 'OMEGA_TEST_FAKE_INPUT_TWO';
const DOWN = '\x1B[B';

function cleanup(...names) {
  for (const name of names) delete process.env[name];
}

/** A spec with one required input, disabling into `fake.enabled`. */
function fakeSpec(inputs = [{ name: VAR, label: 'Fake token' }]) {
  return {
    service: 'fake',
    label: 'Fake service',
    disablePath: 'fake.enabled',
    inputs,
  };
}

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { result: fn(), lines };
  } finally {
    console.log = original;
  }
}

// ─── what a real service asks for: the one function's answer ─────────────────

const REAL_BRAND = {
  brand: { id: 'b', name: 'B' },
  cloud: { provider: 'firebase', config: { projectId: 'b-live' } },
  targets: { web: { type: 'web' }, backend: { type: 'backend' } },
};
const ASKED_KEYS = ['RECAPTCHA_SECRET_KEY', 'CLOUDFLARE_TOKEN', 'NAMECHEAP_USERNAME', 'NAMECHEAP_API_KEY'];

/**
 * A headless ask of one real service, with the asked keys absent from the env.
 * @param {string} service - The REQUIRES service.
 * @param {object} brandConfig - The brand config.
 * @returns {Promise<object|null>} The gate.
 */
async function askHeadless(service, brandConfig) {
  const saved = Object.fromEntries(ASKED_KEYS.map((key) => [key, process.env[key]]));
  cleanup(...ASKED_KEYS);
  try {
    const captured = captureLog(() => requestServiceInput({ brandRoot: '/nope', brandConfig, options: {} }, serviceInputSpec(service)));
    return await captured.result;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

// ─── the mint lane (generated keys) ──────────────────────────────────────────

const GENERATED = 'OMEGA_WEBHOOK_KEY';

// ─── the sweep ───────────────────────────────────────────────────────────────

const SRC_DIR = path.join(__dirname, '..', 'src');

// Keys the manager reads but must NEVER open a setup gate for — each with the
// reason, so a new exemption is a deliberate line, not a silent gap.
const NOT_A_SETUP_GATE = {
  // One of THREE optional Mr. Logo tiers, and only for a brand with no
  // committed brandmark — the ordinary case is committed art, so an ask would
  // nag every fresh brand, and the only opt-out coarse enough to land
  // (`assets.enabled: false`) would kill the app and social icons with it.
  MRLOGO_SERVICE_ACCOUNT: 'an optional generation tier, not a gate on the assets service',
};

/** Every .js file under a src subtree, as [relative path, contents]. */
function sourceFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(entry.parentPath || entry.path, entry.name))
    .map((file) => [path.relative(SRC_DIR, file), fs.readFileSync(file, 'utf8')]);
}

/**
 * The service INPUTS, derived — not hand-kept: an acquired credential the env
 * schema (#581) assigns to a manage service AND the manager's own source
 * actually reads. A key it never reads (a backend-runtime key whose `owner`
 * only names the provisioning domain, a build-time path) is nobody's prompt.
 */
function serviceInputKeys() {
  const fileGroups = new Set(envFileGroups().map((group) => group.id));
  const sources = sourceFiles(SRC_DIR);

  return ENV_SCHEMA.filter((entry) => entry.name
    && !entry.generated                       // OMEGA mints it — no one to ask
    && entry.group !== 'machine'              // a service writes it on its first real run
    && fileGroups.has(entry.group)            // schema-only groups never reach a .env
    && SERVICE_ORDER.includes(entry.owner)    // owned by a manage service, not the backend runtime
    && !NOT_A_SETUP_GATE[entry.name]
    // Word-boundary, not substring: `process.env.APPLE_API_KEY_ID` must not
    // read as a use of APPLE_API_KEY (a derived signing PATH nobody pastes).
    && sources.some(([, text]) => new RegExp(`process\\.env\\.${entry.name}\\b`).test(text)
      || text.includes(`process.env[${JSON.stringify(entry.name)}]`)));
}

/**
 * Every key the format table names: a ship credential, asked through the table.
 * @returns {Set<string>} The key names.
 */
function shipKeys() {
  const keys = new Set();
  for (const platforms of Object.values(FORMATS)) {
    for (const formats of Object.values(platforms)) {
      for (const spec of Object.values(formats)) {
        for (const key of spec.requires) keys.add(key);
      }
    }
  }

  return keys;
}

module.exports = defineCases({
  type: 'group',
  description: 'service-input',
  tests: [
    // ─── the three outcomes ──────────────────────────────────────────────────────

    {
      name: 'service-input: every input present → proceed, nothing asked',
      run: async (ctx) => {
        process.env[VAR] = 'already-set';
        try {
          const gate = await requestServiceInput({ brandRoot: '/nope', brandConfig: {}, options: {} }, fakeSpec());
          ctx.expect(gate).toBe(null);
        } finally {
          cleanup(VAR);
        }
      },
    },

    {
      name: 'service-input: missing + non-interactive → a LOUD skip line and the missingEnv list',
      run: async (ctx) => {
        cleanup(VAR, VAR2);
        const captured = captureLog(() => requestServiceInput(
          { brandRoot: '/nope', brandConfig: {}, options: {} },
          fakeSpec([{ name: VAR }, { name: VAR2 }]),
        ));
        const gate = await captured.result;

        ctx.expect(gate.skip).toBe(true);
        ctx.expect(gate.missingEnv).toEqual([VAR, VAR2]);
        ctx.expect(gate.reason).toMatch(new RegExp(`${VAR}, ${VAR2}`));
        ctx.expect(gate.reason).toMatch(/rerun interactively/);
        // Loud: the skip NAMES the keys on its own line, never a silent step-aside
        ctx.expect(captured.lines.join('\n')).toMatch(new RegExp(`${VAR}.*${VAR2}`));
      },
    },

    {
      name: 'service-input: dry run never prompts, even on a TTY',
      run: async (ctx) => {
        cleanup(VAR);
        const tty = openTtyPrompt();
        try {
          const gate = await requestServiceInput(
            { brandRoot: '/nope', brandConfig: {}, options: { dryRun: true } },
            fakeSpec(),
          );
          ctx.expect(gate.skip).toBe(true);
          ctx.expect(gate.missingEnv).toEqual([VAR]);
        } finally {
          tty.close();
        }
      },
    },

    {
      name: 'service-input: PROVIDE → pastes, saves to the brand .env, exports, proceeds',
      run: async (ctx) => {
        cleanup(VAR);
        const brandRoot = makeBrandRoot('{\n  brand: { id: "b" },\n}\n');
        fs.writeFileSync(path.join(brandRoot, '.env'), 'EXISTING_KEY="keep-me"\n');

        const tty = openTtyPrompt();
        try {
          const run = requestServiceInput({ brandRoot, brandConfig: {}, brandId: 'b', options: {} }, fakeSpec());
          await tty.answer('Set up now?', '\r');            // Provide
          await tty.answer(`Paste ${VAR}`, 'pasted-value\r');
          const gate = await run;

          ctx.expect(gate).toBe(null);
          ctx.expect(process.env[VAR]).toBe('pasted-value');
          const env = fs.readFileSync(path.join(brandRoot, '.env'), 'utf8');
          ctx.expect(env).toMatch(/EXISTING_KEY="keep-me"/);
          ctx.expect(env).toMatch(new RegExp(`${VAR}="pasted-value"`));
          // Providing never disables anything
          ctx.expect(readConfigSource(brandRoot)).not.toMatch(/enabled/);
        } finally {
          tty.close();
          cleanup(VAR);
          fs.rmSync(brandRoot, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'service-input: SKIP THIS RUN → skips without writing config or .env',
      run: async (ctx) => {
        cleanup(VAR);
        const brandRoot = makeBrandRoot('{\n  brand: { id: "b" },\n}\n');

        const tty = openTtyPrompt();
        try {
          const run = requestServiceInput({ brandRoot, brandConfig: {}, brandId: 'b', options: {} }, fakeSpec());
          await tty.answer('Set up now?', `${DOWN}\r`);      // Skip for now
          const gate = await run;

          ctx.expect(gate.skip).toBe(true);
          ctx.expect(gate.disabled).toBe(undefined);
          ctx.expect(gate.missingEnv).toEqual([VAR]);
          ctx.expect(process.env[VAR]).toBe(undefined);
          ctx.expect(fs.existsSync(path.join(brandRoot, '.env'))).toBe(false);
          ctx.expect(readConfigSource(brandRoot)).not.toMatch(/enabled/);
        } finally {
          tty.close();
          cleanup(VAR);
          fs.rmSync(brandRoot, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'service-input: DISABLE PERMANENTLY → lands enabled: false in omega.json5 and stops asking',
      run: async (ctx) => {
        cleanup(VAR);
        const brandRoot = makeBrandRoot('{\n  brand: { id: "b" },\n  // keep me\n  fake: {},\n}\n');
        const brandConfig = { brand: { id: 'b' }, fake: {} };

        const tty = openTtyPrompt();
        try {
          const run = requestServiceInput({ brandRoot, brandConfig, brandId: 'b', options: {} }, fakeSpec());
          await tty.answer('Set up now?', `${DOWN}${DOWN}\r`); // Disable (stop prompting)
          const gate = await run;

          ctx.expect(gate.skip).toBe(true);
          ctx.expect(gate.disabled).toBe(true);
          ctx.expect(gate.reason).toMatch(/fake\.enabled/);
          // Permanent: written to config (comments preserved) and to the in-memory
          // config, so nothing later in the same run asks again
          const source = readConfigSource(brandRoot);
          ctx.expect(source).toMatch(/enabled: false/);
          ctx.expect(source).toMatch(/\/\/ keep me/);
          ctx.expect(brandConfig.fake.enabled).toBe(false);
          ctx.expect(process.env[VAR]).toBe(undefined);
        } finally {
          tty.close();
          cleanup(VAR);
          fs.rmSync(brandRoot, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'service-input: an already-disabled service never prompts again',
      run: async (ctx) => {
        cleanup(VAR);
        const tty = openTtyPrompt();
        try {
          const gate = await requestServiceInput(
            { brandRoot: '/nope', brandConfig: { fake: { enabled: false } }, options: {} },
            fakeSpec(),
          );
          ctx.expect(gate.skip).toBe(true);
          ctx.expect(gate.reason).toMatch(/fake\.enabled/);
        } finally {
          tty.close();
          cleanup(VAR);
        }
      },
    },

    {
      name: 'service-input: a url\'d input walks to the exact mint page before the paste',
      run: async (ctx) => {
        cleanup(VAR);
        const brandRoot = makeBrandRoot('{\n  brand: { id: "b" },\n}\n');

        const tty = openTtyPrompt();
        const events = [];
        try {
          const run = requestServiceInput(
            { brandRoot, brandConfig: {}, brandId: 'b', options: {} },
            fakeSpec([{ name: VAR, label: 'Fake token', url: 'https://example.com/mint', hint: 'Create one with scopes: fake:write' }]),
            { prompt: { pressEnterToOpen: async (url, label) => { events.push([url, label]); return true; } } },
          );
          await tty.answer('Set up now?', '\r');
          await tty.answer(`Paste ${VAR}`, 'v\r');
          const gate = await run;

          ctx.expect(gate).toBe(null);
          ctx.expect(events).toEqual([['https://example.com/mint', 'the Fake token page']]);
          ctx.expect(process.env[VAR]).toBe('v');
        } finally {
          tty.close();
          cleanup(VAR);
          fs.rmSync(brandRoot, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'service-input: an empty paste skips this run (no writeback, no export)',
      run: async (ctx) => {
        cleanup(VAR);
        const brandRoot = makeBrandRoot('{\n  brand: { id: "b" },\n}\n');

        const tty = openTtyPrompt();
        try {
          const run = requestServiceInput({ brandRoot, brandConfig: {}, brandId: 'b', options: {} }, fakeSpec());
          await tty.answer('Set up now?', '\r');
          await tty.answer(`Paste ${VAR}`, '   \r');
          const gate = await run;

          ctx.expect(gate.skip).toBe(true);
          ctx.expect(gate.missingEnv).toEqual([VAR]);
          ctx.expect(process.env[VAR]).toBe(undefined);
          ctx.expect(fs.existsSync(path.join(brandRoot, '.env'))).toBe(false);
        } finally {
          tty.close();
          cleanup(VAR);
          fs.rmSync(brandRoot, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'service-input: captcha asks for its secret while reCAPTCHA is on, and never once it is off',
      run: async (ctx) => {
        const gate = await askHeadless('captcha', REAL_BRAND);
        ctx.expect(gate.skip).toBe(true);
        ctx.expect(gate.missingEnv).toEqual(['RECAPTCHA_SECRET_KEY']);

        const off = await askHeadless('captcha', { ...REAL_BRAND, captcha: { providers: { recaptcha: { enabled: false } } } });
        ctx.expect(off.skip).toBe(true);
        ctx.expect(off.reason).toMatch(/captcha\.providers\.recaptcha\.enabled/);
      },
    },

    {
      name: 'service-input: the domain asks for the namecheap pair only when namecheap is the registrar',
      run: async (ctx) => {
        const namecheap = await askHeadless('domain', { ...REAL_BRAND, domain: { providers: { namecheap: {} } } });
        ctx.expect([...namecheap.missingEnv].sort()).toEqual(['CLOUDFLARE_TOKEN', 'NAMECHEAP_API_KEY', 'NAMECHEAP_USERNAME']);

        const squarespace = await askHeadless('domain', { ...REAL_BRAND, domain: { providers: { squarespace: {} } } });
        ctx.expect(squarespace.missingEnv).toEqual(['CLOUDFLARE_TOKEN']);
      },
    },

    {
      name: 'service-input: a real service with its key present proceeds, nothing asked',
      run: async (ctx) => {
        process.env.RECAPTCHA_SECRET_KEY = 'already-set';
        try {
          const gate = await requestServiceInput({ brandRoot: '/nope', brandConfig: REAL_BRAND, options: {} }, serviceInputSpec('captcha'));
          ctx.expect(gate).toBe(null);
        } finally {
          cleanup('RECAPTCHA_SECRET_KEY');
        }
      },
    },

    {
      name: 'service-input: a GENERATED key is minted in place — no gate, no paste',
      run: async (ctx) => {
        cleanup(GENERATED);
        const brandRoot = makeBrandRoot('{\n  brand: { id: "b" },\n}\n');

        const tty = openTtyPrompt();
        try {
          const captured = captureLog(() => requestServiceInput(
            { brandRoot, brandConfig: {}, brandId: 'b', options: {} },
            { ...fakeSpec([{ name: GENERATED, label: 'Omega webhook key' }]), service: 'payment' },
          ));
          // Nothing to answer: OMEGA mints this one for itself
          const gate = await captured.result;

          ctx.expect(gate).toBe(null);
          ctx.expect(process.env[GENERATED]).toMatch(/^[A-Za-z0-9_-]{43}$/);
          const env = fs.readFileSync(path.join(brandRoot, '.env'), 'utf8');
          ctx.expect(env).toMatch(new RegExp(`^${GENERATED}="[A-Za-z0-9_-]{43}"$`, 'm'));
          // Names only — the value is never printed
          const text = captured.lines.join('\n');
          ctx.expect(text).toMatch(new RegExp(`${GENERATED} minted into the brand .env`));
          ctx.expect(!text.includes(process.env[GENERATED]), 'the minted value is never printed').toBeTruthy();
          // Nothing was disabled and no gate ran
          ctx.expect(readConfigSource(brandRoot)).not.toMatch(/enabled/);
        } finally {
          tty.close();
          cleanup(GENERATED);
          fs.rmSync(brandRoot, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'service-input: a generated key is minted even on a headless run — nobody has to be asked',
      run: async (ctx) => {
        cleanup(GENERATED);
        const brandRoot = makeBrandRoot('{\n  brand: { id: "b" },\n}\n');
        try {
          const gate = await requestServiceInput(
            { brandRoot, brandConfig: {}, brandId: 'b', options: {} },
            { ...fakeSpec([{ name: GENERATED }]), service: 'campaigns' },
          );

          ctx.expect(gate).toBe(null);
          ctx.expect(process.env[GENERATED]).toBeTruthy();
        } finally {
          cleanup(GENERATED);
          fs.rmSync(brandRoot, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'service-input: a generated key beside a pasted one mints the first and still asks for the second',
      run: async (ctx) => {
        cleanup(GENERATED, VAR);
        const brandRoot = makeBrandRoot('{\n  brand: { id: "b" },\n}\n');

        const tty = openTtyPrompt();
        try {
          const run = requestServiceInput(
            { brandRoot, brandConfig: {}, brandId: 'b', options: {} },
            fakeSpec([{ name: GENERATED }, { name: VAR, label: 'Fake token' }]),
          );
          await tty.answer('Set up now?', '\r');
          await tty.answer(`Paste ${VAR}`, 'pasted-value\r');
          const gate = await run;

          ctx.expect(gate).toBe(null);
          ctx.expect(process.env[GENERATED]).toBeTruthy();
          ctx.expect(process.env[VAR]).toBe('pasted-value');
        } finally {
          tty.close();
          cleanup(GENERATED, VAR);
          fs.rmSync(brandRoot, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'service-input: a dry run PLANS the mint, writes nothing, and never calls it a missing secret',
      run: async (ctx) => {
        cleanup(GENERATED);
        const brandRoot = makeBrandRoot('{\n  brand: { id: "b" },\n}\n');

        const captured = captureLog(() => requestServiceInput(
          { brandRoot, brandConfig: {}, brandId: 'b', options: { dryRun: true } },
          { ...fakeSpec([{ name: GENERATED }]), service: 'newsletter' },
        ));
        const gate = await captured.result;

        try {
          ctx.expect(gate.skip).toBe(true);
          // The reason NAMES the key and says who produces it...
          ctx.expect(gate.reason).toMatch(new RegExp(`${GENERATED} will be minted on a real run`));
          // ...but it is not a missing secret: the 🔑 section must never tell anyone
          // to paste a key only OMEGA can produce
          ctx.expect(gate.missingEnv).toEqual([]);
          ctx.expect(process.env[GENERATED]).toBe(undefined);
          ctx.expect(fs.existsSync(path.join(brandRoot, '.env'))).toBe(false);
          ctx.expect(captured.lines.join('\n')).toMatch(new RegExp(`would mint ${GENERATED}`));
        } finally {
          cleanup(GENERATED);
          fs.rmSync(brandRoot, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'service-input: DISABLE beside a generated key leaves NO minted secret behind',
      run: async (ctx) => {
        cleanup(GENERATED, VAR);
        const brandRoot = makeBrandRoot('{\n  brand: { id: "b" },\n  fake: {},\n}\n');
        const brandConfig = { brand: { id: 'b' }, fake: {} };

        const tty = openTtyPrompt();
        try {
          const run = requestServiceInput(
            { brandRoot, brandConfig, brandId: 'b', options: {} },
            fakeSpec([{ name: GENERATED }, { name: VAR, label: 'Fake token' }]),
          );
          await tty.answer('Set up now?', `${DOWN}${DOWN}\r`);          // Disable (stop prompting)
          const gate = await run;

          ctx.expect(gate.disabled).toBe(true);
          // The gate runs BEFORE the mint: a brand that just opted out never gains
          // a secret it did not ask for
          ctx.expect(process.env[GENERATED]).toBe(undefined);
          ctx.expect(fs.existsSync(path.join(brandRoot, '.env'))).toBe(false);
          // ...and the key nobody can paste is not reported as one to paste
          ctx.expect(gate.missingEnv).toEqual([VAR]);
        } finally {
          tty.close();
          cleanup(GENERATED, VAR);
          fs.rmSync(brandRoot, { recursive: true, force: true });
        }
      },
    },

    {
      name: 'sweep: every credential a service actually reads says in the env schema when it is asked',
      run: (ctx) => {
        const keys = serviceInputKeys();
        // The derivation must not quietly collapse to nothing
        ctx.expect(keys.length > 10, `expected the manager to read many credentials, found ${keys.length}`).toBeTruthy();

        // A ship credential is asked through the format table, its one home
        const ship = shipKeys();
        const unasked = keys
          .filter((entry) => typeof entry.askedWhen !== 'function' && !ship.has(entry.name))
          .map((entry) => `${entry.owner}: ${entry.name}`);

        ctx.expect(unasked, 'give these an askedWhen in @omega.js/config env-schema.js so manage can ask for them').toEqual([]);
      },
    },

    {
      name: 'sweep: every GENERATED key a service reads is minted by the workspace before that service runs',
      run: (ctx) => {
        // A generated key has nobody to paste it, so it must exist before a service
        // reads it. The workspace's env-keys op mints every missing one on each
        // manage, and the workspace walks first. Derived, not listed: the service
        // names come from the source tree, the key names from the env schema.
        ctx.expect(OPERATIONS.workspace.some((operation) => operation.name === 'env-keys'), 'the workspace mints the generated keys').toBeTruthy();
        const workspaceAt = SERVICE_ORDER.indexOf('workspace');

        const servicesDir = path.join(SRC_DIR, 'services');
        const generated = Object.keys(generatedEnvKeys());

        const early = [];
        for (const service of fs.readdirSync(servicesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
          if (service.name === 'workspace') continue;
          const sources = sourceFiles(path.join(servicesDir, service.name));

          for (const name of generated) {
            // A literal read is what binds the service to the key
            const reads = sources.some(([, text]) => text.includes(`process.env.${name}`)
              || text.includes(`process.env[${JSON.stringify(name)}]`));
            if (reads && SERVICE_ORDER.indexOf(service.name) <= workspaceAt) {
              early.push(`${service.name}: ${name}`);
            }
          }
        }

        ctx.expect(early, 'these services read a generated key before the workspace could mint it').toEqual([]);
      },
    },

    {
      name: 'sweep: the mint has exactly ONE home',
      run: (ctx) => {
        // Both lanes (the workspace env-keys op, the setup contract) go through
        // lib/env-secret.js's mintGeneratedKey — a second hand-rolled
        // generate + write + export would drift in wording and in what it exports.
        // Prose ABOUT the mint is not a second mint, so each line is read up to its
        // comment marker — the registry annotates its env-keys op with that wording
        const homes = sourceFiles(SRC_DIR)
          .filter(([, text]) => text.split('\n')
            .some((line) => line.split('//')[0].includes('minted into the brand .env')))
          .map(([file]) => file);

        ctx.expect(homes, 'the mint is mintGeneratedKey — never a second copy').toEqual(['lib/env-secret.js']);
      },
    },

    {
      name: 'sweep: every pasted key says what it is and where to get it (#867)',
      run: (ctx) => {
        // The walk opens a gate with the label and walks to the url; a pasted key
        // with neither is a prompt that says "paste CHROME_REFRESH_TOKEN" and stops.
        // `url: null` is a legitimate answer (no page mints this value), and it owes
        // a hint that says where the value does come from.
        const prompted = ENV_SCHEMA.filter((entry) => entry.askedWhen && !entry.generated);

        ctx.expect(prompted.length > 10, `expected many pasted keys, found ${prompted.length}`).toBeTruthy();

        const unlabelled = prompted.filter((entry) => !entry.label).map((entry) => entry.name);
        ctx.expect(unlabelled, 'give each one a `label` in env-schema.js').toEqual([]);

        const homeless = prompted.filter((entry) => !isMachineLocal(entry.name) && !entry.url && !('url' in entry && entry.hint))
          .map((entry) => entry.name);
        ctx.expect(homeless, 'give each one a `url` (the page that mints it), or `url: null` plus a hint saying where it comes from').toEqual([]);
      },
    },

    {
      name: 'sweep: every ship credential a format needs is askable (#867)',
      run: (ctx) => {
        // The format table names the keys a platform cannot ship without. Each one
        // needs its mint page in the schema, or the publish that refuses on it has
        // nowhere to send the developer.
        const unaskable = [...shipKeys()]
          .map((key) => envSchemaEntry(key))
          .filter((entry) => !entry.label || (!entry.url && !entry.hint))
          .map((entry) => entry.name);

        ctx.expect(unaskable, 'give each ship credential a label plus a url or a hint in env-schema.js').toEqual([]);
      },
    },

    {
      name: 'sweep: every REQUIRES entry can run the three-outcome gate',
      run: (ctx) => {
        for (const [service, declaration] of Object.entries(REQUIRES)) {
          ctx.expect(declaration.label, `REQUIRES.${service} needs a label (the gate's human name)`).toBeTruthy();
          ctx.expect(declaration.disablePath, `REQUIRES.${service} needs a disablePath (where "Disable permanently" lands false)`).toBeTruthy();

          const spec = serviceInputSpec(service);
          ctx.expect(spec.service).toBe(service);
          ctx.expect(spec.disablePath).toBe(declaration.disablePath);
        }
      },
    },

    {
      name: 'sweep: every service with declared inputs routes them through the shared helper',
      run: (ctx) => {
        const routed = (service) => sourceFiles(path.join(SRC_DIR, 'services', service))
          .some(([, text]) => text.includes('service-input.js'));

        const handRolled = Object.keys(REQUIRES).filter((service) => !routed(service));
        ctx.expect(handRolled, 'these services declare inputs but never call requestServiceInput').toEqual([]);
      },
    },

    {
      name: 'run-summary: skipped-for-secrets services aggregate into the 🔑 section',
      run: (ctx) => {
        const { RunSummary } = require('../src/lib/run-summary.js');

        const summary = new RunSummary();
        summary.add('brand-a', 'Brand A', 'edge', { status: 'skipped', reason: 'missing CLOUDFLARE_TOKEN', missingEnv: ['CLOUDFLARE_TOKEN'] });
        summary.add('brand-a', 'Brand A', 'domain', { status: 'skipped', reason: 'missing NAMECHEAP…', missingEnv: ['NAMECHEAP_USERNAME', 'NAMECHEAP_API_KEY'] });
        summary.add('brand-a', 'Brand A', 'repo', { status: 'success' });

        const { lines } = captureLog(() => summary.printSummary());

        const text = lines.join('\n');
        ctx.expect(text).toMatch(/Missing secrets/);
        ctx.expect(text).toMatch(/edge: CLOUDFLARE_TOKEN/);
        ctx.expect(text).toMatch(/domain: NAMECHEAP_USERNAME, NAMECHEAP_API_KEY/);
        ctx.expect(text).toMatch(/--service=edge/);
        ctx.expect(text).toMatch(/--service=domain/);
      },
    },

    {
      name: 'sweep: the Provide / Skip / Disable wording has exactly ONE home',
      run: (ctx) => {
        const homes = sourceFiles(SRC_DIR)
          .filter(([, text]) => text.includes('Disable (stop prompting)'))
          .map(([file]) => file);

        ctx.expect(homes, 'the gate is confirmSetup — never a second copy').toEqual(['lib/config-flow.js']);
      },
    },
  ],
});
