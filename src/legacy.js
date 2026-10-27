'use strict';

/**
 * Legacy API (configure / impexImport / flexibleSearch / executeScript /
 * login) over a lazily created default client.
 *
 * The default client is built from a snapshot of the legacy `config`
 * object. Any change to that object (configure, updateConfig or a direct
 * write) replaces the client on the next legacy call; calls already in
 * flight finish on the client they started with (it is retired, then closed).
 */

const { config, updateConfig } = require('./config');
const { HacClient, RETIRE, EXECUTE } = require('./client');
const { fromLegacyConfig } = require('./core/options');
const flexsearch = require('./operations/flexsearch');
const scripting = require('./operations/scripting');

/** @typedef {'HAC_HOST'|'HAC_USER'|'HAC_PASSWORD'|'HYBRIS_VERSION'} LegacyField */
/** @type {readonly LegacyField[]} */
const FIELDS = ['HAC_HOST', 'HAC_USER', 'HAC_PASSWORD', 'HYBRIS_VERSION'];

/** @type {HacClient|null} */
let defaultClient = null;
/** @type {Record<string, unknown>} Module-private; holds the password, never exported or logged. */
let snapshot = {};

/** Retires the current default client (if any). */
function replaceDefaultClient() {
  const old = defaultClient;
  defaultClient = null;
  if (old) old[RETIRE]();
}

/**
 * Returns the default client, replacing it when the legacy config changed.
 * @returns {HacClient}
 * @throws {import('./core/errors').HacConfigError}
 */
function getDefaultClient() {
  const legacyConfig = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (config));
  if (defaultClient && FIELDS.some((field) => !Object.is(snapshot[field], legacyConfig[field]))) {
    replaceDefaultClient();
  }
  if (!defaultClient) {
    const next = Object.fromEntries(FIELDS.map((field) => [field, legacyConfig[field]]));
    defaultClient = new HacClient(fromLegacyConfig(next));
    snapshot = next;
  }
  return defaultClient;
}

/**
 * Overrides the configuration of the default client. Each argument is
 * applied only when truthy. Returns the module exports object.
 *
 * @param {string} [host]
 * @param {string} [user]
 * @param {string} [password]
 * @param {string|number} [hybrisVersion]
 * @returns {Record<string, unknown>}
 */
function configure(host, user, password, hybrisVersion) {
  updateConfig(host, user, password, hybrisVersion);
  return require('../index');
}

/**
 * Imports an ImpEx script. Resolves (to undefined) only after HAC reported
 * success; rejects with a HacError otherwise.
 * @param {string} script
 * @returns {Promise<void>}
 */
async function impexImport(script) {
  await getDefaultClient().importImpex(script);
}

/**
 * Runs a FlexibleSearch query and resolves the first row (legacy shape).
 * @param {string} query
 * @returns {Promise<Record<string, string>>}
 */
async function flexibleSearch(query) {
  const json = await getDefaultClient()[EXECUTE]((session) => flexsearch.runRaw(session, query));
  try {
    return flexsearch.toLegacyRow(json, query);
  } catch (err) {
    if (err && typeof err === 'object') /** @type {any} */ (err).operation = flexsearch.OPERATION;
    throw err;
  }
}

/**
 * Executes a script and resolves the raw HAC JSON.
 * @param {string} script
 * @param {string|boolean} [commit] sent as String(commit); default "true".
 * @param {string} [scriptType] default "groovy".
 * @returns {Promise<Record<string, any>>}
 */
async function executeScript(script, commit = 'true', scriptType = 'groovy') {
  return getDefaultClient()[EXECUTE]((session) =>
    scripting.runRaw(session, script, { commit, scriptType }, { legacy: true }),
  );
}

/**
 * Logs the default client in (reuses an existing session). Resolves undefined.
 * @returns {Promise<void>}
 */
async function login() {
  await getDefaultClient().login();
}

module.exports = {
  configure,
  impexImport,
  flexibleSearch,
  executeScript,
  login,
  getDefaultClient,
  replaceDefaultClient,
};
