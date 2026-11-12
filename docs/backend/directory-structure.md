# Directory Structure

## @omega.js/backend Library (this repo)

```
src/
  omega/
    index.js                          # The Omega class and its one instance (initialize, function wiring)
    context.js                        # Context: the ctx every route, event and cron job receives
    context/                          # Its concerns: logging, respond/redirect/report, authenticate, parse, client-info
    pipeline.js                       # The request pipeline: one ordered list of named steps
    router.js                         # omega_api dispatch: MCP, else the framework's route
    events.js                         # The event dispatcher (every trigger, omega.events.run())
    cron.js                           # The cron runner (framework jobs, then the consumer's hooks/cron/)
    server.js                         # Custom-server mode (projectType 'custom')
    services/                         # One class per service
      utilities.js                    # omega.utilities: batch operations, randomId, slugify, sanitize, trim
      storage.js                      # omega.storage({ name }): local JSON storage (lowdb)
      user.js                         # The User id generators
      usage.js                        # ctx.usage: the counted-feature gate
      analytics.js                    # ctx.analytics: GA4 integration
      metadata.js                     # ctx.metadata(): timestamps and tags
      settings.js                     # Schema loading and validation into ctx.data
    helpers/
      schema.js                       # The one schema adapter (declaration to zod)
      account.js                      # @omega.js/account (User) for the backend
      log-redaction.js                # Credential redaction for every log line
      resolved-config.js              # config.resolved.*
    libraries/
      env.js                          # The one env reader
      email/                          # Transactional and marketing email
      ai/                             # OpenAI and Anthropic
      analytics/                      # Server-side conversion delivery
        conversions.js                # The one send path (GA4 MP, Meta CAPI, TikTok Events API)
        match-data.js                 # Attribution + identity: one match table per platform
        signup.js                     # The server half of sign_up (fired by routes/user/signup)
      payment/                        # Shared payment utilities
        order-id.js                   # Order ID generation (XXXX-XXXX-XXXX)
        providers/                   # Payment provider libraries
          stripe.js                   # Stripe SDK init, fetchResource, toUnified*, resolvePriceId
          paypal.js                   # PayPal fetchResource, toUnified* (custom_id parsing)
          test.js                     # Test provider (delegates to Stripe shapes)
    events/                             # All event-driven code
      auth/                             # Auth event handlers (hookable)
        before-create.js                # Disposable email blocking + IP rate limiting
        before-signin.js                # Activity update + sign-in analytics
        on-create.js                    # User doc creation
        on-delete.js                    # User doc deletion + marketing cleanup
        utils.js                        # Shared utilities (retryWrite, runAuthHook)
      cron/                             # Cron schedules and their jobs
        daily.js                        # Daily cron entry point
        daily/{job}.js                  # Individual daily cron jobs (incl. trial-lapse-sweep.js, expire-paypal-cancellations.js)
        frequent.js                     # Frequent cron entry point
        frequent/{job}.js               # Individual frequent cron jobs (incl. retry-failed-webhooks.js)
        helpers/                        # The jobs' helpers: every file in a schedule's folder runs as a job
      firestore/                        # Firestore triggers
        payments-webhooks/              # Webhook processing pipeline
          on-write.js                   # Orchestrator: fetch→transform→transition→write
          analytics.js                  # Payment analytics tracking (GA4, Meta, TikTok)
          transitions/                  # State transition detection + handlers
            index.js                    # Transition detection logic
            send-email.js               # Shared email helper for handlers
            subscription/               # Subscription transition handlers
            one-time/                   # One-time payment transition handlers
    routes/                           # Built-in routes
      admin/
        post/                         # POST /admin/post - Create blog posts via GitHub
          post.js                     # Extracts images, uploads to GitHub, rewrites body to @post/ format
          put.js                      # PUT /admin/post - Edit existing posts
          templates/
            post.html                 # Post frontmatter template
      payments/
        intent/                       # POST /payments/intent
          post.js                     # Intent creation orchestrator
          providers/                 # Per-provider intent creators
            stripe.js                 # Stripe Checkout Session creation
            paypal.js                 # PayPal subscription + one-time order creation
            test.js                   # Test provider (auto-fires webhooks)
        webhook/                      # POST /payments/webhook
          post.js                     # Webhook ingestion + Firestore write
          providers/                 # Per-provider webhook parsers
            stripe.js                 # Stripe event parsing + categorization
            paypal.js                 # PayPal event parsing + categorization
            test.js                   # Test provider (delegates to Stripe)
        cancel/                       # POST /payments/cancel
          providers/
            stripe.js                 # Stripe cancel_at_period_end
            paypal.js                 # PayPal subscription cancel
            test.js                   # Test cancel (writes webhook doc)
        refund/                       # POST /payments/refund (subscription or one-time by orderId)
          providers/
            stripe.js                 # Stripe refund + immediate cancel
            paypal.js                 # PayPal refund + cancel
            test.js                   # Test refund (writes webhook doc)
        uncancel/                     # POST /payments/uncancel (capability-gated; no PayPal)
          providers/                 # Per-provider cancellation withdrawal
        plan/                         # POST /payments/plan (plan/frequency switch)
          providers/                 # Per-provider plan switchers
        winback/                      # POST /payments/winback (cancel-flow save offer; capability-gated: Stripe + test)
          providers/                 # Per-provider next-cycle discounts
        portal/                       # POST /payments/portal
          providers/
            stripe.js                 # Stripe billing portal URL
            paypal.js                 # PayPal management URL
    schemas/                          # Built-in schemas
  cli/
    index.js                          # CLI entry point
    commands/                         # CLI commands
  test/
    test-accounts.js                  # Test account definitions (static + journey)
templates/
  config/omega.json5                  # Config template
```

