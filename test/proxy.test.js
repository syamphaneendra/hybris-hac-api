'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const util = require('node:util');
const { selectProxy, matchesNoProxy } = require('../src/http/proxy');
const { startStubHac } = require('./helpers/stub-hac');
const { startStubProxy } = require('./helpers/stub-proxy');
const { newClient, captureLogger, freePort } = require('./helpers/harness');
const { HacHttpError, HacTransportError } = require('../index');

const CA_PATH = path.join(__dirname, 'fixtures', 'tls', 'ca.pem');
const PROXY_SECRET = 'Px-Mark3r';

test('matchesNoProxy: *, exact, .suffix, trimmed lists', () => {
  assert.equal(matchesNoProxy('hac.example.com', '*'), true);
  assert.equal(matchesNoProxy('hac.example.com', 'other.com, hac.example.com'), true);
  assert.equal(matchesNoProxy('hac.example.com', '.example.com'), true);
  assert.equal(matchesNoProxy('hac.example.com', 'example.com'), false);
  assert.equal(matchesNoProxy('hac.example.com', ''), false);
  assert.equal(matchesNoProxy('127.0.0.1', 'localhost,127.0.0.1'), true);
});

test('selectProxy: scheme-specific env, lower-case first, NO_PROXY, option override and false', () => {
  const https = 'https://hac.example.com:9002';
  const http = 'http://hac.example.com:9001';
  const env = { HTTPS_PROXY: 'http://upper.example.com:1', https_proxy: 'http://lower.example.com:2', HTTP_PROXY: 'http://plain.example.com:3' };
  assert.equal(selectProxy({ hostUrl: https, env }).origin, 'http://lower.example.com:2');
  assert.equal(selectProxy({ hostUrl: https, env: { HTTPS_PROXY: 'http://upper.example.com:1' } }).variable, 'HTTPS_PROXY');
  assert.equal(selectProxy({ hostUrl: http, env }).origin, 'http://plain.example.com:3');
  assert.equal(selectProxy({ hostUrl: https, env: { HTTP_PROXY: 'http://plain.example.com:3' } }), null);
  assert.equal(selectProxy({ hostUrl: https, env: { ...env, NO_PROXY: '.example.com' } }), null);
  assert.equal(selectProxy({ hostUrl: https, env: { ...env, no_proxy: 'other.com', NO_PROXY: '*' } }).origin, 'http://lower.example.com:2');
  assert.equal(selectProxy({ hostUrl: https, env, option: false }), null);
  const explicit = selectProxy({ hostUrl: https, env: { NO_PROXY: '*' }, option: 'http://u:p%40ss@opt.example.com:8080' });
  assert.equal(explicit.origin, 'http://opt.example.com:8080');
  assert.equal(explicit.authHeader, `Basic ${Buffer.from('u:p@ss').toString('base64')}`);
  assert.equal(explicit.password, 'p@ss');
});

async function setup(t, { tls = false, auth = null } = {}) {
  const stub = await startStubHac({ tls });
  t.after(() => stub.close());
  const proxy = await startStubProxy({ auth });
  t.after(() => proxy.close());
  return { stub, proxy };
}

test('http HAC through HTTP_PROXY: absolute-form requests, Host of HAC', async (t) => {
  const { stub, proxy } = await setup(t);
  const client = newClient(stub, { env: { HTTP_PROXY: proxy.url } });
  t.after(() => client.close());
  await client.search('q');
  assert.ok(proxy.requests.length >= 3);
  for (const r of proxy.requests) assert.ok(r.url.startsWith(`${stub.origin}/hac/`), r.url);
  for (const r of stub.requests) assert.equal(r.headers.host, `127.0.0.1:${stub.port}`);
  assert.equal(stub.count('POST', '/console/flexsearch/execute'), 1);
});

test('https HAC through HTTPS_PROXY: CONNECT tunnel with HAC_CA_CERT verification', async (t) => {
  const { stub, proxy } = await setup(t, { tls: true });
  const client = newClient(stub, { env: { HTTPS_PROXY: proxy.url, HAC_CA_CERT: CA_PATH } });
  t.after(() => client.close());
  await client.search('q');
  assert.ok(proxy.connects.length >= 1);
  assert.equal(proxy.connects[0].target, `127.0.0.1:${stub.port}`);
  assert.equal(proxy.requests.length, 0, 'no plaintext requests through the proxy');
  assert.equal(stub.count('POST', '/console/flexsearch/execute'), 1);
});

