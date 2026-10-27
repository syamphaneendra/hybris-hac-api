'use strict';

/**
 * Legacy configuration object (deep-require compatible:
 * `require('hybris-hac-api/src/config')` → `{ config, updateConfig }`).
 *
 * `.env` is loaded once from the current working directory when this module
 * is first required (existing environment variables win). Values are read
 * from the environment at that moment. `HAC_PASSWORD` is non-enumerable so
 * `console.log(config)` does not print it; reading and writing still work.
 */

require('dotenv').config({ quiet: true });

const env = process.env;

/**
 * @type {{ HAC_USER: string, HAC_PASSWORD: string, HAC_HOST: string|undefined, HYBRIS_VERSION: string|number }}
 */
const config = /** @type {any} */ ({
  HAC_USER: env.HAC_USER || env.USER_NAME || 'admin',
  HAC_HOST: env.HAC_HOST,
  HYBRIS_VERSION: env.HYBRIS_VERSION || 5.7,
});
Object.defineProperty(config, 'HAC_PASSWORD', {
  value: env.HAC_PASSWORD || env.PASSWORD || 'nimda',
  writable: true,
  enumerable: false,
  configurable: true,
});

/**
 * Overrides config values. Each argument is applied only when truthy.
 * @param {string} [host]
 * @param {string} [userName]
 * @param {string} [password]
 * @param {string|number} [hybrisVersion]
 */
function updateConfig(host, userName, password, hybrisVersion) {
  if (host) config.HAC_HOST = host;
  if (userName) config.HAC_USER = userName;
  if (password) config.HAC_PASSWORD = password;
  if (hybrisVersion) config.HYBRIS_VERSION = hybrisVersion;
}

module.exports = {
  config,
  updateConfig,
};
