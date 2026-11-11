# The newsletter service — the brand's publication (Beehiiv)

The `newsletter` service reconciles the brand's newsletter publication on Beehiiv: access to
the publication, `@omega.js/backend`'s custom fields, its segments (verify-only), and the
publication webhook pointed at the parent backend's forwarder.

## What it reconciles

- **`publication`** — resolved from `marketing.newsletter.providers.beehiiv.publicationId`,
  else auto-matched by brand name/id across the account's publications. Publications CANNOT be
  created via API: when nothing matches, the exact values to copy are printed, an interactive
  run opens the create page and polls until the new publication auto-matches, and the resolved
  id is written back into omega.json5.
- **`custom-fields`**: `@omega.js/backend`'s fields, less the provider row's `nativeFields`
  (Beehiiv needs first/last name as custom fields but tracks country and UTM source natively). Beehiiv
  matches subscriber values by DISPLAY name, so fields are diffed by `display`; a kind
  mismatch is a delete + recreate.
- **`segments`** — Beehiiv has NO segment-create API. The read side lists what exists;
  interactive runs offer to drive the dashboard UI through the OMEGA Companion extension
  (trusted-event browser automation) or to open the dashboard for manual creation, then
  RE-verify against the API so "created" means Beehiiv says so. Non-interactive and dry runs
  never mutate: missing segments warn with human-readable conditions.
- **`webhook`** — the publication webhook carrying `subscription.unsubscribed`,
  `subscription.deleted` and `subscription.paused` to the parent backend's forwarder. Matched
  by its managed description first (stable across parent moves), then by URL; drift in
  url/event_types/enabled is patched with the minimum diff.

Fields and segments `@omega.js/backend` does not own are never touched.

## Config

| Key | Meaning |
|---|---|
| `marketing.newsletter.enabled: false` | Skip. |
| `marketing.newsletter.providers.beehiiv` | The vendor is a KEY under `providers`: no entry, no service. The service runs only for the provider whose row serves the `newsletter` role (`emailProviderForRole('newsletter')` in `@omega.js/config`), and its field and segment views take that row's id. |
| `marketing.newsletter.providers.beehiiv.publicationId` | The publication; written back when resolved. |
| `company.id` | Whose backend the webhook points at: the RESOLVED `company.url`, which is this brand's own url when it names no company ([#677](https://github.com/Omega-JS-Stack/omega/issues/677)). |
| `company.webhooks: false` | The one deliberate opt-out: the provider ACCOUNT is shared and its single account-level webhook belongs to somebody else, so the walk leaves it alone. |

**Credentials**: `BEEHIIV_API_KEY` in the brand `.env`; `OMEGA_WEBHOOK_KEY` is minted by the
setup contract, never asked for.

## Gotchas

- **A publication can be shared across sibling brands**, which is exactly why the webhook
  points at the parent and the parent fans each event out per brand.
- **The segment automation targets the LAST matching element** on each dashboard row: Beehiiv
  duplicates element IDs across condition rows, and its React inputs need the native value
  setter plus synthetic input/change events.
