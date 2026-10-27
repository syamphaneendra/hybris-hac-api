'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startStubHac } = require('./helpers/stub-hac');
const { newClient, freePort, TEST_HOOKS } = require('./helpers/harness');
const { HacCsrfError, HacHttpError, HacImpexError, HacSessionExpiredError, HacTimeoutError, HacTransportError } = require('../index');

const FLEX = '/console/flexsearch/execute';
const IMPEX = '/console/impex/import';
const SCRIPT_PATH = '/console/scripting/execute';
const ROWS = { json: { headers: ['p_code'], resultList: [['ORDER-0001']], exception: null } };

async function setup(t, clientOptions) {
  const stub = await startStubHac();
  t.after(() => stub.close());
  const client = newClient(stub, clientOptions);
  t.after(() => client.close());
  await client.login();
  stub.reset();
  return { stub, client };
}

test('safe search: ECONNRESET then 200, 503 then 200 succeed in 2 attempts; 502 twice → HacHttpError{attempts:2}', async (t) => {
  const reset = await setup(t);
  reset.stub.route('POST', FLEX, [{ reset: true }, ROWS]);
  assert.equal((await reset.client.search('q')).rowCount, 1);
  assert.equal(reset.stub.count('POST', FLEX), 2);

  const gateway = await setup(t);
  gateway.stub.route('POST', FLEX, [{ status: 503 }, ROWS]);
  assert.equal((await gateway.client.search('q')).rowCount, 1);
  assert.equal(gateway.stub.count('POST', FLEX), 2);

  const bad = await setup(t);
  bad.stub.route('POST', FLEX, { status: 502 });
  await assert.rejects(bad.client.search('q'), (err) => err instanceof HacHttpError && err.status === 502 && err.attempts === 2);
});

test('unsafe ops: mid-flight reset and 503 are not retried by default; retryOnTransientError: true allows one retry', async (t) => {
  for (const [path, call] of [
    [IMPEX, (c) => c.importImpex('INSERT Product; code\n; ORDER-0001')],
    [SCRIPT_PATH, (c) => c.runScript('println 1')],
  ]) {
    const reset = await setup(t);
    reset.stub.route('POST', path, { reset: true });
    await assert.rejects(call(reset.client), (err) => err instanceof HacTransportError && err.attempts === 1);
    assert.equal(reset.stub.count('POST', path), 1);

    const unavailable = await setup(t);
    unavailable.stub.route('POST', path, { status: 503 });
    await assert.rejects(call(unavailable.client), (err) => err instanceof HacHttpError && err.status === 503 && err.attempts === 1);
    assert.equal(unavailable.stub.count('POST', path), 1);
  }

  const optIn = await setup(t);
  optIn.stub.route('POST', IMPEX, [{ status: 503 }, { pass: true }]);
  const result = await optIn.client.importImpex('INSERT Product; code\n; ORDER-0001', { retryOnTransientError: true });
  assert.equal(result.success, true);
  assert.equal(optIn.stub.count('POST', IMPEX), 2);
});

test('per-call false disables retries for safe ops; retries: 0 wins over per-call true', async (t) => {
  const off = await setup(t);
  off.stub.route('POST', FLEX, [{ status: 503 }, ROWS]);
  await assert.rejects(off.client.search('q', { retryOnTransientError: false }), (err) => err instanceof HacHttpError && err.status === 503 && err.attempts === 1);

  const zero = await setup(t, { retries: 0 });
  zero.stub.route('POST', IMPEX, [{ status: 503 }, { pass: true }]);
  await assert.rejects(zero.client.importImpex('INSERT X; a\n; b', { retryOnTransientError: true }), (err) => err instanceof HacHttpError && err.attempts === 1);
  assert.equal(zero.stub.count('POST', IMPEX), 1);
});

test('connection refused is retried (connect phase) even for impex, once the server comes up', async (t) => {
  const stub = await startStubHac();
  t.after(() => stub.close());
  let sleeps = 0;
  // The backoff "sleep" brings the server back up, so there is no timing race.
  const client = newClient(stub, { [TEST_HOOKS]: { sleep: async () => { sleeps++; await stub.resume(); } } });
  t.after(() => client.close());
  await client.login();
  await stub.suspend();
  stub.reset();
  const result = await client.importImpex('INSERT Product; code\n; ORDER-0001');
  assert.equal(result.success, true);
  assert.equal(sleeps, 1);
  assert.equal(stub.count('POST', IMPEX), 1, 'the refused attempt never reached the server');
});

test('fresh client, connection refused at login: whole login restarted once, then the server answers', async (t) => {
  const stub = await startStubHac();
  t.after(() => stub.close());
  await stub.suspend();
  const client = newClient(stub, { [TEST_HOOKS]: { sleep: () => stub.resume() } });
  t.after(() => client.close());
  const result = await client.importImpex('INSERT Product; code\n; ORDER-0001');
  assert.equal(result.success, true);
});

