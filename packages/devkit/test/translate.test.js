/**
 * @omega.js/devkit/translate — engine protocol (batching, control sentinel,
 * validation retries, whitespace), providers (resolution, chatgpt parsing),
 * committed per-string cache (roundtrip, prune, corruption), language SSOT,
 * and the translation-settings reader.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const defineCases = require('@omega.js/devkit/test/define-cases');
const { withoutCI } = require('@omega.js/devkit/test/without-ci');

const {
  translateCached,
  translateStrings,
  preserveWhitespace,
  CONTROL,
  BATCH_SIZE,
  CONCURRENCY,
  resolveProvider,
  DEFAULT_MODELS,
  hashKey,
  loadCache,
  saveCache,
  LANGUAGE_NAMES,
  LANGUAGE_LOCALES,
  isRTL,
  languageName,
  ogLocale,
  assertKnownLanguages,
  resolveTranslationSettings,
} = require('../src/translate/index.js');

/**
 * A well-behaved fake provider: translates by suffixing '·XX', echoes the
 * control sentinel, and records every call.
 */
function fakeSend(calls = []) {
  return async ({ system, user }) => {
    calls.push({ system, user });
    const payload = JSON.parse(user.slice(user.indexOf('\n\n') + 2));
    const out = payload.map((s) => (s === CONTROL ? s : `${s.trim()}·XX`));
    return { text: JSON.stringify(out), usage: { input: 10, output: 20 } };
  };
}

// A provider any call to which fails the case: a warm or cache-only lookup never reaches it.
const refuseSend = async () => { throw new Error('the provider must not be called'); };

// The resolved settings the one cached call reads, translation on for es.
const CACHED_SETTINGS = resolveTranslationSettings({ brand: { name: 'MiniCo' }, translation: { languages: ['es'] } });

