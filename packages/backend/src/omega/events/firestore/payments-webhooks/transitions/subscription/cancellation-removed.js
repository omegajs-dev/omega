/**
 * Transition: cancellation-removed
 * Triggered when a scheduled cancellation is withdrawn (cancellation.pending true → false, still active)
 *
 * Log-only. The order template's event variants have no copy for a cancellation
 * being withdrawn, and an unknown event falls back to the 'confirmation' variant —
 * which would tell a subscriber whose plan never lapsed that their subscription is
 * confirmed, with a fresh order summary and a "total paid today" they were not
 * charged. Sending the wrong email is worse than sending none, so this transition
 * stays a record until the template carries the copy ([#212]).
 */
export default async function ({ ctx, before, after, order, uid }) {
  ctx.log(`Transition [subscription/cancellation-removed]: uid=${uid}, product=${after.product?.id}, previousCancelDate=${before?.cancellation?.date?.timestamp}, order=${order?.id || 'none'} (no email — the order template has no cancellation-removed variant)`);
};
