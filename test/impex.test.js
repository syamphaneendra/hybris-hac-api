'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startStubHac } = require('./helpers/stub-hac');
const { newClient } = require('./helpers/harness');
const { HacImpexError, HacInputError, HacResponseError, HacSessionExpiredError } = require('../index');

const IMPEX = '/console/impex/import';
const SCRIPT = 'INSERT_UPDATE Product; code[unique=true]; name\n; ORDER-0001; Sample';
const fixture = (rel) => fs.readFileSync(path.join(__dirname, 'fixtures', rel), 'utf8');

async function setup(t, responders) {
  const stub = await startStubHac();
  t.after(() => stub.close());
  if (responders) stub.route('POST', IMPEX, responders);
  const client = newClient(stub);
  t.after(() => client.close());
  return { stub, client };
}

test('importImpex resolves an ImpexResult after the response', async (t) => {
  const { client } = await setup(t);
  const result = await client.importImpex(SCRIPT);
  assert.deepEqual(result, { success: true, level: 'notice', message: 'Import finished successfully' });
});

test('fixture outcomes through the client', async (t) => {
  const cases = [
    ['impex/info.html', 'ok'],
    ['impex/success.html', 'ok'],
    ['impex/warning-success.html', 'ok'],
    ['impex/success-string-only.html', 'ok'],
    ['impex/error.html', HacImpexError],
    ['impex/warning-problems.html', HacImpexError],
    ['impex/impexresult-only.html', HacImpexError],
    ['impex/unknown.html', HacResponseError],
    ['impex/echo-textarea.html', HacResponseError],
  ];
  for (const [file, expected] of cases) {
    const { client } = await setup(t, { body: fixture(file) });
    if (expected === 'ok') {
      const result = await client.importImpex(SCRIPT);
      assert.equal(result.success, true, file);
    } else {
      await assert.rejects(client.importImpex(SCRIPT), (err) => err instanceof expected && err.attempts === 1 && err.operation === 'impexImport', file);
    }
  }
});

test('HacImpexError carries level and result, not the script', async (t) => {
  const { client } = await setup(t, { body: fixture('impex/error.html') });
  await assert.rejects(client.importImpex('INSERT_UPDATE Product; code[unique=true]\n; SCRIPT-MARKER'), (err) => {
    assert.ok(err instanceof HacImpexError);
    assert.equal(err.code, 'HAC_IMPEX_FAILED');
    assert.equal(err.level, 'error');
    assert.match(err.result, /unknown attributes/);
    assert.match(err.message, /^Impex import failed \(level=error\):\n/);
    assert.ok(!err.message.includes('SCRIPT-MARKER'));
    return true;
  });
});

test('login page as ImpEx result → re-login and replay; persistent → HacSessionExpiredError', async (t) => {
  const { stub, client } = await setup(t, [{ body: fixture('login/login.html') }, { pass: true }]);
  const result = await client.importImpex(SCRIPT);
  assert.equal(result.success, true);
  assert.equal(stub.count('POST', IMPEX), 2);

  const always = await setup(t, { body: fixture('login/login.html') });
  await assert.rejects(always.client.importImpex(SCRIPT), HacSessionExpiredError);
});

test('legacy-identical form fields with defaults; flags only when true', async (t) => {
  const { stub, client } = await setup(t);
  await client.importImpex(SCRIPT);
  const first = stub.requests.find((r) => r.sub === IMPEX);
  assert.deepEqual(
    first.fields.map(([k, v]) => (k === '_csrf' ? [k, typeof v] : [k, v])),
    [
      ['scriptContent', SCRIPT],
      ['validationEnum', 'IMPORT_STRICT'],
      ['maxThreads', '16'],
      ['encoding', 'UTF-8'],
      ['_legacyMode', 'on'],
      ['_enableCodeExecution', 'on'],
      ['_csrf', 'string'],
    ],
  );
  assert.equal(first.field('_csrf'), first.headers['x-csrf-token'], 'CSRF in body and header');

  stub.reset();
  await client.importImpex(SCRIPT, { validationMode: 'IMPORT_RELAXED', maxThreads: 4, encoding: 'ISO-8859-1', legacyMode: true, enableCodeExecution: true });
  const second = stub.requests.find((r) => r.sub === IMPEX);
  assert.deepEqual(
    second.fields.map(([k]) => k),
    ['scriptContent', 'validationEnum', 'maxThreads', 'encoding', 'legacyMode', '_legacyMode', 'enableCodeExecution', '_enableCodeExecution', '_csrf'],
  );
  assert.equal(second.field('validationEnum'), 'IMPORT_RELAXED');
  assert.equal(second.field('maxThreads'), '4');
  assert.equal(second.field('legacyMode'), 'true');
});

test('input validation rejects before any request', async (t) => {
  const { stub, client } = await setup(t);
  const bad = [
    ['', undefined, 'script'],
    ['   ', undefined, 'script'],
    [42, undefined, 'script'],
    [SCRIPT, { maxThreads: 0 }, 'maxThreads'],
    [SCRIPT, { maxThreads: 65 }, 'maxThreads'],
    [SCRIPT, { maxThreads: 2.5 }, 'maxThreads'],
    [SCRIPT, { validationMode: 'IMPORT_LOOSE' }, 'validationMode'],
    [SCRIPT, { legacyMode: 'yes' }, 'legacyMode'],
    [SCRIPT, { timeoutMs: -1 }, 'timeoutMs'],
    [SCRIPT, { retryOnTransientError: 1 }, 'retryOnTransientError'],
    [SCRIPT, 'options', 'options'],
  ];
  for (const [script, options, argument] of bad) {
    await assert.rejects(client.importImpex(script, options), (err) => err instanceof HacInputError && err.argument === argument, argument);
  }
  assert.equal(stub.requests.length, 0);
});
