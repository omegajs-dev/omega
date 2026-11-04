# The cloud service — the brand's Firebase/GCP project

The `cloud` service (Firebase provider) reconciles the brand's cloud project to `cloud: {}` in
`config/omega.json5`: billing, the required Google Cloud APIs, project identity, the OAuth
consent screen, the Admin SDK service account and its key, the Hosting `api.{domain}` custom
domains, Firestore, the Realtime Database, Authentication, Storage, Cloud Functions readiness,
Cloud Messaging, and the web SDK config. It runs fifth — after the zone exists, before
everything that depends on a backend.

## What it reconciles

| Operation | What it does |
|---|---|
| `billing` | The Blaze plan. `cloud.billingAccount` set → linked; `false` → the user chose Spark, silently; missing → an interactive run picks from the accounts the authed user can see (or creates one) and lands the answer in omega.json5. |
| `services` | The required Google Cloud APIs (serviceusage first — the Firebase CLI's preflight needs it — then firebase, firestore, storage, hosting, database, identitytoolkit, cloudfunctions, cloudbuild, run, artifactregistry, iap, recaptchaenterprise, fcm) plus the compute service account's Cloud Functions deploy roles. Reads the enabled set first, so a converged project is a zero-mutation no-op. |
| `project-settings` | The GCP display name matches `brand.name`, and a web app named "Web App" exists. Diffed before writing. |
| `oauth-consent` | The OAuth consent screen (IAP brand): application title, support email, and the AUDIENCE (below). |
| `service-account` | The Admin SDK service account with `firebase.admin`, `firebaseauth.admin`, `datastore.owner`, `serviceusage.serviceUsageConsumer`, `cloudscheduler.admin`, its key downloaded, and `iam.serviceAccountUser` on the App Engine and compute default service accounts, the grant a runner's functions deploy needs to act as them ([#878](https://github.com/Omega-JS-Stack/omega/issues/878)). Every IAM grant diffs the policy first. |
| `hosting` | The default hosting site gets `api.{domain}`: ONE api domain, shared by every web target the brand runs ([#588](https://github.com/Omega-JS-Stack/omega/issues/588)); DNS is written through Cloudflare. The main domain is NOT added: the website hosts on GitHub Pages. |
| `firestore` | The Firestore database (nam5 US multi-region) with Point-in-Time Recovery. |
| `database` | The default Realtime Database instance (`{projectId}-default-rtdb`, us-central1). |
| `authentication` | Identity Platform, email/password sign-in, email-enumeration privacy, anonymous auto-delete, the password policy, authorized domains — all diffed via Identity Toolkit — plus Google sign-in. |
| `storage` | The default storage bucket, created and linked. |
| `functions` | A read-only readiness check on cloudfunctions/cloudbuild/run. |
| `cloud-messaging` | The FCM API plus a VAPID key pair — the PUBLIC half to `cloud.messaging.vapidKey`, the private half to `VAPID_PRIVATE_KEY` in the brand `.env`. |
| `sdk-config` | The web SDK config fetched into state and diffed against `cloud.config` in omega.json5, written back key by key. |

## Config

- `cloud.enabled: false` — skip.
- `brand.url`: none skips the service, and so does one on a default Pages host (`*.github.io`,
  the address an unset `brand.url` resolves to, [config.md](../shared/config.md)), with
  `brand.url is the hosting provider's default address (<host>): no domain to manage`: authDomain and `api.<domain>` need a domain
  the brand owns.
- `cloud.config.projectId` — the ONE home of the project id
  ([#23](https://github.com/Omega-JS-Stack/omega/issues/23)). Missing → an interactive run
  offers the selection/creation flow and lands it in omega.json5; otherwise the service skips.
- `cloud.config.*` — the SDK keys (`apiKey`, `authDomain`, `databaseURL`, `projectId`,
  `storageBucket`, `messagingSenderId`, `appId`, `measurementId`), owned by `sdk-config`.
- `cloud.billingAccount`, `cloud.organizationId` — both tri-state
  ([#33](https://github.com/Omega-JS-Stack/omega/issues/33)): a value, `false` for a deliberate
  opt-out, or missing to be asked once.
- `cloud.supportEmail` — the consent screen's support address.
- `cloud.oauthRedirectsConfigured` — the one-time confirm that the OAuth client's redirect
  URIs are set (there is no API for them).
- `cloud.consentAudience: false` — the tri-state opt-out
  ([#33](https://github.com/Omega-JS-Stack/omega/issues/33)) for the audience stopper below: the brand
  accepts an org-only sign-in, so only that step goes quiet — every other cloud operation still runs.
- `cloud.messaging.vapidKey` — the public web-push key.
- `cloud.shared: true` — the project is shared by several brands, so only the per-brand
  operations run (`service-account`, `sdk-config`): one brand never rewrites a shared
  project's settings. The DEPLOY lane honors the same key
  ([#882](https://github.com/Omega-JS-Stack/omega/issues/882)): the backend deploy quits with
  one line and exit 0 on every lane, so a shared project is never deployed into
  ([deploys.md](../shared/deploys.md)). The schema's `false` default is no answer, so while the
  brand's own `config/omega.json5` does not hold the key the walk asks once (default No) and
  lands the answer there either way; a headless or dry run prints the one line naming
  `cloud.shared` instead.

**Credentials**: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` in the brand `.env` (OAuth2;
tokens cache to `.omega/auth/google-tokens.json`, and the first run prints an auth URL).

## The consent screen's audience — a manage-time STOPPER

An Internal consent screen admits only the owning org's Workspace users — `Error 403: org_internal` for
every Gmail account — and **Google gives no API write for the audience**
([#667](https://github.com/Omega-JS-Stack/omega/issues/667), proven live): the PATCH is a 404 (the method
does not exist), `orgInternalOnly` is output-only on create, an API-made brand is born Internal always, and
brand creation itself is org-only. So `oauth-consent` READS the audience and stops on it instead of
attempting a write that cannot exist:

- **External** — a `✓` line, no prompt, no poll.
- **Internal, interactive** — the uniform three-outcome gate: **Yes** opens
  [the audience page](https://console.cloud.google.com/auth/audience) behind the ENTER gate and polls the
  brand read until `orgInternalOnly` flips (the [#662](https://github.com/Omega-JS-Stack/omega/issues/662)
  one-walk-finishes-the-job wait, so the flip lands in THIS run); **Skip for now** — and `s` at the poll —
  warns with the console URL and asks again next run; **Disable** lands `cloud.consentAudience: false` and
  nothing ever asks again (later runs print a dim `⊘` line).
- **Internal, non-interactive** (CI, a piped `omega dev` boot) — the warn plus the console URL, `status:
  warned`. A dry run plans the stopper and touches nothing.

Creating the screen is org-only too: on a project that belongs to no organization the create answers
400 "Project must belong to an organization", and the ensure names that cause with the console consent URL
instead of the generic could-not-create line.

## The branding page — a NAMED manual step

The consent screen's **branding** extras (logo, home/privacy/terms links, authorized domains) have no API
at all, so nothing here can reconcile them. Per the automation ruling
([#693](https://github.com/Omega-JS-Stack/omega/issues/693)) what cannot be automated gets NAMED, so
`oauth-consent` prints
[the branding page](https://console.cloud.google.com/auth/branding) with its one-line checklist
([#696](https://github.com/Omega-JS-Stack/omega/issues/696)): links and authorized domains are safe to
change anytime, while uploading a LOGO starts Google's verification review for External apps. It is a
named step, not a warning — the run's status never changes for it.

## Gotchas

- **A `demo-*` project is emulator-only** by Firebase's own convention, so there is no real
  cloud to reconcile and the service skips. Found live: an offline brand's `demo-` id sent the
  ensure at real Google APIs, 403'd, and killed the whole boot.
- **The service-account key is shown ONCE.** Google never re-serves it, so its ONE home is the
  brand's gitignored `.omega/secrets/service-account.json`; the backend's stage step carries it
  into the staged `dist/` tree.
- **Access self-heals before any operation runs.** A manage identity with no role on the
  project gets granted one through a local `gcloud` account that can (owner first, then
  editor + firebase.admin — projects outside an organization only accept new owners via a
  console invitation), then the probe re-runs through a short IAM-propagation window.
- **`supportEmail` must be an address the AUTHORIZING USER owns** (their own, or a Google Group
  they manage) — anything else is "Request contains an invalid argument". The default is the
  authenticated user's own email.
- **Google sign-in's OAuth client cannot be created programmatically**, and its redirect URIs
  have no API either: instructions plus an interactive confirm, stamped in config.
- **`authDomain` is the BRAND host** (Ian's ruling 2026-07-23): a first-party authDomain keeps
  `signInWithRedirect` working under storage partitioning, and the site self-hosts Firebase's
  `/__/auth/*` helper files at build time.
- **API enablement is eventually consistent.** The `functions` readiness check reads three APIs
  once; a Service Usage lag can report a freshly enabled API as off, and the next run agrees.
- **The API-domain TLS gate** — why a subdomain project's `api.` host stays DNS-only, and what
  the paid Cloudflare add-on changes — is documented in [edge.md](edge.md).
