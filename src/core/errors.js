'use strict';

/**
 * Error hierarchy for hybris-hac-api.
 *
 * Every failure the library reports is a {@link HacError} subclass with a
 * stable `code`. Constructors only accept scalar fields plus an optional
 * `cause` (a Node system error or another HacError): request and response
 * objects, bodies, headers and cookies never reach an error instance.
 */

/** Fields shared by every HacError (all optional). */
const BASE_FIELDS = Object.freeze(['operation', 'method', 'path', 'status', 'attempts']);

/**
 * @typedef {object} HacErrorDetails
 * @property {string} [code] Overrides the class code (base classes only).
 * @property {string} [operation] 'login' | 'csrf' | 'impexImport' | 'search' | 'runScript'.
 * @property {string} [method] HTTP method, e.g. 'POST'.
 * @property {string} [path] Request path only (no host, no query string).
 * @property {number} [status] HTTP status, when there is one.
 * @property {number} [attempts] Number of sends of the operation request.
 * @property {unknown} [cause] Underlying Node system error or HacError.
 * @property {string} [variable] HacConfigError: offending option or env var name.
 * @property {string} [argument] HacInputError: offending argument name.
 * @property {string} [networkCode] HacTransportError: e.g. 'ECONNRESET'.
 * @property {'connect'|'response'} [phase] HacTimeoutError/HacHttpError phase.
 * @property {number} [timeoutMs] HacTimeoutError: the deadline that expired.
 * @property {string} [bodyExcerpt] Sanitised excerpt of the response body.
 * @property {string} [redirectOrigin] Cross-origin redirect target (origin only).
 * @property {string} [reason] HacAuthError: redacted login error text.
 * @property {string|null} [level] HacImpexError: HAC result level.
 * @property {string} [result] HacImpexError: redacted HAC result text.
 * @property {string} [stacktrace] HacScriptError: HAC stacktraceText.
 * @property {unknown} [output] HacScriptError: HAC outputText.
 * @property {string} [hacMessage] HacFlexibleSearchError: HAC exception message.
 * @property {string} [query] HacNoResultsError: the query that returned no rows.
 */

/** Base class of every error raised by this package. */
class HacError extends Error {
  /** @type {string} */
  static code = 'HAC_ERROR';
  /** @type {readonly string[]} */
  static extraFields = [];

  /**
   * @param {string} message
   * @param {HacErrorDetails} [details]
   */
  constructor(message, details = {}) {
    const { cause, ...rest } = details;
    super(message, cause === undefined ? undefined : { cause });
    const ctor = /** @type {typeof HacError} */ (new.target);
    /** @type {string} */
    this.name = ctor.name;
    /** @type {string} */
    this.code = rest.code || ctor.code;
    /** @type {string|undefined} */
    this.operation = undefined;
    /** @type {string|undefined} */
    this.method = undefined;
    /** @type {string|undefined} */
    this.path = undefined;
    /** @type {number|undefined} */
    this.status = undefined;
    /** @type {number|undefined} */
    this.attempts = undefined;
    const target = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (this));
    const source = /** @type {Record<string, unknown>} */ (rest);
    for (const key of [...BASE_FIELDS, ...ctor.extraFields]) {
      if (source[key] !== undefined) target[key] = source[key];
      else if (target[key] === undefined) delete target[key];
    }
  }

  /**
   * Safe serialisation: never includes `cause` or the stack.
   * @returns {Record<string, unknown>}
   */
  toJSON() {
    const ctor = /** @type {typeof HacError} */ (this.constructor);
    const self = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (this));
    /** @type {Record<string, unknown>} */
    const out = { name: this.name, code: this.code, message: this.message };
    for (const key of [...BASE_FIELDS, ...ctor.extraFields]) {
      if (self[key] !== undefined) out[key] = self[key];
    }
    return out;
  }
}

/** Invalid or missing configuration. Thrown synchronously by createHacClient. */
class HacConfigError extends HacError {
  static code = 'HAC_CONFIG';
  static extraFields = ['variable'];
}

