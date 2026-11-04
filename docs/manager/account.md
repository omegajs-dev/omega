# The account service — the brand's required accounts

The `account` service makes sure the configured admin accounts exist in the brand's Firebase
Auth with the resolved passwords, carry the admin role and the highest plan on their Firestore
user doc — and that NO ONE ELSE holds the admin role. It runs AFTER the update/deploy pass,
because the signup and marketing calls it makes hit the live brand backend.

## What it reconciles

One operation, `users`. Per configured entry:

- `account: true` → create the auth user when missing (then `POST /user/signup` to complete
  the flow), else converge the password; set `roles.admin` and the highest plan on the user
  doc; sync to marketing when flagged.
- `marketing: true` only → push the contact to the marketing providers when the auth user
  exists, and skip quietly when it does not.

Then the AUDIT: any other user holding `roles.admin` FAILS the service. An unauthorized admin
is not a warning.

## Config

| Key | Meaning |
|---|---|
| `account.enabled: false` (or `account: false`) | Skip. |
| `account.admins[]` | The required accounts, `{ email, account, marketing }`, with `{domain}` templated from `brand.url`. The schema default is `support@{domain}` ONLY, resolved but never written into a brand file; a company's own list lives in its company omega.json5 and replaces the default whole. |
| `cloud.config.apiKey` | Read for password verification and backend calls (the cloud service lands it). |
| `cloud.shared: true` | Skip — the owning brand manages accounts. |

The service also skips with no `backend` target, when
`.omega/secrets/service-account.json` is missing (run the cloud service first), with no
`brand.url`, and with a `brand.url` on a default Pages host (`*.github.io`, the address an unset
`brand.url` resolves to, [config.md](../shared/config.md)), whose reason is
`brand.url is the hosting provider's default address (<host>): no domain to manage`.

**Passwords** resolve per account through the owner channels, lazily — nothing happens until
an account actually needs one: `OMEGA_ACCOUNT_PASSWORD__*` env var →
`config/hooks/account/password.js` → a lazy `ACCOUNT_PASSWORD_SEED` derivation. A brand fully
covered by env vars or hooks never grows a seed in its `.env`.

## Gotchas

- **De-ITW'd from omega-manager.** The account list used to be hardcoded company Gmail
  addresses and the password a company-specific formula in code; both are config and owner
  channels now.
- **`firebase-admin` is not used.** The service talks to the Identity Toolkit REST API and
  `FirestoreREST` over the brand's own service account, which is what keeps it runnable from
  the manager without the admin SDK's ambient credentials.
