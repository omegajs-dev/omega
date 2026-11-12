/**
 * The event catalog — the SSOT for every analytics event OMEGA fires
 * ([#328](https://github.com/Omega-JS-Stack/omega/issues/328) §Architecture,
 * built by [#382](https://github.com/Omega-JS-Stack/omega/issues/382)).
 *
 * ONE entry per canonical event. Callers only ever speak canonical names and
 * canonical params; each adapter translates into its provider's own dialect,
 * because there is no unified cross-provider signature (Ian's constraint).
 *
 * MANDATORY BEFORE ANY EDIT BELOW (Ian 2026-08-27): every provider `name`,
 * `kind` and param shape in this file is checked LIVE against the platform's
 * own specification, never from memory. Open all six, read the event you are
 * touching, and confirm the name is spelled as the platform spells it, that
 * `kind: 'standard'` only claims an event the platform lists, and that the
 * shaper sends the parameters the platform documents for that event:
 *   GA4        https://support.google.com/analytics/answer/9267735
 *   Meta       https://www.facebook.com/business/help/402791146561655
 *   Meta pixel https://developers.facebook.com/docs/meta-pixel/reference
 *   TikTok     https://ads.tiktok.com/help/article/standard-events-parameters
 *   TikTok 2.0 https://business-api.tiktok.com/portal/docs?id=1771100865818625
 *   GA4 dedupe https://support.google.com/analytics/answer/12313109
 * A platform renames and retires events (TikTok retired CompletePayment for
 * Purchase); a mapping that was right when written can be wrong today. The
 * last link is the one that binds a PARAM rather than a name: GA4
 * deduplicates `purchase` on `transaction_id`, so a money event's id is one
 * CHARGE's ([#656](https://github.com/Omega-JS-Stack/omega/issues/656)).
 *
 * Entry shape:
 *   params     — the canonical param contract, documentation for callers.
 *                Drawn from the EXISTING call sites so a rewired site sends
 *                what it sends today.
 *   placement  — 'client' | 'server' | 'both'. Money and account truth fire
 *                server-side, UI actions client-side, signup both.
 *   providers  — per-provider mapping. A provider ABSENT from this object has
 *                no mapping: the adapter returns null and the facade logs the
 *                dev skip. Each mapping carries:
 *                  name — the provider's NATIVE event name
 *                  kind — 'standard' (the platform defines this event) or
 *                         'custom' (a deliberate custom event; the provider
 *                         fires its custom-event mechanism)
 *                  map  — OPTIONAL (params, context) => payload, only where
 *                         the provider's shape genuinely differs. Default is
 *                         pass-through.
 *                  method — OPTIONAL, browser only: the provider's own PIXEL
 *                         METHOD to call instead of its tracked-event command,
 *                         for the one signal a platform manages itself rather
 *                         than exposing as a trackable name (TikTok's
 *                         `ttq.page()`). The name and kind stay declared for the
 *                         catalog and the fire log; the transport calls the
 *                         method, with no name and no payload.
 *                  actionSource — OPTIONAL, Meta only: the `action_source` this
 *                         event's SERVER fire carries instead of the sender's
 *                         default `website`. Meta requires the field and makes
 *                         its accuracy a term of use, and its enum names the
 *                         case itself: `system_generated`, "for example, a
 *                         subscription renewal that's set to auto-pay each
 *                         month". A charge a card takes on its own had nobody
 *                         on a website to claim
 *                         ([#498](https://github.com/Omega-JS-Stack/omega/issues/498)).
 *
 * The canonical param vocabulary is GA4-flavoured (flat params plus an `items`
 * array), because that is what the live call sites and the backend's payment
 * webhook already build — so GA4 is pass-through and the maps live where the
 * other two platforms genuinely disagree: their commerce vocabulary (both spell
 * a cart as `content_ids` + `contents`, but the contents OBJECT is each
 * platform's own) and Search's `search_string`.
 */

