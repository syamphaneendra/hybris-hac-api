'use strict';

/**
 * HAC login flow (Spring Security form login):
 * GET {ctx}/login.jsp → POST {ctx}/j_spring_security_check → follow the
 * redirect → take the rotated CSRF token from the landing page (or from the
 * CSRF refresh page). The whole sequence is restarted once on a transient
 * failure when `retries` is 1; individual steps are never retried.
 */

const { HacAuthError, HacCsrfError, HacError, HacHttpError } = require('../core/errors');
const { encodeForm } = require('../http/form');
const { classify, backoffMs } = require('../http/retry');
const { excerpt, extractCsrfToken, extractLoginError, isLoginPage } = require('../parse/html');

const MAX_REDIRECTS = 5;
const LOGIN_TIMEOUT_CAP_MS = 60000;
const LOGIN_PATH = '/login.jsp';
const LOGIN_POST_PATH = '/j_spring_security_check';
/** Console page used to (re)fetch a CSRF token. */
const CSRF_REFRESH_PATH = '/console/impex/import';

/**
 * Everything the session layer needs, shared by auth.js and session.js.
 * @typedef {object} SessionContext
 * @property {Readonly<import('../core/options').ResolvedOptions>} resolved
 * @property {import('../http/transport').Transport} transport
 * @property {import('../http/cookie-jar').CookieJar} jar
 * @property {import('../core/logger').HacLogger} logger
 * @property {readonly string[]} secrets
 * @property {() => string} password Accessor, so the value is never stored on the context.
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} random
 */

/**
 * @param {SessionContext} ctx
 * @param {string} subPath e.g. '/login.jsp'
 * @returns {string}
 */
function urlFor(ctx, subPath) {
  return `${ctx.resolved.baseUrl}${subPath}`;
}

/** @param {number} status */
const is2xx = (status) => status >= 200 && status < 300;
/** @param {number} status */
const is3xx = (status) => status >= 300 && status < 400;

/** @param {string} url */
function pathOf(url) {
  return new URL(url).pathname;
}

/**
 * Sends one request with jar cookies and stores the response cookies.
 *
 * @param {SessionContext} ctx
 * @param {{ method: 'GET'|'POST', url: string, fields?: import('../http/form').FormFields,
 *   headers?: Record<string, string>, timeoutMs: number }} request
 * @returns {Promise<import('../http/transport').TransportResponse>}
 */
async function sendWithCookies(ctx, { method, url, fields, headers = {}, timeoutMs }) {
  /** @type {Record<string, string>} */
  const allHeaders = { ...headers };
  const cookie = ctx.jar.header(url);
  if (cookie) allHeaders.Cookie = cookie;
  const response = await ctx.transport.send({
    method,
    url,
    headers: allHeaders,
    form: fields ? encodeForm(fields) : undefined,
    timeoutMs,
    connectTimeoutMs: ctx.resolved.connectTimeoutMs,
  });
  ctx.jar.store(response.headers['set-cookie'], url);
  return response;
}

/**
 * Resolves a redirect target and enforces the same-origin rule.
 * @param {SessionContext} ctx
 * @param {import('../http/transport').TransportResponse} response
 * @param {string} currentUrl
 * @param {string} method
 * @returns {URL}
 */
function redirectTarget(ctx, response, currentUrl, method) {
  const next = new URL(String(response.headers.location), currentUrl);
  if (next.origin !== ctx.resolved.origin) {
    throw new HacHttpError(`HAC redirected to a different origin (${next.origin}); set HAC_HOST to that origin`, {
      status: response.status,
      redirectOrigin: next.origin,
      method,
      path: pathOf(currentUrl),
    });
  }
  return next;
}

/**
 * GET that follows at most 5 same-origin redirects.
 *
 * @param {SessionContext} ctx
 * @param {string} url
 * @param {{ timeoutMs: number }} options
 * @returns {Promise<import('../http/transport').TransportResponse>} final response; `url` is the final URL.
 */
async function followGet(ctx, url, { timeoutMs }) {
  let current = url;
  for (let hop = 0; ; hop++) {
    const response = await sendWithCookies(ctx, { method: 'GET', url: current, timeoutMs });
    if (!is3xx(response.status) || !response.headers.location) return { ...response, url: current };
    const next = redirectTarget(ctx, response, current, 'GET');
    if (hop >= MAX_REDIRECTS) {
      throw new HacHttpError(`too many redirects (>${MAX_REDIRECTS})`, {
        status: response.status,
        method: 'GET',
        path: pathOf(current),
      });
    }
    current = next.href;
  }
}

/**
 * @param {SessionContext} ctx
 * @param {import('../http/transport').TransportResponse} response
 * @param {string} what
 * @returns {HacHttpError}
 */
function unexpectedStatus(ctx, response, what) {
  return new HacHttpError(`${what} returned unexpected status ${response.status}`, {
    status: response.status,
    method: 'GET',
    path: pathOf(response.url),
    bodyExcerpt: excerpt(response.body, ctx.secrets, 500),
  });
}

/**
 * @param {SessionContext} ctx
 * @param {string|null} body
 * @param {number} status
 * @returns {HacAuthError}
 */