/** Invalid script/query/option passed to an operation. No request is sent. */
class HacInputError extends HacError {
  static code = 'HAC_INVALID_INPUT';
  static extraFields = ['argument'];
}

/** Socket, DNS or TLS failure. */
class HacTransportError extends HacError {
  static code = 'HAC_TRANSPORT';
  static extraFields = ['networkCode'];
}

/** Connect or overall request deadline exceeded. */
class HacTimeoutError extends HacTransportError {
  static code = 'HAC_TIMEOUT';
  static extraFields = ['networkCode', 'phase', 'timeoutMs'];
}

/** Unexpected HTTP status or redirect. */
class HacHttpError extends HacError {
  static code = 'HAC_HTTP_STATUS';
  static extraFields = ['bodyExcerpt', 'redirectOrigin', 'phase'];
}

/** HAC rejected the login. */
class HacAuthError extends HacError {
  static code = 'HAC_AUTH';
  static extraFields = ['reason'];
}

/** Still redirected to the login page after one re-login and replay. */
class HacSessionExpiredError extends HacError {
  static code = 'HAC_SESSION_EXPIRED';
}

/** No CSRF token found, or 403 again after one token refresh. */
class HacCsrfError extends HacError {
  static code = 'HAC_CSRF';
}

/** Response body could not be parsed or has an unknown shape. */
class HacResponseError extends HacError {
  static code = 'HAC_UNEXPECTED_RESPONSE';
  static extraFields = ['bodyExcerpt'];
}

/** Base class of failures that HAC itself reported. */
class HacReportedError extends HacError {
  static code = 'HAC_REPORTED';
}

/** HAC reported that the ImpEx import failed. */
class HacImpexError extends HacReportedError {
  static code = 'HAC_IMPEX_FAILED';
  static extraFields = ['level', 'result'];
}

/** HAC returned a non-empty stacktrace for a script. */
class HacScriptError extends HacReportedError {
  static code = 'HAC_SCRIPT_FAILED';
  static extraFields = ['stacktrace', 'output'];
}

/** HAC returned an exception for a FlexibleSearch query. */
class HacFlexibleSearchError extends HacReportedError {
  static code = 'HAC_FLEXSEARCH_FAILED';
  static extraFields = ['hacMessage'];
}

/** Legacy flexibleSearch only: the query returned zero rows. */
class HacNoResultsError extends HacError {
  static code = 'HAC_NO_RESULTS';
  static extraFields = ['query'];
}

/** A call on a client that was closed or retired. */
class HacClientClosedError extends HacError {
  static code = 'HAC_CLIENT_CLOSED';
}

/** Every concrete error code, keyed by class name. */
const ERROR_CODES = Object.freeze({
  HacConfigError: HacConfigError.code,
  HacInputError: HacInputError.code,
  HacTransportError: HacTransportError.code,
  HacTimeoutError: HacTimeoutError.code,
  HacHttpError: HacHttpError.code,
  HacAuthError: HacAuthError.code,
  HacSessionExpiredError: HacSessionExpiredError.code,
  HacCsrfError: HacCsrfError.code,
  HacResponseError: HacResponseError.code,
  HacImpexError: HacImpexError.code,
  HacScriptError: HacScriptError.code,
  HacFlexibleSearchError: HacFlexibleSearchError.code,
  HacNoResultsError: HacNoResultsError.code,
  HacClientClosedError: HacClientClosedError.code,
});

/**
 * Stamps `attempts` (and `operation` when missing) on a HacError.
 * @template {unknown} T
 * @param {T} err
 * @param {number} attempts
 * @param {string} [operation]
 * @returns {T}
 */
function withAttempts(err, attempts, operation) {
  if (err instanceof HacError) {
    err.attempts = attempts;
    if (operation && !err.operation) err.operation = operation;
  }
  return err;
}

module.exports = {
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
  ERROR_CODES,
  withAttempts,
};