test('NO_PROXY=127.0.0.1 → direct connection', async (t) => {
  const { stub, proxy } = await setup(t);
  const client = newClient(stub, { env: { HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1' } });
  t.after(() => client.close());
  await client.search('q');
  assert.equal(proxy.requests.length + proxy.connects.length, 0);
  const disabled = newClient(stub, { env: { HTTP_PROXY: proxy.url }, proxy: false });
  t.after(() => disabled.close());
  await disabled.search('q');
  assert.equal(proxy.requests.length, 0);
});

test('proxy auth accepted; wrong auth → 407 (http) / CONNECT 407 (https), never retried; password never logged', async (t) => {
  const httpSetup = await setup(t, { auth: `user:${PROXY_SECRET}` });
  const capture = captureLogger();
  const ok = newClient(httpSetup.stub, { env: { HTTP_PROXY: `http://user:${PROXY_SECRET}@127.0.0.1:${httpSetup.proxy.port}`, HAC_DEBUG: 'true' }, logger: capture.logger });
  t.after(() => ok.close());
  await ok.search('q');
  assert.ok(capture.lines.length > 0);
  assert.ok(!capture.text().includes(PROXY_SECRET));
  assert.ok(capture.text().includes(`http://127.0.0.1:${httpSetup.proxy.port}`));

  const wrong = newClient(httpSetup.stub, { proxy: `http://user:nope@127.0.0.1:${httpSetup.proxy.port}` });
  t.after(() => wrong.close());
  await assert.rejects(wrong.search('q'), (err) => err instanceof HacHttpError && err.status === 407);

  const tlsSetup = await setup(t, { tls: true, auth: `user:${PROXY_SECRET}` });
  const tunnelOk = newClient(tlsSetup.stub, { proxy: `http://user:${PROXY_SECRET}@127.0.0.1:${tlsSetup.proxy.port}` });
  t.after(() => tunnelOk.close());
  await tunnelOk.search('q');

  const before = tlsSetup.proxy.connects.length;
  const tunnelBad = newClient(tlsSetup.stub, { proxy: `http://user:${PROXY_SECRET}x@127.0.0.1:${tlsSetup.proxy.port}` });
  t.after(() => tunnelBad.close());
  await assert.rejects(tunnelBad.search('q'), (err) => {
    assert.ok(err instanceof HacHttpError);
    assert.equal(err.status, 407);
    assert.equal(err.phase, 'connect');
    assert.match(err.message, /proxy CONNECT failed \(status 407\)/);
    for (const text of [err.message, JSON.stringify(err), util.inspect(err, { depth: Infinity })]) {
      assert.ok(!text.includes(PROXY_SECRET), text);
    }
    return true;
  });
  assert.equal(tlsSetup.proxy.connects.length - before, 1, 'CONNECT failure not retried');
});

test('proxy unreachable → connect-phase HacTransportError retried once, even for importImpex', async (t) => {
  const stub = await startStubHac();
  t.after(() => stub.close());
  const port = await freePort();
  let sleeps = 0;
  const client = newClient(stub, {
    proxy: `http://user:${PROXY_SECRET}@127.0.0.1:${port}`,
    [Symbol.for('hybris-hac-api.test')]: { sleep: async () => void sleeps++ },
  });
  t.after(() => client.close());
  await assert.rejects(client.importImpex('INSERT X; a\n; b'), (err) => {
    assert.ok(err instanceof HacTransportError);
    assert.equal(err.networkCode, 'ECONNREFUSED');
    assert.equal(err.connectPhase, true);
    for (const text of [err.message, err.stack, JSON.stringify(err), util.inspect(err, { depth: Infinity })]) {
      assert.ok(!text.includes(PROXY_SECRET), text);
    }
    return true;
  });
  assert.equal(sleeps, 1, 'one restart of the login sequence');
});
