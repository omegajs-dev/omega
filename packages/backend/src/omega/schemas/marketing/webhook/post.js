/**
 * Schema: POST /marketing/webhook
 *
 * Empty by design — webhook payloads are provider-defined and validated inside
 * each provider module. Auth + provider come from query params, not the body.
 */
export default() => ({});
