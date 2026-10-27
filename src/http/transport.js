'use strict';

/**
 * Sends exactly one HTTP request: no redirects, no retries, no cookies.
 *
 * Responsibilities: standard request headers, TLS options, keep-alive agent,
 * proxy routing, connect and overall timeouts, 50 MiB body cap, identity
 * encoding only, UTF-8 body decoding, and mapping socket failures to
 * HacTransportError / HacTimeoutError. Errors only ever carry the method,
 * the path and a network code; never a body, header or URL with credentials.
 */

const http = require('node:http');
const https = require('node:https');
const { HacError, HacResponseError, HacTimeoutError, HacTransportError } = require('../core/errors');
const { redact } = require('../core/redact');
const { createProxyAgent } = require('./proxy');
const { version } = require('../../package.json');

const MAX_BODY_BYTES = 50 * 1024 * 1024;
const FREE_SOCKET_TIMEOUT_MS = 4000;
const ACCEPT = 'application/json, text/html;q=0.9, */*;q=0.8';
const USER_AGENT = `hybris-hac-api/${version}`;

/**
 * @typedef {object} TransportRequest
 * @property {'GET'|'POST'} method
 * @property {string} url Absolute URL.
 * @property {Record<string, string>} [headers] Extra headers (Cookie, X-CSRF-TOKEN…).
 * @property {{ body: Buffer, contentType: string, contentLength: number }} [form]
 * @property {number} timeoutMs Overall deadline.
 * @property {number} connectTimeoutMs New-socket connect deadline.
 */

/**
 * @typedef {object} TransportResponse
 * @property {number} status
 * @property {import('node:http').IncomingHttpHeaders} headers
 * @property {string} body UTF-8 decoded body.
 * @property {string} url The request URL.
 */

/**
 * @typedef {object} Transport
 * @property {(request: TransportRequest) => Promise<TransportResponse>} send
 * @property {() => void} destroy Destroys every socket of the private agent.
 */

/**
 * Marks whether a transport error happened before the socket connected.
 * Non-enumerable so it never shows up in logs or JSON.
 * @param {HacError} err
 * @param {boolean} connectPhase
 * @returns {HacError}
 */
function markPhase(err, connectPhase) {
  if (!Object.prototype.hasOwnProperty.call(err, 'connectPhase')) {
    Object.defineProperty(err, 'connectPhase', { value: connectPhase, enumerable: false, writable: true });
  }
  return err;
}

/**
 * @param {{ resolved: import('../core/options').ResolvedOptions, logger: import('../core/logger').HacLogger, secrets: readonly string[] }} input
 * @returns {Transport}
 */
