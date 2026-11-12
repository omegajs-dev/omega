/**
 * Catalog + adapter tests — the mapping layer is pure, so these are the
 * cheapest place to pin what each provider is told.
 */
const defineCases = require('@omega.js/devkit/test/define-cases');
const fs = require('node:fs');
const path = require('node:path');
const { ANALYTICS_PROVIDERS } = require('@omega.js/config');

const { CATALOG, PLACEMENTS, KINDS, entryFor } = require('../src/catalog.js');
const google = require('../src/adapters/google.js');
const meta = require('../src/adapters/meta.js');
const tiktok = require('../src/adapters/tiktok.js');

const ADAPTERS = [google, meta, tiktok];

// The 2026-08-27 live cross-check ([#652]): every `standard` claim is spelled
// the way the platform's own list spells it, and a name the platform does not
// list may only be `custom`. The rosters below are the live pages verbatim:
//   Meta   https://www.facebook.com/business/help/402791146561655
//   TikTok https://ads.tiktok.com/help/article/standard-events-parameters
const META_STANDARD = [
  'AddPaymentInfo', 'AddToCart', 'AddToWishlist', 'CompleteRegistration', 'Contact',
  'CustomizeProduct', 'Donate', 'FindLocation', 'InitiateCheckout', 'Lead', 'PageView',
  'Purchase', 'Schedule', 'Search', 'StartTrial', 'SubmitApplication', 'Subscribe',
  'ViewContent',
];

const TIKTOK_STANDARD = [
  'AddPaymentInfo', 'AddToCart', 'AddToWishlist', 'ApplicationApproval',
  'CompleteRegistration', 'Contact', 'CustomizeProduct', 'Download', 'FindLocation',
  'InitiateCheckout', 'Purchase', 'Schedule', 'Search', 'StartTrial',
  'SubmitApplication', 'SubmitForm', 'Subscribe', 'ViewContent',
];

// ─── Commerce mapping ───

const PURCHASE_PARAMS = {
  // One CHARGE's id — the order on a first purchase, the provider's invoice id
  // on a renewal. NEVER the subscription id, which GA4 would dedupe every later
  // charge away on ([#656](https://github.com/Omega-JS-Stack/omega/issues/656)).
  transaction_id: 'ORD-1',
  value: 49.99,
  currency: 'USD',
  items: [{ item_id: 'pro', item_name: 'Pro Plan', item_category: 'subscription', price: 49.99, quantity: 1 }],
  is_trial: false,
  is_recurring: false,
  payment_provider: 'stripe',
};

