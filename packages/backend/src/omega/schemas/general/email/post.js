/**
 * Schema for POST /general/email
 */
export default() => ({
  id: { type: 'string', required: true },
  email: { type: 'string', required: true },
  name: { type: 'string', default: '' },
});
