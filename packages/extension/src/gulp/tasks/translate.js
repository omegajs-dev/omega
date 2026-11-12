// Libraries
const build = require('../../build.js');
const logger = build.logger('translate');
const { series } = require('gulp');
const jetpack = require('fs-jetpack');
const path = require('path');
const JSON5 = require('json5');
const { writeJson } = require('@omega.js/devkit/write-json');
const {
  resolveTranslationSettings,
  translateCached,
  hashKey,
  loadCache,
} = require('@omega.js/devkit/translate');

// Locale field limits (shared with audit.js)
const { limits: LOCALE_LIMITS } = require('../config/locales.js');

// Paths
const configMessagesPath = path.join(process.cwd(), 'config', 'messages.json');
const configDescriptionPath = path.join(process.cwd(), 'config', 'description.md');
const distLocalesDir = path.join(process.cwd(), 'dist', '_locales');

// The committed per-string cache: translations/{lang}/messages.json and
// translations/{lang}/description.json, each source hash → translation
const translationsDir = path.join(process.cwd(), 'translations');

const DESCRIPTION_RULES = '- Preserve the markdown formatting (headers, bold, bullets) and keep all emojis exactly as they are.\n- Maintain the same tone: enthusiastic, conversational, and persuasive.';

// Helper: the one warning a cold pass prints per language
function warnCold(settings, lang, namespace, cold) {
  logger.warn(`[${lang}] ${namespace}: ${cold.length} string(s) have no saved translation and ship in ${settings.default}: ${cold.join(', ')}. Build locally to translate them, then commit translations/`);
}

// Helper: Read and parse config/messages.json (JSON5 → object)
function readConfigMessages() {
  if (!jetpack.exists(configMessagesPath)) {
    return null;
  }

  try {
    return JSON5.parse(jetpack.read(configMessagesPath));
  } catch (e) {
    logger.error(`Failed to parse config/messages.json: ${e.message}`);
    return null;
  }
}

// Helper: translation settings from the RESOLVED config (brand root included)
function getSettings() {
  return resolveTranslationSettings(build.getConfig());
}

// Helper: compose a locale's messages.json from the EN source + cache
// (missing translations fall back to English so the file is always complete)
function composeMessages(enMessages, lang, baseDir) {
  const cache = loadCache(baseDir || translationsDir, lang, 'messages');
  const composed = {};

  for (const [key, entry] of Object.entries(enMessages)) {
    composed[key] = {
      ...entry,
      message: cache[hashKey(entry.message)] ?? entry.message,
    };
  }

  return composed;
}

// Deploy locales to dist/_locales/ — EN from config, translations from the
// committed cache. Always runs (dev + build) so package has all locale files.
async function deployTranslations(complete) {
  const enMessages = readConfigMessages();
  if (!enMessages) {
    logger.warn('config/messages.json not found or invalid, skipping');
    return complete();
  }

  // EN straight from config
  writeJson(path.join(distLocalesDir, 'en', 'messages.json'), enMessages);

  // Configured languages from the committed cache (none when disabled)
  const settings = getSettings();
  const languages = settings.enabled ? settings.languages : [];
  let count = 0;

  for (const lang of languages) {
    writeJson(path.join(distLocalesDir, lang, 'messages.json'), composeMessages(enMessages, lang));
    count++;
  }

  logger.log(`Deployed locales to dist/_locales/: en${count ? ` + ${count} translation(s)` : ''}`);

  // Complete
  return complete();
}

// Translate config/messages.json message values — per-KEY incremental: only
// strings without a cache entry (new or edited source) hit the provider.
async function translateMessages(complete) {
  // Only run in build mode
  if (!build.isBuildMode()) {
    logger.log('Skipping messages translation (not in build mode)');
    return complete();
  }

  const settings = getSettings();
  if (!settings.enabled) {
    logger.log('Translation disabled (set translation.languages in omega.json5)');
    return complete();
  }

  const enMessages = readConfigMessages();
  if (!enMessages) {
    logger.warn('config/messages.json not found or invalid, skipping');
    return complete();
  }

  const brand = build.getConfig()?.brand?.name;
  // The build's --cached-only; a CI runner is cache-only regardless
  const { cachedOnly } = build.getArguments();
  const strings = Object.fromEntries(Object.entries(enMessages).map(([key, entry]) => [key, entry.message]));
  const limitsRules = Object.entries(LOCALE_LIMITS)
    .map(([field, limit]) => `- The translation of the "${field}" message must be at most ${limit} characters (Chrome Web Store limit).`)
    .join('\n');

  for (const lang of settings.languages) {
    const { translated, cold, fresh } = await translateCached({
      strings,
      language: lang,
      namespace: 'messages',
      settings,
      cachedOnly,
      rootDir: translationsDir,
      brand,
      extraRules: limitsRules,
    });

    if (cold.length) {
      warnCold(settings, lang, 'messages', cold);
      continue;
    }

    if (!fresh.length) {
      logger.log(`[${lang}] All ${Object.keys(strings).length} messages cached`);
      continue;
    }

    // Warn on Chrome Web Store limit violations (keys sharing a message share a translation)
    for (const [key, text] of Object.entries(translated)) {
      const limit = LOCALE_LIMITS[key];

      if (limit && text.length > limit) {
        logger.warn(`[${lang}] "${key}" translation is ${text.length} chars (limit ${limit}): shorten it in translations/${lang}/messages.json`);
      }
    }

    logger.log(`[${lang}] ${fresh.length} message(s) translated (${settings.provider}), saved`);
  }

  // Complete
  return complete();
}

// Translate config/description.md per language, whole-document, through the
// same committed cache (edit the source → retranslate).
async function translateDescription(complete) {
  // Only run in build mode
  if (!build.isBuildMode()) {
    logger.log('Skipping description translation (not in build mode)');
    return complete();
  }

  const settings = getSettings();
  if (!settings.enabled) {
    return complete();
  }

  if (!jetpack.exists(configDescriptionPath)) {
    logger.log('config/description.md not found, skipping');
    return complete();
  }

  const enDescription = jetpack.read(configDescriptionPath);
  if (!enDescription || !enDescription.trim()) {
    logger.warn('config/description.md is empty, skipping');
    return complete();
  }

  const brand = build.getConfig()?.brand?.name;
  const { cachedOnly } = build.getArguments();

  for (const lang of settings.languages) {
    const { cold, fresh } = await translateCached({
      strings: { description: enDescription },
      language: lang,
      namespace: 'description',
      settings,
      cachedOnly,
      rootDir: translationsDir,
      brand,
      extraRules: DESCRIPTION_RULES,
    });

    if (cold.length) {
      warnCold(settings, lang, 'description', cold);
      continue;
    }

    logger.log(fresh.length ? `[${lang}] Description translated (${settings.provider}), saved` : `[${lang}] Description cached`);
  }

  // Complete
  return complete();
}

/**
 * Read the saved translation of the CURRENT config/description.md, used by
 * the package task for store assets. A cold language answers null, so its
 * store listing falls back to the English one.
 * @param {string} lang - language code
 * @param {string} [baseDir] - translations dir override (tests)
 * @returns {string|null}
 */
function readTranslatedDescription(lang, baseDir) {
  if (!jetpack.exists(configDescriptionPath)) {
    return null;
  }

  const source = jetpack.read(configDescriptionPath);

  return loadCache(baseDir || translationsDir, lang, 'description')[hashKey(source)] ?? null;
}

// Export task
module.exports = series(translateMessages, translateDescription, deployTranslations);
module.exports.readTranslatedDescription = readTranslatedDescription;
module.exports.composeMessages = composeMessages;
