'use strict';

/**
 * FlexibleSearch: POST {ctx}/console/flexsearch/execute (JSON).
 * Safe (read-only; sqlQuery is always empty): full single transient retry.
 */

const he = require('he');
const { HacFlexibleSearchError, HacNoResultsError, HacResponseError } = require('../core/errors');
const { redact } = require('../core/redact');
const { excerpt } = require('../parse/html');
const { parseConsoleJson } = require('../parse/json');
const { SESSION_EXPIRED } = require('../session/session');
const { callOptions, optionalInteger, optionalText, requireOptions, requireText } = require('./common');

const OPERATION = 'search';
const SUB_PATH = '/console/flexsearch/execute';

/**
 * Raw HAC FlexibleSearch JSON (relevant fields only).
 * @typedef {{ headers: unknown[], resultList: unknown[][], exception?: unknown, [key: string]: unknown }} FlexSearchJson
 */

/**
 * @typedef {object} SearchResult
 * @property {string[]} headers Column headers as HAC returns them (e.g. 'p_code').
 * @property {string[]} columns Unique column names (leading 'p_' removed unless that collides).
 * @property {Array<Record<string, string|null>>} rows Rows keyed by `columns`; values he-decoded, nulls kept.
 * @property {number} rowCount
 */

/**
 * @param {unknown} query
 * @param {unknown} rawOptions
 */
function validate(query, rawOptions) {
  const text = requireText(query, 'query');
  const options = requireOptions(rawOptions);
  return {
    query: text,
    settings: {
      maxCount: optionalInteger(options, 'maxCount', 1, 100000, 200),
      user: optionalText(options, 'user', 'admin'),
      locale: optionalText(options, 'locale', 'en'),
      call: callOptions(options),
    },
  };
}

/**
 * Legacy-identical form fields (header-only CSRF).
 * @param {string} query
 * @param {{ maxCount: number, user: string, locale: string }} settings
 * @returns {import('../http/form').FormFields}
 */
function buildFields(query, settings) {
  return [
    ['flexibleSearchQuery', query],
    ['sqlQuery', ''],
    ['maxCount', String(settings.maxCount)],
    ['user', settings.user],
    ['locale', settings.locale],
    ['commit', 'false'],
  ];
}

/**
 * @param {unknown} exception
 * @returns {string}
 */
function exceptionMessage(exception) {
  if (typeof exception === 'string') return exception;
  if (exception && typeof exception === 'object') {
    const message = /** @type {Record<string, unknown>} */ (exception).message;
    if (typeof message === 'string' && message) return message;
    try {
      return JSON.stringify(exception);
    } catch {
      return String(exception);
    }
  }
  return String(exception);
}

/**
 * Validates the JSON shape and HAC-reported exceptions.
 * @param {import('../http/transport').TransportResponse} response
 * @param {{ basePath: string, secrets: readonly string[] }} context
 * @returns {FlexSearchJson | typeof SESSION_EXPIRED}
 */
function interpret(response, { basePath, secrets }) {
  const parsed = parseConsoleJson({
    body: response.body,
    contentType: String(response.headers['content-type'] || ''),
    basePath,
  });
  if (parsed.kind === 'login') return SESSION_EXPIRED;
  if (parsed.kind === 'invalid' || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    throw new HacResponseError('unexpected FlexibleSearch response (not a JSON object)', {
      status: response.status,
      bodyExcerpt: excerpt(response.body, secrets, 500),
    });
  }
  const json = /** @type {Record<string, unknown>} */ (parsed.value);
  if (json.exception !== null && json.exception !== undefined) {
    const hacMessage = redact(exceptionMessage(json.exception), secrets).slice(0, 2000);
    throw new HacFlexibleSearchError(`HAC Flexible Search failed: ${hacMessage}`, { hacMessage, status: response.status });
  }
  if (!Array.isArray(json.headers) || !Array.isArray(json.resultList)) {
    throw new HacResponseError('unexpected FlexibleSearch response (missing headers or resultList)', {
      status: response.status,
    });
  }
  return /** @type {FlexSearchJson} */ (json);
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function decodeCell(value) {
  if (value === null || value === undefined) return null;
  return he.decode(String(value));
}

/**
 * Unique column names (design §4.2):
 * 1. strip a leading 'p_';
 * 2. on a collision, the colliding headers keep their original name;
 * 3. identical raw headers get '#2', '#3', … appended.
 * @param {unknown[]} headers
 * @returns {string[]}
 */
function columnNames(headers) {
  const raw = headers.map((h) => String(h));
  const candidates = raw.map((h) => h.replace(/^p_/, ''));
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const c of candidates) counts.set(c, (counts.get(c) || 0) + 1);
  const names = raw.map((h, i) => ((counts.get(candidates[i]) || 0) > 1 ? h : candidates[i]));
  /** @type {Map<string, number>} */
  const seen = new Map();
  return names.map((name) => {
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name}#${n}`;
  });
}

/**
 * @param {FlexSearchJson} json
 * @returns {SearchResult}
 */
function toSearchResult(json) {
  const headers = json.headers.map((h) => String(h));
  const columns = columnNames(headers);
  const rows = json.resultList.map((row) => {
    /** @type {Record<string, string|null>} */
    const record = {};
    columns.forEach((column, i) => {
      record[column] = decodeCell(Array.isArray(row) ? row[i] : undefined);
    });
    return record;
  });
  return { headers, columns, rows, rowCount: rows.length };
}

/**
 * Legacy `flexibleSearch` shape: first row only, keys with the first 'p_'
 * removed (String#replace, as before), null → '', values he-decoded,
 * last key wins.
 * @param {FlexSearchJson} json
 * @param {string} query
 * @returns {Record<string, string>}
 */
function toLegacyRow(json, query) {
  if (json.resultList.length === 0) {
    throw new HacNoResultsError(`HAC Flexible Search returned 0 results:\n${query}`, { query });
  }
  /** @type {Record<string, string>} */
  const result = {};
  const row = Array.isArray(json.resultList[0]) ? json.resultList[0] : [];
  json.headers.forEach((key, i) => {
    result[String(key).replace('p_', '')] = row[i] == null ? '' : he.decode(String(row[i]));
  });
  return result;
}

/**
 * Runs a query and returns the validated raw JSON.
 * @param {import('../session/session').HacSession} session
 * @param {unknown} query
 * @param {unknown} [options]
 * @returns {Promise<FlexSearchJson>}
 */
async function runRaw(session, query, options) {
  const input = validate(query, options);
  const { basePath } = session.ctx.resolved;
  const secrets = session.ctx.secrets;
  return session.request({
    operation: OPERATION,
    safe: true,
    subPath: SUB_PATH,
    fields: () => buildFields(input.query, input.settings),
    interpret: (response) => interpret(response, { basePath, secrets }),
    callOptions: input.settings.call,
  });
}

/**
 * @param {import('../session/session').HacSession} session
 * @param {unknown} query
 * @param {unknown} [options]
 * @returns {Promise<SearchResult>}
 */
async function run(session, query, options) {
  return toSearchResult(await runRaw(session, query, options));
}

module.exports = { run, runRaw, validate, buildFields, interpret, toSearchResult, toLegacyRow, columnNames, OPERATION, SUB_PATH };