## Consumer Project Structure

Consumers are src-first: authored code lives in `src/`, `dist/` is staged output (gitignored, generated by `omega build`; `firebase.json` points `functions.source` + `hosting.public` at it). See [build-system.md](build-system.md).

```
package.json                          # THE target manifest: scripts + runtime deps
.env                                  # Secrets (gitignored; D15 cascade)
.nvmrc                                # Node version pin
config/omega.json5                    # Local config (standalone only — brand targets carry none)
service-account.json                  # Firebase SA (standalone only — brand targets
                                      # keep it in the brand's .omega/secrets/)
src/
  index.js                            # initialize() + custom functions; exports omega.functions
  routes/
    {endpoint}/
      index.js                        # All methods handler
      get.js                          # GET handler
      post.js                         # POST handler
  schemas/
    {endpoint}/
      index.js                        # Schema definition
  events/
    {name}.js                         # OPTIONAL: handlers a custom trigger runs
                                      # through omega.events.run('{name}', payload)
  hooks/
    auth/
      before-create.js                # Custom pre-signup checks (can block)
      before-signin.js                # Custom pre-signin checks (can block)
      on-create.js                    # Post-signup side effects (non-blocking)
      on-delete.js                    # Post-deletion side effects (non-blocking)
    cron/
      daily/
        {job}.js                      # Custom daily jobs (async fn taking
                                      # { ctx, omega, context }; see routes.md)
  payment-providers/
    {productId}.js                    # OPTIONAL: per-product handler that
                                      # POST /omega/admin/payment loads off
                                      # omega.cwd (the STAGED copy). A CLASS:
                                      # the route constructs it, sets .omega,
                                      # and awaits .process(data)
  public/                             # OPTIONAL: hosting boilerplate overrides
test/                                 # Project tests
firebase.json  .firebaserc           # Firebase project config
firestore.rules  database.rules.json  # Security rules (firestore.rules is YOUR
                                      # source — compiled into dist/, see
                                      # build-system.md)
dist/                                 # GENERATED — never edit (staged by omega build)
```
