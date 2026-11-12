/**
 * Schema for POST /handler/post
 */
export default() => ({
  url: { type: 'string', required: true },
  title: { type: 'string', required: true },
  invoiceEmail: { type: 'string' },
  invoicePrice: { type: 'number' },
  invoiceNote: { type: 'string', default: '' },
  sendNotification: { type: 'boolean', default: true },
});
