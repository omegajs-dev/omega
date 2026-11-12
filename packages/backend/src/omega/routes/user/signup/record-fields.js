/**
 * Pure helpers POST /user/signup builds its record and its log lines with.
 */

/**
 * The top-level key names of a payload, for a log line that must not carry the payload.
 *
 * The incoming settings and the record signup writes carry api keys, consent records,
 * the request IP and the attribution, and a backend line lands in Cloud Logging for
 * the whole retention window. The SHAPE is what a log reader needs; the values belong
 * at `ctx.debug` or nowhere.
 *
 * @param {*} value - Any payload (a non-object reads as nothing)
 * @returns {string} Comma-joined top-level key names, or '(none)'
 */
function keyNames(value) {
  const keys = value && typeof value === 'object' ? Object.keys(value) : [];

  return keys.length ? keys.join(', ') : '(none)';
}

/**
 * The `personal.location` fields the request's geolocation can fill: the address
 * half of the ad-platform match keys (`libraries/analytics/match-data.js`) and the
 * email merge fields.
 *
 * The fill is per-field and never overwrites: an IP guess loses to anything the user set, in the
 * incoming settings or in the existing doc. Nothing to fill returns an EMPTY object, so the
 * write carries no `personal.location` key at all rather than a map of nulls.
 */
function locationFromGeolocation(geolocation, existingLocation) {
  const location = {};

  for (const field of ['country', 'region', 'city']) {
    if (existingLocation?.[field] || !geolocation?.[field]) {
      continue;
    }

    location[field] = geolocation[field];
  }

  return location;
}

module.exports = { keyNames, locationFromGeolocation };
