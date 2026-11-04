# The captcha service — the brand's own reCAPTCHA keys

The `captcha` service proves the brand's OWN classic reCAPTCHA keys work. Every brand mints
its own key in its own GCP project — never a company-shared key — and interactive runs ask
for both halves through the shared setup contract, pointing at the GCP reCAPTCHA console.

## What it reconciles

One operation, `site-key`:

- **The secret is PROVEN.** Classic reCAPTCHA has exactly one documented endpoint,
  `siteverify`, and it doubles as a validity check: verifying a throwaway token answers
  `invalid-input-response` for a good secret and `invalid-input-secret` for a bad one. The
  probe is a pure read — no assessment is created — so a dry run behaves identically.
- **The domain list cannot be reconciled.** Classic reCAPTCHA has no key-management API, so
  the key's allowed-domain list is manual: an interactive run opens the console deep-link and
  confirms once, stamping `captcha.providers.recaptcha.domainsConfirmed`
  ([#434](https://github.com/Omega-JS-Stack/omega/issues/434) — a confirmation nothing can
  re-check is the one kind of reconcile flag config keeps). Non-interactive runs keep the
  printed guidance.

## Config and credentials

| Key | Meaning |
|---|---|
| `captcha.providers.recaptcha.enabled: false` | Skip the service. |
| `brand.url` | None skips the service, and so does one on a default Pages host (`*.github.io`, the address an unset `brand.url` resolves to, [config.md](../shared/config.md)), with `brand.url is the hosting provider's default address (<host>): no domain to manage`. |
| `captcha.providers.recaptcha.siteKey` | The public site key, and its ONE home ([#893](https://github.com/Omega-JS-Stack/omega/issues/893)): every page carrying a form renders it, so it is public by definition. An interactive run ASKS for it here (the config flow, landed in omega.json5) instead of naming an env key. |
| `captcha.providers.recaptcha.project` | Only for a key minted OUTSIDE the brand's own GCP project; otherwise the deep-link resolves from `cloud.config.projectId`. |
| `captcha.providers.recaptcha.domainsConfirmed` | The one-time domain-list confirmation. |

`RECAPTCHA_SECRET_KEY` in the brand `.env` (the only half that is a credential;
`RECAPTCHA_SITE_KEY` is a retired env key, #893). Missing either half → an
interactive run asks, each through its own home's flow; a non-interactive one
skips with guidance.

## Gotcha: the orphan secret

`RECAPTCHA_SECRET_KEY` set with NO `captcha.providers.recaptcha.siteKey` in config is a silent
403 on every protected POST ([#507](https://github.com/Omega-JS-Stack/omega/issues/507)): the
backend enforces verification the moment the secret exists, and the client has no key to mint
a token with. This service is the one place that sees both halves, so it says that direction
out loud, with the console link to paste the site key from, whenever nobody could be asked
for the key (a headless run, a step-aside).

The REVERSE direction — a site key requiring its secret — is the env schema's `requiredWhen`
rule ([#626](https://github.com/Omega-JS-Stack/omega/issues/626)): warned brand-wide by the
workspace `env-rules` op and refused by a production backend boot. NEITHER half is the
sanctioned unkeyed brand ([#17](https://github.com/Omega-JS-Stack/omega/issues/17)) — green,
and skipped.
