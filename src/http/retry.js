'use strict';

/**
 * Pure retry helpers. There is no loop here: the only retry loops are the
 * per-call budget in `session.request()` and the login restart in `auth.js`.
 *
 * Deliberate deviation from "never retry unsafe requests": a connect-phase
 * failure (the socket never connected, so no request byte was sent) is
 * retryable for every operation, including ImpEx and scripts, unless the
 * caller opts out with `retryOnTransientError: false` or `retries: 0`.
 */

const { HacHttpError, HacTimeoutError, HacTransportError } = require('../core/errors');

/** Network codes that are transient when the socket never connected. */
const CONNECT_PHASE_CODES = new Set(['ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH']);
/** Network codes that are transient once the request may have been sent. */
const MIDFLIGHT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED']);
const GATEWAY_STATUSES = new Set([502, 503, 504]);
const MAX_RETRY_AFTER_SECONDS = 5;

/**
 * @typedef {'connect'|'midflight'|'gateway'|'permanent'} FailureKind
 * @typedef {'none'|'connect-only'|'full'} RetryMode
 */

/**
 * Classifies a failure for the retry decision.
 * @param {unknown} err
 * @returns {FailureKind}
 */
function classify(err) {
  const fields = /** @type {{ phase?: string, networkCode?: string, connectPhase?: boolean }} */ (err || {});
  if (err instanceof HacTimeoutError) return fields.phase === 'connect' ? 'connect' : 'permanent';
  if (err instanceof HacTransportError) {
    const code = fields.networkCode || '';
    if (fields.connectPhase) return CONNECT_PHASE_CODES.has(code) ? 'connect' : 'permanent';
    return MIDFLIGHT_CODES.has(code) ? 'midflight' : 'permanent';
  }
  if (err instanceof HacHttpError) {
    if (fields.phase === 'connect') return 'permanent';
    return err.status !== undefined && GATEWAY_STATUSES.has(err.status) ? 'gateway' : 'permanent';
  }
  return 'permanent';
}

/**
 * Which transient failures may be retried (at most once) for one call.
 * @param {{ clientRetries: number, perCall?: boolean, safe: boolean }} input
 * @returns {RetryMode}
 */
function effectiveTransientBudget({ clientRetries, perCall, safe }) {
  if (clientRetries === 0) return 'none'; // retries: 0 always wins, even over perCall: true
  if (perCall === false) return 'none'; // explicit opt-out, connect-phase included
  if (!safe && perCall !== true) return 'connect-only'; // unsafe default: only "never sent"
  return 'full';
}

/**
 * @param {FailureKind} kind
 * @param {RetryMode} mode
 * @returns {boolean}
 */
function qualifies(kind, mode) {
  if (kind === 'permanent' || mode === 'none') return false;
  if (mode === 'connect-only') return kind === 'connect';
  return true;
}

/**
 * Backoff before a retry: `retryDelayMs + random(0, retryDelayMs / 2)`, or a
 * numeric `Retry-After` of at most 5 seconds when given.
 * @param {{ retryDelayMs: number, retryAfter?: string|null, random?: () => number }} input
 * @returns {number}
 */
function backoffMs({ retryDelayMs, retryAfter, random = Math.random }) {
  if (retryAfter !== undefined && retryAfter !== null && /^\s*\d+\s*$/.test(String(retryAfter))) {
    const seconds = Number(retryAfter);
    if (seconds <= MAX_RETRY_AFTER_SECONDS) return seconds * 1000;
  }
  return retryDelayMs + Math.floor(random() * (retryDelayMs / 2));
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { classify, effectiveTransientBudget, qualifies, backoffMs, defaultSleep, GATEWAY_STATUSES };
