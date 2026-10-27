'use strict';

/** Legacy shim: `require('hybris-hac-api/src/FlexibleSearchExecute')` → `{ flexibleSearchExecute }`. */

const legacy = require('./legacy');

/**
 * @param {string} query
 * @returns {Promise<Record<string, string>>}
 */
function flexibleSearchExecute(query) {
  return legacy.flexibleSearch(query);
}

module.exports = {
  flexibleSearchExecute,
};
