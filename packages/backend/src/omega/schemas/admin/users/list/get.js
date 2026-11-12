/**
 * Schema for GET /admin/users/list
 */
export default() => ({
  limit: { type: 'number', default: 20 },
  search: { type: 'string', default: '' },
  startAfter: { type: 'string', default: '' },
});
