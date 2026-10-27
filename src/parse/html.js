'use strict';

/**
 * Tolerant HTML helpers for HAC console pages. HAC has no API contract, so
 * every extractor is best-effort and fails closed (unknown → error).
 */

const he = require('he');
const { redact } = require('../core/redact');

const SUCCESS_TEXT = 'Import finished successfully';
const SUCCESS_LEVELS = new Set(['notice', 'info', 'success']);
const LOGIN_PATH_PATTERN = /(^|\/)login(\.jsp)?$/;

/**
 * Parses the attributes of one start tag (names lower-cased, values decoded).
 * @param {string} tag e.g. `<meta name="_csrf" content="abc">`
 * @returns {Record<string, string>}
 */
function parseAttributes(tag) {
  /** @type {Record<string, string>} */
  const attrs = Object.create(null);
  const body = tag.replace(/^<\s*[^\s>/]+/, '').replace(/\/?>$/, '');
  const pattern = /([^\s=<>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4];
    const name = match[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = value === undefined ? '' : he.decode(value);
  }
  return attrs;
}

/**
 * Removes blocks that may echo submitted content: textarea, script, style
 * and pre blocks whose id/class mentions "script" or "editor". An unclosed
 * block is removed to the end of the document.
 * @param {string} html
 * @returns {string}
 */
function removeEchoBlocks(html) {
  return String(html)
    .replace(/<(textarea|script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<pre\b([^>]*)>[\s\S]*?(?:<\/pre\s*>|$)/gi, (block, attrs) => {
      const parsed = parseAttributes(`<pre ${attrs}>`);
      const marker = `${parsed.id || ''} ${parsed.class || ''}`;
      return /script|editor/i.test(marker) ? ' ' : block;
    });
}

/**
 * @param {string} html
 * @returns {string} plain text, decoded, whitespace collapsed.
 */
function toText(html) {
  return he
    .decode(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sanitised excerpt of an HTML/text body, safe for error messages:
 * (1) drop echo blocks, (2) strip tags, (3) decode entities,
 * (4) collapse whitespace, (5) redact secrets, (6) truncate.
 *
 * @param {string} html
 * @param {readonly string[]} [secrets]
 * @param {number} [max]
 * @returns {string}
 */
function excerpt(html, secrets = [], max = 500) {
  const text = redact(toText(removeEchoBlocks(html || '')), secrets);
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Finds every start tag of the given element name.
 * @param {string} html
 * @param {string} tagName
 * @returns {Array<Record<string, string>>}
 */
function findTags(html, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  return (String(html).match(pattern) || []).map(parseAttributes);
}

/**
 * Extracts the CSRF token from a `<meta name="_csrf" content="…">` tag (any
 * attribute order, quoting or case), falling back to a hidden
 * `<input name="_csrf" value="…">`.
 *
 * @param {string} html
 * @returns {string|null}
 */
function extractCsrfToken(html) {
  if (!html) return null;
  for (const attrs of findTags(html, 'meta')) {
    if (attrs.name === '_csrf' && attrs.content) return attrs.content;
  }
  for (const attrs of findTags(html, 'input')) {
    if (attrs.name === '_csrf' && attrs.value) return attrs.value;
  }
  return null;
}

/**
 * Login page detection by URL and/or body.
 * URL: the context prefix is removed from the pathname and the rest is tested
 * against `/(^|\/)login(\.jsp)?$/` (query and hash ignored).
 * Body: a form posting to `j_spring_security_check` or an input named `j_username`.
 *
 * @param {{ url?: string|null, basePath?: string, body?: string|null }} input
 * @returns {boolean}
 */
function isLoginPage({ url, basePath = '', body }) {
  if (url) {
    try {
      let rest = new URL(url, 'http://placeholder.invalid').pathname;
      if (basePath && (rest === basePath || rest.startsWith(`${basePath}/`))) rest = rest.slice(basePath.length);
      if (LOGIN_PATH_PATTERN.test(rest)) return true;
    } catch {
      // not a URL: ignore
    }
  }
  if (body) {
    const visible = removeEchoBlocks(body);
    if (findTags(visible, 'form').some((attrs) => /j_spring_security_check/i.test(attrs.action || ''))) return true;
    if (findTags(visible, 'input').some((attrs) => attrs.name === 'j_username')) return true;
  }
  return false;
}

/**
 * Finds the first element matching a predicate and returns its attributes and
 * inner HTML (up to the first matching close tag; nesting is not tracked).
 *
 * @param {string} html
 * @param {(attrs: Record<string, string>) => boolean} predicate
 * @returns {{ attrs: Record<string, string>, inner: string } | null}
 */
function findElement(html, predicate) {
  const pattern = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const attrs = parseAttributes(match[0]);
    if (!predicate(attrs)) continue;
    const start = match.index + match[0].length;
    const close = html.toLowerCase().indexOf(`</${match[1].toLowerCase()}`, start);
    return { attrs, inner: close === -1 ? '' : html.slice(start, close) };
  }
  return null;
}

/**
 * Text of the `id="loginErrors"` element: decoded, collapsed, redacted, ≤ 200 chars.
 * @param {string} html
 * @param {readonly string[]} [secrets]
 * @returns {string|null}
 */
function extractLoginError(html, secrets = []) {
  if (!html) return null;
  const element = findElement(String(html), (attrs) => attrs.id === 'loginErrors');
  if (!element) return null;
  const text = excerpt(element.inner, secrets, 200);
  return text || null;
}

/**
 * @typedef {object} ImpexParseResult
 * @property {'success'|'failure'|'login'|'unknown'} kind
 * @property {string|null} level HAC result level (lower-cased), when present.
 * @property {string} message Result text (redacted, ≤ 2000 chars).
 */

/**
 * Classifies an ImpEx import result page (design §11, in order):
 * 1. login page → 'login' (session expired)
 * 2. element with data-level: error → failure; notice/info/success → success;
 *    any other level → success only with the success text in data-result
 * 3. success text in the page → success
 * 4. element with id/class impexResult → failure
 * 5. otherwise 'unknown'
 *
 * @param {string} html
 * @param {{ basePath?: string, secrets?: readonly string[] }} [context]
 * @returns {ImpexParseResult}
 */
function parseImpexResult(html, { basePath = '', secrets = [] } = {}) {
  const body = String(html || '');
  if (isLoginPage({ basePath, body })) return { kind: 'login', level: null, message: '' };
  const visible = removeEchoBlocks(body);
  const isResultBlock = (/** @type {Record<string, string>} */ attrs) =>
    attrs.id === 'impexResult' || /(^|\s)impexResult(\s|$)/.test(attrs.class || '');

  const levelled = findElement(visible, (attrs) => 'data-level' in attrs);
  if (levelled) {
    const level = levelled.attrs['data-level'].trim().toLowerCase();
    const resultText = levelled.attrs['data-result'] || '';
    const details = [resultText, toText(levelled.inner)];
    const block = findElement(visible, (attrs) => isResultBlock(attrs) && !('data-level' in attrs));
    if (block) details.push(toText(block.inner));
    const message = excerpt([...new Set(details.filter(Boolean))].join('\n'), secrets, 2000);
    if (level === 'error') return { kind: 'failure', level, message };
    if (SUCCESS_LEVELS.has(level)) return { kind: 'success', level, message: excerpt(resultText, secrets, 2000) || message };
    if (resultText.includes(SUCCESS_TEXT)) return { kind: 'success', level, message: excerpt(resultText, secrets, 2000) };
    return { kind: 'failure', level: level || null, message };
  }
  if (visible.includes(SUCCESS_TEXT)) return { kind: 'success', level: null, message: SUCCESS_TEXT };
  const block = findElement(visible, isResultBlock);
  if (block) return { kind: 'failure', level: null, message: excerpt(block.inner, secrets, 2000) };
  return { kind: 'unknown', level: null, message: '' };
}

module.exports = {
  extractCsrfToken,
  isLoginPage,
  extractLoginError,
  parseImpexResult,
  excerpt,
  removeEchoBlocks,
  parseAttributes,
  SUCCESS_TEXT,
};
