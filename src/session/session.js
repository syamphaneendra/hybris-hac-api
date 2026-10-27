'use strict';

/**
 * HacSession: one authenticated HAC session per client.
 *
 * - Single-flight login shared by concurrent operations.
 * - CSRF token cache with single-flight refresh.
 * - `generation` / `csrfVersion` counters so that only the first request
 *   that detects an expiry or a 403 starts the recovery (design §7.2).
 * - `request()` owns the per-call budget loop (design §8.1).
 */

const {
  HacClientClosedError,
  HacCsrfError,
  HacError,
  HacHttpError,
  HacSessionExpiredError,
  withAttempts,
} = require('../core/errors');
const { backoffMs, classify, effectiveTransientBudget, qualifies, GATEWAY_STATUSES } = require('../http/retry');
const { excerpt, isLoginPage } = require('../parse/html');
const { fetchCsrfFromConsole, performLogin, sendWithCookies, urlFor, pathOf, LOGIN_TIMEOUT_CAP_MS } = require('./auth');

const MAX_ATTEMPTS = 3;
/** Returned by an operation's `interpret()` when the body is a login page. */
const SESSION_EXPIRED = Symbol('hybris-hac-api.session-expired');

/**
 * @typedef {object} CallOptions
 * @property {number} [timeoutMs]
 * @property {boolean} [retryOnTransientError]
 */

/**
 * @template T
 * @typedef {object} OperationRequest
 * @property {string} operation 'impexImport' | 'search' | 'runScript'
 * @property {boolean} safe Idempotent operation (full transient retry by default).
 * @property {string} subPath Path below the context path, e.g. '/console/impex/import'.
 * @property {(csrfToken: string) => import('../http/form').FormFields} fields
 * @property {(response: import('../http/transport').TransportResponse) => T | typeof SESSION_EXPIRED} interpret
 * @property {CallOptions} [callOptions]
 */

class HacSession {
  /** @param {import('./auth').SessionContext} ctx */
  constructor(ctx) {
    /** @type {import('./auth').SessionContext} */
    this.ctx = ctx;
    /** @type {'anonymous'|'authenticating'|'authenticated'|'closed'} */
    this.state = 'anonymous';
    this.generation = 0;
    this.csrfVersion = 0;
    /** @type {string|null} */
    this.csrfToken = null;
    /** @type {Promise<void>|null} */
    this.loginPromise = null;
    /** @type {Promise<{ expired: boolean }>|null} */
    this.refreshPromise = null;
  }

  /** @returns {HacClientClosedError} */
  closedError() {
    return new HacClientClosedError('HAC client is closed');
  }

  /**
   * Logs in unless already authenticated; joins an in-flight login.
   * @returns {Promise<void>}
   */
  ensureLoggedIn() {
    if (this.state === 'closed') return Promise.reject(this.closedError());
    if (this.state === 'authenticated') return Promise.resolve();
    if (!this.loginPromise) {
      this.state = 'authenticating';
      this.loginPromise = (async () => {
        try {
          const { csrfToken } = await performLogin(this.ctx);
          if (this.state === 'closed') throw this.closedError();
          this.csrfToken = csrfToken;
          this.csrfVersion++;
          this.state = 'authenticated';
          this.ctx.logger.debug('login.success', { operation: 'login' });
        } catch (err) {
          if (this.state !== 'closed') this.state = 'anonymous';
          throw err;
        } finally {
          this.loginPromise = null;
        }
      })();
    }
    return this.loginPromise;
  }

  /** Clears cookies and the token; the next request logs in again. */
  invalidate() {
    this.ctx.jar.clear();
    this.csrfToken = null;
    if (this.state !== 'closed') this.state = 'anonymous';
  }

  /**
   * Session expiry detected by a request sent in `sentGeneration`.
   * @param {number} sentGeneration
   * @returns {Promise<void>}
   */
  onExpired(sentGeneration) {
    if (sentGeneration === this.generation && this.state !== 'closed') {
      this.invalidate();
      this.generation++;
    }
    return this.ensureLoggedIn();
  }

  /**
   * 403 detected by a request sent with `sentCsrfVersion`.
   * @param {number} sentCsrfVersion
   * @returns {Promise<{ expired: boolean }>} expired: the refresh page was a login page.
   */
  async onForbidden(sentCsrfVersion) {
    if (sentCsrfVersion !== this.csrfVersion && !this.refreshPromise) return { expired: false };
    return this.refreshCsrf();
  }

