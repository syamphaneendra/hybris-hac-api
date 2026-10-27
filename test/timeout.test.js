'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startStubHac } = require('./helpers/stub-hac');
const { newClient } = require('./helpers/harness');
const { HacTimeoutError } = require('../index');

const FLEX = '/console/flexsearch/execute';

test('client timeoutMs: a stub that never answers → HacTimeoutError{phase:response} within a bounded time', async (t) => {
  const stub = await startStubHac();
  t.after(() => stub.close());
  stub.route('POST', FLEX, { hang: true });
  const client = newClient(stub, { timeoutMs: 100 });
  t.after(() => client.close());
  await client.login();
  const started = Date.now();
  await assert.rejects(client.search('q'), (err) => {
    assert.ok(err instanceof HacTimeoutError);
    assert.equal(err.code, 'HAC_TIMEOUT');
    assert.equal(err.phase, 'response');
    assert.equal(err.timeoutMs, 100);
    assert.equal(err.operation, 'search');
    return true;
  });
  assert.ok(Date.now() - started < 2000);
});

test('per-call timeoutMs overrides the client value for that call only', async (t) => {
  const stub = await startStubHac();
  t.after(() => stub.close());
  stub.route('POST', FLEX, [{ hang: true }, { delayMs: 150, json: { headers: [], resultList: [], exception: null } }]);
  const client = newClient(stub, { timeoutMs: 5000 });
  t.after(() => client.close());
  await assert.rejects(client.search('q', { timeoutMs: 80 }), (err) => err instanceof HacTimeoutError && err.timeoutMs === 80);
  const result = await client.search('q');
  assert.equal(result.rowCount, 0);
});
