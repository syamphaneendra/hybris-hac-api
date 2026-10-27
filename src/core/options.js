'use strict';

/**
 * Configuration resolution: explicit options > environment > defaults.
 *
 * - An option wins whenever it is not `undefined`, so falsy values such as
 *   `retries: 0`, `retryDelayMs: 0` or `contextPath: ''` are honoured.
 * - An environment variable counts only when it is set and not `''`.
 * - Validation errors name the option/variable and the rule, never the value
 *   (only the HAC_CA_CERT path is echoed, because a path is not secret).
 */

const fs = require('node:fs');
const { HacConfigError } = require('./errors');
const { createLogger } = require('./logger');
const { buildSecrets } = require('./redact');
const { parseVersion, usesLegacyScriptingEndpoint } = require('./version');
const { selectProxy } = require('../http/proxy');

/** Verbatim legacy message for a missing host. */
const MISSING_HOST_MESSAGE =
  'HAC_HOST is not configured. Please use .env file for configuration or set it via configure() method.';

/**
 * Supported environment variables (documentation source of truth).
 * @type {ReadonlyArray<Readonly<{ name: string, default: string, description: string }>>}
 */
const ENV_VARS = Object.freeze(
  [
    { name: 'HAC_HOST', default: '(required)', description: 'HAC origin, e.g. https://hac.example.com:9002 (no /hac suffix).' },
    { name: 'HAC_USER', default: 'admin', description: 'HAC user (preferred over USER_NAME).' },
    { name: 'USER_NAME', default: 'admin', description: 'Legacy fallback for HAC_USER.' },
    { name: 'HAC_PASSWORD', default: 'nimda', description: 'HAC password (preferred over PASSWORD). Never logged.' },
    { name: 'PASSWORD', default: 'nimda', description: 'Legacy fallback for HAC_PASSWORD.' },
    { name: 'HYBRIS_VERSION', default: '5.7', description: 'Versions below 5.7 use /console/<scriptType>/execute.' },
    { name: 'HAC_CONTEXT_PATH', default: '/hac', description: 'HAC web context path; "/" for the root context.' },
    { name: 'HAC_TIMEOUT_MS', default: '120000', description: 'Overall request timeout (1..86400000).' },
    { name: 'HAC_CONNECT_TIMEOUT_MS', default: '10000', description: 'TCP/TLS connect timeout (1..600000).' },
    { name: 'HAC_RETRIES', default: '1', description: '0 disables transient retries and the login restart; 1 allows one.' },
    { name: 'HAC_RETRY_DELAY_MS', default: '500', description: 'Base backoff before a retry (0..60000).' },
    { name: 'HAC_TLS_REJECT_UNAUTHORIZED', default: 'false (true when a CA is supplied)', description: 'Verify the HAC TLS certificate.' },
    { name: 'HAC_CA_CERT', default: '(unset)', description: 'Path to a PEM CA bundle used to verify HAC; turns verification on.' },
    { name: 'HAC_DEBUG', default: 'false', description: 'Print structured debug events with console.debug.' },
    { name: 'HTTP_PROXY / http_proxy', default: '(unset)', description: 'Proxy for http: HAC hosts.' },
    { name: 'HTTPS_PROXY / https_proxy', default: '(unset)', description: 'Proxy (CONNECT tunnel) for https: HAC hosts.' },
    { name: 'NO_PROXY / no_proxy', default: '(unset)', description: 'Comma list of hosts that bypass the proxy.' },
  ].map((entry) => Object.freeze(entry)),
);

