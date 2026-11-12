/**
 * Schema for POST /admin/email
 *
 * Recipients (to, cc, bcc) accept flexible formats:
 * - Email string: "user@example.com"
 * - UID string (no @): "abc123" — auto-fetches user doc from Firestore
 * - Email object: { email: "user@example.com", name: "John" }
 * - Array of any of the above
 *
 * No raw-HTML field is declared here. `html` (the top-level override) joins
 * `contentHtml` and `trustedContent` as internal-caller only — the schema strip is
 * the belt, `prepare.internalOnlyFieldFault()` in the handler is the braces
 * ([#125](https://github.com/Omega-JS-Stack/omega/issues/125)).
 */
export default() => ({
  to: { type: ['array', 'string', 'object'], default: [] },
  cc: { type: ['array', 'string', 'object'], default: [] },
  bcc: { type: ['array', 'string', 'object'], default: [] },
  from: { type: 'object' },
  replyTo: { type: 'string' },
  sender: { type: 'string' },
  subject: { type: 'string' },
  template: { type: 'string', default: 'card' },
  group: { type: ['number', 'string'] },
  sendAt: { type: ['number', 'string'] },
  data: { type: 'object', default: {} },
  categories: { type: 'array', default: [] },
  copy: { type: 'boolean' },
});
