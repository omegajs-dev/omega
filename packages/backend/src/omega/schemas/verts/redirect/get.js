/**
 * Schema for GET /verts/redirect
 */
export default() => ({
  id: { type: 'string', required: true },
  parent: { type: 'string', default: '' },
  brand: { type: 'string', default: '' },
});