function createTransport({ resolved, logger, secrets }) {
  const targetProtocol = new URL(resolved.origin).protocol;
  const isHttps = targetProtocol === 'https:';
  /** @type {import('node:https').AgentOptions} */
  const agentOptions = { keepAlive: true, timeout: FREE_SOCKET_TIMEOUT_MS };
  if (isHttps) {
    agentOptions.rejectUnauthorized = resolved.tls.rejectUnauthorized;
    if (resolved.tls.ca !== undefined) agentOptions.ca = resolved.tls.ca;
  }
  const proxy = resolved.proxy;
  /** @type {import('node:http').Agent} */
  let agent;
  let tunnel = false;
  if (proxy) {
    ({ agent, tunnel } = createProxyAgent({ proxy, targetProtocol, agentOptions }));
  } else {
    agent = isHttps ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
  }

  /**
   * @param {TransportRequest} request
   * @returns {Promise<TransportResponse>}
   */
  function send(request) {
    const { method, url, timeoutMs, connectTimeoutMs } = request;
    const target = new URL(url);
    const path = target.pathname;
    const started = Date.now();

    /** @type {Record<string, string|number>} */
    const headers = { Accept: ACCEPT, 'User-Agent': USER_AGENT, ...(request.headers || {}) };
    if (request.form) {
      headers['Content-Type'] = request.form.contentType;
      headers['Content-Length'] = request.form.contentLength;
    }

    /** @type {import('node:https').RequestOptions} */
    const options = {
      method,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers,
      agent,
    };
    if (proxy && !tunnel) {
      // Absolute-form request to the proxy for http: targets.
      options.hostname = proxy.url.hostname;
      options.port = Number(proxy.url.port) || 80;
      options.path = target.href;
      headers.Host = target.host;
      if (proxy.authHeader) headers['Proxy-Authorization'] = proxy.authHeader;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let connected = false;
      const req = (isHttps && (!proxy || tunnel) ? https : http).request(options);

      const connectTimer = setTimeout(() => {
        if (!connected) {
          req.destroy(new HacTimeoutError(`connect timed out after ${connectTimeoutMs} ms`, {
            phase: 'connect',
            timeoutMs: connectTimeoutMs,
            method,
            path,
          }));
        }
      }, connectTimeoutMs);
      const deadline = setTimeout(() => {
        req.destroy(new HacTimeoutError(`request timed out after ${timeoutMs} ms`, {
          phase: 'response',
          timeoutMs,
          method,
          path,
        }));
      }, timeoutMs);

      const markConnected = () => {
        connected = true;
        clearTimeout(connectTimer);
      };

      /** @param {unknown} cause */
      const fail = (cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(deadline);
        /** @type {HacError} */
        let err;
        if (cause instanceof HacError) {
          err = cause;
          if (!err.method) err.method = method;
          if (!err.path) err.path = path;
        } else {
          const nodeErr = /** @type {NodeJS.ErrnoException} */ (cause);
          const networkCode = (nodeErr && nodeErr.code) || 'ECONNRESET';
          const detail = nodeErr && nodeErr.message ? `: ${redact(nodeErr.message, secrets)}` : '';
          err = new HacTransportError(`${method} ${path} failed (${networkCode}${detail})`, {
            networkCode,
            method,
            path,
            cause: nodeErr,
          });
        }
        if (err instanceof HacTransportError || (err && /** @type {any} */ (err).phase === 'connect')) {
          markPhase(err, !connected);
        }
        logger.debug('http.error', {
          method,
          path,
          reason: err.code,
          durationMs: Date.now() - started,
          proxy: proxy ? proxy.origin : undefined,
        });
        reject(err);
      };

      req.on('socket', (socket) => {
        if (req.reusedSocket) {
          markConnected();
          return;
        }
        if (isHttps && (!proxy || tunnel)) {
          // A fresh TLS socket counts as connected once the handshake is done.
          socket.once('secureConnect', markConnected);
        } else if (!socket.connecting) {
          markConnected();
        } else {
          socket.once('connect', markConnected);
        }
      });

      req.on('error', fail);
      req.on('close', () => {
        if (!settled) fail(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      });

      req.on('response', (res) => {
        markConnected();
        const status = res.statusCode || 0;
        const encoding = String(res.headers['content-encoding'] || 'identity').trim().toLowerCase();
        if (encoding !== 'identity') {
          fail(new HacResponseError(`unsupported Content-Encoding ${encoding}`, { status, method, path }));
          req.destroy();
          return;
        }
        /** @type {Buffer[]} */
        const chunks = [];
        let total = 0;
        res.on('data', (/** @type {Buffer} */ chunk) => {
          total += chunk.length;
          if (total > MAX_BODY_BYTES) {
            fail(new HacResponseError(`response body exceeds ${MAX_BODY_BYTES} bytes`, { status, method, path }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', fail);
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(connectTimer);
          clearTimeout(deadline);
          logger.debug('http.response', {
            method,
            path,
            status,
            durationMs: Date.now() - started,
            proxy: proxy ? proxy.origin : undefined,
          });
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), url });
        });
      });

      if (request.form) req.end(request.form.body);
      else req.end();
    });
  }

  return {
    send,
    destroy: () => agent.destroy(),
  };
}

module.exports = { createTransport, MAX_BODY_BYTES, USER_AGENT, ACCEPT };