  /**
   * Single-flight CSRF refresh. Never retried on its own.
   * @returns {Promise<{ expired: boolean }>}
   */
  refreshCsrf() {
    if (this.state === 'closed') return Promise.reject(this.closedError());
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        try {
          const timeoutMs = Math.min(this.ctx.resolved.timeoutMs, LOGIN_TIMEOUT_CAP_MS);
          const result = await fetchCsrfFromConsole(this.ctx, timeoutMs);
          if ('expired' in result) return { expired: true };
          this.csrfToken = result.token;
          this.csrfVersion++;
          this.ctx.logger.debug('csrf.refreshed', { operation: 'csrf' });
          return { expired: false };
        } finally {
          this.refreshPromise = null;
        }
      })();
    }
    return this.refreshPromise;
  }

  /**
   * Sends an operation request with expiry/CSRF recovery and transient
   * retries, all within one per-call budget (cap: 3 sends).
   *
   * @template T
   * @param {OperationRequest<T>} op
   * @returns {Promise<T>}
   */
  async request(op) {
    const { resolved, logger } = this.ctx;
    const callOptions = op.callOptions || {};
    const mode = effectiveTransientBudget({
      clientRetries: resolved.retries,
      perCall: callOptions.retryOnTransientError,
      safe: op.safe,
    });
    const budget = { transient: mode === 'none' ? 0 : 1, relogin: 1, csrf: 1 };
    const url = urlFor(this.ctx, op.subPath);
    const path = pathOf(url);
    const timeoutMs = callOptions.timeoutMs !== undefined ? callOptions.timeoutMs : resolved.timeoutMs;
    let attempts = 0;

    /**
     * @param {unknown} err
     * @returns {unknown}
     */
    const stamp = (err) => withAttempts(err, attempts, op.operation);

    for (;;) {
      try {
        await this.ensureLoggedIn();
      } catch (err) {
        throw stamp(err);
      }
      const sentGeneration = this.generation;
      const sentCsrfVersion = this.csrfVersion;
      const token = this.csrfToken || '';
      attempts++;

      /** @type {'ok'|'expired'|'forbidden'|'transient'} */
      let outcome;
      /** @type {unknown} */
      let failure = null;
      /** @type {T|undefined} */
      let value;
      /** @type {string|null} */
      let retryAfter = null;
      try {
        const response = await sendWithCookies(this.ctx, {
          method: 'POST',
          url,
          fields: op.fields(token),
          headers: { 'X-CSRF-TOKEN': token },
          timeoutMs,
        });
        outcome = 'ok';
        const status = response.status;
        if (status >= 300 && status < 400) {
          const location = response.headers.location ? new URL(String(response.headers.location), url) : null;
          if (location && location.origin !== resolved.origin) {
            throw new HacHttpError(
              `HAC redirected to a different origin (${location.origin}); set HAC_HOST to that origin`,
              { status, redirectOrigin: location.origin, method: 'POST', path },
            );
          }
          if (location && isLoginPage({ url: location.href, basePath: resolved.basePath })) outcome = 'expired';
          else throw new HacHttpError(`HAC answered with an unexpected redirect (status ${status})`, { status, method: 'POST', path });
        } else if (status === 401) {
          outcome = 'expired';
        } else if (status === 403) {
          outcome = 'forbidden';
        } else if (status < 200 || status >= 300) {
          const header = response.headers['retry-after'];
          retryAfter = status === 503 && header ? String(header) : null;
          throw new HacHttpError(`HAC answered with HTTP ${status}`, {
            status,
            method: 'POST',
            path,
            bodyExcerpt: excerpt(response.body, this.ctx.secrets, 500),
          });
        } else {
          const interpreted = op.interpret(response);
          if (interpreted === SESSION_EXPIRED) outcome = 'expired';
          else value = /** @type {T} */ (interpreted);
        }
      } catch (err) {
        if (!(err instanceof HacError) || !qualifies(classify(err), mode)) throw stamp(err);
        outcome = 'transient';
        failure = err;
      }

      if (outcome === 'ok') return /** @type {T} */ (value);

      if (outcome === 'expired') {
        if (attempts >= MAX_ATTEMPTS || budget.relogin === 0) {
          throw stamp(new HacSessionExpiredError('HAC session expired and could not be re-established', { method: 'POST', path }));
        }
        budget.relogin--;
        logger.debug('session.expired', { operation: op.operation, path, attempt: attempts, reason: 'relogin' });
        try {
          await this.onExpired(sentGeneration);
        } catch (err) {
          throw stamp(err);
        }
        continue;
      }

      if (outcome === 'forbidden') {
        if (attempts >= MAX_ATTEMPTS || budget.csrf === 0) {
          throw stamp(new HacCsrfError('HAC rejected the CSRF token (status 403)', { status: 403, method: 'POST', path }));
        }
        budget.csrf--;
        logger.debug('csrf.forbidden', { operation: op.operation, path, attempt: attempts, reason: 'refresh' });
        try {
          const { expired } = await this.onForbidden(sentCsrfVersion);
          if (expired) {
            if (budget.relogin === 0) {
              throw new HacSessionExpiredError('HAC session expired and could not be re-established', { method: 'POST', path });
            }
            budget.relogin--;
            await this.onExpired(sentGeneration);
          }
        } catch (err) {
          throw stamp(err);
        }
        continue;
      }

      // transient
      if (attempts >= MAX_ATTEMPTS || budget.transient === 0) throw stamp(failure);
      budget.transient--;
      logger.debug('request.retry', {
        operation: op.operation,
        path,
        attempt: attempts,
        reason: failure instanceof HacError ? failure.code : 'unknown',
      });
      await this.ctx.sleep(backoffMs({ retryDelayMs: resolved.retryDelayMs, retryAfter, random: this.ctx.random }));
    }
  }

  /** Immediate close: clears state and destroys every socket. Idempotent. */
  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.ctx.jar.clear();
    this.csrfToken = null;
    this.ctx.transport.destroy();
  }
}

module.exports = { HacSession, SESSION_EXPIRED, MAX_ATTEMPTS, GATEWAY_STATUSES };
