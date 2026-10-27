'use strict';

/**
 * Safe JSON parsing for HAC console endpoints (FlexibleSearch, scripting).
 */

const { isLoginPage } = require('./html');

/**
 * @typedef {{ kind: 'json', value: unknown } | { kind: 'login' } | { kind: 'invalid' }} ConsoleJson
 */

/**
 * Classifies a console response body as JSON, a login page (expired
 * session) or something invalid. JSON is tried first, so a JSON payload that
 * happens to contain login-like text is still JSON.
 *
 * @param {{ body: string, contentType?: string, basePath?: string }} input
 * @returns {ConsoleJson}
 */
function parseConsoleJson({ body, contentType = '', basePath = '' }) {
  const text = String(body || '');
  const trimmed = text.trim();
  const looksJson = /json/i.test(contentType) || trimmed.startsWith('{') || trimmed.startsWith('[');
  if (looksJson) {
    try {
      return { kind: 'json', value: JSON.parse(trimmed) };
    } catch {
      // fall through
    }
  }
  if (isLoginPage({ basePath, body: text })) return { kind: 'login' };
  return { kind: 'invalid' };
}

module.exports = { parseConsoleJson };
