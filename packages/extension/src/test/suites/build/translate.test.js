// Build-layer tests for the translation glue — the engine/cache/providers live
// in @omega.js/devkit/translate (unit-tested there); these cover the
// extension-specific pieces: composing a locale's messages.json from the
// committed per-string cache (EN fallback for gaps, developer descriptions
// kept in English), the saved store description read back by its source, the
// cache-only task on a runner, and the publish workflow's secrets block.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { stripVTControlCharacters } = require('util');
const jetpack = require('fs-jetpack');

const { composeMessages } = require('../../../gulp/tasks/translate.js');
const { scaffoldDefaults } = require('../../../gulp/tasks/defaults.js');
const { stageProject, inProject } = require('../../utils/package-project.js');
const { hashKey, saveCache } = require('@omega.js/devkit/translate');
const { CI_FLAGS } = require('@omega.js/devkit/ci');
const defineCases = require('@omega.js/devkit/test/define-cases');

const EN_MESSAGES = {
  appName: { message: 'OMEGA', description: 'The name of the extension.' },
  appNameShort: { message: 'OMEGA', description: 'The short name of the extension.' },
  btnTooltip: { message: 'Click to open', description: 'Tooltip for the button.' },
};

// The default claude provider's SDK, as the devkit engine resolves it: stubbed so
// a provider call is counted and fails, and never reaches the real service.
const SDK_PATH = require.resolve('@anthropic-ai/claude-agent-sdk', { paths: [path.dirname(require.resolve('@omega.js/devkit/translate'))] });
const GULP = require(require.resolve('gulp', { paths: [path.join(__dirname, '..', '..', '..')] }));

// A staged extension that translates to es with the default provider.
function stageTranslating(files) {
  return stageProject({
    config: `{ brand: { id: 'staged', name: 'Staged' }, translation: { languages: ['es'] }, targets: { extension: { type: 'extension' } } }`,
    files,
  });
}

/**
 * Run the build's translate task in `dir` in build mode, on a runner (`ci`) or
 * a laptop, with `args` as the gulp lane's command line, and hand back its
 * outcome, its warnings and the provider calls it made. Every variable it sets
 * is put back as it was.
 */
