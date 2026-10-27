'use strict';

/** Legacy shim: `require('hybris-hac-api/src/ImpexImportExecute')` → `{ impexImportExecute }`. */

const legacy = require('./legacy');

/**
 * @param {string} script
 * @returns {Promise<void>}
 */
async function impexImportExecute(script) {
  await legacy.impexImport(script);
}

module.exports = {
  impexImportExecute,
};
