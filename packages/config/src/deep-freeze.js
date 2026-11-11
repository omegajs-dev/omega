/**
 * deep-freeze.js: the one freezer of the row tables in this package (payment
 * providers, analytics providers, email providers, target types).
 */

/**
 * Freeze an object and every object inside it.
 * @param {object} object
 * @returns {object} the same object, frozen
 */
function deepFreeze(object) {
  Object.values(object).forEach((value) => {
    if (value && typeof value === 'object') deepFreeze(value);
  });

  return Object.freeze(object);
}

module.exports = { deepFreeze };