// Drop keys a caller did not supply — a provider payload carrying
// `content_name: undefined` is noise, not data.
function compact(payload) {
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

// ─── Shared provider shapers ────────────────────────────────────────────────

// Meta's commerce vocabulary: content_ids + contents + num_items instead of
// GA4's items[]. BOTH id carriers ride, because Meta accepts either and its
// pixel reference asks for "contents or content_ids" on Purchase and Search
// (plain `contents` on AddToCart) for Advantage+ catalog ads: the priced
// objects are what a catalog campaign can match on
// ([#498](https://github.com/Omega-JS-Stack/omega/issues/498)). The object's
// field names are Meta's own (`id`, `quantity`, `item_price`), never GA4's;
// `delivery_category` is the fourth and belongs to physical fulfilment, which a
// subscription has none of.
function metaCommerce(params) {
  const items = Array.isArray(params.items) ? params.items : [];

  return compact({
    content_ids: items.length ? items.map((item) => item.item_id) : undefined,
    contents: items.length ? items.map((item) => compact({
      id: item.item_id,
      // Meta's object requires id + quantity; a line naming none is one of it,
      // the same answer num_items gives below
      quantity: item.quantity ?? 1,
      item_price: item.price,
    })) : undefined,
    // "Name of the page/product", SINGULAR. This named items[0] for a whole
    // cart, which labels a two-product order with one of them; `content_ids` and
    // `contents` are the members that carry every product [#498].
    content_name: items.length === 1 ? items[0].item_name : undefined,
    content_type: items.length ? 'product' : undefined,
    currency: params.currency,
    value: params.value,
    // "The number of items that a user tries to buy", so two seats on one line
    // are two items, and a line naming no quantity is one of that thing [#498].
    num_items: items.length ? items.reduce((total, item) => total + (item.quantity ?? 1), 0) : undefined,
    // The transaction's own id, in Meta's vocabulary. The dedupe `event_id` is
    // not this: Meta reads that as the pair-key for one browser/server fire and
    // never as the order [#498].
    order_id: params.transaction_id,
  });
}

// TikTok's commerce vocabulary: a `contents` ARRAY of product objects, plus the
// order's own content_type/value/currency. The pixel reference documents exactly
// this shape — `ttq.track('AddToCart', { contents: [{ content_id, content_name,
// quantity, price }], content_type: 'product', value, currency })`, with
// `contents` "a list of content objects that represent relevant products in a
// web event with product information" — and the flat single-item
// `content_id`/`price`/`quantity` this sent before appears nowhere in it
// ([#652](https://github.com/Omega-JS-Stack/omega/issues/652)).
//
// Events API 2.0 documents `content_ids` BESIDE `contents` in the same
// `properties` object, and TikTok's standard-events page recommends `content_ids`
// on every commerce event it lists, so both ride, as they do on Meta's half
// ([#498](https://github.com/Omega-JS-Stack/omega/issues/498)). `content_type`
// stays where 2.0 documents it, at the properties level: the per-item
// `content_type` of the older Pixel SDK model is not in 2.0's contents object,
// whose fields are price, content_id, content_name, content_category and brand.
function tiktokCommerce(params) {
  const items = Array.isArray(params.items) ? params.items : [];

  return compact({
    content_ids: items.length ? items.map((item) => item.item_id) : undefined,
    contents: items.length ? items.map((item) => compact({
      content_id: item.item_id,
      content_name: item.item_name,
      content_category: item.item_category,
      price: item.price,
      quantity: item.quantity,
    })) : undefined,
    content_type: items.length ? 'product' : undefined,
    currency: params.currency,
    value: params.value,
    // 2.0's `properties.order_id`, Meta's `order_id` twin [#498].
    order_id: params.transaction_id,
  });
}

// A churn moment's ad-platform half: an EXCLUSION-AUDIENCE signal, never money
// ([#415](https://github.com/Omega-JS-Stack/omega/issues/415)). Neither platform
// can subtract revenue, so a cancellation or a refund carrying its amount would
// ADD to the return their ads manager reports — the exact opposite of the truth.
// `value: 0` is the honest number on that side; GA4 keeps the real one, where a
// refund is a standard event the revenue report knows how to net.
function metaAudienceSignal(params) {
  // `contents` comes off whole: its `item_price` IS the amount, and Meta's
  // object requires `id` + `quantity`, so a stripped one would be a malformed
  // object rather than a quieter signal. `content_ids` already names the plan,
  // which is the entire content of an exclusion audience
  // ([#498](https://github.com/Omega-JS-Stack/omega/issues/498)).
  const { contents, ...signal } = metaCommerce(params);

  return { ...signal, value: 0 };
}

function tiktokAudienceSignal(params) {
  // TikTok's per-item `price` and `quantity` come off with the value: zeroing
  // one field while the amount rides inside `contents` is not a zero-value
  // signal. Meta's signal drops its own `contents` outright for the same reason,
  // and TikTok's array stays because it is that platform's only id carrier
  // besides `content_ids`. What is left is who and which plan, which is the
  // whole point of the audience.
  const signal = tiktokCommerce(params);

  return compact({
    ...signal,
    contents: signal.contents
      ? signal.contents.map(({ price, quantity, ...content }) => content)
      : undefined,
    value: 0,
  });
}

// Both ad platforms call the query `search_string`; GA4 calls it `search_term`.
function metaSearch(params) {
  return compact({
    search_string: params.search_term,
    content_category: params.content_category,
  });
}

function tiktokSearch(params) {
  return compact({
    search_string: params.search_term,
  });
}

// The recurring-revenue events ride GA4's standard `purchase` under their own
// canonical name, so the flag that tells them apart in GA4 is set here.
function googleRecurring(params) {
  return { ...params, is_recurring: true };
}

// The canonical commerce param contract, shared by every money event.
const COMMERCE_PARAMS = ['transaction_id', 'value', 'currency', 'items', 'is_trial', 'is_recurring', 'payment_provider', 'payment_frequency'];

// A plan change is the one money event with a BEFORE: `items` is the plan the
// subscriber moved to, and these carry the one they came from, so the direction
// of the switch is readable without a second event
// ([#407](https://github.com/Omega-JS-Stack/omega/issues/407)).
const PLAN_CHANGE_PARAMS = [...COMMERCE_PARAMS, 'previous_item_id', 'previous_item_name', 'previous_value'];

// ─── The catalog ────────────────────────────────────────────────────────────

const CATALOG = {
  // ─── Auth ───

  // The funnel entry, fired when the signup form is submitted. No provider
  // mapping: the signup FUNNEL is ours to read, not an ad platform's.
  sign_up_started: {
    params: ['method'],
    placement: 'client',
    providers: {},
  },

  sign_up: {
    params: ['method', 'user_id'],
    placement: 'both',
    providers: {
      google: { name: 'sign_up', kind: 'standard' },
      meta: { name: 'CompleteRegistration', kind: 'standard' },
      tiktok: { name: 'CompleteRegistration', kind: 'standard' },
    },
  },

  login: {
    params: ['method', 'user_id'],
    placement: 'client',
    providers: {
      google: { name: 'login', kind: 'standard' },
      // Neither ad platform defines a Login event — today's call sites already
      // fire it as a custom one, and the catalog says so out loud.
      meta: { name: 'Login', kind: 'custom' },
      tiktok: { name: 'Login', kind: 'custom' },
    },
  },

  // Deliberately unmapped everywhere: a logout is not an ad signal, and GA4
  // reads the session end on its own.
  logout: {
    params: [],
    placement: 'client',
    providers: {},
  },

  password_reset: {
    params: ['method', 'status'],
    placement: 'client',
    providers: {
      google: { name: 'password_reset', kind: 'custom' },
      meta: { name: 'PasswordReset', kind: 'custom' },
      tiktok: { name: 'SubmitForm', kind: 'standard' },
    },
  },

  // Every platform hears the page view through THIS entry
  // ([#409](https://github.com/Omega-JS-Stack/omega/issues/409)): the web
  // loader's raw `fbq('track', 'PageView')` and `ttq.page()` at pixel init are
  // retired, so a page view walks the same consent gate and the same catalog as
  // every other event. Pass-through: a page's own params are all any of them
  // wants, and each pixel reads the URL itself when a fire carries none.
  page_view: {
    params: ['page_path', 'page_title', 'page_location'],
    placement: 'client',
    providers: {
      google: { name: 'page_view', kind: 'standard' },
      meta: { name: 'PageView', kind: 'standard' },
      // TikTok's page view is a pixel METHOD it manages itself (`ttq.page()`),
      // not a name in its trackable set — `ttq.track('Pageview')` appears
      // nowhere in TikTok's documented surface, and sending it would risk a
      // Pageview metric that silently reads zero. So the mapping names the
      // METHOD and the browser transport calls exactly that; the name and the
      // honest `custom` kind stay for the catalog and the fire log.
      tiktok: { name: 'Pageview', kind: 'custom', method: 'page' },
    },
  },

  // The page_view twin for the runtimes that have screens, not pages —
  // desktop's renderers fire it through the main-process singleton.
  screen_view: {
    params: ['screen_name'],
    placement: 'client',
    providers: {
      google: { name: 'screen_view', kind: 'standard' },
    },
  },

  // ─── Commerce (client funnel) ───

  view_item: {
    params: ['currency', 'value', 'items'],
    placement: 'client',
    providers: {
      google: { name: 'view_item', kind: 'standard' },
      meta: { name: 'ViewContent', kind: 'standard', map: metaCommerce },
      tiktok: { name: 'ViewContent', kind: 'standard', map: tiktokCommerce },
    },
  },

  // The pricing page's monthly/yearly switch. Both platforms define ViewContent
  // as a PAGE or product view (Meta: "a visit to a web page you care about";
  // TikTok: "when a visitor views a specific page") and a toggle is neither, so
  // all three read it as the custom event it is
  // ([#652](https://github.com/Omega-JS-Stack/omega/issues/652)).
  pricing_toggle: {
    params: ['billing_type'],
    placement: 'client',
    providers: {
      google: { name: 'pricing_toggle', kind: 'custom' },
      meta: { name: 'PricingToggle', kind: 'custom' },
      tiktok: { name: 'PricingToggle', kind: 'custom' },
    },
  },

  add_to_cart: {
    params: ['currency', 'value', 'items'],
    placement: 'client',
    providers: {
      google: { name: 'add_to_cart', kind: 'standard' },
      meta: { name: 'AddToCart', kind: 'standard', map: metaCommerce },
      tiktok: { name: 'AddToCart', kind: 'standard', map: tiktokCommerce },
    },
  },

  begin_checkout: {
    params: ['currency', 'value', 'items'],
    placement: 'client',
    providers: {
      google: { name: 'begin_checkout', kind: 'standard' },
      meta: { name: 'InitiateCheckout', kind: 'standard', map: metaCommerce },
      tiktok: { name: 'InitiateCheckout', kind: 'standard', map: tiktokCommerce },
    },
  },

  add_payment_info: {
    params: ['currency', 'value', 'payment_type', 'items'],
    placement: 'client',
    providers: {
      google: { name: 'add_payment_info', kind: 'standard' },
      meta: { name: 'AddPaymentInfo', kind: 'standard', map: metaCommerce },
      tiktok: { name: 'AddPaymentInfo', kind: 'standard', map: tiktokCommerce },
    },
  },

  // ─── Commerce (server truth) ───

  // Server is the truth: the backend's payment webhook owns the revenue. The
  // BROWSER half is the retargeting signal the ad platforms need
  // ([#386](https://github.com/Omega-JS-Stack/omega/issues/386)) — and GA4's
  // too, since GA4 deduplicates `purchase` on `transaction_id`: both halves
  // name the ORDER, so the browser adds the session, the campaign and the
  // client id, and GA4 still counts one purchase
  // ([#656](https://github.com/Omega-JS-Stack/omega/issues/656)). All three
  // carry the same `<canonical>.<order id>` dedupe id for the two platforms
  // that key on one.
  purchase: {
    params: COMMERCE_PARAMS,
    placement: 'both',
    providers: {
      google: { name: 'purchase', kind: 'standard' },
      meta: { name: 'Purchase', kind: 'standard', map: metaCommerce },
      // TikTok RETIRED CompletePayment: `Purchase` — "when a visitor makes a
      // purchase" — is the standard event its live list names, and the only one
      // it documents `value`/`currency` for ([#652]).
      tiktok: { name: 'Purchase', kind: 'standard', map: tiktokCommerce },
    },
  },

  // A trial checkout's own conversion, and the SECOND event with a browser half
  // ([#654](https://github.com/Omega-JS-Stack/omega/issues/654)): the
  // confirmation page fired `purchase` for every checkout, so a $0 trial sent a
  // browser Purchase beside this trial_start. The names, not the amounts, were
  // the defect — two different event names never deduplicate, so each platform
  // counted the pair as two conversions. The browser half is meta + tiktok —
  // GA4's trial_start is a custom event the server owns outright, and there is
  // no revenue for GA4 to deduplicate here.
  //
  // Value 0 on both platforms: a trial charges nothing, and both spell that out
  // (Meta `fbq('track', 'StartTrial', { value: '0.00', currency: 'USD' })`).
  trial_start: {
    params: COMMERCE_PARAMS,
    placement: 'both',
    providers: {
      // GA4 has no trial_start in its standard set — an explicit custom event.
      google: { name: 'trial_start', kind: 'custom' },
      meta: { name: 'StartTrial', kind: 'standard', map: metaCommerce },
      // TikTok's own StartTrial — "when a customer begins a free trial for your
      // product or service" — replaces the Subscribe this claimed, which TikTok
      // defines as subscribing, paid subscriptions included ([#652]).
      tiktok: { name: 'StartTrial', kind: 'standard', map: tiktokCommerce },
    },
  },

  // The FIRST real charge after a trial — the funnel step the generic renewal
  // branch used to swallow, which made a conversion indistinguishable from a
  // routine renewal ([#407](https://github.com/Omega-JS-Stack/omega/issues/407)).
  //
  // GA4 hears its standard `purchase`, because this is where the money finally
  // moves and revenue belongs in the revenue report; the pair `is_trial: true` +
  // `is_recurring: false` is what marks it inside that stream, so the conversion
  // is still countable on its own. The ad platforms already heard `StartTrial`
  // at trial start, and every REAL CHARGE is a Purchase to both of them — the
  // one event each documents `value` + `currency` for (Ian's money-event table,
  // [#652](https://github.com/Omega-JS-Stack/omega/issues/652)).
  trial_convert: {
    params: COMMERCE_PARAMS,
    placement: 'server',
    providers: {
      google: { name: 'purchase', kind: 'standard' },
      meta: { name: 'Purchase', kind: 'standard', map: metaCommerce, actionSource: 'system_generated' },
      tiktok: { name: 'Purchase', kind: 'standard', map: tiktokCommerce },
    },
  },

  // The other end of the same funnel: a trial that ended without ever paying.
  // GA4-only, and DELIBERATELY out of the exclusion lane the two entries below
  // joined ([#415](https://github.com/Omega-JS-Stack/omega/issues/415)): a
  // lapsed trialist is a win-back audience worth RETARGETING, not somebody to
  // stop showing ads to. An ad platform optimizes toward conversions, so the
  // failure itself buys nothing either.
  trial_lapse: {
    params: COMMERCE_PARAMS,
    placement: 'server',
    providers: {
      google: { name: 'trial_lapse', kind: 'custom' },
    },
  },

  // GA4's own refund event, fired by the payment webhook's refund transitions.
  // The ad platforms hear a zero-value custom `Refund` — an audience to stop
  // paying to reach, and the one thing they can do with a churn moment.
  refund: {
    params: ['transaction_id', 'value', 'currency', 'items'],
    placement: 'server',
    providers: {
      google: { name: 'refund', kind: 'standard' },
      meta: { name: 'Refund', kind: 'custom', map: metaAudienceSignal },
      tiktok: { name: 'Refund', kind: 'custom', map: tiktokAudienceSignal },
    },
  },

  // The cancellation that TOOK EFFECT. Cancellation-REQUESTED stays event-less by
  // design: a schedule changed, nothing ended, no money moved, and the
  // subscription may never cancel at all.
  subscription_cancel: {
    params: COMMERCE_PARAMS,
    placement: 'server',
    providers: {
      google: { name: 'subscription_cancel', kind: 'custom' },
      meta: { name: 'SubscriptionCancel', kind: 'custom', map: metaAudienceSignal },
      tiktok: { name: 'SubscriptionCancel', kind: 'custom', map: tiktokAudienceSignal },
    },
  },

  // The uncancel — a scheduled cancellation withdrawn. The request had no event
  // to be the pair of, which is the point: a retention win is an outcome, and it
  // was completely dark before [#407].
  subscription_uncancel: {
    params: COMMERCE_PARAMS,
    placement: 'server',
    providers: {
      google: { name: 'subscription_uncancel', kind: 'custom' },
    },
  },

  // An upgrade or downgrade between two paid plans. GA4-only: no money moves at
  // the switch itself, and firing a platform's Subscribe here would count a
  // second subscription for a customer who already has one.
  subscription_plan_change: {
    params: PLAN_CHANGE_PARAMS,
    placement: 'server',
    providers: {
      google: { name: 'subscription_plan_change', kind: 'custom' },
    },
  },

  // A renewal and a recovered payment are CHARGES, so both ad platforms hear
  // Purchase for the real amount. Neither is a Subscribe: Meta defines that as
  // "the START of a paid subscription", and month two starts nothing — the
  // mapping counted a new subscriber every month
  // ([#652](https://github.com/Omega-JS-Stack/omega/issues/652)). GA4 keeps its
  // standard `purchase` with `is_recurring`, and its `transaction_id` is THIS
  // charge's, never the subscription's, or GA4 dedupes every renewal after the
  // first away ([#656](https://github.com/Omega-JS-Stack/omega/issues/656)).
  subscription_renew: {
    params: COMMERCE_PARAMS,
    placement: 'server',
    providers: {
      google: { name: 'purchase', kind: 'standard', map: googleRecurring },
      meta: { name: 'Purchase', kind: 'standard', map: metaCommerce, actionSource: 'system_generated' },
      tiktok: { name: 'Purchase', kind: 'standard', map: tiktokCommerce },
    },
  },

  payment_recovered: {
    params: COMMERCE_PARAMS,
    placement: 'server',
    providers: {
      google: { name: 'purchase', kind: 'standard', map: googleRecurring },
      meta: { name: 'Purchase', kind: 'standard', map: metaCommerce, actionSource: 'system_generated' },
      tiktok: { name: 'Purchase', kind: 'standard', map: tiktokCommerce },
    },
  },

  // ─── Engagement ───

  // Meta's Lead is exactly this ("a submission of information by a customer with
  // the understanding that they may be contacted at a later date"), and TikTok's
  // SubmitForm is the standard event for a form; its Contact means "when a
  // visitor contacts you", which a lead form is not
  // ([#652](https://github.com/Omega-JS-Stack/omega/issues/652)).
  generate_lead: {
    params: ['lead_source', 'subject'],
    placement: 'client',
    providers: {
      google: { name: 'generate_lead', kind: 'standard' },
      meta: { name: 'Lead', kind: 'standard' },
      tiktok: { name: 'SubmitForm', kind: 'standard' },
    },
  },

  // The enterprise "talk to us" path off the pricing page.
  contact_enterprise: {
    params: ['from_page'],
    placement: 'client',
    providers: {
      google: { name: 'contact_enterprise', kind: 'custom' },
      meta: { name: 'Contact', kind: 'standard' },
      tiktok: { name: 'Contact', kind: 'standard' },
    },
  },

  // The contact form's honeypot catch. GA4 only: a spam signal is ours to
  // read, and feeding it to an ad platform would poison the audience.
  contact_form_spam: {
    params: ['content_type'],
    placement: 'client',
    providers: {
      google: { name: 'contact_form_spam', kind: 'custom' },
    },
  },

  // GA4's standard name, replacing the literal `download` today's page sends.
  file_download: {
    params: ['platform', 'download_name', 'download_url'],
    placement: 'client',
    providers: {
      google: { name: 'file_download', kind: 'standard' },
      meta: { name: 'Download', kind: 'custom' },
      tiktok: { name: 'Download', kind: 'standard' },
    },
  },

  // Meta's SubmitApplication is "an application for a product, service or
  // program you offer... a credit card, educational program or job" — feedback
  // applies for nothing, so Meta hears a custom event. TikTok's SubmitForm
  // ("when a visitor submits a form") fits as it stands
  // ([#652](https://github.com/Omega-JS-Stack/omega/issues/652)).
  feedback_submit: {
    params: ['feedback_rating'],
    placement: 'client',
    providers: {
      google: { name: 'feedback_submit', kind: 'custom' },
      meta: { name: 'FeedbackSubmit', kind: 'custom' },
      tiktok: { name: 'SubmitForm', kind: 'standard' },
    },
  },

  // A click through to a review page is neither Meta's Lead (a submission of
  // information) nor TikTok's Contact (a visitor contacting you), so both hear
  // the canonical event as a custom one
  // ([#652](https://github.com/Omega-JS-Stack/omega/issues/652)).
  review_click: {
    params: ['review_url'],
    placement: 'client',
    providers: {
      google: { name: 'review_click', kind: 'custom' },
      meta: { name: 'ReviewClick', kind: 'custom' },
      tiktok: { name: 'ReviewClick', kind: 'custom' },
    },
  },

  // The prompt half of the review pair — ours to read, no ad signal in it.
  review_prompt_show: {
    params: ['review_url'],
    placement: 'client',
    providers: {
      google: { name: 'review_prompt_show', kind: 'custom' },
    },
  },

  search: {
    params: ['search_term', 'content_category'],
    placement: 'client',
    providers: {
      google: { name: 'search', kind: 'standard' },
      meta: { name: 'Search', kind: 'standard', map: metaSearch },
      tiktok: { name: 'Search', kind: 'standard', map: tiktokSearch },
    },
  },

  share: {
    params: ['method', 'content_type', 'item_id'],
    placement: 'client',
    providers: {
      google: { name: 'share', kind: 'standard' },
      // Neither platform defines Share — today's sites claim it as standard.
      meta: { name: 'Share', kind: 'custom' },
      tiktok: { name: 'Share', kind: 'custom' },
    },
  },

  // The share panel's copy-to-clipboard half. ClickButton is on NEITHER
  // platform's standard list — TikTok's own set runs AddPaymentInfo … ViewContent
  // and never names it — so this is a custom event on both, under the canonical
  // name ([#652](https://github.com/Omega-JS-Stack/omega/issues/652)).
  copy_link: {
    params: ['content_type', 'item_id'],
    placement: 'client',
    providers: {
      google: { name: 'copy_link', kind: 'custom' },
      meta: { name: 'CopyLink', kind: 'custom' },
      tiktok: { name: 'CopyLink', kind: 'custom' },
    },
  },

  marketing_newsletter_subscribe: {
    params: ['method'],
    placement: 'client',
    providers: {
      google: { name: 'marketing_newsletter_subscribe', kind: 'custom' },
      meta: { name: 'Lead', kind: 'standard' },
      tiktok: { name: 'Subscribe', kind: 'standard' },
    },
  },

  // The status page's incident-updates opt-in — its own event, keeping its
  // live provider dialect (TikTok reads it as a form submit, not a Subscribe).
  status_subscribe: {
    params: ['method'],
    placement: 'client',
    providers: {
      google: { name: 'status_subscribe', kind: 'custom' },
      meta: { name: 'Lead', kind: 'standard' },
      tiktok: { name: 'SubmitForm', kind: 'standard' },
    },
  },

  // ─── Exit popup ───

  // The popup trio, all custom on both ad platforms
  // ([#652](https://github.com/Omega-JS-Stack/omega/issues/652)): a popup is not
  // a page view (TikTok's ViewContent is "when a visitor views a specific
  // page"), a click is not Meta's Lead ("a submission of information"), and
  // ClickButton is not on TikTok's standard list at all.
  exit_popup_show: {
    params: ['event_category', 'event_label', 'page_path'],
    placement: 'client',
    providers: {
      google: { name: 'exit_popup_show', kind: 'custom' },
      meta: { name: 'ExitPopupShow', kind: 'custom' },
      tiktok: { name: 'ExitPopupShow', kind: 'custom' },
    },
  },

  exit_popup_click: {
    params: ['event_category', 'event_label', 'destination_url'],
    placement: 'client',
    providers: {
      google: { name: 'exit_popup_click', kind: 'custom' },
      meta: { name: 'ExitPopupClick', kind: 'custom' },
      tiktok: { name: 'ExitPopupClick', kind: 'custom' },
    },
  },

  exit_popup_dismiss: {
    params: ['event_category', 'event_label'],
    placement: 'client',
    providers: {
      google: { name: 'exit_popup_dismiss', kind: 'custom' },
      meta: { name: 'ExitPopupDismiss', kind: 'custom' },
      tiktok: { name: 'ExitPopupDismiss', kind: 'custom' },
    },
  },

  // ─── Cookie consent ───
  // TikTok is deliberately unmapped: consent bookkeeping is not an ad signal.
  // (`cookie_consent_auto_accept` is DROPPED — the new consent system has no
  // auto-accept-on-scroll.)

  cookie_banner_show: {
    params: ['event_category'],
    placement: 'client',
    providers: {
      google: { name: 'cookie_banner_show', kind: 'custom' },
      meta: { name: 'CookieBannerShow', kind: 'custom' },
    },
  },

  cookie_consent_accept: {
    params: ['event_category', 'consent_type'],
    placement: 'client',
    providers: {
      google: { name: 'cookie_consent_accept', kind: 'custom' },
      meta: { name: 'CookieConsentAccept', kind: 'custom' },
    },
  },

  cookie_consent_deny: {
    params: ['event_category', 'consent_type'],
    placement: 'client',
    providers: {
      google: { name: 'cookie_consent_deny', kind: 'custom' },
      meta: { name: 'CookieConsentDeny', kind: 'custom' },
    },
  },

  cookie_policy_reopen: {
    params: ['event_category'],
    placement: 'client',
    providers: {
      google: { name: 'cookie_policy_reopen', kind: 'custom' },
      meta: { name: 'CookiePolicyReopen', kind: 'custom' },
    },
  },

  // ─── Account & portal ───
  // Action buckets: one event with an `action`/`section_name` param, never a
  // per-action event sprawl (the inventory ruling).

  user_section_view: {
    params: ['section_name'],
    placement: 'client',
    providers: {
      google: { name: 'user_section_view', kind: 'custom' },
    },
  },

  user_billing_action: {
    params: ['action'],
    placement: 'client',
    providers: {
      google: { name: 'user_billing_action', kind: 'custom' },
    },
  },

  user_refund_request: {
    params: ['action'],
    placement: 'client',
    providers: {
      google: { name: 'user_refund_request', kind: 'custom' },
    },
  },

  user_data_request: {
    params: ['action'],
    placement: 'client',
    providers: {
      google: { name: 'user_data_request', kind: 'custom' },
    },
  },

  marketing_email_subscribe: {
    params: ['content_type'],
    placement: 'client',
    providers: {
      google: { name: 'marketing_email_subscribe', kind: 'custom' },
      meta: { name: 'EmailSubscribe', kind: 'custom' },
    },
  },

  marketing_email_unsubscribe: {
    params: ['content_type'],
    placement: 'client',
    providers: {
      google: { name: 'marketing_email_unsubscribe', kind: 'custom' },
      meta: { name: 'EmailUnsubscribe', kind: 'custom' },
    },
  },

  // ─── Notifications ───

  notification_permission_request: {
    params: [],
    placement: 'client',
    providers: {
      google: { name: 'notification_permission_request', kind: 'custom' },
    },
  },

  notification_permission_grant: {
    params: [],
    placement: 'client',
    providers: {
      google: { name: 'notification_permission_grant', kind: 'custom' },
    },
  },

  notification_permission_deny: {
    params: [],
    placement: 'client',
    providers: {
      google: { name: 'notification_permission_deny', kind: 'custom' },
    },
  },

  notification_subscribe: {
    params: [],
    placement: 'server',
    providers: {
      google: { name: 'notification_subscribe', kind: 'custom' },
    },
  },

  notification_unsubscribe: {
    params: [],
    placement: 'server',
    providers: {
      google: { name: 'notification_unsubscribe', kind: 'custom' },
    },
  },

  // ─── Surfaces ───

  vert_click: {
    params: ['vert_id', 'vert_lane', 'vert_campaign', 'vert_slot', 'vert_source'],
    placement: 'client',
    providers: {
      google: { name: 'vert_click', kind: 'custom' },
    },
  },

  extension_install: {
    params: ['browser', 'install_url'],
    placement: 'client',
    providers: {
      google: { name: 'extension_install', kind: 'custom' },
      meta: { name: 'ExtensionInstall', kind: 'custom' },
      tiktok: { name: 'Download', kind: 'standard' },
    },
  },

  app_launch: {
    params: [],
    placement: 'client',
    providers: {
      google: { name: 'app_launch', kind: 'custom' },
    },
  },

  // The 404 page's own event, carrying the path that missed. GA4 only: a broken
  // link is ours to fix, never an ad signal.
  page_not_found: {
    params: ['path'],
    placement: 'client',
    providers: {
      google: { name: 'page_not_found', kind: 'custom' },
    },
  },

  user_delete: {
    params: [],
    placement: 'server',
    providers: {
      google: { name: 'user_delete', kind: 'custom' },
    },
  },
};

// The placements an entry may declare.
const PLACEMENTS = ['client', 'server', 'both'];

// The provider kinds a mapping may declare.
const KINDS = ['standard', 'custom'];

/**
 * The catalog entry for a canonical event name, or null when it has none.
 * @param {string} name - The canonical event name.
 * @returns {object|null}
 */
function entryFor(name) {
  return Object.prototype.hasOwnProperty.call(CATALOG, name) ? CATALOG[name] : null;
}

module.exports = {
  CATALOG,
  PLACEMENTS,
  KINDS,
  entryFor,
  compact,
};
