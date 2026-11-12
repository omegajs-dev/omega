/**
 * Schema for POST /special/electron-client
 */
export default() => ({
  uid: { type: 'string' },
  brandId: { type: 'string' },
  brand: { type: 'string' },
  config: { type: 'object', default: {} },
});
