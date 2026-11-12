/**
 * Schema for GET /verts/serve
 */
export default() => ({
  parent: { type: 'string', default: '' },
  brand: { type: 'string', default: '' },
  tags: { type: 'string', default: '' },
  width: { type: ['string', 'number'], default: '' },
  height: { type: ['string', 'number'], default: '' },
  theme: { type: 'string', default: '', enum: ['', 'light', 'dark'] },
  vertId: { type: 'string', default: '' },
});
