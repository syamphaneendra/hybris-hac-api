'use strict';

// The legacy API reads process.env when src/config.js is first required, so
// the environment is scrubbed before anything from the package is loaded.
const { scrubEnv, noUnhandledRejection } = require('./helpers/harness');
scrubEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const globalsBefore = new Set(Object.keys(globalThis));
const hac = require('../index');
const legacy = require('../src/legacy');
const { config, updateConfig } = require('../src/config');
const { startStubHac } = require('./helpers/stub-hac');
const { HacClientClosedError, HacHttpError, HacImpexError, HacInputError, HacNoResultsError, HacScriptError, HacTransportError } = hac;

const IMPEX = '/console/impex/import';
const FLEX = '/console/flexsearch/execute';
const SCRIPT = 'INSERT_UPDATE Product; code[unique=true]\n; ORDER-0001';

/** Starts a stub and points the legacy API at it. */
async function legacyStub(t, options) {
  const stub = await startStubHac(options);
  t.after(() => stub.close());
  hac.configure(stub.origin, 'admin', 'nimda', '5.7');
  return stub;
}

test.after(() => legacy.replaceDefaultClient());

test('impexImport stays pending until HAC answers, then resolves undefined', async (t) => {
  const stub = await legacyStub(t);
  stub.route('POST', IMPEX, { delayMs: 200, pass: true });
  let settled = false;
  const pending = hac.impexImport(SCRIPT).then((v) => {
    settled = true;
    return v;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false, 'must not resolve before HAC answered');
  assert.equal(await pending, undefined);
  assert.equal(stub.count('POST', IMPEX), 1);
});

test('impexImport rejects on HTTP 500, connection reset and ImpEx errors; no unhandled rejection', async (t) => {
  const guard = noUnhandledRejection(t);
  const cases = [
    [{ status: 500, body: '<h1>Server error</h1>' }, HacHttpError],
    [{ reset: true }, HacTransportError],
    [{ body: '<span data-level="error" data-result="Import has encountered problems"></span>' }, HacImpexError],
  ];
  for (const [responder, ErrorClass] of cases) {
    const stub = await legacyStub(t);
    stub.route('POST', IMPEX, responder);
    await assert.rejects(hac.impexImport(SCRIPT), (err) => err instanceof ErrorClass && err instanceof Error && err.operation === 'impexImport');
  }
  await new Promise((resolve) => setImmediate(resolve));
  guard.assertNone();
});

test('flexibleSearch keeps the legacy shape: first row, replace("p_",""), null → "", decoded', async (t) => {
  const stub = await legacyStub(t);
  stub.route('POST', FLEX, {
    json: {
      headers: ['p_code', 'shop_price', 'p_name'],
      resultList: [
        ['ORDER-0001', null, 'Caf&eacute; &lt;b&gt;'],
        ['ORDER-0002', '5', 'second'],
      ],
      exception: null,
    },
  });
  const row = await hac.flexibleSearch('SELECT {code} FROM {Order}');
  assert.deepEqual(row, { code: 'ORDER-0001', shoprice: '', name: 'Café <b>' });
  const post = stub.requests.find((r) => r.sub === FLEX);
  assert.deepEqual(post.fields, [
    ['flexibleSearchQuery', 'SELECT {code} FROM {Order}'],
    ['sqlQuery', ''],
    ['maxCount', '200'],
    ['user', 'admin'],
    ['locale', 'en'],
    ['commit', 'false'],
  ]);
});

test('flexibleSearch with 0 rows → HacNoResultsError with the legacy message', async (t) => {
  const stub = await legacyStub(t);
  stub.route('POST', FLEX, { json: { headers: ['p_code'], resultList: [], exception: null } });
  const query = 'SELECT {pk} FROM {Order} WHERE {code} = ORDER-0001';
  await assert.rejects(hac.flexibleSearch(query), (err) => {
    assert.ok(err instanceof HacNoResultsError);
    assert.ok(err instanceof Error);
    assert.equal(err.message, `HAC Flexible Search returned 0 results:\n${query}`);
    assert.equal(err.operation, 'search');
    return true;
  });
});

test('executeScript: exact fields on both endpoints, commit coercion, raw JSON, legacy error text', async (t) => {
  const raw = { outputText: 'hi', executionResult: 'r', stacktraceText: '' };
  const modern = await legacyStub(t);
  modern.route('POST', '/console/scripting/execute', { json: raw });
  assert.deepEqual(await hac.executeScript('println "hi"', false, 'groovy'), raw);
  await hac.executeScript('println "hi"');
  const [first, second] = modern.requests.filter((r) => r.sub === '/console/scripting/execute');
  assert.deepEqual(first.fields, [['script', 'println "hi"'], ['scriptType', 'groovy'], ['commit', 'false']]);
  assert.deepEqual(second.fields, [['script', 'println "hi"'], ['scriptType', 'groovy'], ['commit', 'true']]);
  assert.ok(first.headers['x-csrf-token']);

  const old = await startStubHac();
  t.after(() => old.close());
  hac.configure(old.origin, undefined, undefined, '5.6');
  await hac.executeScript('println "hi"', false, 'groovy');
  const oldPost = old.requests.find((r) => r.sub === '/console/groovy/execute');
  assert.deepEqual(oldPost.fields, [['script', 'println "hi"'], ['scriptType', 'groovy'], ['commit', 'false']]);

  old.route('POST', '/console/groovy/execute', { json: { outputText: '', stacktraceText: 'java.lang.Exception: boom' } });
  await assert.rejects(hac.executeScript('x'), (err) => err instanceof HacScriptError && err.message === 'HAC Script error occurred:\n java.lang.Exception: boom');
  await assert.rejects(hac.executeScript('x', 'true', '../evil'), HacInputError);
});

test('configure returns the exports object, keeps truthy-override semantics and honours the version', async (t) => {
  const stub = await startStubHac();
  t.after(() => stub.close());
  assert.equal(hac.configure(stub.origin, 'admin', 'nimda', '5.6'), hac);
  const { configure } = hac;
  assert.equal(configure(), hac, 'destructured call returns the exports object, not globalThis');
  assert.equal(config.HAC_HOST, stub.origin, 'falsy arguments keep the current value');
  assert.equal(config.HYBRIS_VERSION, '5.6');
  await hac.executeScript('x');
  assert.equal(stub.count('POST', '/console/groovy/execute'), 1);
  hac.configure(undefined, undefined, undefined, '5.10');
  await hac.executeScript('x');
  assert.equal(stub.count('POST', '/console/scripting/execute'), 1);
  hac.configure(undefined, undefined, undefined, '5.7');
});

test('root context via HAC_CONTEXT_PATH=/', async (t) => {
  const stub = await startStubHac({ contextPath: '/' });
  t.after(() => stub.close());
  process.env.HAC_CONTEXT_PATH = '/';
  t.after(() => {
    delete process.env.HAC_CONTEXT_PATH;
    legacy.replaceDefaultClient();
  });
  legacy.replaceDefaultClient();
  hac.configure(stub.origin);
  await hac.impexImport(SCRIPT);
  assert.deepEqual(stub.sequence(), ['GET /login.jsp', 'POST /j_spring_security_check', 'GET /', 'POST /console/impex/import']);
  assert.ok(stub.requests.every((r) => !r.path.startsWith('/hac')));
});

test('deep requires load and work through the default client; no new globals', async (t) => {
  const stub = await legacyStub(t);
  stub.route('POST', FLEX, { json: { headers: ['p_code'], resultList: [['ORDER-0001']], exception: null } });
  const { login } = require('../src/HACApiConnect');
  const { impexImportExecute } = require('../src/ImpexImportExecute');
  const { flexibleSearchExecute } = require('../src/FlexibleSearchExecute');
  const { scriptExecute } = require('../src/ScriptExecute');
  const deepConfig = require('../src/config');
  assert.equal(typeof deepConfig.updateConfig, 'function');
  assert.equal(deepConfig.config, config);
  assert.equal(await login(), undefined);
  assert.equal(await impexImportExecute(SCRIPT), undefined);
  assert.deepEqual(await flexibleSearchExecute('q'), { code: 'ORDER-0001' });
  assert.equal(typeof (await scriptExecute('x')), 'object');
  assert.equal(stub.count('POST', '/j_spring_security_check'), 1, 'one session for every deep call');
  const added = Object.keys(globalThis).filter((k) => !globalsBefore.has(k));
  assert.deepEqual(added, []);
});

test('legacy config hides the password from enumeration but keeps it readable/writable', () => {
  assert.equal(Object.keys(config).includes('HAC_PASSWORD'), false);
  assert.ok(!JSON.stringify(config).includes('nimda'));
  const saved = config.HAC_PASSWORD;
  updateConfig(undefined, undefined, 'changed-pass');
  assert.equal(config.HAC_PASSWORD, 'changed-pass');
  config.HAC_PASSWORD = saved;
});

test('ESM import exposes the default export and named exports', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'index.js')).href);
  for (const name of ['configure', 'impexImport', 'flexibleSearch', 'executeScript', 'createHacClient']) {
    assert.equal(typeof mod[name], 'function', name);
  }
  assert.equal(mod.default, hac);
});

