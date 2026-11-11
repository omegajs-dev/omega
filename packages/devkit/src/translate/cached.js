/**
 * The ONE cached translation call every pass makes: the committed cache
 * lookup, the cache-only switch, the live provider call for cold strings and
 * the save. The website's page pass and the extension's messages and store
 * description passes all translate through it.
 *
 * Strings are a key → source map; the answer keeps the same keys. The call is
 * cache-only on a CI runner or when the caller asks: a cold string keeps its
 * source text and `cold` names its key, so a runner builds from the committed
 * cache with no provider and no key.
 */
const { isCI } = require('../ci.js');
const { languageName } = require('./languages.js');
const { resolveProvider } = require('./providers.js');
const { translateStrings } = require('./engine.js');
const { hashKey, loadCache, saveCache } = require('./cache.js');

/**
 * Whether a build reads the saved translations only: on a CI runner, or when
 * its caller passed `--cached-only`.
 * @param {boolean} [flag] - the build's `--cached-only` flag
 * @param {object} env - the environment to read (`process.env`, or a test's own)
 * @returns {boolean}
 */
function isCachedOnly(flag, env) {
  return Boolean(flag) || isCI(env);
}

/**
 * Translate a key → source map through the committed cache.
 * @param {object} options - { strings, language, namespace, settings, cachedOnly, rootDir }:
 *   strings is key → source, namespace the cache file ('pages/about', 'messages'),
 *   cachedOnly the caller's `--cached-only` (a CI runner is cache-only regardless),
 *   settings the resolved translation settings, rootDir the target's `translations/`;
 *   optional send (provider override), brand and extraRules ride to the engine
 * @returns {Promise<{ translated: object, cold: string[], fresh: string[], usage: object }>}
 *   translated has every key; cold names the keys left in the source language,
 *   fresh the keys the provider translated on this call
 */
async function translateCached(options) {
  const { strings, language, namespace, settings, rootDir, brand, extraRules } = options;
  const cachedOnly = isCachedOnly(options.cachedOnly, process.env);
  const cache = loadCache(rootDir, language, namespace);
  const keys = Object.keys(strings);
  const translated = {};
  const misses = [];

  for (const key of keys) {
    const hit = cache[hashKey(strings[key])];

    if (hit === undefined) {
      misses.push(key);
    } else {
      translated[key] = hit;
    }
  }

  if (cachedOnly && misses.length) {
    misses.forEach((key) => { translated[key] = strings[key]; });
    return { translated, cold: misses, fresh: [], usage: { input: 0, output: 0 } };
  }

  let usage = { input: 0, output: 0 };

  if (misses.length) {
    const send = options.send || resolveProvider({ provider: settings.provider, model: settings.model }).send;
    const outcome = await translateStrings({
      strings: misses.map((key) => strings[key]),
      language,
      languageName: languageName(language),
      brand,
      extraRules,
      send,
    });

    misses.forEach((key, i) => {
      translated[key] = outcome.result[i];
      cache[hashKey(strings[key])] = outcome.result[i];
    });
    usage = outcome.usage;
  }

  saveCache(rootDir, language, namespace, cache, keys.map((key) => strings[key]));

  return { translated, cold: [], fresh: misses, usage };
}

module.exports = { translateCached, isCachedOnly };
