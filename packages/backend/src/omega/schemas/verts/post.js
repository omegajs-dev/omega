/**
 * Schema for POST /verts
 */
// The one Omega instance: a schema loads per request, long after boot
import omega from '../../index.js';

export default () => ({
  // A fresh id per request: the caller cannot set it
  id: { type: 'string', value: omega.utilities.randomId() },
  enabled: { type: 'boolean', default: true },
  title: { type: 'string', required: true },
  description: { type: 'string', default: '' },
  button: { type: 'string', default: '' },
  link: { type: 'string', required: true },
  image: { type: 'string', default: '' },
  footer: { type: 'string', default: '' },
  weight: { type: 'number', default: 1, min: 1 },
  targeting: { type: 'object', fields: {
    sites: { type: 'array', default: [] },
    categories: { type: 'array', default: [] },
    keywords: { type: 'array', default: [] },
  } },
  whitelist: { type: 'array', default: [] },
  blacklist: { type: 'array', default: [] },
});