module.exports = defineCases({
  type: 'group',
  description: 'catalog',
  tests: [
    // ─── Integrity ───

    {
      name: 'every entry declares a valid placement and a params array',
      run: (ctx) => {
        for (const [name, entry] of Object.entries(CATALOG)) {
          ctx.expect(PLACEMENTS.includes(entry.placement), `${name} has placement "${entry.placement}"`).toBeTruthy();
          ctx.expect(Array.isArray(entry.params), `${name} declares a params array`).toBeTruthy();
          ctx.expect(entry.providers && typeof entry.providers === 'object', `${name} declares a providers object`).toBeTruthy();
        }
      },
    },

    {
      name: 'every provider mapping declares a native name and a known kind',
      run: (ctx) => {
        for (const [name, entry] of Object.entries(CATALOG)) {
          for (const [provider, mapping] of Object.entries(entry.providers)) {
            ctx.expect(mapping.name && typeof mapping.name === 'string', `${name}.${provider} has a native name`).toBeTruthy();
            ctx.expect(KINDS.includes(mapping.kind), `${name}.${provider} kind is standard|custom, got "${mapping.kind}"`).toBeTruthy();
            if (mapping.map !== undefined) {
              ctx.expect(typeof mapping.map, `${name}.${provider} map is a function`).toBe('function');
            }
          }
        }
      },
    },

    {
      name: 'every provider the catalog maps is a provider row',
      run: (ctx) => {
        const ids = Object.values(ANALYTICS_PROVIDERS).map((row) => row.id);

        for (const [name, entry] of Object.entries(CATALOG)) {
          for (const provider of Object.keys(entry.providers)) {
            ctx.expect(ids.includes(provider), `${name} maps "${provider}", which has no row`).toBeTruthy();
          }
        }
      },
    },

    {
      name: 'every adapter file has a row, and every row has an adapter file named by its id',
      run: (ctx) => {
        const dir = path.join(__dirname, '..', 'src', 'adapters');
        // An adapter is a module answering for one provider; the shared mechanism beside them answers for none
        const adapters = fs.readdirSync(dir)
          .filter((file) => file.endsWith('.js'))
          .map((file) => ({ file: path.basename(file, '.js'), adapter: require(path.join(dir, file)) }))
          .filter(({ adapter }) => typeof adapter.provider === 'string');

        for (const { file, adapter } of adapters) {
          ctx.expect(adapter.provider, `adapters/${file}.js answers for the provider it is named after`).toBe(file);
          ctx.expect(typeof adapter.resolve, `adapters/${file}.js resolves descriptors`).toBe('function');
        }

        ctx.expect(adapters.map(({ file }) => file).sort()).toEqual(Object.values(ANALYTICS_PROVIDERS).map((row) => row.id).sort());
      },
    },

    {
      name: 'the only zero-provider entries are the deliberate ones',
      run: (ctx) => {
        const empty = Object.entries(CATALOG)
          .filter(([, entry]) => Object.keys(entry.providers).length === 0)
          .map(([name]) => name)
          .sort();

        // A logout is not an ad signal; the signup funnel entry is ours to read.
        ctx.expect(empty).toEqual(['logout', 'sign_up_started']);
      },
    },

    {
      name: 'the live call sites the audit found all resolve — none can throw at rewire',
      run: (ctx) => {
        const live = [
          'pricing_toggle', 'contact_enterprise', 'copy_link',
          'contact_form_spam', 'review_prompt_show', 'status_subscribe', 'screen_view',
        ];

        for (const name of live) {
          ctx.expect(entryFor(name), `${name} is in the catalog`).toBeTruthy();
          ctx.expect(google.resolve(name, {}), `${name} resolves for GA4`).toBeTruthy();
        }

        // Spot check on the shape, not just the presence.
        const facebook = meta.resolve('pricing_toggle', { billing_type: 'yearly' });
        ctx.expect(facebook.name).toBe('PricingToggle');
        ctx.expect(facebook.kind).toBe('custom');
        ctx.expect(facebook.payload.billing_type).toBe('yearly');

        // GA4-only entries stay GA4-only: a spam signal never reaches an ad platform.
        ctx.expect(meta.resolve('contact_form_spam', {})).toBe(null);
        ctx.expect(tiktok.resolve('contact_form_spam', {})).toBe(null);
      },
    },

    {
      name: 'a standard mapping only ever claims a name its platform actually lists',
      run: (ctx) => {
        for (const [name, entry] of Object.entries(CATALOG)) {
          for (const [provider, roster] of [['meta', META_STANDARD], ['tiktok', TIKTOK_STANDARD]]) {
            const mapping = entry.providers[provider];

            if (mapping && mapping.kind === 'standard') {
              ctx.expect(roster.includes(mapping.name), `${name} → ${provider} ${mapping.name} is on the platform's standard list`).toBeTruthy();
            }
          }
        }
      },
    },

    {
      name: 'the names the platforms retired or never had are gone from the catalog',
      run: (ctx) => {
        // TikTok retired CompletePayment for Purchase, and ClickButton is on NEITHER
        // roster — both were claimed as `standard` until the live check ([#652]).
        const claimed = Object.values(CATALOG)
          .flatMap((entry) => Object.values(entry.providers))
          .map((mapping) => mapping.name);

        ctx.expect(claimed.includes('CompletePayment'), 'CompletePayment is retired').toBe(false);
        ctx.expect(claimed.includes('ClickButton'), 'ClickButton was never a standard event').toBe(false);

        // Meta's Subscribe means "the START of a paid subscription", which is what
        // `purchase` and `trial_start` already say — so it is deliberately unused,
        // and a renewal is a Purchase (Ian's money-event table).
        const metaNames = Object.values(CATALOG)
          .map((entry) => entry.providers.meta)
          .filter(Boolean)
          .map((mapping) => mapping.name);

        ctx.expect(metaNames.includes('Subscribe'), 'Meta Subscribe stays unused').toBe(false);
      },
    },

    {
      name: 'the dropped and renamed names are gone',
      run: (ctx) => {
        // The new consent system has no auto-accept-on-scroll.
        ctx.expect(entryFor('cookie_consent_auto_accept')).toBe(null);
        // GA4's standard name replaces the literal `download` the page sends today.
        ctx.expect(entryFor('download')).toBe(null);
        ctx.expect(entryFor('file_download'), 'file_download is the canonical name').toBeTruthy();
      },
    },

    {
      name: 'the email-preferences pair carries the same marketing prefix',
      run: (ctx) => {
        // One ternary on one page fires both halves ([#416]): an opt-out named for a
        // different family than the opt-in it sits beside is a reporting trap.
        ctx.expect(entryFor('email_unsubscribe'), 'the unprefixed opt-out name is gone').toBe(null);

        for (const name of ['marketing_email_subscribe', 'marketing_email_unsubscribe']) {
          const ga = google.resolve(name, { content_type: 'marketing' });

          ctx.expect(ga.name, `${name} resolves on GA4 under its own name`).toBe(name);
          ctx.expect(ga.kind, `${name} is a GA4 custom event`).toBe('custom');
        }

        // Meta's wire names are the live custom ones, untouched by the rename: the
        // canonical key moved, the data continuity in the ad account did not.
        ctx.expect(meta.resolve('marketing_email_subscribe', {}).name).toBe('EmailSubscribe');
        ctx.expect(meta.resolve('marketing_email_unsubscribe', {}).name).toBe('EmailUnsubscribe');
      },
    },

    // ─── Page view ───

    {
      name: 'page_view maps all three providers, so one fire is the whole page view',
      run: (ctx) => {
        // The raw `fbq('track', 'PageView')` / `ttq.page()` the web loader fired at
        // pixel init are retired ([#409](https://github.com/Omega-JS-Stack/omega/issues/409)):
        // the catalog is what tells each platform about a page now.
        const params = { page_path: '/pricing', page_title: 'Pricing', page_location: 'https://brand.test/pricing' };

        const ga = google.resolve('page_view', params);
        ctx.expect(ga.name).toBe('page_view');
        ctx.expect(ga.kind).toBe('standard');
        ctx.expect(ga.payload.page_path, 'GA4 is pass-through, so the page params ride as-is').toBe('/pricing');

        const facebook = meta.resolve('page_view', params);
        ctx.expect(facebook.name, 'Meta defines PageView — the pixel snippet\'s own standard event').toBe('PageView');
        ctx.expect(facebook.kind).toBe('standard');

        const tt = tiktok.resolve('page_view', params);
        ctx.expect(tt.name, 'the event TikTok records for it — for the catalog and the fire log').toBe('Pageview');
        ctx.expect(tt.kind, 'a pixel method is not a standard trackable name').toBe('custom');
        ctx.expect(tt.method, 'and the descriptor names the method TikTok documents: ttq.page()').toBe('page');
      },
    },

    {
      name: 'a pixel method is named by exactly one mapping',
      run: (ctx) => {
        // `method` exists for TikTok's SDK-managed page view and nothing else. Every
        // other mapping is a tracked event NAME, and a stray method would silently
        // stop a fire from reaching `ttq.track`.
        const named = Object.entries(CATALOG)
          .filter(([, entry]) => Object.values(entry.providers).some((mapping) => mapping.method !== undefined))
          .map(([name]) => name);

        ctx.expect(named).toEqual(['page_view']);
      },
    },

    {
      name: 'purchase maps to Purchase on both ad platforms, with value and currency intact',
      run: (ctx) => {
        const ga = google.resolve('purchase', PURCHASE_PARAMS);
        ctx.expect(ga.name).toBe('purchase');
        ctx.expect(ga.kind).toBe('standard');
        ctx.expect(ga.payload.items, 'GA4 keeps its own items array').toEqual(PURCHASE_PARAMS.items);
        ctx.expect(ga.payload.value).toBe(49.99);
        ctx.expect(ga.payload.currency).toBe('USD');
        // GA4 deduplicates `purchase` on transaction_id, so the param is not optional
        // decoration — it is the key the browser and the webhook halves collapse on
        // ([#656](https://github.com/Omega-JS-Stack/omega/issues/656)).
        ctx.expect(ga.payload.transaction_id).toBe('ORD-1');

        const facebook = meta.resolve('purchase', PURCHASE_PARAMS);
        ctx.expect(facebook.name).toBe('Purchase');
        ctx.expect(facebook.kind).toBe('standard');
        ctx.expect(facebook.payload.value, 'Meta REQUIRES value and currency on a Purchase').toBe(49.99);
        ctx.expect(facebook.payload.currency).toBe('USD');
        ctx.expect(facebook.payload.content_ids, 'Meta speaks content_ids, not items').toEqual(['pro']);
        ctx.expect(facebook.payload.content_name).toBe('Pro Plan');
        ctx.expect(facebook.payload.num_items).toBe(1);
        ctx.expect(facebook.payload.items, 'GA4 vocabulary does not leak into Meta').toBe(undefined);

        const tt = tiktok.resolve('purchase', PURCHASE_PARAMS);
        ctx.expect(tt.name, 'TikTok retired CompletePayment').toBe('Purchase');
        ctx.expect(tt.kind).toBe('standard');
        ctx.expect(tt.payload.value).toBe(49.99);
        ctx.expect(tt.payload.currency).toBe('USD');
        ctx.expect(tt.payload.content_type).toBe('product');
        ctx.expect(tt.payload.contents, 'TikTok speaks a contents array of product objects, the shape its pixel reference documents').toEqual([{ content_id: 'pro', content_name: 'Pro Plan', content_category: 'subscription', price: 49.99, quantity: 1 }]);
        ctx.expect(tt.payload.content_id, 'and the flat single-item shape is gone').toBe(undefined);
        ctx.expect(tt.payload.price).toBe(undefined);

        // The product type is the category; an item that names none sends no key.
        const uncategorized = tiktok.resolve('purchase', { ...PURCHASE_PARAMS, items: [{ item_id: 'pro', item_name: 'Pro Plan', price: 49.99, quantity: 1 }] });
        ctx.expect('content_category' in uncategorized.payload.contents[0], 'an item with no item_category carries no content_category').toBe(false);
      },
    },

    {
      name: 'every item rides TikTok\'s contents array, not just the first',
      run: (ctx) => {
        // The flat shape could only ever describe items[0]; `contents` is a list.
        const tt = tiktok.resolve('purchase', {
          ...PURCHASE_PARAMS,
          items: [
            { item_id: 'pro', item_name: 'Pro Plan', price: 40, quantity: 1 },
            { item_id: 'addon', item_name: 'Extra Seat', price: 9.99, quantity: 2 },
          ],
        });

        ctx.expect(tt.payload.contents).toEqual([
          { content_id: 'pro', content_name: 'Pro Plan', price: 40, quantity: 1 },
          { content_id: 'addon', content_name: 'Extra Seat', price: 9.99, quantity: 2 },
        ]);
      },
    },

    // The 2026-09-02 standards review against the live references
    // ([#498](https://github.com/Omega-JS-Stack/omega/issues/498)): Meta's pixel
    // reference marks `contents` required for Advantage+ catalog ads on Purchase,
    // ViewContent, AddToCart and Search, and TikTok's Events API 2.0 documents
    // `content_ids` beside `contents` and an `order_id` in `properties`.

    {
      name: 'Meta commerce carries the documented contents[] beside content_ids',
      run: (ctx) => {
        const facebook = meta.resolve('purchase', PURCHASE_PARAMS);

        // Meta's own field list for a contents object is `id`, `quantity`,
        // `item_price`, `delivery_category`, never GA4's item_id/price spelling.
        ctx.expect(facebook.payload.contents).toEqual([{ id: 'pro', quantity: 1, item_price: 49.99 }]);
        ctx.expect(facebook.payload.content_ids, 'and content_ids stays: Meta accepts either').toEqual(['pro']);
      },
    },

    {
      name: 'the order id reaches both ad platforms under their own order_id',
      run: (ctx) => {
        // Both platforms document an `order_id` for the transaction, and both were
        // getting the charge id only as the dedupe `event_id`, a field neither
        // surfaces as the order.
        ctx.expect(meta.resolve('purchase', PURCHASE_PARAMS).payload.order_id).toBe('ORD-1');
        ctx.expect(tiktok.resolve('purchase', PURCHASE_PARAMS).payload.order_id).toBe('ORD-1');

        // A funnel event has no transaction to name, and `compact()` keeps the key off.
        const cart = meta.resolve('add_to_cart', { currency: 'USD', value: 49.99, items: PURCHASE_PARAMS.items });
        ctx.expect('order_id' in cart.payload).toBe(false);
      },
    },

    {
      name: 'TikTok carries content_ids beside contents, the pair its 2.0 properties document',
      run: (ctx) => {
        const tt = tiktok.resolve('purchase', PURCHASE_PARAMS);

        ctx.expect(tt.payload.content_ids).toEqual(['pro']);
        ctx.expect(tt.payload.contents[0].content_id, 'the contents array keeps the product detail').toBe('pro');
      },
    },

    {
      name: 'Meta\'s content_name only rides an event with ONE product',
      run: (ctx) => {
        // Meta documents it as "name of the page/product", singular, and it had been
        // naming items[0] for a whole cart, which labels the wrong basket.
        ctx.expect(meta.resolve('purchase', PURCHASE_PARAMS).payload.content_name).toBe('Pro Plan');

        const multi = meta.resolve('purchase', {
          ...PURCHASE_PARAMS,
          items: [
            { item_id: 'pro', item_name: 'Pro Plan', price: 40, quantity: 1 },
            { item_id: 'addon', item_name: 'Extra Seat', price: 9.99, quantity: 2 },
          ],
        });

        ctx.expect('content_name' in multi.payload, 'two products have no one name').toBe(false);
        ctx.expect(multi.payload.content_ids, 'the ids still name every one of them').toEqual(['pro', 'addon']);
        ctx.expect(multi.payload.contents).toEqual([
          { id: 'pro', quantity: 1, item_price: 40 },
          { id: 'addon', quantity: 2, item_price: 9.99 },
        ]);
      },
    },

    {
      name: 'a charge nobody is present for tells Meta action_source system_generated',
      run: (ctx) => {
        // Meta's enum names this case itself: `system_generated`, "for example, a
        // subscription renewal that's set to auto-pay each month". A person clicked
        // nothing on these, so `website` was a claim about where the conversion
        // happened that was not true, on a field Meta requires be accurate
        // ([#498](https://github.com/Omega-JS-Stack/omega/issues/498)).
        for (const name of ['subscription_renew', 'payment_recovered', 'trial_convert']) {
          ctx.expect(meta.resolve(name, PURCHASE_PARAMS).actionSource, `${name} is billed, never visited`).toBe('system_generated');
        }

        // Everything a PERSON did keeps the default the transport supplies: a
        // checkout, a trial a visitor started, a cancellation they clicked.
        for (const name of ['purchase', 'trial_start', 'subscription_cancel', 'refund']) {
          ctx.expect('actionSource' in meta.resolve(name, PURCHASE_PARAMS), `${name} overrides nothing`).toBe(false);
        }

        // Meta's field alone: TikTok's 2.0 envelope has no action_source at all.
        ctx.expect('actionSource' in tiktok.resolve('subscription_renew', PURCHASE_PARAMS)).toBe(false);
      },
    },

    {
      name: 'num_items counts the UNITS bought, not the lines they came on',
      run: (ctx) => {
        // Meta: "the number of items that a user tries to buy during checkout", so
        // two seats on one line are two items [#498].
        const multi = meta.resolve('purchase', {
          ...PURCHASE_PARAMS,
          items: [
            { item_id: 'pro', item_name: 'Pro Plan', price: 40, quantity: 1 },
            { item_id: 'addon', item_name: 'Extra Seat', price: 9.99, quantity: 2 },
          ],
        });

        ctx.expect(multi.payload.num_items).toBe(3);

        // A line that names no quantity is one of that thing, never none of it.
        const bare = meta.resolve('purchase', { ...PURCHASE_PARAMS, items: [{ item_id: 'pro', item_name: 'Pro Plan', price: 40 }] });

        ctx.expect(bare.payload.num_items).toBe(1);
      },
    },

    {
      name: 'the zero-value audience signals keep every amount off the wire',
      run: (ctx) => {
        // `contents` grew an `item_price` on Meta's side, which is the amount itself,
        // so the exclusion signal drops the array outright. `content_ids` already
        // names the plan, and Meta REQUIRES id + quantity in a contents object, so a
        // stripped-down one would be worse than none.
        for (const name of ['subscription_cancel', 'refund']) {
          const facebook = meta.resolve(name, PURCHASE_PARAMS);

          ctx.expect(facebook.payload.value).toBe(0);
          ctx.expect('contents' in facebook.payload, `${name} sends Meta no priced contents`).toBe(false);
          ctx.expect(facebook.payload.content_ids, 'the plan still makes the audience').toEqual(['pro']);

          const tt = tiktok.resolve(name, PURCHASE_PARAMS);

          ctx.expect(tt.payload.value).toBe(0);
          ctx.expect(tt.payload.content_ids).toEqual(['pro']);
          ctx.expect(tt.payload.contents, 'TikTok has no other id carrier, minus the money').toEqual([{ content_id: 'pro', content_name: 'Pro Plan', content_category: 'subscription' }]);
        }
      },
    },

    {
      name: 'a trial start is StartTrial on both ad platforms, and the browser may fire it',
      run: (ctx) => {
        // TikTok's Subscribe ("subscribes... including paid subscriptions") said a
        // trial was a subscription; StartTrial is the event both platforms define for
        // "a customer begins a free trial" ([#652]). The browser half exists because a
        // trial checkout used to fire `purchase` there ([#654]).
        const params = { ...PURCHASE_PARAMS, transaction_id: 'ORD-1', value: 0, is_trial: true };

        ctx.expect(entryFor('trial_start').placement).toBe('both');

        const facebook = meta.resolve('trial_start', params);
        ctx.expect(facebook.name).toBe('StartTrial');
        ctx.expect(facebook.kind).toBe('standard');
        ctx.expect(facebook.payload.value, 'a trial charges nothing').toBe(0);
        ctx.expect(facebook.payload.currency).toBe('USD');

        const tt = tiktok.resolve('trial_start', params);
        ctx.expect(tt.name).toBe('StartTrial');
        ctx.expect(tt.kind).toBe('standard');
        ctx.expect(tt.payload.value).toBe(0);
        ctx.expect(tt.payload.currency).toBe('USD');

        // GA4's trial_start is a custom event: no standard purchase to deduplicate,
        // so the server owns it outright and the browser half names ads only.
        const ga = google.resolve('trial_start', params);
        ctx.expect(ga.name).toBe('trial_start');
        ctx.expect(ga.kind).toBe('custom');
      },
    },

    {
      name: 'the recurring events ride GA4 purchase with is_recurring set, and Purchase on the ad platforms',
      run: (ctx) => {
        for (const name of ['subscription_renew', 'payment_recovered']) {
          const ga = google.resolve(name, { ...PURCHASE_PARAMS, is_recurring: false });
          ctx.expect(ga.name, `${name} → GA4 purchase`).toBe('purchase');
          ctx.expect(ga.payload.is_recurring, `${name} is flagged recurring for GA4`).toBe(true);

          // Every real charge is a Purchase: Meta's Subscribe means the START of a
          // paid subscription, so a renewal counted a new subscriber every month
          // ([#652]).
          const facebook = meta.resolve(name, PURCHASE_PARAMS);
          ctx.expect(facebook.name, `${name} → Meta Purchase`).toBe('Purchase');
          ctx.expect(facebook.payload.value, 'for the real amount').toBe(49.99);
          ctx.expect(facebook.payload.currency).toBe('USD');

          const tt = tiktok.resolve(name, PURCHASE_PARAMS);
          ctx.expect(tt.name, `${name} → TikTok Purchase`).toBe('Purchase');
          ctx.expect(tt.payload.value).toBe(49.99);
          ctx.expect(tt.payload.currency).toBe('USD');
        }
      },
    },

    // The four subscription lifecycle moments the 2026-08-20 coverage audit found
    // dark or mislabeled ([#407](https://github.com/Omega-JS-Stack/omega/issues/407)).

    {
      name: 'a trial conversion is a purchase everywhere — the first real charge',
      run: (ctx) => {
        const params = { ...PURCHASE_PARAMS, is_trial: true, is_recurring: false };

        const ga = google.resolve('trial_convert', params);
        ctx.expect(ga.name, 'the first real charge belongs in GA4\'s revenue report').toBe('purchase');
        ctx.expect(ga.kind).toBe('standard');
        ctx.expect(ga.payload.value).toBe(49.99);
        ctx.expect(ga.payload.is_trial, 'the pair of flags is what marks it inside GA4 purchase').toBe(true);
        ctx.expect(ga.payload.is_recurring, 'a conversion is the FIRST payment, never a renewal').toBe(false);

        const facebook = meta.resolve('trial_convert', params);
        ctx.expect(facebook.name, 'Meta already heard StartTrial — and money moving is a Purchase').toBe('Purchase');
        ctx.expect(facebook.kind).toBe('standard');
        ctx.expect(facebook.payload.value, 'the amount actually charged').toBe(49.99);
        ctx.expect(facebook.payload.content_ids).toEqual(['pro']);

        const tt = tiktok.resolve('trial_convert', params);
        ctx.expect(tt.name).toBe('Purchase');
        ctx.expect(tt.kind).toBe('standard');
        ctx.expect(tt.payload.value).toBe(49.99);
        ctx.expect(tt.payload.contents).toEqual([{ content_id: 'pro', content_name: 'Pro Plan', content_category: 'subscription', price: 49.99, quantity: 1 }]);
      },
    },

    // The exclusion-audience half ([#415](https://github.com/Omega-JS-Stack/omega/issues/415)).

    {
      name: 'a cancellation and a refund reach the ad platforms as zero-value audience signals',
      run: (ctx) => {
        for (const [name, native] of [['subscription_cancel', 'SubscriptionCancel'], ['refund', 'Refund']]) {
          const facebook = meta.resolve(name, PURCHASE_PARAMS);

          ctx.expect(facebook.name, `${name} → Meta ${native}`).toBe(native);
          ctx.expect(facebook.kind, 'Meta defines no churn event, so this is a custom one and says so').toBe('custom');
          ctx.expect(facebook.payload.value, 'a churn signal must never book revenue in an ad account').toBe(0);
          ctx.expect(facebook.payload.content_ids, 'the plan is what makes the audience worth building').toEqual(['pro']);

          const tt = tiktok.resolve(name, PURCHASE_PARAMS);

          ctx.expect(tt.name, `${name} → TikTok ${native}`).toBe(native);
          ctx.expect(tt.kind).toBe('custom');
          ctx.expect(tt.payload.value, 'TikTok cannot subtract revenue either').toBe(0);
          ctx.expect(tt.payload.contents, 'who and which plan is the whole point of the audience').toEqual([{ content_id: 'pro', content_name: 'Pro Plan', content_category: 'subscription' }]);
          ctx.expect(tt.payload.contents[0].price, 'the per-item price would put the amount back on the wire').toBe(undefined);
          ctx.expect(tt.payload.contents[0].quantity, 'and Meta\'s signal carries neither, by construction').toBe(undefined);
        }

        // GA4 is where the money is netted, so it keeps the real number.
        ctx.expect(google.resolve('refund', PURCHASE_PARAMS).payload.value).toBe(49.99);
        ctx.expect(google.resolve('subscription_cancel', PURCHASE_PARAMS).payload.value).toBe(49.99);
      },
    },

    {
      name: 'the outcomes an ad platform has no use for stay GA4-only',
      run: (ctx) => {
        // `trial_lapse` is the deliberate omission of the exclusion lane above: a
        // lapsed trialist is a win-back audience to RETARGET, not one to hide ads
        // from. The other two are dark to an ad platform for the older reason — no
        // money moved, and a platform optimizes toward conversions.
        for (const name of ['trial_lapse', 'subscription_uncancel', 'subscription_plan_change']) {
          const ga = google.resolve(name, PURCHASE_PARAMS);

          ctx.expect(ga.name, `${name} resolves on GA4 under its own name`).toBe(name);
          ctx.expect(ga.kind, `no platform defines a standard ${name}`).toBe('custom');
          ctx.expect(meta.resolve(name, PURCHASE_PARAMS), `${name} has no Meta mapping`).toBe(null);
          ctx.expect(tiktok.resolve(name, PURCHASE_PARAMS), `${name} has no TikTok mapping`).toBe(null);
        }
      },
    },

    {
      name: 'a plan change carries the plan it came from',
      run: (ctx) => {
        const entry = entryFor('subscription_plan_change');

        for (const param of ['previous_item_id', 'previous_item_name', 'previous_value']) {
          ctx.expect(entry.params.includes(param), `subscription_plan_change declares ${param}`).toBeTruthy();
        }

        const ga = google.resolve('subscription_plan_change', {
          ...PURCHASE_PARAMS,
          previous_item_id: 'starter',
          previous_item_name: 'Starter',
          previous_value: 9.99,
        });

        ctx.expect(ga.payload.previous_item_id, 'GA4 is pass-through, so the from-plan rides as-is').toBe('starter');
        ctx.expect(ga.payload.previous_item_name).toBe('Starter');
        ctx.expect(ga.payload.previous_value).toBe(9.99);
        ctx.expect(ga.payload.items[0].item_id, 'and items[] is still the plan they moved TO').toBe('pro');
      },
    },

    // ─── The live-spec cross-check's "wrong meaning" rows ([#652]) ───

    {
      name: 'an interaction the platforms do not define is a custom event under its canonical name',
      run: (ctx) => {
        // Each of these claimed a standard event whose OWN definition says something
        // else: Meta's SubmitApplication is "an application for a product, service or
        // program", its Lead "a submission of information", and both platforms'
        // ViewContent a page view. A toggle, a popup and a click are none of those.
        const rows = [
          ['feedback_submit', 'meta', 'FeedbackSubmit'],
          ['pricing_toggle', 'meta', 'PricingToggle'],
          ['pricing_toggle', 'tiktok', 'PricingToggle'],
          ['review_click', 'meta', 'ReviewClick'],
          ['review_click', 'tiktok', 'ReviewClick'],
          ['copy_link', 'tiktok', 'CopyLink'],
          ['exit_popup_show', 'tiktok', 'ExitPopupShow'],
          ['exit_popup_click', 'meta', 'ExitPopupClick'],
          ['exit_popup_click', 'tiktok', 'ExitPopupClick'],
          ['exit_popup_dismiss', 'tiktok', 'ExitPopupDismiss'],
        ];

        const adapters = { meta: meta, tiktok: tiktok };

        for (const [name, provider, native] of rows) {
          const descriptor = adapters[provider].resolve(name, {});

          ctx.expect(descriptor.name, `${name} → ${provider} ${native}`).toBe(native);
          ctx.expect(descriptor.kind, `${name} → ${provider} is a custom event, honestly declared`).toBe('custom');
        }
      },
    },

    {
      name: 'a lead form is a form submit to TikTok, and still a Lead to Meta',
      run: (ctx) => {
        // TikTok's Contact is "when a visitor contacts you"; a lead form is its
        // SubmitForm. Meta's Lead — "a submission of information by a customer with
        // the understanding that they may be contacted" — is exactly this event.
        ctx.expect(tiktok.resolve('generate_lead', { lead_source: 'pricing' }).name).toBe('SubmitForm');
        ctx.expect(tiktok.resolve('generate_lead', {}).kind).toBe('standard');
        ctx.expect(meta.resolve('generate_lead', {}).name).toBe('Lead');
        ctx.expect(google.resolve('generate_lead', {}).name).toBe('generate_lead');
      },
    },

    {
      name: 'search hands the ad platforms search_string, GA4 search_term',
      run: (ctx) => {
        const params = { search_term: 'omega', content_category: 'blog' };

        ctx.expect(google.resolve('search', params).payload.search_term).toBe('omega');
        ctx.expect(meta.resolve('search', params).payload.search_string).toBe('omega');
        ctx.expect(meta.resolve('search', params).payload.search_term).toBe(undefined);
        ctx.expect(tiktok.resolve('search', params).payload.search_string).toBe('omega');
      },
    },

    {
      name: 'a map never mutates the caller params',
      run: (ctx) => {
        const params = { ...PURCHASE_PARAMS };
        meta.resolve('purchase', params);
        tiktok.resolve('purchase', params);
        google.resolve('subscription_renew', params);

        ctx.expect(params, 'the caller object is untouched').toEqual(PURCHASE_PARAMS);
      },
    },

    // ─── No mapping ───

    {
      name: 'an unmapped provider resolves to null',
      run: (ctx) => {
        // vert_click is GA4-only; user_refund_request likewise.
        ctx.expect(google.resolve('vert_click', { vert_id: 'x' })).toBeTruthy();
        ctx.expect(meta.resolve('vert_click', { vert_id: 'x' })).toBe(null);
        ctx.expect(tiktok.resolve('vert_click', { vert_id: 'x' })).toBe(null);
        ctx.expect(tiktok.resolve('cookie_banner_show')).toBe(null);
      },
    },

    {
      name: 'an unknown event resolves to null on every adapter',
      run: (ctx) => {
        for (const adapter of ADAPTERS) {
          ctx.expect(adapter.resolve('not_an_event', {}), `${adapter.provider} returns null`).toBe(null);
        }
      },
    },

    // ─── Consent categories + attribution ───

    {
      name: 'attribution lands where each provider wants it',
      run: (ctx) => {
        const attribution = { campaign: 'summer', source: 'newsletter', fbc: 'fb.1.x', ttclid: 'tt-1', gclid: 'g-1' };
        const context = { attribution };

        const ga = google.resolve('sign_up', { method: 'google' }, context);
        ctx.expect(ga.payload.campaign, 'GA4 takes campaign as a flat event param').toBe('summer');
        ctx.expect(ga.payload.source).toBe('newsletter');
        ctx.expect(ga.payload.gclid, 'GA4 has no match block, so the Google click id is a param too').toBe('g-1');
        ctx.expect(ga.payload.fbc, 'another platform\'s click id never rides GA4').toBe(undefined);

        const facebook = meta.resolve('sign_up', { method: 'google' }, context);
        ctx.expect(facebook.userData.fbc, 'Meta match data lands in userData').toBe('fb.1.x');
        ctx.expect(facebook.payload.fbc, 'never in the custom data').toBe(undefined);

        const tt = tiktok.resolve('sign_up', { method: 'google' }, context);
        ctx.expect(tt.userData.ttclid, 'TikTok click id lands in userData').toBe('tt-1');
        ctx.expect(tt.payload.gclid, 'and GA4\'s param never rides another platform').toBe(undefined);
      },
    },

    {
      name: 'the touch\'s page rides the descriptor for the server senders',
      run: (ctx) => {
        // The attribution touch is the only URL a server conversion has any claim to
        // (a webhook has no page of its own), and the two ad platforms both read one:
        // TikTok's `page: { url, referrer }` data-item member and Meta's
        // `event_source_url` ([#497](https://github.com/Omega-JS-Stack/omega/issues/497)).
        const context = { attribution: { url: 'https://brand.test/pricing?utm_source=meta', referrer: 'https://facebook.com/' } };

        for (const adapter of [meta, tiktok]) {
          const descriptor = adapter.resolve('purchase', { value: 9.99, currency: 'USD' }, context);

          ctx.expect(descriptor.page, `${adapter.provider} carries the page`).toEqual({ url: 'https://brand.test/pricing?utm_source=meta', referrer: 'https://facebook.com/' });
          ctx.expect(descriptor.payload.url, `${adapter.provider} never rides the url in the event payload`).toBe(undefined);
          ctx.expect(descriptor.userData.url, 'nor in the match block').toBe(undefined);
        }

        // GA4's Measurement Protocol has no slot the campaign params do not already
        // fill, and an invented one is worse than an absent one.
        const ga = google.resolve('purchase', { value: 9.99, currency: 'USD' }, context);

        ctx.expect(Object.hasOwn(ga, 'page'), 'GA4 is untouched').toBe(false);
        ctx.expect(ga.payload.url, 'and gains no url param').toBe(undefined);
      },
    },

    {
      name: 'a touch with no referrer carries a page of the url alone',
      run: (ctx) => {
        const context = { attribution: { url: 'https://brand.test/' } };

        for (const adapter of [meta, tiktok]) {
          const descriptor = adapter.resolve('purchase', { value: 9.99 }, context);

          ctx.expect(descriptor.page, `${adapter.provider} sends the url without an empty referrer`).toEqual({ url: 'https://brand.test/' });
          ctx.expect(Object.hasOwn(descriptor.page, 'referrer'), 'a direct landing has no referrer to send').toBe(false);
        }
      },
    },

    {
      name: 'no touch url means no page at all',
      run: (ctx) => {
        // The raw-API recovery lane: no browser was ever involved. A referrer with no
        // url is not half a page — it is nothing to send.
        for (const attribution of [undefined, {}, { referrer: 'https://facebook.com/' }]) {
          for (const adapter of [meta, tiktok]) {
            const descriptor = adapter.resolve('purchase', { value: 9.99 }, { attribution: attribution });

            ctx.expect(Object.hasOwn(descriptor, 'page'), `${adapter.provider} invents no page from ${JSON.stringify(attribution)}`).toBe(false);
          }
        }
      },
    },

    {
      name: 'every descriptor carries a userData block for the server enrichment',
      run: (ctx) => {
        for (const adapter of ADAPTERS) {
          const descriptor = adapter.resolve('sign_up', { method: 'email' });
          ctx.expect(descriptor.userData, `${adapter.provider} has an empty match block by default`).toEqual({});
        }
      },
    },
  ],
});
