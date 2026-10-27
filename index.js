'use strict';

/**
 * hybris-hac-api public entry.
 *
 * Legacy API: configure, impexImport, flexibleSearch, executeScript.
 * Client API: createHacClient, HacClient and the HacError hierarchy.
 */

const { configure, impexImport, flexibleSearch, executeScript } = require('./src/legacy');
const { createHacClient, HacClient } = require('./src/client');
const {
  HacError,
  HacConfigError,
  HacInputError,
  HacTransportError,
  HacTimeoutError,
  HacHttpError,
  HacAuthError,
  HacSessionExpiredError,
  HacCsrfError,
  HacResponseError,
  HacReportedError,
  HacImpexError,
  HacScriptError,
  HacFlexibleSearchError,
  HacNoResultsError,
  HacClientClosedError,
} = require('./src/core/errors');

module.exports = {
  configure,
  impexImport,
  flexibleSearch,
  executeScript,
  createHacClient,
  HacClient,
  HacError,
  HacConfigError,
  HacInputError,
  HacTransportError,
  HacTimeoutError,
  HacHttpError,
  HacAuthError,
  HacSessionExpiredError,
  HacCsrfError,
  HacResponseError,
  HacReportedError,
  HacImpexError,
  HacScriptError,
  HacFlexibleSearchError,
  HacNoResultsError,
  HacClientClosedError,
};
