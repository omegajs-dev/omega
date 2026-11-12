/**
 * Schema for POST /admin/users/disable
 */
export default() => ({
  uid: { type: 'string', required: true },
  disabled: { type: 'boolean', default: true },
});
