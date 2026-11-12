/**
 * Surface: schema, POST /notes (a required field, and an id the caller cannot set)
 * Doc: node_modules/@omega.js/manager/docs/backend/schemas.md
 */
import omega from '@omega.js/backend';

export default () => ({
  id: { type: 'string', value: omega.utilities.randomId() },
  // The pipeline trims AFTER validation, so the clean trims first: a
  // whitespace-only note then fails min: 1 instead of storing an empty string
  text: { type: 'string', required: true, clean: (value) => value.trim(), min: 1, max: 280 },
});
