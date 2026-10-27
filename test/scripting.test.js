'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startStubHac } = require('./helpers/stub-hac');
const { newClient } = require('./helpers/harness');
const { HacInputError, HacResponseError, HacScriptError } = require('../index');

const MODERN = '/console/scripting/execute';

async function setup(t, clientOptions, route) {
  const stub = await startStubHac();
  t.after(() => stub.close());
  if (route) stub.route('POST', route.path, route.responders);
  const client = newClient(stub, clientOptions);
  t.after(() => client.close());
  return { stub, client };
}

test('runScript returns output/result/raw and sends exactly script, scriptType, commit', async (t) => {
  const raw = { outputText: 'hello\n', executionResult: 'ORDER-0001', stacktraceText: '' };
  const { stub, client } = await setup(t, {}, { path: MODERN, responders: { json: raw } });
  const result = await client.runScript('println "hello"', { commit: false });
  assert.deepEqual(result, { output: 'hello\n', result: 'ORDER-0001', raw });
  const post = stub.requests.find((r) => r.sub === MODERN);
  assert.deepEqual(post.fields, [
    ['script', 'println "hello"'],
    ['scriptType', 'groovy'],
    ['commit', 'false'],
  ]);
  assert.ok(post.headers['x-csrf-token']);

  stub.reset();
  await client.runScript('x');
  assert.equal(stub.requests.find((r) => r.sub === MODERN).field('commit'), 'true');
});

test('endpoint by version: < 5.7 uses /console/<scriptType>/execute, 5.10 uses /console/scripting/execute', async (t) => {
  const old = await setup(t, { hybrisVersion: '5.6' });
  await old.client.runScript('x', { scriptType: 'javascript' });
  assert.equal(old.stub.count('POST', '/console/javascript/execute'), 1);
  const modern = await setup(t, { hybrisVersion: '5.10' });
  await modern.client.runScript('x');
  assert.equal(modern.stub.count('POST', MODERN), 1);
});

test('validation: scriptType path injection, non-boolean commit, empty script', async (t) => {
  const { stub, client } = await setup(t);
  await assert.rejects(client.runScript('x', { scriptType: '../x' }), (err) => err instanceof HacInputError && err.argument === 'scriptType');
  await assert.rejects(client.runScript('x', { commit: 'false' }), (err) => err instanceof HacInputError && err.argument === 'commit');
  await assert.rejects(client.runScript(''), (err) => err instanceof HacInputError && err.argument === 'script');
  assert.equal(stub.requests.length, 0);
});

test('stacktraceText matrix: missing → HacResponseError, null → HacScriptError legacy text, non-empty → HacScriptError', async (t) => {
  const missing = await setup(t, {}, { path: MODERN, responders: { json: { outputText: '' } } });
  await assert.rejects(missing.client.runScript('x'), HacResponseError);

  const nul = await setup(t, {}, { path: MODERN, responders: { json: { outputText: 'partial', stacktraceText: null } } });
  await assert.rejects(nul.client.runScript('x'), (err) => err instanceof HacScriptError && err.message === 'HAC Script error occurred:\n null');

  const failed = await setup(t, {}, { path: MODERN, responders: { json: { outputText: 'out', stacktraceText: 'groovy.lang.MissingPropertyException: foo' } } });
  await assert.rejects(failed.client.runScript('x'), (err) => {
    assert.ok(err instanceof HacScriptError);
    assert.equal(err.message, 'HAC Script error occurred:\n groovy.lang.MissingPropertyException: foo');
    assert.equal(err.stacktrace, 'groovy.lang.MissingPropertyException: foo');
    assert.equal(err.output, 'out');
    assert.equal(err.attempts, 1);
    return true;
  });

  const html = await setup(t, {}, { path: MODERN, responders: { body: '<html>no</html>' } });
  await assert.rejects(html.client.runScript('x'), HacResponseError);
});
