export default({ user }) => ({
  uid: { type: 'string', default: user.uid },
  attribution: { type: 'object', default: {} },
  // The client's tracking-consent snapshot, stored verbatim on the user record beside
  // attribution — never interpreted here, and distinct from the legal/marketing
  // `consent` below, which the route translates into the canonical user-doc shape.
  trackingConsent: { type: 'object', default: null },
  context: { type: 'object', default: {} },
  // Consent decision captured at signup. Each sub-object is OPTIONAL — if the client omits
  // `legal`/`marketing` (e.g. a legacy account re-firing /user/signup on page load with no
  // fresh consent), the route leaves that consent untouched rather than downgrading it.
  // When present, `granted` is the decision and `text` is the exact copy shown to the user.
  // (Omitted sub-fields resolve to granted: false / text: '' — buildConsentRecord in the
  // route treats those as "not explicitly re-granted" and preserves existing consent.)
  consent: { type: 'object', fields: {
    legal: { type: 'object', fields: {
      granted: { type: 'boolean' },
      text: { type: 'string' },
    } },
    marketing: { type: 'object', fields: {
      granted: { type: 'boolean' },
      text: { type: 'string' },
    } },
  } },
});
