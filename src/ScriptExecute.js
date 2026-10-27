'use strict';

/** Legacy shim: `require('hybris-hac-api/src/ScriptExecute')` → `{ scriptExecute }`. */

const legacy = require('./legacy');

/**
 * @param {string} script
 * @param {string|boolean} [commit] default "true"
 * @param {string} [scriptType] default "groovy"
 * @returns {Promise<Record<string, any>>}
 */
function scriptExecute(script, commit = 'true', scriptType = 'groovy') {
  return legacy.executeScript(script, commit, scriptType);
}

module.exports = {
  scriptExecute,
};
