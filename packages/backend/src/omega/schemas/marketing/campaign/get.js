/**
 * Schema for GET /marketing/campaign
 */
export default() => ({
  id: { type: 'string', default: '' },
  start: { type: ['string', 'number'], default: '' },
  end: { type: ['string', 'number'], default: '' },
  status: { type: 'string', default: '' },
  type: { type: 'string', default: '' },
  limit: { type: ['string', 'number'], default: 100 },
});
