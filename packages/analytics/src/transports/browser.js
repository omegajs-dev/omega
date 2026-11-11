/**
 * The browser transport — executes descriptors against the page's own pixel
 * globals, absorbing the guard semantics of
 * [#306](https://github.com/Omega-JS-Stack/omega/issues/306).
 *
 * `gtag`, `fbq` and `ttq` are page-level snippets, and an ad blocker does not
 * stub them: it keeps them from ever being defined, so a BARE call throws a
 * ReferenceError. Every one of these calls sits in front of the thing the
 * customer just pressed, so that throw takes the action with it (the bug
 * [#283](https://github.com/Omega-JS-Stack/omega/issues/283) fixed inside the
 * billing card, found again in 19 other files).
 *
 * `typeof` against an undeclared name is the one check that does not throw, and
 * every provider is checked on its own: blockers are per-list, so a page that
 * lost Meta still counts Google. A missing or blocked global is a SILENT no-op,
 * never a throw — the return value is the only trace, so the facade's dev log
 * can tell "delivered" from "blocked" without anything reaching a visitor.
 */

// Google Analytics 4 — one command function; the event command is 'event'.
function sendGoogle(descriptor) {
  if (typeof gtag !== 'function') {
    return false;
  }

  gtag('event', descriptor.name, descriptor.payload);
  return true;
}

// Facebook Pixel — one command function; the kind picks the command, which is
// the whole point of the catalog's standard/custom distinction.
//
// A descriptor carrying an `eventId` is one half of a conversion whose other
// half fires server-side: the Pixel's fourth argument is where its `eventID`
// goes, and Meta deduplicates on the (event_name, event_id) PAIR. It is passed
// only when there is one — an `{ eventID: undefined }` option object reads to
// the Pixel as an id we tried and failed to send.
function sendMeta(descriptor) {
  if (typeof fbq !== 'function') {
    return false;
  }

  const command = descriptor.kind === 'custom' ? 'trackCustom' : 'track';

  if (descriptor.eventId) {
    fbq(command, descriptor.name, descriptor.payload, { eventID: descriptor.eventId });
  } else {
    fbq(command, descriptor.name, descriptor.payload);
  }

  return true;
}

// TikTok Pixel — an object of methods, so the method gets its own check. Its
// dedupe key is `event_id` in the third argument (the Events API half sends the
// same string).
//
// A descriptor carrying a `method` is the signal TikTok manages ITSELF rather
// than exposing as a trackable name: the page view, whose documented surface is
// `ttq.page()` and nothing else ([#409](https://github.com/Omega-JS-Stack/omega/issues/409)).
// It takes no name and no payload — the pixel reads the page — and a build that
// does not have the method is the same silent no-op a blocked global is (#306).
function sendTikTok(descriptor) {
  if (typeof ttq === 'undefined') {
    return false;
  }

  if (descriptor.method) {
    if (typeof ttq[descriptor.method] !== 'function') {
      return false;
    }

    ttq[descriptor.method]();
    return true;
  }

  if (typeof ttq.track !== 'function') {
    return false;
  }

  if (descriptor.eventId) {
    ttq.track(descriptor.name, descriptor.payload, { event_id: descriptor.eventId });
  } else {
    ttq.track(descriptor.name, descriptor.payload);
  }

  return true;
}

// The provider id → its sender: one per row whose `browserSender` is true.
const SENDERS = {
  google: sendGoogle,
  meta: sendMeta,
  tiktok: sendTikTok,
};

/**
 * Execute one descriptor against the page globals.
 * @param {object} descriptor - { provider, name, kind, payload, userData }.
 * @returns {boolean} true when the provider's global was there to take it.
 */
function send(descriptor) {
  const sender = SENDERS[descriptor.provider];
  if (!sender) {
    return false;
  }

  return sender(descriptor);
}

module.exports = { send, SENDERS };
