'use strict';

/**
 * HTTP proxy support without extra dependencies.
 *
 * Selection follows the rules axios 0.19 used (lower-case env names first):
 * `http_proxy`/`HTTP_PROXY` for http: hosts, `https_proxy`/`HTTPS_PROXY`
 * for https: hosts, `no_proxy`/`NO_PROXY` to bypass. An explicit `proxy`
 * option overrides the environment; `proxy: false` disables proxies.
 *
 * - http: HAC hosts are reached with absolute-form requests to the proxy.
 * - https: HAC hosts are reached through a `CONNECT` tunnel, then TLS.
 * Only http: proxy URLs are supported.
 */

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { HacConfigError, HacHttpError } = require('../core/errors');

/**
 * @typedef {object} ProxyConfig
 * @property {URL} url Parsed proxy URL.
 * @property {string} origin `http://host:port`, safe to log.
 * @property {string|null} authHeader `Basic …` value, or null.
 * @property {string|null} password Decoded proxy password (for redaction).
 * @property {string} variable Where the proxy came from ('proxy' or the env var name).
 */

/**
 * NO_PROXY matching (axios 0.19 semantics): comma list, entries trimmed,
 * `*` matches everything, an entry starting with `.` matches as a suffix,
 * any other entry matches the hostname exactly.
 *
 * @param {string} hostname
 * @param {string|undefined} noProxy
 * @returns {boolean}
 */
function matchesNoProxy(hostname, noProxy) {
  if (!noProxy) return false;
  const host = hostname.toLowerCase();
  return noProxy
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => {
      if (!entry) return false;
      if (entry === '*') return true;
      if (entry.startsWith('.') && host.endsWith(entry)) return true;
      return host === entry;
    });
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {string[]} names
 * @returns {{ name: string, value: string } | null}
 */
function firstSet(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') return { name, value };
  }
  return null;
}

/**
 * Builds the `Proxy-Authorization` header from the URL userinfo.
 * @param {URL} url
 * @returns {string|null}
 */
function proxyAuthHeader(url) {
  if (!url.username && !url.password) return null;
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/**
 * Picks the proxy for a HAC host, or null for a direct connection.
 *
 * @param {{ hostUrl: string, env: Record<string, string|undefined>, option?: string|false }} input
 * @returns {ProxyConfig|null}
 * @throws {HacConfigError} invalid proxy URL (the message never echoes it).
 */
function selectProxy({ hostUrl, env, option }) {
  if (option === false) return null;
  const target = new URL(hostUrl);
  /** @type {{ name: string, value: string } | null} */
  let chosen = null;
  if (typeof option === 'string' && option !== '') {
    chosen = { name: 'proxy', value: option };
  } else if (option !== undefined && option !== '') {
    throw new HacConfigError('proxy must be a proxy URL string or false', { variable: 'proxy' });
  } else {
    const scheme = target.protocol.slice(0, -1);
    chosen = firstSet(env, [`${scheme}_proxy`, `${scheme.toUpperCase()}_PROXY`]);
    if (!chosen) return null;
    const noProxy = firstSet(env, ['no_proxy', 'NO_PROXY']);
    if (noProxy && matchesNoProxy(target.hostname, noProxy.value)) return null;
  }

  let url;
  try {
    url = new URL(chosen.value);
  } catch {
    throw new HacConfigError(`${chosen.name} must be an absolute http: proxy URL`, { variable: chosen.name });
  }
  if (url.protocol === 'https:') {
    throw new HacConfigError(`${chosen.name}: https: proxy URLs are not supported; use an http: proxy URL`, {
      variable: chosen.name,
    });
  }
  if (url.protocol !== 'http:' || !url.hostname) {
    throw new HacConfigError(`${chosen.name} must be an absolute http: proxy URL`, { variable: chosen.name });
  }
  return {
    url,
    origin: `${url.protocol}//${url.hostname}:${url.port || 80}`,
    authHeader: proxyAuthHeader(url),
    password: url.password ? decodeURIComponent(url.password) : null,
    variable: chosen.name,
  };
}

/**
 * https.Agent that opens every new connection through an HTTP CONNECT tunnel.
 */
class TunnelingAgent extends https.Agent {
  /**
   * @param {https.AgentOptions} agentOptions
   * @param {ProxyConfig} proxy
   */
  constructor(agentOptions, proxy) {
    super(agentOptions);
    /** @type {ProxyConfig} */
    this.proxy = proxy;
  }

  /**
   * Called by Node's Agent for every new socket. Uses the async callback form.
   * @param {any} options
   * @param {(err: Error|null, stream: import('node:stream').Duplex) => void} [callback]
   * @returns {undefined}
   */
  createConnection(options, callback) {
    const host = options.host || options.hostname;
    const port = options.port || 443;
    const authority = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
    /** @type {Record<string, string>} */
    const headers = { Host: authority };
    if (this.proxy.authHeader) headers['Proxy-Authorization'] = this.proxy.authHeader;
    let done = false;
    /** @param {Error|null} err @param {import('node:stream').Duplex} [socket] */
    const finish = (err, socket) => {
      if (done || !callback) return;
      done = true;
      callback(err, /** @type {import('node:stream').Duplex} */ (socket));
    };
    const connectReq = http.request({
      host: this.proxy.url.hostname,
      port: Number(this.proxy.url.port) || 80,
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
    });
    connectReq.once('connect', (res, socket) => {
      const status = res.statusCode || 0;
      if (status < 200 || status >= 300) {
        socket.destroy();
        finish(new HacHttpError(`proxy CONNECT failed (status ${status})`, { status, phase: 'connect' }));
        return;
      }
      /** @type {import('node:tls').ConnectionOptions} */
      const tlsOptions = {
        socket,
        rejectUnauthorized: options.rejectUnauthorized,
        ca: options.ca,
      };
      const servername = options.servername || host;
      if (servername && !net.isIP(servername)) tlsOptions.servername = servername;
      finish(null, tls.connect(tlsOptions));
    });
    connectReq.once('error', (err) => finish(err));
    connectReq.end();
    return undefined;
  }
}

/**
 * Creates the agent and request-target helper for a proxied transport.
 *
 * @param {{ proxy: ProxyConfig, targetProtocol: string, agentOptions: https.AgentOptions }} input
 * @returns {{ agent: http.Agent, tunnel: boolean }}
 */
function createProxyAgent({ proxy, targetProtocol, agentOptions }) {
  if (targetProtocol === 'https:') {
    return { agent: new TunnelingAgent(agentOptions, proxy), tunnel: true };
  }
  return { agent: new http.Agent(agentOptions), tunnel: false };
}

module.exports = { selectProxy, matchesNoProxy, proxyAuthHeader, createProxyAgent, TunnelingAgent };
