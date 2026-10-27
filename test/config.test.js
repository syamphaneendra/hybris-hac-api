'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const util = require('node:util');
const { resolveOptions, fromLegacyConfig, MISSING_HOST_MESSAGE, ENV_VARS } = require('../src/core/options');
const { HacConfigError } = require('../src/core/errors');
const { captureLogger } = require('./helpers/harness');

const HOST = 'https://hac.example.com:9002';
const CA_PATH = path.join(__dirname, 'fixtures', 'tls', 'ca.pem');

/** @param {object} options */
const resolve = (options) => resolveOptions({ env: {}, ...options });

/**
 * @param {() => unknown} fn
 * @param {string} variable
 */
function assertConfigError(fn, variable) {
  assert.throws(fn, (err) => err instanceof HacConfigError && err.code === 'HAC_CONFIG' && err.variable === variable);
}

test('defaults', () => {
  const { resolved, password } = resolve({ host: HOST });
  assert.equal(resolved.origin, HOST);
  assert.equal(resolved.contextPath, '/hac');
  assert.equal(resolved.baseUrl, `${HOST}/hac`);
  assert.equal(resolved.user, 'admin');
  assert.equal(password, 'nimda');
  assert.equal(resolved.hybrisVersion, '5.7');
  assert.equal(resolved.timeoutMs, 120000);
  assert.equal(resolved.connectTimeoutMs, 10000);
  assert.equal(resolved.retries, 1);
  assert.equal(resolved.retryDelayMs, 500);
  assert.equal(resolved.tls.rejectUnauthorized, false);
  assert.equal(resolved.proxy, null);
  assert.ok(Object.isFrozen(resolved));
  assert.ok(!JSON.stringify(resolved).includes('nimda'));
});

test('env names: HAC_USER/HAC_PASSWORD preferred over USER_NAME/PASSWORD; empty string is unset', () => {
  const env = { HAC_HOST: HOST, HAC_USER: 'hac-user', USER_NAME: 'legacy-user', HAC_PASSWORD: '', PASSWORD: 'legacy-pass' };
  const { resolved, password } = resolveOptions({ env });
  assert.equal(resolved.user, 'hac-user');
  assert.equal(password, 'legacy-pass');
  const legacyOnly = resolveOptions({ env: { HAC_HOST: HOST, USER_NAME: 'legacy-user' } });
  assert.equal(legacyOnly.resolved.user, 'legacy-user');
});

test('options win over env, including falsy values', () => {
  const env = { HAC_HOST: 'http://ignored.example.com', HAC_RETRIES: '1', HAC_RETRY_DELAY_MS: '900', HAC_CONTEXT_PATH: '/x', HAC_TIMEOUT_MS: '5' };
  const { resolved } = resolveOptions({ env, host: HOST, retries: 0, retryDelayMs: 0, contextPath: '' });
  assert.equal(resolved.origin, HOST);
  assert.equal(resolved.retries, 0);
  assert.equal(resolved.retryDelayMs, 0);
  assert.equal(resolved.contextPath, '');
  assert.equal(resolved.baseUrl, HOST);
  assert.equal(resolved.timeoutMs, 5);
});

test('context path normalisation', () => {
  assert.equal(resolveOptions({ env: { HAC_HOST: HOST, HAC_CONTEXT_PATH: '/' } }).resolved.contextPath, '');
  assert.equal(resolveOptions({ env: { HAC_HOST: HOST, HAC_CONTEXT_PATH: '' } }).resolved.contextPath, '/hac');
  assert.equal(resolve({ host: HOST, contextPath: '/' }).resolved.contextPath, '');
  assert.equal(resolve({ host: HOST, contextPath: '/admin/hac/' }).resolved.contextPath, '/admin/hac');
  assertConfigError(() => resolve({ host: HOST, contextPath: 'hac' }), 'contextPath');
  assertConfigError(() => resolveOptions({ env: { HAC_HOST: HOST, HAC_CONTEXT_PATH: 'x y' } }), 'HAC_CONTEXT_PATH');
});

