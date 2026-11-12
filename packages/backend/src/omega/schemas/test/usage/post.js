module.exports = () => ({
  // Clamped at 0: a negative amount would DECREMENT the counter, and the route
  // keys usage off the caller's uid OR their IP — so an unauthenticated caller
  // could zero their own rate-limit bucket.
  amount: { type: 'number', default: 1, min: 0 },
  // Another account to count against through usage.forUser(); '' counts the caller's own
  uid: { type: 'string', default: '' },
});
