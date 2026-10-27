'use strict';

/**
 * Minimal per-client cookie store for a single origin (RFC 6265 subset):
 * Max-Age/Expires (including deletion), Path matching with the default-path
 * rule, Secure. `Domain` is ignored because a client talks to one origin,
 * and cookies are never sent to, or accepted from, another origin.
 */

/**
 * @typedef {object} StoredCookie
 * @property {string} name
 * @property {string} value
 * @property {string} path
 * @property {boolean} secure
 * @property {number|null} expiresAt epoch ms, null for session cookies.
 */

/**
 * RFC 6265 §5.1.4 default-path.
 * @param {string} requestPath
 * @returns {string}
 */
function defaultPath(requestPath) {
  if (!requestPath || !requestPath.startsWith('/')) return '/';
  const last = requestPath.lastIndexOf('/');
  return last <= 0 ? '/' : requestPath.slice(0, last);
}

/**
 * RFC 6265 §5.1.4 path-match.
 * @param {string} requestPath
 * @param {string} cookiePath
 * @returns {boolean}
 */
function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

class CookieJar {
  /**
   * @param {string} origin e.g. 'https://hac.example.com:9002'
   * @param {{ now?: () => number }} [options]
   */
  constructor(origin, { now = Date.now } = {}) {
    /** @type {string} */
    this.origin = new URL(origin).origin;
    /** @type {() => number} */
    this.now = now;
    /** @type {Map<string, StoredCookie>} */
    this.cookies = new Map();
  }

  /**
   * Stores the `Set-Cookie` headers of a response.
   * @param {string|string[]|undefined} setCookie
   * @param {string} requestUrl
   */
  store(setCookie, requestUrl) {
    if (!setCookie) return;
    const url = new URL(requestUrl);
    if (url.origin !== this.origin) return;
    for (const header of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      this.storeOne(header, url);
    }
  }

  /**
   * @param {string} header
   * @param {URL} url
   */
  storeOne(header, url) {
    const [pair, ...attributes] = String(header).split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) return;
    let path = null;
    let secure = false;
    /** @type {number|null} */
    let maxAge = null;
    /** @type {number|null} */
    let expires = null;
    for (const attribute of attributes) {
      const idx = attribute.indexOf('=');
      const key = (idx === -1 ? attribute : attribute.slice(0, idx)).trim().toLowerCase();
      const val = idx === -1 ? '' : attribute.slice(idx + 1).trim();
      if (key === 'max-age' && /^-?\d+$/.test(val)) maxAge = Number(val);
      else if (key === 'expires') {
        const time = Date.parse(val);
        if (!Number.isNaN(time)) expires = time;
      } else if (key === 'path' && val.startsWith('/')) path = val;
      else if (key === 'secure') secure = true;
    }
    const cookiePath = path || defaultPath(url.pathname);
    const key = `${name}\u0000${cookiePath}`;
    const now = this.now();
    /** @type {number|null} */
    let expiresAt = null;
    if (maxAge !== null) expiresAt = maxAge <= 0 ? 0 : now + maxAge * 1000;
    else if (expires !== null) expiresAt = expires;
    if (expiresAt !== null && expiresAt <= now) {
      this.cookies.delete(key);
      return;
    }
    if (secure && url.protocol !== 'https:') return;
    this.cookies.set(key, { name, value, path: cookiePath, secure, expiresAt });
  }

  /**
   * `Cookie` header value for a request, or '' when nothing matches.
   * @param {string} requestUrl
   * @returns {string}
   */
  header(requestUrl) {
    const url = new URL(requestUrl);
    if (url.origin !== this.origin) return '';
    const now = this.now();
    /** @type {StoredCookie[]} */
    const matching = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (cookie.secure && url.protocol !== 'https:') continue;
      if (!pathMatches(url.pathname, cookie.path)) continue;
      matching.push(cookie);
    }
    matching.sort((a, b) => b.path.length - a.path.length);
    return matching.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** Removes every cookie. */
  clear() {
    this.cookies.clear();
  }
}

module.exports = { CookieJar, defaultPath, pathMatches };
