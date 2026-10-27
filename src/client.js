'use strict';

/**
 * HacClient: one HAC session (cookie jar, CSRF token, keep-alive agent) with
 * typed operations. Options are resolved and validated in the constructor
 * (HacConfigError, no network I/O); operations log in lazily.
 */

const util = require('node:util');
const { HacClientClosedError } = require('./core/errors');
const { resolveOptions } = require('./core/options');
const { CookieJar } = require('./http/cookie-jar');
const { defaultSleep } = require('./http/retry');
const { createTransport } = require('./http/transport');
const { HacSession } = require('./session/session');
const impex = require('./operations/impex');
const flexsearch = require('./operations/flexsearch');
const scripting = require('./operations/scripting');

/** Test-only hooks (`{ sleep, random }`), read from a non-enumerable option key. */
const TEST_HOOKS = Symbol.for('hybris-hac-api.test');
/** Module-private: graceful retirement used by the legacy default client. */
const RETIRE = Symbol('hybris-hac-api.retire');
/** Module-private: runs a session function with in-flight accounting. */
const EXECUTE = Symbol('hybris-hac-api.execute');

class HacClient {
  /** @type {string} */
  #password;
  /** @type {HacSession} */
  #session;
  /** @type {Readonly<import('./core/options').ResolvedOptions>} */
  #resolved;
  #inFlight = 0;
  /** @type {'active'|'retiring'|'closed'} */
  #state = 'active';

  /**
   * @param {Record<string|symbol, any>} [options] HacClientOptions (see index.d.ts).
   * @throws {import('./core/errors').HacConfigError} invalid configuration.
   */
  constructor(options = {}) {
    const { resolved, password, secrets, logger } = resolveOptions(options);
    const hooks = (options && options[TEST_HOOKS]) || {};
    this.#password = password;
    this.#resolved = resolved;
    const transport = createTransport({ resolved, logger, secrets });
    /** @type {import('./session/auth').SessionContext} */
    const ctx = {
      resolved,
      transport,
      jar: new CookieJar(resolved.origin),
      logger,
      secrets,
      password: () => this.#password,
      sleep: typeof hooks.sleep === 'function' ? hooks.sleep : defaultSleep,
      random: typeof hooks.random === 'function' ? hooks.random : Math.random,
    };
    this.#session = new HacSession(ctx);
  }

  /**
   * Runs `fn` on the session, rejecting when the client is closed or retiring.
   * @template T
   * @param {(session: HacSession) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async #run(fn) {
    if (this.#state !== 'active') throw new HacClientClosedError('HAC client is closed');
    this.#inFlight++;
    try {
      return await fn(this.#session);
    } finally {
      this.#inFlight--;
      // The state may have changed to 'retiring' while the call was running.
      const state = /** @type {string} */ (this.#state);
      if (state === 'retiring' && this.#inFlight === 0) this.close();
    }
  }

  /**
   * Logs in now. Resolves immediately when already authenticated and joins an
   * in-flight login. Optional: every operation logs in lazily.
   * @returns {Promise<void>}
   */
  async login() {
    await this.#run((session) => session.ensureLoggedIn());
  }

  /**
   * Imports an ImpEx script. Resolves only after HAC reported success.
   * @param {string} script
   * @param {Record<string, any>} [options] ImpexOptions.
   * @returns {Promise<import('./operations/impex').ImpexResult>}
   */
  importImpex(script, options) {
    return this.#run((session) => impex.run(session, script, options));
  }

  /**
   * Runs a FlexibleSearch query and returns all rows.
   * @param {string} query
   * @param {Record<string, any>} [options] SearchOptions.
   * @returns {Promise<import('./operations/flexsearch').SearchResult>}
   */
  search(query, options) {
    return this.#run((session) => flexsearch.run(session, query, options));
  }

  /**
   * Executes a script (Groovy by default, commit true by default).
   * @param {string} script
   * @param {Record<string, any>} [options] ScriptOptions.
   * @returns {Promise<import('./operations/scripting').ScriptResult>}
   */
  runScript(script, options) {
    return this.#run((session) => scripting.run(session, script, options));
  }

  /**
   * Closes the client immediately: clears the session and destroys sockets.
   * In-flight calls fail; later calls reject with HacClientClosedError. Idempotent.
   */
  close() {
    this.#state = 'closed';
    this.#session.close();
  }

  /**
   * @template T
   * @param {(session: HacSession) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  [EXECUTE](fn) {
    return this.#run(fn);
  }

  /** Rejects new calls and closes once in-flight calls have finished. */
  [RETIRE]() {
    if (this.#state !== 'active') return;
    this.#state = 'retiring';
    if (this.#inFlight === 0) this.close();
  }

  /** @returns {{ host: string, contextPath: string, state: string }} */
  toJSON() {
    return { host: this.#resolved.hostUrl, contextPath: this.#resolved.contextPath, state: this.#state };
  }

  /** @returns {string} */
  [util.inspect.custom]() {
    return `HacClient ${util.inspect(this.toJSON())}`;
  }
}

/**
 * Creates a client. Throws HacConfigError synchronously on invalid options.
 * @param {Record<string|symbol, any>} [options] HacClientOptions.
 * @returns {HacClient}
 */
function createHacClient(options) {
  return new HacClient(options);
}

module.exports = { HacClient, createHacClient, RETIRE, EXECUTE, TEST_HOOKS };