function authFailure(ctx, body, status) {
  const reason = (body && extractLoginError(body, ctx.secrets)) || `login rejected (unexpected response, status ${status})`;
  return new HacAuthError(`HAC login failed: ${reason}`, {
    reason,
    status,
    method: 'POST',
    path: pathOf(urlFor(ctx, LOGIN_POST_PATH)),
  });
}

/**
 * Fetches a CSRF token from the CSRF refresh page.
 * @param {SessionContext} ctx
 * @param {number} timeoutMs
 * @returns {Promise<{ token: string } | { expired: true }>}
 */
async function fetchCsrfFromConsole(ctx, timeoutMs) {
  const page = await followGet(ctx, urlFor(ctx, CSRF_REFRESH_PATH), { timeoutMs });
  if (isLoginPage({ url: page.url, basePath: ctx.resolved.basePath, body: page.body })) return { expired: true };
  if (!is2xx(page.status)) throw unexpectedStatus(ctx, page, 'HAC CSRF refresh page');
  const token = extractCsrfToken(page.body);
  if (!token) {
    throw new HacCsrfError('no CSRF token found on the HAC console page', {
      status: page.status,
      method: 'GET',
      path: pathOf(page.url),
    });
  }
  return { token };
}

/**
 * One login sequence without restart.
 * @param {SessionContext} ctx
 * @returns {Promise<{ csrfToken: string }>}
 */
async function loginOnce(ctx) {
  const timeoutMs = Math.min(ctx.resolved.timeoutMs, LOGIN_TIMEOUT_CAP_MS);
  const basePath = ctx.resolved.basePath;

  const loginPage = await followGet(ctx, urlFor(ctx, LOGIN_PATH), { timeoutMs });
  if (!is2xx(loginPage.status)) throw unexpectedStatus(ctx, loginPage, 'HAC login page');
  // Old HAC versions have no CSRF on the login form; send an empty token as before.
  const loginToken = extractCsrfToken(loginPage.body) || '';

  const postUrl = urlFor(ctx, LOGIN_POST_PATH);
  const response = await sendWithCookies(ctx, {
    method: 'POST',
    url: postUrl,
    fields: [
      ['j_username', ctx.resolved.user],
      ['j_password', ctx.password()],
      ['submit', 'login'],
      ['_csrf', loginToken],
    ],
    timeoutMs,
  });

  /** @type {import('../http/transport').TransportResponse} */
  let landing;
  if (is3xx(response.status) && response.headers.location) {
    const next = redirectTarget(ctx, response, postUrl, 'POST');
    if (next.href.includes('login_error') || isLoginPage({ url: next.href, basePath })) {
      let errorPage = null;
      try {
        errorPage = await followGet(ctx, next.href, { timeoutMs });
      } catch {
        // The failure reason is optional; the login failed either way.
      }
      throw authFailure(ctx, errorPage ? errorPage.body : null, response.status);
    }
    landing = await followGet(ctx, next.href, { timeoutMs });
    if (isLoginPage({ url: landing.url, basePath, body: landing.body })) throw authFailure(ctx, landing.body, response.status);
    if (!is2xx(landing.status)) throw unexpectedStatus(ctx, landing, 'HAC page after login');
  } else if (is2xx(response.status)) {
    landing = { ...response, url: postUrl };
    if (isLoginPage({ basePath, body: landing.body })) throw authFailure(ctx, landing.body, response.status);
  } else if (response.status === 401) {
    throw authFailure(ctx, response.body, response.status);
  } else {
    throw new HacHttpError(`HAC login returned unexpected status ${response.status}`, {
      status: response.status,
      method: 'POST',
      path: pathOf(postUrl),
      bodyExcerpt: excerpt(response.body, ctx.secrets, 500),
    });
  }

  const landingToken = extractCsrfToken(landing.body);
  if (landingToken) return { csrfToken: landingToken };
  const refreshed = await fetchCsrfFromConsole(ctx, timeoutMs);
  if ('expired' in refreshed) {
    throw new HacAuthError('HAC login failed: login rejected (session was not established)', {
      reason: 'login rejected (session was not established)',
      method: 'GET',
      path: pathOf(urlFor(ctx, CSRF_REFRESH_PATH)),
    });
  }
  return { csrfToken: refreshed.token };
}

/**
 * @param {unknown} err
 * @returns {unknown}
 */
function tagLogin(err) {
  if (err instanceof HacError && !err.operation) err.operation = 'login';
  return err;
}

/**
 * Full login with the single whole-sequence restart (design §8.2).
 * @param {SessionContext} ctx
 * @returns {Promise<{ csrfToken: string }>}
 */
async function performLogin(ctx) {
  try {
    return await loginOnce(ctx);
  } catch (err) {
    const transient = classify(err) !== 'permanent';
    if (ctx.resolved.retries !== 1 || !transient) throw tagLogin(err);
    ctx.logger.debug('login.restart', {
      operation: 'login',
      reason: err instanceof HacError ? err.code : 'unknown',
    });
    await ctx.sleep(backoffMs({ retryDelayMs: ctx.resolved.retryDelayMs, random: ctx.random }));
    ctx.jar.clear();
    try {
      return await loginOnce(ctx);
    } catch (second) {
      throw tagLogin(second);
    }
  }
}

module.exports = {
  performLogin,
  followGet,
  sendWithCookies,
  fetchCsrfFromConsole,
  urlFor,
  pathOf,
  CSRF_REFRESH_PATH,
  LOGIN_TIMEOUT_CAP_MS,
};