test('host validation (no userinfo/query/hash, http(s) only, trailing slash removed)', () => {
  assert.equal(resolve({ host: `${HOST}/` }).resolved.hostUrl, HOST);
  assert.equal(resolve({ host: `${HOST}/prefix/` }).resolved.baseUrl, `${HOST}/prefix/hac`);
  assertConfigError(() => resolve({ host: 'ftp://hac.example.com' }), 'host');
  assertConfigError(() => resolve({ host: 'not a url' }), 'host');
  assertConfigError(() => resolve({ host: `${HOST}?a=1` }), 'host');
  assertConfigError(() => resolve({ host: `${HOST}#x` }), 'host');
  assertConfigError(() => resolveOptions({ env: { HAC_HOST: 'https://u:p@hac.example.com' } }), 'HAC_HOST');
});

test('missing HAC_HOST keeps the legacy message verbatim', () => {
  for (const options of [{ env: {} }, { env: { HAC_HOST: '' } }, { env: {}, host: '' }]) {
    assert.throws(
      () => resolveOptions(options),
      (err) => err instanceof HacConfigError && err.message === MISSING_HOST_MESSAGE && err.variable === 'HAC_HOST',
    );
  }
  assert.equal(
    MISSING_HOST_MESSAGE,
    'HAC_HOST is not configured. Please use .env file for configuration or set it via configure() method.',
  );
});

test('invalid numeric and boolean values name the variable', () => {
  const cases = [
    [{ env: { HAC_HOST: HOST, HAC_TIMEOUT_MS: 'abc' } }, 'HAC_TIMEOUT_MS'],
    [{ env: { HAC_HOST: HOST, HAC_TIMEOUT_MS: '0' } }, 'HAC_TIMEOUT_MS'],
    [{ env: { HAC_HOST: HOST, HAC_CONNECT_TIMEOUT_MS: '600001' } }, 'HAC_CONNECT_TIMEOUT_MS'],
    [{ env: { HAC_HOST: HOST, HAC_RETRIES: '2' } }, 'HAC_RETRIES'],
    [{ env: { HAC_HOST: HOST, HAC_RETRY_DELAY_MS: '-1' } }, 'HAC_RETRY_DELAY_MS'],
    [{ env: { HAC_HOST: HOST, HAC_TLS_REJECT_UNAUTHORIZED: 'maybe' } }, 'HAC_TLS_REJECT_UNAUTHORIZED'],
    [{ env: { HAC_HOST: HOST, HAC_DEBUG: 'sure' } }, 'HAC_DEBUG'],
    [{ env: {}, host: HOST, retries: null }, 'retries'],
    [{ env: {}, host: HOST, retries: 2 }, 'retries'],
    [{ env: {}, host: HOST, timeoutMs: 1.5 }, 'timeoutMs'],
    [{ env: {}, host: HOST, user: '' }, 'user'],
    [{ env: {}, host: HOST, password: 5 }, 'password'],
    [{ env: {}, host: HOST, hybrisVersion: null }, 'hybrisVersion'],
    [{ env: {}, host: HOST, tls: { rejectUnauthorized: 'yes' } }, 'tls.rejectUnauthorized'],
    [{ env: {}, host: HOST, tls: { ca: 42 } }, 'tls.ca'],
    [{ env: {}, host: HOST, proxy: 42 }, 'proxy'],
  ];
  for (const [options, variable] of cases) assertConfigError(() => resolveOptions(options), variable);
  assert.throws(() => resolveOptions(null), HacConfigError);
});

test('config error messages never echo the value (userinfo marker)', () => {
  const marker = 'Pw-Mark3r';
  let caught;
  try {
    resolveOptions({ env: { HAC_HOST: `https://u:${marker}@127.0.0.1:1` } });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof HacConfigError);
  for (const text of [caught.message, JSON.stringify(caught), util.inspect(caught)]) {
    assert.ok(!text.includes(marker), text);
  }
});

test('booleans accept true/false/1/0/yes/no in any case', () => {
  for (const [raw, expected] of [['TRUE', true], ['1', true], ['Yes', true], ['false', false], ['0', false], ['NO', false]]) {
    const { resolved } = resolveOptions({ env: { HAC_HOST: HOST, HAC_TLS_REJECT_UNAUTHORIZED: raw } });
    assert.equal(resolved.tls.rejectUnauthorized, expected, raw);
  }
});

