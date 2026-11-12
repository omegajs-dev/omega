/**
 * @omega.js/backend's marketing SSOT: the FIELDS + SEGMENTS dictionaries that
 * define every custom field and segment the backend expects in the marketing
 * providers (SendGrid, Beehiiv), GROUP_KEYS (the unsubscribe groups its send
 * path names) and SENDERS (the senders it sends from). Required straight from
 * the @omega.js/backend workspace package, so the definitions can never drift
 * from the code that consumes them at runtime.
 */
const { FIELDS, SEGMENTS, GROUP_KEYS, SENDERS, senderFrom, fieldsForProvider } = require('@omega.js/backend/lib/email-constants');

// The sender keys, one per SENDERS row; senderFrom(key, { brandName, domain }) answers each one's address and name
const BACKEND_SENDERS = Object.keys(SENDERS);

// Array shapes for handlers that iterate
const BACKEND_FIELDS = Object.entries(FIELDS).map(([name, field]) => ({
  name,
  display: field.display,
  type: field.type,
}));

const BACKEND_SEGMENTS = Object.entries(SEGMENTS).map(([name, segment]) => ({
  name,
  display: segment.display,
  conditions: segment.conditions,
  logic: segment.logic || 'and',
  skip: segment.skip || [],
}));

const BACKEND_FIELDS_BY_NAME = Object.fromEntries(BACKEND_FIELDS.map((field) => [field.name, field]));

/**
 * Fields a given provider id should provision: @omega.js/backend's OWN view of
 * its catalog (every field but the provider row's nativeFields), so what OMEGA
 * creates and what the backend's contact sync writes are never two lists.
 */
function fieldsFor(provider) {
  return fieldsForProvider(provider).map((name) => BACKEND_FIELDS_BY_NAME[name]);
}

/** Segments a given provider should provision (honors each segment's skip list). */
function segmentsFor(provider) {
  return BACKEND_SEGMENTS.filter((segment) => !segment.skip.includes(provider));
}

module.exports = { BACKEND_FIELDS_MAP: FIELDS, BACKEND_FIELDS, BACKEND_SEGMENTS, BACKEND_GROUP_KEYS: GROUP_KEYS, BACKEND_SENDERS, senderFrom, fieldsFor, segmentsFor };
