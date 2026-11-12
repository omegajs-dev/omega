/**
 * Schema for PUT /verts
 * Only provided fields update — everything except id defaults to undefined.
 */
export default() => ({
  id: { type: 'string', required: true },
  enabled: { type: 'boolean' },
  title: { type: 'string' },
  description: { type: 'string' },
  button: { type: 'string' },
  link: { type: 'string' },
  image: { type: 'string' },
  footer: { type: 'string' },
  weight: { type: 'number', min: 1 },
  targeting: { type: 'object' },
  whitelist: { type: 'array' },
  blacklist: { type: 'array' },
});