async function runTranslate(dir, { ci, args = [] }) {
  const env = { OMEGA_BUILD_MODE: 'true', OMEGA_ENVIRONMENT: undefined, ...Object.fromEntries(CI_FLAGS.map((name) => [name, undefined])) };
  if (ci) env.CI = 'true';
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const previousArgv = process.argv;
  const warnings = [];
  const originalWarn = console.warn;
  let sdkCalls = 0;

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.argv = [previousArgv[0], 'gulp', ...args];
  require.cache[SDK_PATH] = {
    id: SDK_PATH, filename: SDK_PATH, loaded: true,
    exports: {
      query: () => (async function* () {
        sdkCalls++;
        yield { type: 'result', subtype: 'error_during_execution', result: 'a cache-only build must never call the provider' };
      })(),
    },
  };
  console.warn = (...args) => warnings.push(stripVTControlCharacters(args.join(' ')));
  // A failed gulp step is also emitted on the gulp instance; unheard, it throws past the callback
  const swallow = () => {};
  GULP.on('error', swallow);

  try {
    const failure = await inProject(dir, (task) => new Promise((resolve) => {
      const result = task(resolve);
      if (result && typeof result.then === 'function') result.then(() => resolve(), resolve);
    }), path.join('gulp', 'tasks', 'translate.js'));
    return { failure, warnings, sdkCalls };
  } finally {
    GULP.removeListener('error', swallow);
    process.argv = previousArgv;
    console.warn = originalWarn;
    delete require.cache[SDK_PATH];
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

module.exports = defineCases({
  type: 'group',
  layer: 'build',
  description: 'translation glue (devkit engine consumers)',
  tests: [
    {
      name: 'composeMessages: cache hits land, gaps fall back to English, descriptions stay English',
      run: (ctx) => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-translate-'));

        // Cache carries a translation for the shared "OMEGA" string only
        saveCache(tmp, 'es', 'messages', { [hashKey('OMEGA')]: 'OMEGA·es' });

        const composed = composeMessages(EN_MESSAGES, 'es', tmp);

        // Shared source string → both keys get the cached translation
        ctx.expect(composed.appName.message).toBe('OMEGA·es');
        ctx.expect(composed.appNameShort.message).toBe('OMEGA·es');
        // No cache entry → English fallback (file always complete)
        ctx.expect(composed.btnTooltip.message).toBe('Click to open');
        // Developer-facing descriptions never translate
        ctx.expect(composed.appName.description).toBe('The name of the extension.');

        jetpack.remove(tmp);
      },
    },
    {
      name: 'source edit invalidates: a changed EN message misses the old cache entry',
      run: (ctx) => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-translate-'));
        saveCache(tmp, 'es', 'messages', { [hashKey('Old tooltip')]: 'Vieja' });

        const composed = composeMessages(
          { btnTooltip: { message: 'New tooltip', description: 'd' } },
          'es',
          tmp
        );

        ctx.expect(composed.btnTooltip.message).toBe('New tooltip');

        jetpack.remove(tmp);
      },
    },
    {
      name: 'readTranslatedDescription: the saved text for the current description, null when none is saved',
      run: async (ctx) => {
        const source = '# The Description\n\nHello.';
        const tmp = stageProject({ files: { 'config/description.md': source } });
        const translations = path.join(tmp, 'translations');
        saveCache(translations, 'es', 'description', { [hashKey(source)]: '# La Descripción\n\nHola.' }, [source]);
        // fr carries only a translation of an earlier source, which an edit made stale
        saveCache(translations, 'fr', 'description', { [hashKey('# The Old Description')]: '# L\'ancienne' }, ['# The Old Description']);

        try {
          await inProject(tmp, (task) => {
            ctx.expect(task.readTranslatedDescription('es', translations)).toBe('# La Descripción\n\nHola.');
            ctx.expect(task.readTranslatedDescription('fr', translations), 'a stale entry is no translation').toBe(null);
            ctx.expect(task.readTranslatedDescription('de', translations), 'nothing saved').toBe(null);
          }, path.join('gulp', 'tasks', 'translate.js'));
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'on a runner cold messages call no provider, ship their source text, and the build passes with one warning for the language naming them',
      run: async (ctx) => {
        const tmp = stageTranslating({
          'config/messages.json': JSON.stringify({
            appName: { message: 'Staged', description: 'The name of the extension.' },
            btnTooltip: { message: 'Click to open', description: 'Tooltip for the button.' },
            appDescription: { message: 'A staged extension.', description: 'The description of the extension.' },
          }),
        });
        saveCache(path.join(tmp, 'translations'), 'es', 'messages', { [hashKey('Staged')]: 'Staged·es' }, ['Staged']);

        try {
          const { failure, warnings, sdkCalls } = await runTranslate(tmp, { ci: true });

          ctx.expect(failure, 'the build goes on').toBe(undefined);
          ctx.expect(sdkCalls, 'CI with no flag is cache-only').toBe(0);
          // One warning for the language, never one per key
          const naming = warnings.filter((line) => line.includes('btnTooltip') || line.includes('appDescription'));
          ctx.expect(naming.length, `one warning names the cold keys: ${JSON.stringify(warnings)}`).toBe(1);
          ctx.expect(/\bes\b/.test(naming[0]) && naming[0].includes('messages'), 'it names the language and the namespace').toBeTruthy();
          ctx.expect(naming[0].includes('btnTooltip') && naming[0].includes('appDescription'), 'and every cold key').toBeTruthy();

          const locale = JSON.parse(fs.readFileSync(path.join(tmp, 'dist', '_locales', 'es', 'messages.json'), 'utf8'));
          ctx.expect(locale.appName.message, 'the saved translation ships').toBe('Staged·es');
          ctx.expect(locale.btnTooltip.message, 'the cold message ships its source text').toBe('Click to open');
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'off a runner, --cached-only on the gulp lane makes the task cache-only: no provider call, the cold message ships its source text',
      run: async (ctx) => {
        const tmp = stageTranslating({
          'config/messages.json': JSON.stringify({ btnTooltip: { message: 'Click to open', description: 'Tooltip for the button.' } }),
        });

        try {
          const { failure, sdkCalls } = await runTranslate(tmp, { ci: false, args: ['build', '--cached-only'] });

          ctx.expect(failure, 'the build goes on').toBe(undefined);
          ctx.expect(sdkCalls, 'the flag alone makes the task cache-only').toBe(0);
          const locale = JSON.parse(fs.readFileSync(path.join(tmp, 'dist', '_locales', 'es', 'messages.json'), 'utf8'));
          ctx.expect(locale.btnTooltip.message).toBe('Click to open');
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'on a runner a cold store description calls no provider and the build passes with a warning naming it',
      run: async (ctx) => {
        const tmp = stageTranslating({
          'config/messages.json': JSON.stringify({ appName: { message: 'Staged', description: 'The name of the extension.' } }),
          'config/description.md': '# Staged\n\nA staged extension for the store listing.\n',
        });
        saveCache(path.join(tmp, 'translations'), 'es', 'messages', { [hashKey('Staged')]: 'Staged·es' }, ['Staged']);

        try {
          const { failure, warnings, sdkCalls } = await runTranslate(tmp, { ci: true });

          ctx.expect(failure, 'the build goes on').toBe(undefined);
          ctx.expect(sdkCalls, 'CI with no flag is cache-only').toBe(0);
          ctx.expect(
            warnings.some((line) => /\bes\b/.test(line) && line.includes('description')),
            `a warning names the language and the description: ${JSON.stringify(warnings)}`
          ).toBeTruthy();
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'the scaffolded publish workflow carries no AI key, even with one in the target .env',
      run: (ctx) => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-translate-workflow-'));
        fs.writeFileSync(path.join(tmp, '.env'), 'OPENAI_API_KEY="sk-fixture"\nANTHROPIC_API_KEY="sk-ant-fixture"\nFIXTURE_OWN_KEY="own"\n');

        try {
          scaffoldDefaults({ outputDir: tmp });
          const workflow = fs.readFileSync(path.join(tmp, '.github', 'workflows', 'publish.yml'), 'utf8');

          // The control: the target's own .env reached the generated secrets block
          ctx.expect(workflow).toContain('FIXTURE_OWN_KEY: ${{ secrets.FIXTURE_OWN_KEY }}');
          ctx.expect(workflow.includes('OPENAI_API_KEY'), 'no OpenAI key reaches the runner').toBe(false);
          ctx.expect(workflow.includes('ANTHROPIC_API_KEY'), 'no Anthropic key reaches the runner').toBe(false);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
  ],
});
