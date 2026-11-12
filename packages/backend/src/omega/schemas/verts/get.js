/**
 * Schema for GET /verts
 */
export default() => ({
  id: { type: 'string', default: '' },
  limit: { type: ['string', 'number'], default: 100 },
});
