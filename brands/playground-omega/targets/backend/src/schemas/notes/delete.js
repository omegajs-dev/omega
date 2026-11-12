/**
 * Surface: schema, DELETE /notes (the id of the note to delete)
 * Doc: node_modules/@omega.js/manager/docs/backend/schemas.md
 */
export default () => ({
  id: { type: 'string', required: true, max: 128 },
});