test('TLS: CA turns verification on; explicit false + CA ignores the CA with one warn', () => {
  const viaEnv = resolveOptions({ env: { HAC_HOST: HOST, HAC_CA_CERT: CA_PATH } });
  assert.equal(viaEnv.resolved.tls.rejectUnauthorized, true);
  assert.ok(Buffer.isBuffer(viaEnv.resolved.tls.ca));

  const capture = captureLogger();
  const ignored = resolve({ host: HOST, logger: capture.logger, tls: { rejectUnauthorized: false, ca: 'PEM' } });
  assert.equal(ignored.resolved.tls.rejectUnauthorized, false);
  assert.equal(ignored.resolved.tls.ca, undefined);
  assert.equal(capture.lines.filter((l) => l.startsWith('warn')).length, 1);

  // option on one sub-field does not hide the env var of the other
  const mixed = resolveOptions({ env: { HAC_HOST: HOST, HAC_CA_CERT: CA_PATH }, tls: { rejectUnauthorized: true } });
  assert.ok(Buffer.isBuffer(mixed.resolved.tls.ca));

  assert.throws(
    () => resolveOptions({ env: { HAC_HOST: HOST, HAC_CA_CERT: '/nonexistent/ca.pem' } }),
    (err) => err instanceof HacConfigError && err.variable === 'HAC_CA_CERT' && err.message.includes('/nonexistent/ca.pem'),
  );
});

test('hybrisVersion given as a number logs one debug event', () => {
  const capture = captureLogger();
  const { resolved } = resolve({ host: HOST, hybrisVersion: 5.1, logger: capture.logger });
  assert.equal(resolved.legacyScripting, true);
  assert.equal(capture.lines.filter((l) => l.includes('given as number')).length, 1);
  assert.equal(resolve({ host: HOST, hybrisVersion: '5.10' }).resolved.legacyScripting, false);
});

test('proxy env/option validation names the variable only', () => {
  assertConfigError(() => resolveOptions({ env: { HAC_HOST: HOST, HTTPS_PROXY: 'not a url' } }), 'HTTPS_PROXY');
  assertConfigError(() => resolveOptions({ env: { HAC_HOST: HOST, https_proxy: 'https://proxy.example.com' } }), 'https_proxy');
  assertConfigError(() => resolve({ host: HOST, proxy: 'https://proxy.example.com:3128' }), 'proxy');
  let caught;
  try {
    resolveOptions({ env: { HAC_HOST: HOST, HTTPS_PROXY: 'https://u:Px-Mark3r@proxy.example.com' } });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught && !caught.message.includes('Px-Mark3r'));
  const { resolved, secrets } = resolveOptions({ env: { HAC_HOST: HOST, HTTPS_PROXY: 'http://u:Px-Mark3r@proxy.example.com:3128' } });
  assert.equal(resolved.proxy.origin, 'http://proxy.example.com:3128');
  assert.ok(secrets.includes('Px-Mark3r'));
});

test('fromLegacyConfig maps falsy values to undefined', () => {
  assert.deepEqual(fromLegacyConfig({ HAC_HOST: '', HAC_USER: 'admin', HAC_PASSWORD: undefined, HYBRIS_VERSION: 0 }), {
    host: undefined,
    user: 'admin',
    password: undefined,
    hybrisVersion: undefined,
  });
  // host '' from the legacy config falls back to env, then the verbatim message
  assert.throws(() => resolveOptions({ env: {}, ...fromLegacyConfig({ HAC_HOST: '' }) }), { message: MISSING_HOST_MESSAGE });
  assert.equal(resolveOptions({ env: { HAC_HOST: HOST }, ...fromLegacyConfig({ HAC_HOST: '' }) }).resolved.origin, HOST);
});

test('ENV_VARS documents every supported variable', () => {
  const names = ENV_VARS.map((v) => v.name).join(' ');
  for (const name of ['HAC_HOST', 'HAC_USER', 'USER_NAME', 'HAC_PASSWORD', 'PASSWORD', 'HYBRIS_VERSION', 'HAC_CONTEXT_PATH', 'HAC_TIMEOUT_MS', 'HAC_CONNECT_TIMEOUT_MS', 'HAC_RETRIES', 'HAC_RETRY_DELAY_MS', 'HAC_TLS_REJECT_UNAUTHORIZED', 'HAC_CA_CERT', 'HAC_DEBUG', 'HTTPS_PROXY', 'NO_PROXY']) {
    assert.ok(names.includes(name), name);
  }
});
