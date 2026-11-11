# Marketing Custom Fields

@omega.js/backend syncs user data to marketing providers (SendGrid, Beehiiv) as custom fields. Field definitions live in a single dictionary; OMEGA provisions them in each provider.

## Adding a New Field

1. Add the field to `FIELDS` in `src/omega/libraries/email/constants.js`: the key IS the field name in both providers. Set `source`, `path`, `type`. A provider that stores the value in its own columns lists the key in its row's `nativeFields` (`@omega.js/config`'s `src/email-providers.js`, see [email-system.md](email-system.md#email-providers-and-roles)), never in `FIELDS`.
2. Nothing to add anywhere else: `fieldsForProvider(provider)` beside the dictionary is the ONE derivation of a provider's view (every field but its row's `nativeFields`), read by OMEGA's `custom-fields` ensure (what gets provisioned) and by the provider's `buildFields()` (what gets written), so the two lists cannot drift.
3. Run OMEGA: `npx omega manage --service=campaigns,newsletter` from the brand root.
4. @omega.js/backend resolves field IDs at runtime — no provider code changes needed.

## How It Works

- **SendGrid**: `resolveFieldIds()` fetches field definitions from the SendGrid API, builds a name-to-ID cache, and maps values to SendGrid's auto-generated IDs (e.g., `brand_id` maps to `e35_T`). First/last name are on SendGrid's `nativeFields`: SendGrid keeps them in its own reserved contact columns, which `addContact()` writes natively, so they are never a custom field here.
- **Beehiiv**: @omega.js/backend uses the field's display name as the custom field name, with no ID resolution. Country and UTM source are on Beehiiv's `nativeFields`: it tracks them itself.
- **OMEGA**: The `ensure/custom-fields.js` handlers are idempotent — they fetch existing fields and only create what is missing.

## Key Files

| Purpose | File |
|---------|------|
| Field dictionary + per-provider view (the ONE SSOT) | `src/omega/libraries/email/constants.js` (`FIELDS`, `fieldsForProvider()`) |
| Each provider's native fields | `@omega.js/config` `src/email-providers.js` (`nativeFields`) |
| How OMEGA reads the dictionary | `@omega.js/manager` `src/lib/backend-marketing.js` |
| SendGrid provisioning | `@omega.js/manager` `src/services/campaigns/ensure/custom-fields.js` |
| Beehiiv provisioning | `@omega.js/manager` `src/services/newsletter/ensure/custom-fields.js` |