test('configure() while an import is in flight: the import finishes on the old client, which is then closed', async (t) => {
  const first = await legacyStub(t);
  first.route('POST', IMPEX, { delayMs: 300, pass: true });
  await hac.impexImport(SCRIPT.replace('0001', '0000')).catch(() => {}); // warm-up session (delayed)
  const oldClient = legacy.getDefaultClient();
  const pending = hac.impexImport(SCRIPT);

  const second = await startStubHac();
  t.after(() => second.close());
  second.route('POST', FLEX, { json: { headers: ['p_code'], resultList: [['ORDER-0002']], exception: null } });
  hac.configure(second.origin);
  assert.deepEqual(await hac.flexibleSearch('q'), { code: 'ORDER-0002' });
  assert.equal(second.count('POST', '/j_spring_security_check'), 1, 'fresh login on the new host');
  assert.equal(await pending, undefined, 'in-flight import still resolves');
  assert.notEqual(legacy.getDefaultClient(), oldClient);
  await assert.rejects(oldClient.search('q'), HacClientClosedError);
});

test('direct config writes switch host; identical configure() causes no extra login', async (t) => {
  const first = await legacyStub(t);
  await hac.impexImport(SCRIPT);
  hac.configure(first.origin, 'admin', 'nimda', '5.7');
  await hac.impexImport(SCRIPT);
  assert.equal(first.count('POST', '/j_spring_security_check'), 1);

  const second = await startStubHac();
  t.after(() => second.close());
  config.HAC_HOST = second.origin;
  await hac.impexImport(SCRIPT);
  assert.equal(second.count('POST', '/j_spring_security_check'), 1);
  assert.equal(first.count('POST', IMPEX), 2);
});

test('missing HAC_HOST rejects (not throws) with the legacy message', async () => {
  legacy.replaceDefaultClient();
  const saved = config.HAC_HOST;
  config.HAC_HOST = undefined;
  try {
    const promise = hac.impexImport(SCRIPT);
    assert.ok(promise instanceof Promise);
    await assert.rejects(promise, {
      message: 'HAC_HOST is not configured. Please use .env file for configuration or set it via configure() method.',
    });
  } finally {
    config.HAC_HOST = saved;
  }
});