module.exports = defineCases({
  type: 'group',
  description: 'translate',
  tests: [
    // ── engine ─────────────────────────────────────────────────────────────────

    {
      name: 'translateStrings: aligned result, whitespace preserved, usage aggregated',
      run: async (ctx) => {
        const calls = [];
        const { result, usage } = await translateStrings({
          strings: ['Hello world', ' padded ', 'Third'],
          language: 'es',
          languageName: 'Spanish',
          brand: 'MiniCo',
          send: fakeSend(calls),
        });

        ctx.expect(result).toEqual(['Hello world·XX', ' padded·XX ', 'Third·XX']);
        ctx.expect(calls.length).toBe(1);
        ctx.expect(calls[0].system.includes('MiniCo'), 'brand lands in the system prompt').toBeTruthy();
        ctx.expect(calls[0].user.includes('Spanish'), 'language name lands in the user message').toBeTruthy();
        ctx.expect(usage).toEqual({ input: 10, output: 20 });
      },
    },

    {
      name: 'translateStrings: batches of 25 with the sentinel appended to each',
      run: async (ctx) => {
        const calls = [];
        const strings = Array.from({ length: BATCH_SIZE * 2 + 3 }, (_, i) => `s${i}`);
        const { result } = await translateStrings({ strings, language: 'fr', languageName: 'French', send: fakeSend(calls) });

        ctx.expect(result.length).toBe(strings.length);
        ctx.expect(calls.length).toBe(3);
        for (const call of calls) {
          const payload = JSON.parse(call.user.slice(call.user.indexOf('\n\n') + 2));
          ctx.expect(payload[payload.length - 1], 'every batch carries the sentinel last').toBe(CONTROL);
        }
      },
    },

    {
      name: '#604: batches fly CONCURRENCY-wide at once and land back in order',
      run: async (ctx) => {
        // Sequential batching made one language a long serial wait: every 25-string
        // batch paid the model's full latency before the next one was asked.
        const strings = Array.from({ length: BATCH_SIZE * (CONCURRENCY * 2) }, (_, i) => `s${i}`);
        let inFlight = 0;
        let peak = 0;

        const send = async ({ user }) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          const payload = JSON.parse(user.slice(user.indexOf('\n\n') + 2));
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight--;
          return { text: JSON.stringify(payload.map((s) => (s === CONTROL ? s : `${s}·XX`))), usage: { input: 1, output: 1 } };
        };

        const { result, usage } = await translateStrings({ strings, language: 'es', languageName: 'Spanish', send });

        ctx.expect(peak, `${CONCURRENCY} batches were in flight at once, not ${peak}`).toBe(CONCURRENCY);
        ctx.expect(result, 'completion order never reorders the result').toEqual(strings.map((s) => `${s}·XX`));
        ctx.expect(usage.input, 'every batch is still counted').toBe(CONCURRENCY * 2);
      },
    },

    {
      name: 'translateStrings: length mismatch retries, then succeeds',
      run: async (ctx) => {
        let attempts = 0;
        const send = async ({ user }) => {
          attempts++;
          const payload = JSON.parse(user.slice(user.indexOf('\n\n') + 2));
          if (attempts === 1) {
            return { text: JSON.stringify(payload.slice(1)), usage: {} }; // short by one
          }
          return { text: JSON.stringify(payload), usage: {} };
        };

        const { result } = await translateStrings({ strings: ['a', 'b'], language: 'es', languageName: 'Spanish', send });
        ctx.expect(result.length).toBe(2);
        ctx.expect(attempts).toBe(2);
      },
    },

    {
      name: '#523: a batch the provider keeps collapsing is re-asked in halves, not lost',
      run: async (ctx) => {
        // The playground's /blog/ship-the-docs-with-the-diff: 26 out, 25 back, on
        // every attempt, in BOTH languages, across two runs — a model that merges a
        // pair of adjacent twins is deterministic, so retrying the same batch can
        // only fail the same way and the page shipped untranslated. Splitting the
        // batch separates the pair and every string comes back.
        const payloadSizes = [];
        const send = async ({ user }) => {
          const payload = JSON.parse(user.slice(user.indexOf('\n\n') + 2));
          payloadSizes.push(payload.length);
          // The collapse, reproduced: adjacent NEAR-identical strings come back as
          // one. Exact twins no longer reach a batch (#529 dedupes them), but the
          // near-twins a headline and its meta description are still adjacent.
          const out = payload.filter((text, i) => i === 0 || text.slice(0, 20) !== payload[i - 1].slice(0, 20));
          return { text: JSON.stringify(out), usage: { input: 1, output: 2 } };
        };

        const TWINS = ['Ship the docs with the diff', 'Ship the docs with the diff — a follow-up'];
        const strings = Array.from({ length: BATCH_SIZE }, (_, i) => (i === 10 || i === 11 ? TWINS[i - 10] : `s${i}`));
        const { result, usage } = await translateStrings({ strings, language: 'es', languageName: 'Spanish', send });

        ctx.expect(result, 'every string comes back, in its own position').toEqual(strings);
        ctx.expect(payloadSizes[0], 'the full batch was asked first').toBe(BATCH_SIZE + 1);
        ctx.expect(payloadSizes.length > 3, `the collapsing batch was split, not just retried: ${payloadSizes.join(', ')}`).toBeTruthy();
        ctx.expect(usage.input > 0 && usage.output > 0, 'every call the split made is counted').toBeTruthy();
      },
    },

    {
      name: '#523: a single string the provider will not return whole still fails loudly',
      run: async (ctx) => {
        // Splitting bottoms out: one string plus the sentinel is unambiguous, so a
        // provider that still collapses it is broken — the page-language pair is
        // skipped whole, never shipped half-translated.
        const send = async ({ user }) => {
          const payload = JSON.parse(user.slice(user.indexOf('\n\n') + 2));
          return { text: JSON.stringify(payload.slice(1)), usage: {} };
        };

        await ctx.expect(translateStrings({ strings: ['a', 'b'], language: 'es', languageName: 'Spanish', send })).rejects.toThrow(/length mismatch/);
      },
    },

    {
      name: '#529: a repeated string is translated once and fanned back to every occurrence',
      run: async (ctx) => {
        // A page sends its title and description once per meta tag — <title>,
        // og:title, twitter:title — so the failing #523 page shipped each of them
        // three times, adjacently, in one batch. Every duplicate was AI spend, and
        // adjacent twins are what the model merges.
        const calls = [];
        const strings = [
          'Ship the docs with the diff',
          'A post about shipping docs',
          'Ship the docs with the diff',
          'A post about shipping docs',
          'Ship the docs with the diff',
          'A post about shipping docs',
          'Read more',
        ];

        const { result } = await translateStrings({ strings, language: 'es', languageName: 'Spanish', send: fakeSend(calls) });

        ctx.expect(result, 'every occurrence lands translated, in its own position').toEqual(strings.map((s) => `${s}·XX`));
        ctx.expect(calls.length).toBe(1);

        const payload = JSON.parse(calls[0].user.slice(calls[0].user.indexOf('\n\n') + 2));
        ctx.expect(payload, 'each unique string is sent exactly once').toEqual(['Ship the docs with the diff', 'A post about shipping docs', 'Read more', CONTROL]);
      },
    },

    {
      name: '#529: dedupe is what fills a batch, so uniques past the batch size still split',
      run: async (ctx) => {
        // The dedupe happens BEFORE batching: 60 strings that are 30 unique ride two
        // batches, not three.
        const calls = [];
        const unique = Array.from({ length: BATCH_SIZE + 5 }, (_, i) => `s${i}`);
        const strings = [...unique, ...unique];

        const { result } = await translateStrings({ strings, language: 'es', languageName: 'Spanish', send: fakeSend(calls) });

        ctx.expect(result.length, 'every occurrence comes back').toBe(strings.length);
        ctx.expect(result.slice(0, unique.length), 'both halves got the same translations').toEqual(result.slice(unique.length));
        ctx.expect(calls.length, `${unique.length} uniques is two batches, not ${Math.ceil(strings.length / BATCH_SIZE)}`).toBe(2);
      },
    },

    {
      name: 'translateStrings: altered control sentinel exhausts retries and throws',
      run: async (ctx) => {
        let attempts = 0;
        const send = async ({ user }) => {
          attempts++;
          const payload = JSON.parse(user.slice(user.indexOf('\n\n') + 2));
          return { text: JSON.stringify(payload.map(() => 'CORRUPTED')), usage: {} };
        };

        await ctx.expect(translateStrings({ strings: ['a'], language: 'es', languageName: 'Spanish', send })).rejects.toThrow(/control sentinel/);
        ctx.expect(attempts, 'initial + 2 retries').toBe(3);
      },
    },

    {
      name: 'translateStrings: markdown fences around the JSON are stripped',
      run: async (ctx) => {
        const send = async ({ user }) => {
          const payload = JSON.parse(user.slice(user.indexOf('\n\n') + 2));
          return { text: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``, usage: {} };
        };

        const { result } = await translateStrings({ strings: ['x'], language: 'es', languageName: 'Spanish', send });
        ctx.expect(result).toEqual(['x']);
      },
    },

    {
      name: 'translateStrings: empty input short-circuits without calling the provider',
      run: async (ctx) => {
        const { result } = await translateStrings({
          strings: [],
          language: 'es',
          languageName: 'Spanish',
          send: async () => { throw new Error('must not be called'); },
        });
        ctx.expect(result).toEqual([]);
      },
    },

    {
      name: 'preserveWhitespace keeps the original edges',
      run: (ctx) => {
        ctx.expect(preserveWhitespace('  hi ', 'hola')).toBe('  hola ');
        ctx.expect(preserveWhitespace('hi', ' hola ')).toBe('hola');
      },
    },

    // ── providers ──────────────────────────────────────────────────────────────

    {
      name: 'resolveProvider: defaults, overrides, unknown name',
      run: (ctx) => {
        const claude = resolveProvider({});
        ctx.expect(claude.name).toBe('claude');
        ctx.expect(claude.model).toBe(DEFAULT_MODELS.claude);

        const custom = resolveProvider({ provider: 'chatgpt', model: 'gpt-x' });
        ctx.expect(custom.model).toBe('gpt-x');

        ctx.expect(() => resolveProvider({ provider: 'gemini' })).toThrow(/Unknown translation provider/);
      },
    },

    {
      name: 'chatgpt provider: requires OPENAI_API_KEY, parses the Responses shape',
      run: async (ctx) => {
        const saved = process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_API_KEY;

        try {
          await ctx.expect(resolveProvider({ provider: 'chatgpt' }).send({ system: 's', user: 'u' })).rejects.toThrow(/OPENAI_API_KEY/);

          process.env.OPENAI_API_KEY = 'test-key';
          const provider = resolveProvider({
            provider: 'chatgpt',
            fetchFn: async (url, init) => {
              ctx.expect(url.includes('api.openai.com')).toBeTruthy();
              ctx.expect(JSON.parse(init.body).model).toBe(DEFAULT_MODELS.chatgpt);
              return {
                ok: true,
                json: async () => ({
                  output: [
                    { type: 'reasoning' },
                    { type: 'message', content: [{ type: 'output_text', text: '["hola"]' }] },
                  ],
                  usage: { input_tokens: 5, output_tokens: 7 },
                }),
              };
            },
          });

          const { text, usage } = await provider.send({ system: 's', user: 'u' });
          ctx.expect(text).toBe('["hola"]');
          ctx.expect(usage).toEqual({ input: 5, output: 7 });
        } finally {
          if (saved === undefined) {
            delete process.env.OPENAI_API_KEY;
          } else {
            process.env.OPENAI_API_KEY = saved;
          }
        }
      },
    },

    // ── cache ──────────────────────────────────────────────────────────────────

    {
      name: 'cache: roundtrip, prune to current sources, corruption tolerance, empty removal',
      run: (ctx) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-tcache-'));

        const map = { [hashKey('Hello')]: 'Hola', [hashKey('Old')]: 'Viejo' };
        saveCache(root, 'es', 'pages/home', map, ['Hello']);

        const loaded = loadCache(root, 'es', 'pages/home');
        ctx.expect(loaded, 'stale entry pruned').toEqual({ [hashKey('Hello')]: 'Hola' });

        // Corrupt file → {}
        fs.writeFileSync(path.join(root, 'es', 'pages', 'home.json'), 'not json');
        ctx.expect(loadCache(root, 'es', 'pages/home')).toEqual({});

        // Empty map removes the file
        saveCache(root, 'es', 'pages/home', {}, []);
        ctx.expect(!fs.existsSync(path.join(root, 'es', 'pages', 'home.json'))).toBeTruthy();

        fs.rmSync(root, { recursive: true, force: true });
      },
    },

    // ── the one cached call ────────────────────────────────────────────────────

    {
      name: 'translateCached: every string saved answers the saved text and calls no provider',
      run: (ctx) => withoutCI(async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-tcached-'));
        saveCache(root, 'es', 'messages', { [hashKey('Hello')]: 'Hola', [hashKey('Goodbye')]: 'Adiós' }, ['Hello', 'Goodbye']);

        try {
          const { translated, cold } = await translateCached({
            strings: { greet: 'Hello', leave: 'Goodbye' },
            language: 'es',
            namespace: 'messages',
            settings: CACHED_SETTINGS,
            rootDir: root,
            send: refuseSend,
          });

          ctx.expect(translated).toEqual({ greet: 'Hola', leave: 'Adiós' });
          ctx.expect(cold).toEqual([]);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }),
    },

    {
      name: 'translateCached: under cachedOnly a cold string keeps its source text, is named in cold, and is never saved',
      run: (ctx) => withoutCI(async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-tcached-'));
        saveCache(root, 'es', 'messages', { [hashKey('Hello')]: 'Hola' }, ['Hello']);

        try {
          const { translated, cold } = await translateCached({
            strings: { greet: 'Hello', tip: 'Click to open' },
            language: 'es',
            namespace: 'messages',
            settings: CACHED_SETTINGS,
            cachedOnly: true,
            rootDir: root,
            send: refuseSend,
          });

          ctx.expect(translated).toEqual({ greet: 'Hola', tip: 'Click to open' });
          ctx.expect(cold).toEqual(['tip']);
          // The source text is a fallback for this build, never a translation to commit
          ctx.expect(loadCache(root, 'es', 'messages')).toEqual({ [hashKey('Hello')]: 'Hola' });
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }),
    },

    {
      name: 'translateCached: without cachedOnly a cold string goes to the provider once and the result is saved',
      run: (ctx) => withoutCI(async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-tcached-'));
        saveCache(root, 'es', 'messages', { [hashKey('Hello')]: 'Hola' }, ['Hello']);
        const calls = [];

        try {
          const { translated, cold } = await translateCached({
            strings: { greet: 'Hello', tip: 'Click to open' },
            language: 'es',
            namespace: 'messages',
            settings: CACHED_SETTINGS,
            rootDir: root,
            send: fakeSend(calls),
          });

          ctx.expect(calls.length).toBe(1);
          const payload = JSON.parse(calls[0].user.slice(calls[0].user.indexOf('\n\n') + 2));
          ctx.expect(payload, 'only the cold string rides the call').toEqual(['Click to open', CONTROL]);
          ctx.expect(translated).toEqual({ greet: 'Hola', tip: 'Click to open·XX' });
          ctx.expect(cold).toEqual([]);
          ctx.expect(loadCache(root, 'es', 'messages')).toEqual({ [hashKey('Hello')]: 'Hola', [hashKey('Click to open')]: 'Click to open·XX' });
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }),
    },

    {
      name: 'translateCached: two keys sharing a cold source text send it once and both answer the one result',
      run: (ctx) => withoutCI(async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-tcached-'));
        const calls = [];

        try {
          const { translated, cold } = await translateCached({
            strings: { appName: 'Staged', appNameShort: 'Staged' },
            language: 'es',
            namespace: 'messages',
            settings: CACHED_SETTINGS,
            rootDir: root,
            send: fakeSend(calls),
          });

          const sent = calls.flatMap((call) => JSON.parse(call.user.slice(call.user.indexOf('\n\n') + 2)));
          ctx.expect(sent.filter((text) => text === 'Staged').length, 'the shared text is sent once').toBe(1);
          ctx.expect(translated).toEqual({ appName: 'Staged·XX', appNameShort: 'Staged·XX' });
          ctx.expect(cold).toEqual([]);
          ctx.expect(loadCache(root, 'es', 'messages'), 'one saved entry').toEqual({ [hashKey('Staged')]: 'Staged·XX' });
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }),
    },

    // ── languages + settings ───────────────────────────────────────────────────

    {
      name: 'language SSOT: names, RTL, unknown-code rejection',
      run: (ctx) => {
        ctx.expect(languageName('es')).toBe('Spanish');
        ctx.expect(languageName('xx')).toBe('xx');
        ctx.expect(isRTL('ar') && !isRTL('es')).toBeTruthy();
        ctx.expect(Object.keys(LANGUAGE_NAMES).length >= 30).toBeTruthy();
        ctx.expect(() => assertKnownLanguages(['es', 'klingon'])).toThrow(/klingon/);
      },
    },

    {
      name: 'ogLocale: Open Graph language_TERRITORY form for every supported code',
      run: (ctx) => {
        ctx.expect(ogLocale('en')).toBe('en_US');
        ctx.expect(ogLocale('es')).toBe('es_ES');
        ctx.expect(ogLocale('ar')).toBe('ar_AR');
        ctx.expect(ogLocale('no'), 'Norwegian carries the bokmal territory').toBe('nb_NO');

        // Every target language is mapped, and every locale is language_TERRITORY
        for (const code of Object.keys(LANGUAGE_NAMES)) {
          ctx.expect(ogLocale(code), `${code} has a locale`).toMatch(/^[a-z]{2}_[A-Z]{2}$/);
        }
        ctx.expect(Object.keys(LANGUAGE_LOCALES).length, 'the map is the language set plus en').toBe(Object.keys(LANGUAGE_NAMES).length + 1);

        // Unmapped source language falls back to the bare code
        ctx.expect(ogLocale('xx')).toBe('xx');
      },
    },

    {
      name: 'resolveTranslationSettings: defaults + gating',
      run: (ctx) => {
        const off = resolveTranslationSettings({});
        ctx.expect(off.enabled).toBe(false);
        ctx.expect(off.provider).toBe('claude');
        ctx.expect(off.default).toBe('en');

        // The engine is a KEY under translation.providers (#425) — presence picks it
        const on = resolveTranslationSettings({ translation: { languages: ['es'], providers: { chatgpt: {} }, model: 'm' } });
        ctx.expect(on.enabled).toBe(true);
        ctx.expect(on.languages).toEqual(['es']);
        ctx.expect(on.provider).toBe('chatgpt');
        ctx.expect(on.model).toBe('m');

        // An empty providers block is no pick at all, so the claude default stands
        const empty = resolveTranslationSettings({ translation: { languages: ['es'], providers: {} } });
        ctx.expect(empty.provider).toBe('claude');

        const disabled = resolveTranslationSettings({ translation: { enabled: false, languages: ['es'] } });
        ctx.expect(disabled.enabled).toBe(false);

        ctx.expect(() => resolveTranslationSettings({ translation: { languages: ['nope'] } })).toThrow(/nope/);
      },
    },

    {
      name: 'claude provider fails loud when the Agent SDK is not installed',
      run: async (ctx) => {
        // #37: web no longer ships the SDK as a runtime dependency, so a target that
        // enabled translation without installing it must hit a named, actionable
        // error (never a silent skip). The resolution is stubbed, not uninstalled.
        const Module = require('node:module');
        const original = Module._resolveFilename;
        Module._resolveFilename = function (request, ...rest) {
          if (request === '@anthropic-ai/claude-agent-sdk') {
            const error = new Error(`Cannot find module '${request}'`);
            error.code = 'MODULE_NOT_FOUND';
            throw error;
          }
          return original.call(this, request, ...rest);
        };

        try {
          await ctx.expect(resolveProvider({ provider: 'claude' }).send({ system: 's', user: 'u' })).rejects.toThrow((e) => {
              ctx.expect(e.message, 'the error names the package').toMatch(/@anthropic-ai\/claude-agent-sdk/);
              ctx.expect(e.message, 'the error carries the install command').toMatch(/npm install @anthropic-ai\/claude-agent-sdk/);
              ctx.expect(e.message, 'the error says why it is not bundled').toMatch(/opt-in and the SDK is heavy/);
              return true;
            });
        } finally {
          Module._resolveFilename = original;
        }
      },
    },

    {
      name: 'claude provider surfaces SDK error results immediately — a failed call never hangs the build',
      run: async (ctx) => {
        const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk');
        require.cache[sdkPath] = {
          id: sdkPath,
          filename: sdkPath,
          loaded: true,
          exports: {
            query: () => (async function* () {
              yield { type: 'result', subtype: 'error_during_execution', result: 'Session limit reached · resets 6pm' };
            })(),
          },
        };

        try {
          await ctx.expect(resolveProvider({ provider: 'claude' }).send({ system: 's', user: 'u' })).rejects.toThrow(/failed \(error_during_execution\).*Session limit/s);
        } finally {
          delete require.cache[sdkPath];
        }
      },
    },

    {
      name: 'claude provider times out a stalled SDK call instead of hanging',
      run: async (ctx) => {
        const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk');
        require.cache[sdkPath] = {
          id: sdkPath,
          filename: sdkPath,
          loaded: true,
          exports: {
            // A call that never yields and never returns — the cp119 28-minute stall
            query: () => (async function* () { await new Promise(() => {}); })(),
          },
        };

        process.env.OMEGA_TRANSLATE_TIMEOUT_MS = '80';
        try {
          await ctx.expect(resolveProvider({ provider: 'claude' }).send({ system: 's', user: 'u' })).rejects.toThrow(/exceeded .*stalled SDK call/);
        } finally {
          delete process.env.OMEGA_TRANSLATE_TIMEOUT_MS;
          delete require.cache[sdkPath];
        }
      },
    },

    {
      name: 'claude provider hides ANTHROPIC_API_KEY from the SDK — subscription-only auth by contract',
      run: async (ctx) => {
        // Inject a fake SDK before sendClaude's lazy require runs
        const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk');
        const seen = {};
        require.cache[sdkPath] = {
          id: sdkPath,
          filename: sdkPath,
          loaded: true,
          exports: {
            query: ({ options }) => {
              seen.env = options.env;
              return (async function* () {
                yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } };
              })();
            },
          },
        };

        process.env.ANTHROPIC_API_KEY = 'sk-would-bill-api-credits';
        try {
          await resolveProvider({ provider: 'claude' }).send({ system: 's', user: 'u' });
          ctx.expect(seen.env, 'the provider passes an explicit env to the SDK').toBeTruthy();
          ctx.expect(seen.env.ANTHROPIC_API_KEY, 'the API key never reaches the SDK').toBe(undefined);
          ctx.expect(Object.keys(seen.env).length > 0, 'the rest of the environment passes through').toBeTruthy();
        } finally {
          delete process.env.ANTHROPIC_API_KEY;
          delete require.cache[sdkPath];
        }
      },
    },
  ],
});
