'use strict';

/**
 * Structured, allow-listed logging. Silent by default.
 *
 * Only the fields listed in {@link ALLOWED_FIELDS} are ever passed to a
 * logger, so bodies, scripts, queries, headers, cookies, tokens and
 * credentials cannot be logged by accident.
 */

const PREFIX = '[hybris-hac-api]';
const ALLOWED_FIELDS = Object.freeze([
  'operation',
  'method',
  'path',
  'status',
  'durationMs',
  'attempt',
  'reason',
  'proxy',
  'variable',
]);

/**
 * @typedef {Partial<Record<'debug'|'info'|'warn'|'error', (...args: any[]) => void>>} LoggerLike
 * @typedef {Record<string, string|number|boolean|null|undefined>} LogFields
 * @typedef {{ debug(event: string, fields?: LogFields): void, info(event: string, fields?: LogFields): void, warn(event: string, fields?: LogFields): void }} HacLogger
 */

/**
 * @param {LogFields} [fields]
 * @returns {Record<string, string|number|boolean|null>}
 */
function pickFields(fields) {
  /** @type {Record<string, string|number|boolean|null>} */
  const out = {};
  if (!fields) return out;
  for (const key of ALLOWED_FIELDS) {
    const value = fields[key];
    if (value === undefined) continue;
    out[key] = typeof value === 'number' || typeof value === 'boolean' || value === null ? value : String(value);
  }
  return out;
}

/**
 * Creates the internal logger.
 *
 * @param {{ logger?: LoggerLike|null, debug?: boolean }} [options]
 *   `logger`: injected logger (e.g. console, pino). `debug`: when no logger
 *   is injected, print events with `console.debug`.
 * @returns {HacLogger}
 */
function createLogger({ logger, debug } = {}) {
  /**
   * @param {'debug'|'info'|'warn'} level
   * @param {string} event
   * @param {LogFields} [fields]
   */
  function emit(level, event, fields) {
    try {
      const safe = pickFields(fields);
      if (logger) {
        const fn = logger[level];
        if (typeof fn === 'function') fn.call(logger, `${PREFIX} ${event}`, safe);
        return;
      }
      if (debug) console.debug(PREFIX, event, JSON.stringify(safe));
    } catch {
      // A broken logger must never break a call.
    }
  }
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
  };
}

module.exports = { createLogger, ALLOWED_FIELDS };
