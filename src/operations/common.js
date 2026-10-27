'use strict';

/**
 * Input validation helpers shared by the operation modules. Validation runs
 * before any network I/O and throws HacInputError.
 */

const { HacInputError } = require('../core/errors');

/**
 * @param {unknown} value
 * @param {string} argument
 * @returns {string}
 */
function requireText(value, argument) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HacInputError(`${argument} must be a non-empty string`, { argument });
  }
  return value;
}

/**
 * @param {unknown} options
 * @returns {Record<string, any>}
 */
function requireOptions(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object') {
    throw new HacInputError('options must be an object', { argument: 'options' });
  }
  return /** @type {Record<string, any>} */ (options);
}

/**
 * @param {Record<string, any>} options
 * @param {string} key
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function optionalInteger(options, key, min, max, fallback) {
  const value = options[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HacInputError(`${key} must be an integer between ${min} and ${max}`, { argument: key });
  }
  return value;
}

/**
 * @param {Record<string, any>} options
 * @param {string} key
 * @returns {boolean|undefined}
 */
function optionalBoolean(options, key) {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new HacInputError(`${key} must be a boolean`, { argument: key });
  return value;
}

/**
 * @param {Record<string, any>} options
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function optionalText(options, key, fallback) {
  const value = options[key];
  if (value === undefined) return fallback;
  return requireText(value, key);
}

/**
 * Validates the options every operation accepts.
 * @param {Record<string, any>} options
 * @returns {import('../session/session').CallOptions}
 */
function callOptions(options) {
  /** @type {import('../session/session').CallOptions} */
  const out = {};
  if (options.timeoutMs !== undefined) out.timeoutMs = optionalInteger(options, 'timeoutMs', 1, 86400000, 0);
  const retry = optionalBoolean(options, 'retryOnTransientError');
  if (retry !== undefined) out.retryOnTransientError = retry;
  return out;
}

module.exports = { requireText, requireOptions, optionalInteger, optionalBoolean, optionalText, callOptions };