test('connection refused: retries 0 → single attempt; impex with retryOnTransientError: false → single attempt', async (t) => {
  const port = await freePort();
  const { createHacClient } = require('../index');
  let sleeps = 0;
  const hooks = { random: () => 0, sleep: async () => void sleeps++ };
  const zero = createHacClient({ host: `http://127.0.0.1:${port}`, env: {}, retries: 0, [TEST_HOOKS]: hooks });
  t.after(() => zero.close());
  await assert.rejects(zero.importImpex('INSERT X; a\n; b'), (err) => err instanceof HacTransportError && err.networkCode === 'ECONNREFUSED' && err.operation === 'login');
  assert.equal(sleeps, 0);

  // Already-authenticated client whose server disappears: operation-level connect retry disabled per call.
  const stub = await startStubHac();
  t.after(() => stub.close());
  const client = newClient(stub, { [TEST_HOOKS]: hooks });
  t.after(() => client.close());
  await client.login();
  await stub.suspend();
  await assert.rejects(client.importImpex('INSERT X; a\n; b', { retryOnTransientError: false }), (err) => {
    assert.ok(err instanceof HacTransportError);
    assert.equal(err.networkCode, 'ECONNREFUSED');
    assert.equal(err.attempts, 1);
    assert.equal(err.operation, 'impexImport');
    return true;
  });
  assert.equal(sleeps, 0);
});

test('never retried: 400, 404, HAC-reported failures, response timeout', async (t) => {
  for (const status of [400, 404, 500]) {
    const { stub, client } = await setup(t);
    stub.route('POST', FLEX, { status });
    await assert.rejects(client.search('q'), (err) => err instanceof HacHttpError && err.status === status && err.attempts === 1);
    assert.equal(stub.count('POST', FLEX), 1);
  }
  const reported = await setup(t);
  reported.stub.route('POST', IMPEX, { body: '<span data-level="error" data-result="Import has encountered problems"></span>' });
  await assert.rejects(reported.client.importImpex('INSERT X; a\n; b', { retryOnTransientError: true }), (err) => err instanceof HacImpexError && err.attempts === 1);

  const slow = await setup(t);
  slow.stub.route('POST', FLEX, { hang: true });
  await assert.rejects(slow.client.search('q', { timeoutMs: 100 }), (err) => err instanceof HacTimeoutError && err.phase === 'response' && err.attempts === 1);
  assert.equal(slow.stub.count('POST', FLEX), 1);
});

test('per-call cap: [503, 403, login redirect] → HacSessionExpiredError{attempts:3}, one refresh GET', async (t) => {
  const { stub, client } = await setup(t);
  stub.route('POST', FLEX, [{ status: 503 }, { status: 403 }, { redirect: '/hac/login.jsp' }], { raw: true });
  await assert.rejects(client.search('q'), (err) => err instanceof HacSessionExpiredError && err.attempts === 3);
  assert.equal(stub.count('POST', FLEX), 3);
  assert.equal(stub.count('GET', '/console/impex/import'), 1);
});

test('budget errors: [403, 403] → HacCsrfError{attempts:2}; [503, 503] → HacHttpError{attempts:2}; 403 + refresh on login page → re-login → success', async (t) => {
  const csrf = await setup(t);
  csrf.stub.route('POST', FLEX, { status: 403 }, { raw: true });
  await assert.rejects(csrf.client.search('q'), (err) => err instanceof HacCsrfError && err.attempts === 2);

  const gateway = await setup(t);
  gateway.stub.route('POST', FLEX, { status: 503 });
  await assert.rejects(gateway.client.search('q'), (err) => err instanceof HacHttpError && err.status === 503 && err.attempts === 2);

  const relogin = await setup(t);
  relogin.stub.route('POST', FLEX, [{ status: 403 }, ROWS], { raw: true });
  relogin.stub.route('GET', '/console/impex/import', [{ redirect: '/hac/login.jsp' }, { pass: true }], { raw: true });
  const result = await relogin.client.search('q');
  assert.equal(result.rowCount, 1);
  assert.equal(relogin.stub.count('POST', '/j_spring_security_check'), 1);
  assert.equal(relogin.stub.count('POST', FLEX), 2);
});

test('403 whose CSRF refresh GET is reset → HacTransportError{ECONNRESET, attempts:1, operation:search}, refresh not retried', async (t) => {
  const { stub, client } = await setup(t);
  stub.route('POST', FLEX, [{ status: 403 }, ROWS], { raw: true });
  stub.route('GET', '/console/impex/import', { reset: true }, { raw: true });
  await assert.rejects(client.search('q'), (err) => {
    assert.ok(err instanceof HacTransportError);
    assert.equal(err.networkCode, 'ECONNRESET');
    assert.equal(err.attempts, 1);
    assert.equal(err.operation, 'search');
    return true;
  });
  assert.equal(stub.count('GET', '/console/impex/import'), 1);
  assert.equal(stub.count('POST', FLEX), 1);
});