const BOOLEAN_TRUE = new Set(['true', '1', 'yes']);
const BOOLEAN_FALSE = new Set(['false', '0', 'no']);
const CONTEXT_PATH_PATTERN = /^(\/[A-Za-z0-9._~%!$&'()*+,;=:@-]+)+\/?$/;

/**
 * @typedef {object} ResolvedTls
 * @property {boolean} rejectUnauthorized
 * @property {string|Buffer|Array<string|Buffer>|undefined} ca
 */

/**
 * @typedef {object} ResolvedOptions
 * @property {string} origin scheme://host:port of HAC.
 * @property {string} hostUrl HAC_HOST without trailing slash.
 * @property {string} contextPath '' (root) or '/segment…'.
 * @property {string} baseUrl hostUrl + contextPath.
 * @property {string} basePath Path part of baseUrl ('' for root).
 * @property {string} user
 * @property {string|number} hybrisVersion
 * @property {boolean} legacyScripting
 * @property {number} timeoutMs
 * @property {number} connectTimeoutMs
 * @property {0|1} retries
 * @property {number} retryDelayMs
 * @property {ResolvedTls} tls
 * @property {import('../http/proxy').ProxyConfig|null} proxy
 * @property {boolean} debug
 */

/**
 * @typedef {object} ResolveResult
 * @property {Readonly<ResolvedOptions>} resolved
 * @property {string} password
 * @property {string[]} secrets Spellings to redact.
 * @property {import('./logger').HacLogger} logger
 */

/**
 * @param {string} variable
 * @param {string} rule
 * @returns {HacConfigError}
 */
function configError(variable, rule) {
  return new HacConfigError(`${variable} ${rule}`, { variable });
}

/**
 * @param {string} name
 * @param {string} raw
 * @returns {boolean}
 */
function parseBoolean(name, raw) {
  const value = raw.trim().toLowerCase();
  if (BOOLEAN_TRUE.has(value)) return true;
  if (BOOLEAN_FALSE.has(value)) return false;
  throw configError(name, 'must be one of true/false/1/0/yes/no');
}

/**
 * @param {number} min
 * @param {number} max
 * @returns {(name: string, value: unknown) => number}
 */
function integerIn(min, max) {
  return (name, value) => {
    const number = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
      throw configError(name, `must be an integer between ${min} and ${max}`);
    }
    return number;
  };
}

/**
 * Field resolver: option (when !== undefined) > first non-empty env var > default.
 *
 * @template T
 * @param {Record<string, string|undefined>} env
 * @param {{ option: unknown, optionName: string, envNames: string[], fallback: T,
 *   parse: (name: string, value: any, fromEnv: boolean) => T }} spec
 * @returns {T}
 */
function pick(env, { option, optionName, envNames, fallback, parse }) {
  if (option !== undefined) return parse(optionName, option, false);
  for (const name of envNames) {
    const raw = env[name];
    if (raw !== undefined && raw !== '') return parse(name, raw, true);
  }
  return fallback;
}

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {{ origin: string, hostUrl: string }}
 */
function parseHost(name, value) {
  if (value === undefined || value === '') {
    throw new HacConfigError(MISSING_HOST_MESSAGE, { variable: 'HAC_HOST' });
  }
  if (typeof value !== 'string') throw configError(name, 'must be a string URL');
  /** @type {URL} */
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw configError(name, 'must be an absolute http: or https: URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw configError(name, 'must use the http: or https: scheme');
  }
  if (url.username || url.password) throw configError(name, 'must not contain user:password@ credentials');
  if (url.search || url.hash || value.includes('?') || value.includes('#')) {
    throw configError(name, 'must not contain a query string or hash');
  }
  const pathPrefix = url.pathname.replace(/\/+$/, '');
  return { origin: url.origin, hostUrl: `${url.origin}${pathPrefix}` };
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {boolean} fromEnv
 * @returns {string}
 */
function parseContextPath(name, value, fromEnv) {
  if (typeof value !== 'string') throw configError(name, 'must be a string');
  if (value === '' && !fromEnv) return '';
  if (value === '/') return '';
  if (!CONTEXT_PATH_PATTERN.test(value)) throw configError(name, 'must be "/" or "/segment[/segment...]"');
  return value.replace(/\/+$/, '');
}

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
function nonEmptyString(name, value) {
  if (typeof value !== 'string' || value.trim() === '') throw configError(name, 'must be a non-empty string');
  return value;
}

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
function anyString(name, value) {
  if (typeof value !== 'string') throw configError(name, 'must be a string');
  return value;
}

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {string|number}
 */
function parseHybrisVersion(name, value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  throw configError(name, 'must be a version string such as "5.7" or "6.7"');
}

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {string|Buffer|Array<string|Buffer>}
 */
function parseCaOption(name, value) {
  const ok = (/** @type {unknown} */ v) => typeof v === 'string' || Buffer.isBuffer(v);
  if (ok(value) || (Array.isArray(value) && value.length > 0 && value.every(ok))) {
    return /** @type {string|Buffer|Array<string|Buffer>} */ (value);
  }
  throw configError(name, 'must be a PEM string, a Buffer or an array of them');
}

/**
 * @param {string} name
 * @param {string} path
 * @returns {Buffer}
 */
function readCaFile(name, path) {
  try {
    return fs.readFileSync(path);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? ` (${String(err.code)})` : '';
    throw new HacConfigError(`${name}: cannot read CA certificate file ${path}${code}`, { variable: name });
  }
}

/**
 * Resolves and validates client options against an environment.
 *
 * @param {Record<string, any>} [options] HacClientOptions.
 * @returns {ResolveResult}
 * @throws {HacConfigError}
 */
function resolveOptions(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new HacConfigError('options must be an object', { variable: 'options' });
  }
  const env = /** @type {Record<string, string|undefined>} */ (options.env === undefined ? process.env : options.env);
  if (env === null || typeof env !== 'object') throw configError('env', 'must be an object');

  if (options.logger !== undefined && (options.logger === null || typeof options.logger !== 'object')) {
    throw configError('logger', 'must be an object with debug/info/warn methods');
  }
  const debug = pick(env, {
    option: undefined,
    optionName: 'debug',
    envNames: ['HAC_DEBUG'],
    fallback: false,
    parse: (name, raw) => parseBoolean(name, raw),
  });
  const logger = createLogger({ logger: options.logger, debug });

  const { origin, hostUrl } = parseHost(
    options.host !== undefined ? 'host' : 'HAC_HOST',
    options.host !== undefined ? options.host : env.HAC_HOST,
  );

  const user = pick(env, {
    option: options.user,
    optionName: 'user',
    envNames: ['HAC_USER', 'USER_NAME'],
    fallback: 'admin',
    parse: nonEmptyString,
  });
  const password = pick(env, {
    option: options.password,
    optionName: 'password',
    envNames: ['HAC_PASSWORD', 'PASSWORD'],
    fallback: 'nimda',
    parse: anyString,
  });
  const hybrisVersion = pick(env, {
    option: options.hybrisVersion,
    optionName: 'hybrisVersion',
    envNames: ['HYBRIS_VERSION'],
    fallback: /** @type {string|number} */ ('5.7'),
    parse: parseHybrisVersion,
  });
  if (typeof hybrisVersion === 'number') {
    logger.debug('config.version', { reason: "hybrisVersion given as number; pass a string such as '5.10'" });
  }
  if (!parseVersion(hybrisVersion)) {
    logger.debug('config.version', { reason: 'hybrisVersion is not numeric; using the modern scripting endpoint' });
  }
  const contextPath = pick(env, {
    option: options.contextPath,
    optionName: 'contextPath',
    envNames: ['HAC_CONTEXT_PATH'],
    fallback: '/hac',
    parse: parseContextPath,
  });
  const timeoutMs = pick(env, {
    option: options.timeoutMs,
    optionName: 'timeoutMs',
    envNames: ['HAC_TIMEOUT_MS'],
    fallback: 120000,
    parse: integerIn(1, 86400000),
  });
  const connectTimeoutMs = pick(env, {
    option: options.connectTimeoutMs,
    optionName: 'connectTimeoutMs',
    envNames: ['HAC_CONNECT_TIMEOUT_MS'],
    fallback: 10000,
    parse: integerIn(1, 600000),
  });
  const retries = /** @type {0|1} */ (
    pick(env, {
      option: options.retries,
      optionName: 'retries',
      envNames: ['HAC_RETRIES'],
      fallback: 1,
      parse: integerIn(0, 1),
    })
  );
  const retryDelayMs = pick(env, {
    option: options.retryDelayMs,
    optionName: 'retryDelayMs',
    envNames: ['HAC_RETRY_DELAY_MS'],
    fallback: 500,
    parse: integerIn(0, 60000),
  });

  // TLS: each sub-field resolved on its own (§10).
  const tlsOption = options.tls;
  if (tlsOption !== undefined && (tlsOption === null || typeof tlsOption !== 'object')) {
    throw configError('tls', 'must be an object');
  }
  const rejectOption = tlsOption ? tlsOption.rejectUnauthorized : undefined;
  /** @type {boolean|undefined} */
  const rejectSetting = pick(env, {
    option: rejectOption,
    optionName: 'tls.rejectUnauthorized',
    envNames: ['HAC_TLS_REJECT_UNAUTHORIZED'],
    fallback: /** @type {boolean|undefined} */ (undefined),
    parse: (name, value, fromEnv) => {
      if (fromEnv) return parseBoolean(name, value);
      if (typeof value !== 'boolean') throw configError(name, 'must be a boolean');
      return value;
    },
  });
  /** @type {string|Buffer|Array<string|Buffer>|undefined} */
  let ca = pick(env, {
    option: tlsOption ? tlsOption.ca : undefined,
    optionName: 'tls.ca',
    envNames: ['HAC_CA_CERT'],
    fallback: /** @type {string|Buffer|Array<string|Buffer>|undefined} */ (undefined),
    parse: (name, value, fromEnv) => (fromEnv ? readCaFile(name, value) : parseCaOption(name, value)),
  });
  let rejectUnauthorized = rejectSetting === undefined ? ca !== undefined : rejectSetting;
  if (ca !== undefined && rejectSetting === false) {
    logger.warn('tls.ca_ignored', { reason: 'a CA was supplied but TLS verification is explicitly disabled; the CA is ignored' });
    ca = undefined;
    rejectUnauthorized = false;
  }
  if (!rejectUnauthorized && origin.startsWith('https:')) {
    logger.debug('tls.insecure', { reason: 'TLS certificate verification is disabled (default)' });
  }

  // Proxy (option string overrides env; false disables).
  if (options.proxy !== undefined && options.proxy !== false && typeof options.proxy !== 'string') {
    throw configError('proxy', 'must be a proxy URL string or false');
  }
  const proxy = selectProxy({ hostUrl, env, option: options.proxy });
  if (proxy) logger.debug('proxy.selected', { proxy: proxy.origin, variable: proxy.variable });

  const baseUrl = `${hostUrl}${contextPath}`;
  /** @type {ResolvedOptions} */
  const resolved = {
    origin,
    hostUrl,
    contextPath,
    baseUrl,
    basePath: new URL(baseUrl).pathname.replace(/\/+$/, ''),
    user,
    hybrisVersion,
    legacyScripting: usesLegacyScriptingEndpoint(hybrisVersion),
    timeoutMs,
    connectTimeoutMs,
    retries,
    retryDelayMs,
    tls: Object.freeze({ rejectUnauthorized, ca }),
    proxy,
    debug,
  };
  return {
    resolved: Object.freeze(resolved),
    password,
    secrets: buildSecrets({ password, proxyPassword: proxy ? proxy.password : null }),
    logger,
  };
}

/**
 * Maps a legacy `config` snapshot to client options. Every falsy legacy value
 * becomes `undefined`, so the environment/defaults apply as before.
 *
 * @param {{ HAC_HOST?: unknown, HAC_USER?: unknown, HAC_PASSWORD?: unknown, HYBRIS_VERSION?: unknown }} snapshot
 * @returns {{ host?: any, user?: any, password?: any, hybrisVersion?: any }}
 */
function fromLegacyConfig(snapshot) {
  const orUndefined = (/** @type {unknown} */ v) => (v ? v : undefined);
  return {
    host: orUndefined(snapshot.HAC_HOST),
    user: orUndefined(snapshot.HAC_USER),
    password: orUndefined(snapshot.HAC_PASSWORD),
    hybrisVersion: orUndefined(snapshot.HYBRIS_VERSION),
  };
}

module.exports = { resolveOptions, fromLegacyConfig, MISSING_HOST_MESSAGE, ENV_VARS };
