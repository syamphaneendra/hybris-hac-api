'use strict';

/**
 * Script execution: POST {ctx}/console/scripting/execute, or
 * {ctx}/console/<scriptType>/execute for Hybris versions below 5.7 (JSON).
 * Unsafe (scripts can have side effects): only connect-phase failures are
 * retried by default.
 */

const { HacInputError, HacResponseError, HacScriptError } = require('../core/errors');
const { redact } = require('../core/redact');
const { excerpt } = require('../parse/html');
const { parseConsoleJson } = require('../parse/json');
const { SESSION_EXPIRED } = require('../session/session');
const { callOptions, optionalText, requireOptions, requireText } = require('./common');

const OPERATION = 'runScript';
const SCRIPT_TYPE_PATTERN = /^[A-Za-z]+$/;

/**
 * @typedef {object} ScriptResult
 * @property {string} output HAC outputText.
 * @property {unknown} result HAC executionResult.
 * @property {Record<string, unknown>} raw Full HAC JSON.
 */

/**
 * @param {unknown} script
 * @param {unknown} rawOptions
 * @param {{ legacy?: boolean }} [mode] legacy: `commit` may be any value (sent as String(commit)).
 * @returns {{ script: string, scriptType: string, commit: string, call: import('../session/session').CallOptions }}
 */
function validate(script, rawOptions, { legacy = false } = {}) {
  const text = requireText(script, 'script');
  const options = requireOptions(rawOptions);
  const scriptType = optionalText(options, 'scriptType', 'groovy');
  if (!SCRIPT_TYPE_PATTERN.test(scriptType)) {
    throw new HacInputError('scriptType must contain letters only (e.g. "groovy")', { argument: 'scriptType' });
  }
  let commit;
  if (legacy) {
    commit = options.commit === undefined ? 'true' : String(options.commit);
  } else {
    if (options.commit !== undefined && typeof options.commit !== 'boolean') {
      throw new HacInputError('commit must be a boolean', { argument: 'commit' });
    }
    commit = options.commit === false ? 'false' : 'true';
  }
  return { script: text, scriptType, commit, call: callOptions(options) };
}

/**
 * @param {boolean} legacyScripting resolved flag (Hybris version below 5.7)
 * @param {string} scriptType
 * @returns {string}
 */
function subPathFor(legacyScripting, scriptType) {
  return legacyScripting ? `/console/${scriptType}/execute` : '/console/scripting/execute';
}

/**
 * Exactly script, scriptType, commit (header-only CSRF), on both endpoints.
 * @param {{ script: string, scriptType: string, commit: string }} input
 * @returns {import('../http/form').FormFields}
 */
function buildFields({ script, scriptType, commit }) {
  return [
    ['script', script],
    ['scriptType', scriptType],
    ['commit', commit],
  ];
}

/**
 * stacktraceText: '' → success; non-empty string, null or other → HacScriptError
 * (legacy message); missing → HacResponseError.
 * @param {import('../http/transport').TransportResponse} response
 * @param {{ basePath: string, secrets: readonly string[] }} context
 * @returns {Record<string, unknown> | typeof SESSION_EXPIRED}
 */
function interpret(response, { basePath, secrets }) {
  const parsed = parseConsoleJson({
    body: response.body,
    contentType: String(response.headers['content-type'] || ''),
    basePath,
  });
  if (parsed.kind === 'login') return SESSION_EXPIRED;
  if (parsed.kind === 'invalid' || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    throw new HacResponseError('unexpected scripting response (not a JSON object)', {
      status: response.status,
      bodyExcerpt: excerpt(response.body, secrets, 500),
    });
  }
  const json = /** @type {Record<string, unknown>} */ (parsed.value);
  const stacktrace = json.stacktraceText;
  if (stacktrace === '') return json;
  if (stacktrace === undefined) {
    throw new HacResponseError('unexpected scripting response (missing stacktraceText)', { status: response.status });
  }
  const text = redact(String(stacktrace), secrets);
  throw new HacScriptError(`HAC Script error occurred:\n ${text}`, {
    stacktrace: text,
    output: typeof json.outputText === 'string' ? redact(json.outputText, secrets) : json.outputText,
    status: response.status,
  });
}

/**
 * Runs a script and returns the raw HAC JSON.
 * @param {import('../session/session').HacSession} session
 * @param {unknown} script
 * @param {unknown} [options]
 * @param {{ legacy?: boolean }} [mode]
 * @returns {Promise<Record<string, unknown>>}
 */
async function runRaw(session, script, options, mode = {}) {
  const input = validate(script, options, mode);
  const { basePath, legacyScripting } = session.ctx.resolved;
  const secrets = session.ctx.secrets;
  return session.request({
    operation: OPERATION,
    safe: false,
    subPath: subPathFor(legacyScripting, input.scriptType),
    fields: () => buildFields(input),
    interpret: (response) => interpret(response, { basePath, secrets }),
    callOptions: input.call,
  });
}

/**
 * @param {import('../session/session').HacSession} session
 * @param {unknown} script
 * @param {unknown} [options]
 * @returns {Promise<ScriptResult>}
 */
async function run(session, script, options) {
  const raw = await runRaw(session, script, options);
  const output = raw.outputText;
  return { output: typeof output === 'string' ? output : output == null ? '' : String(output), result: raw.executionResult, raw };
}

module.exports = { run, runRaw, validate, buildFields, interpret, subPathFor, OPERATION };
