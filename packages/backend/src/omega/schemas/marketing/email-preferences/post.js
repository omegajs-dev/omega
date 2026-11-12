/**
 * Schema for POST /marketing/email-preferences
 *
 * Two supported modes (route decides based on user.authenticated):
 * - Authenticated (account page toggle): action ('subscribe' | 'unsubscribe'). Other fields ignored.
 * - Anonymous (HMAC link from email footer): email + asmId + sig + action ('subscribe' | 'unsubscribe').
 */
export default() => ({
  email: { type: 'string' },
  asmId: { type: ['string', 'number'] },
  action: { type: 'string', required: true },
  sig: { type: 'string' },
});
