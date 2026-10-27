'use strict';

/**
 * ImpEx import: POST {ctx}/console/impex/import (HTML result page).
 * Unsafe (not idempotent): only connect-phase failures are retried by default.
 */

const { HacImpexError, HacInputError, HacResponseError } = require('../core/errors');
const { excerpt, parseImpexResult } = require('../parse/html');
const { SESSION_EXPIRED } = require('../session/session');
const { callOptions, optionalBoolean, optionalInteger, optionalText, requireOptions, requireText } = require('./common');

const OPERATION = 'impexImport';
const SUB_PATH = '/console/impex/import';
const VALIDATION_MODES = new Set(['IMPORT_STRICT', 'IMPORT_RELAXED']);

/**
 * @typedef {object} ImpexResult
 * @property {true} success
 * @property {string|null} level HAC result level ('notice', 'info', …) or null.
 * @property {string} message HAC result text.
 */

/**
 * @typedef {object} ImpexSettings
 * @property {string} validationMode
 * @property {number} maxThreads
 * @property {string} encoding
 * @property {boolean} legacyMode
 * @property {boolean} enableCodeExecution
 * @property {import('../session/session').CallOptions} call
 */

/**
 * Validates the script and options (before any I/O).
 * @param {unknown} script
 * @param {unknown} rawOptions
 * @returns {{ script: string, settings: ImpexSettings }}
 */
function validate(script, rawOptions) {
  const text = requireText(script, 'script');
  const options = requireOptions(rawOptions);
  const validationMode = optionalText(options, 'validationMode', 'IMPORT_STRICT');
  if (!VALIDATION_MODES.has(validationMode)) {
    throw new HacInputError('validationMode must be IMPORT_STRICT or IMPORT_RELAXED', { argument: 'validationMode' });
  }
  return {
    script: text,
    settings: {
      validationMode,
      maxThreads: optionalInteger(options, 'maxThreads', 1, 64, 16),
      encoding: optionalText(options, 'encoding', 'UTF-8'),
      legacyMode: optionalBoolean(options, 'legacyMode') === true,
      enableCodeExecution: optionalBoolean(options, 'enableCodeExecution') === true,
      call: callOptions(options),
    },
  };
}

/**
 * Form fields in the pinned order. With default settings this is exactly the
 * legacy form: scriptContent, validationEnum, maxThreads, encoding,
 * _legacyMode=on, _enableCodeExecution=on, _csrf.
 *
 * @param {string} script
 * @param {ImpexSettings} settings
 * @param {string} csrfToken
 * @returns {import('../http/form').FormFields}
 */
function buildFields(script, settings, csrfToken) {
  /** @type {import('../http/form').FormFields} */
  const fields = [
    ['scriptContent', script],
    ['validationEnum', settings.validationMode],
    ['maxThreads', String(settings.maxThreads)],
    ['encoding', settings.encoding],
  ];
  if (settings.legacyMode) fields.push(['legacyMode', 'true']);
  fields.push(['_legacyMode', 'on']);
  if (settings.enableCodeExecution) fields.push(['enableCodeExecution', 'true']);
  fields.push(['_enableCodeExecution', 'on']);
  fields.push(['_csrf', csrfToken]);
  return fields;
}

/**
 * Interprets the ImpEx result page.
 * @param {import('../http/transport').TransportResponse} response
 * @param {{ basePath: string, secrets: readonly string[] }} context
 * @returns {ImpexResult | typeof SESSION_EXPIRED}
 */
function interpret(response, { basePath, secrets }) {
  const parsed = parseImpexResult(response.body, { basePath, secrets });
  if (parsed.kind === 'login') return SESSION_EXPIRED;
  if (parsed.kind === 'success') return { success: true, level: parsed.level, message: parsed.message };
  if (parsed.kind === 'failure') {
    return failWith(
      new HacImpexError(`Impex import failed (level=${parsed.level}):\n${parsed.message}`, {
        level: parsed.level,
        result: parsed.message,
        status: response.status,
      }),
    );
  }
  return failWith(
    new HacResponseError('unrecognised ImpEx response', {
      status: response.status,
      bodyExcerpt: excerpt(response.body, secrets, 500),
    }),
  );
}

/**
 * @param {Error} err
 * @returns {never}
 */
function failWith(err) {
  throw err;
}

/**
 * Runs an ImpEx import on a session.
 * @param {import('../session/session').HacSession} session
 * @param {unknown} script
 * @param {unknown} [options]
 * @returns {Promise<ImpexResult>}
 */
async function run(session, script, options) {
  const input = validate(script, options);
  const { basePath } = session.ctx.resolved;
  const secrets = session.ctx.secrets;
  return session.request({
    operation: OPERATION,
    safe: false,
    subPath: SUB_PATH,
    fields: (token) => buildFields(input.script, input.settings, token),
    interpret: (response) => interpret(response, { basePath, secrets }),
    callOptions: input.settings.call,
  });
}

module.exports = { run, validate, buildFields, interpret, OPERATION, SUB_PATH };
