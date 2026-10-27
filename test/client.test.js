'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const { startStubHac } = require('./helpers/stub-hac');
const { newClient } = require('./helpers/harness');
const { HacClient, createHacClient, HacClientClosedError, HacConfigError } = require('../index');

test('createHacClient validates synchronously, without network I/O', () => {
  assert.throws(() => createHacClient({ env: {} }), HacConfigError);
  assert.throws(() => new HacClient({ env: {}, host: 'https://hac.example.com', timeoutMs: 0 }), HacConfigError);
  const client = createHacClient({ env: {}, host: 'https://hac.example.com' });
  assert.ok(client instanceof HacClient);
  client.close();
});

test('close() then a call → HacClientClosedError; close is idempotent; inspect/JSON hide the password', async (t) => {
  const stub = await startStubHac({ password: 'Very-Secret-1' });
  t.after(() => stub.close());
  const client = newClient(stub, { password: 'Very-Secret-1' });
  await client.search('q');
  for (const text of [util.inspect(client, { depth: Infinity, showHidden: true }), JSON.stringify(client), String(client)]) {
    assert.ok(!text.includes('Very-Secret-1'), text);
  }
  assert.match(util.inspect(client), /HacClient/);
  client.close();
  client.close();
  await assert.rejects(client.search('q'), (err) => err instanceof HacClientClosedError && err.code === 'HAC_CLIENT_CLOSED');
  await assert.rejects(client.login(), HacClientClosedError);
  await assert.rejects(client.importImpex('x'), HacClientClosedError);
  await assert.rejects(client.runScript('x'), HacClientClosedError);
});

test('login(): second call sends nothing; concurrent login + search share one login', async (t) => {
  const stub = await startStubHac();
  t.after(() => stub.close());
  const client = newClient(stub);
  t.after(() => client.close());
  assert.equal(await client.login(), undefined);
  const count = stub.requests.length;
  await client.login();
  assert.equal(stub.requests.length, count);

  const other = newClient(stub);
  t.after(() => other.close());
  stub.reset();
  await Promise.all([other.login(), other.search('q')]);
  assert.equal(stub.count('POST', '/j_spring_security_check'), 1);
});

test('close() during an in-flight call fails it; nothing keeps the process alive', async (t) => {
  const stub = await startStubHac();
  t.after(() => stub.close());
  stub.route('POST', '/console/impex/import', { hang: true });
  const client = newClient(stub);
  await client.login();
  const pending = client.importImpex('INSERT X; a\n; b');
  setTimeout(() => client.close(), 50);
  await assert.rejects(pending, (err) => err instanceof Error && err.name.startsWith('Hac'));
});

test('a failed login can be retried by the next call', async (t) => {
  const stub = await startStubHac();
  t.after(() => stub.close());
  stub.route('POST', '/j_spring_security_check', [{ status: 500 }, { pass: true }], { raw: true });
  const client = newClient(stub);
  t.after(() => client.close());
  await assert.rejects(client.search('q'));
  assert.equal((await client.search('q')).rowCount, 0);
});
