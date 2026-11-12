/**
 * @omega.js/devkit/translate — the shared OMEGA translation system: language
 * SSOT, provider abstraction (claude via local Claude Code / chatgpt via
 * OpenAI), the batch translation engine, and the committed per-string cache.
 * Config contract (shared `translation` section of omega.json5):
 *   { enabled, default, languages, providers: { claude|chatgpt: {} }, model }
 */
const { chosenProvider } = require('@omega.js/config');
const { LANGUAGE_NAMES, LANGUAGE_LOCALES, RTL_LANGUAGES, isRTL, languageName, ogLocale, assertKnownLanguages } = require('./languages.js');
const { PROVIDERS, DEFAULT_MODELS, resolveProvider } = require('./providers.js');
const { translateStrings, preserveWhitespace, CONTROL, BATCH_SIZE, CONCURRENCY } = require('./engine.js');
const { hashKey, cachePath, loadCache, saveCache } = require('./cache.js');
const { translateCached, isCachedOnly } = require('./cached.js');

/**
 * Read + validate the `translation` section of a resolved config.
 * @param {object} config - resolved omega.json5 config
 * @returns {{ enabled: boolean, default: string, languages: string[], provider: string, model: string|null }}
 *   enabled is false when the section is off or lists no languages
 */
function resolveTranslationSettings(config) {
  const section = config?.translation || {};
  const languages = section.languages || [];

  assertKnownLanguages(languages);

  return {
    enabled: section.enabled !== false && languages.length > 0,
    default: section.default || 'en',
    languages,
    // The engine is a KEY under translation.providers (#425); no block at all
    // means claude, the no-API-key default.
    provider: chosenProvider(section.providers) || 'claude',
    model: section.model || null,
  };
}

module.exports = {
  // languages
  LANGUAGE_NAMES, LANGUAGE_LOCALES, RTL_LANGUAGES, isRTL, languageName, ogLocale, assertKnownLanguages,
  // providers
  PROVIDERS, DEFAULT_MODELS, resolveProvider,
  // engine
  translateStrings, preserveWhitespace, CONTROL, BATCH_SIZE, CONCURRENCY,
  // cache
  hashKey, cachePath, loadCache, saveCache,
  // the one cached call
  translateCached, isCachedOnly,
  // config
  resolveTranslationSettings,
};
