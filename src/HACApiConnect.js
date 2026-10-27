'use strict';

/** Legacy shim: `require('hybris-hac-api/src/HACApiConnect')` → `{ login }`. */

const legacy = require('./legacy');

/**
 * Logs the default client in (reuses an existing session).
 * @returns {Promise<void>}
 */
async function login() {
  await legacy.login();
}

module.exports = {
  login,
};
