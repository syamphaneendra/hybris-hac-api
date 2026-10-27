'use strict';

/**
 * Secret removal for any text that may end up in an error message or log.
 */

const MASK = '***';
const MIN_SECRET_LENGTH = 3;

/**
 * Builds the list of literal secret spellings to mask, longest first.
 * Each secret is masked as typed, as `encodeURIComponent` produces it and as
 * `URLSearchParams` (form encoding) produces it.
 *
 * @param {{ password?: string|null, proxyPassword?: string|null }} [secrets]
 * @returns {string[]}
 */
function buildSecrets({ password, proxyPassword } = {}) {
  const spellings = new Set();
  for (const secret of [password, proxyPassword]) {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) continue;
    spellings.add(secret);
    spellings.add(encodeURIComponent(secret));
    spellings.add(new URLSearchParams({ p: secret }).toString().slice(2));
  }
  return [...spellings].sort((a, b) => b.length - a.length);
}

/** Pattern-based masks applied after the literal secrets. */
const PATTERNS = [
  [/(j_password=)[^&\s"'<>]*/gi, `$1${MASK}`],
  [/(JSESSIONID=)[^;\s"'<>&]*/gi, `$1${MASK}`],
  [/(_csrf=)[^&\s"'<>;]*/gi, `$1${MASK}`],
  [/(<meta\b[^>]*\bname\s*=\s*["']?_csrf["']?[^>]*\bcontent\s*=\s*["'])[^"']*/gi, `$1${MASK}`],
  [/(<meta\b[^>]*\bcontent\s*=\s*["'])[^"']*(["'][^>]*\bname\s*=\s*["']?_csrf\b)/gi, `$1${MASK}$2`],
  [/(<input\b[^>]*\bname\s*=\s*["']?_csrf["']?[^>]*\bvalue\s*=\s*["'])[^"']*/gi, `$1${MASK}`],
  [/(X-CSRF-TOKEN\s*:\s*)[^\s,;]+/gi, `$1${MASK}`],
  [/(Proxy-Authorization\s*:\s*)[^\r\n]+/gi, `$1${MASK}`],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi, `$1${MASK}@`],
];

/**
 * Replaces secrets, session cookies, CSRF tokens and URL userinfo with `***`.
 *
 * @param {unknown} text
 * @param {readonly string[]} [secrets] Output of {@link buildSecrets}.
 * @returns {string}
 */
function redact(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(MASK);
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(/** @type {RegExp} */ (pattern), /** @type {string} */ (replacement));
  }
  return out;
}

module.exports = { buildSecrets, redact, MASK };
