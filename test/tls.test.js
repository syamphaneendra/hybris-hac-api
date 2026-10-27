'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startStubHac } = require('./helpers/stub-hac');
const { newClient, captureLogger } = require('./helpers/harness');
const { HacTransportError } = require('../index');

const CA_PATH = path.join(__dirname, 'fixtures', 'tls', 'ca.pem');

async function httpsStub(t) {
  const stub = await startStubHac({ tls: true });
  t.after(() => stub.close());
  return stub;
}

test('default: verification off (compatibility) → connects to a server with a private CA', async (t) => {
  const stub = await httpsStub(t);
  const client = newClient(stub);
  t.after(() => client.close());
  const result = await client.search('q');
  assert.equal(result.rowCount, 0);
});

test('rejectUnauthorized: true without the CA → HacTransportError with a certificate code, not retried', async (t) => {
  const stub = await httpsStub(t);
  const client = newClient(stub, { tls: { rejectUnauthorized: true } });
  t.after(() => client.close());
  await assert.rejects(client.search('q'), (err) => {
    assert.ok(err instanceof HacTransportError);
    assert.match(err.networkCode, /CERT|SIGNATURE|SELF_SIGNED|ISSUER/);
    assert.equal(err.operation, 'login');
    return true;
  });
  assert.equal(stub.requests.length, 0);
});

test('HAC_CA_CERT turns verification on and connects', async (t) => {
  const stub = await httpsStub(t);
  const client = newClient(stub, { env: { HAC_CA_CERT: CA_PATH } });
  t.after(() => client.close());
  assert.equal((await client.search('q')).rowCount, 0);

  const viaOption = newClient(stub, { tls: { ca: fs.readFileSync(CA_PATH) } });
  t.after(() => viaOption.close());
  assert.equal((await viaOption.search('q')).rowCount, 0);
});

test('CA + explicit false → connects and warns once', async (t) => {
  const stub = await httpsStub(t);
  const capture = captureLogger();
  const client = newClient(stub, { env: { HAC_CA_CERT: CA_PATH, HAC_TLS_REJECT_UNAUTHORIZED: 'false' }, logger: capture.logger });
  t.after(() => client.close());
  assert.equal((await client.search('q')).rowCount, 0);
  assert.equal(capture.lines.filter((l) => l.startsWith('warn')).length, 1);
});
