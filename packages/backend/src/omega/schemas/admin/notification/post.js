/**
 * Schema for POST /admin/notification
 * (The route reads named props only and rebuilds filters explicitly.)
 */
export default() => ({
  notification: {
    type: 'object',
    default: {
      title: 'Notification',
      body: 'Check this out',
    },
  },
  filters: {
    type: 'object',
    default: {
      tags: false,
      owner: null,
      token: null,
      limit: null,
    },
  },
});
