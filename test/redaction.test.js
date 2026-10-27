'use strict';

// Credentials, session cookies, CSRF tokens, scripts and queries must never
// appear in logs, error messages, stacks, JSON or util.inspect output.

const { scrubEnv, newClient, captureLogger } = require('./helpers/harness');
scrubEnv();

const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const { startStubHac, escapeHtml } = require('./helpers/stub-hac');

const PASSWORD = 'S3cr3t Pa55!*';
const SPELLINGS = [PASSWORD, encodeURIComponent(PASSWORD), new URLSearchParams({ p: PASSWORD }).toString().slice(2)];
const SCRIPT_MARKER = 'Scr1pt-Mark3r';
const QUERY_MARKER = 'Qu3ry-Mark3r';
const IMPEX = '/console/impex/import';
const FLEX = '/console/flexsearch/execute';

/** Every serialisation of an error that could end up in a report. */
function renderings(err) {
  return [err.message, err.stack, JSON.stringify(err), util.inspect(err, { depth: Infinity }), String(err.bodyExcerpt || ''), String(err.result || '')];
}

function assertClean(texts, markers, label) {
  for (const text of texts) {
    for (const marker of markers) assert.ok(!String(text).includes(marker), `${label}: "${marker}" leaked in:\n${text}`);
  }
}

/** Captures console.debug output (HAC_DEBUG path) for the duration of a test. */
function captureConsoleDebug(t) {
  const lines = [];
  const original = console.debug;
  console.debug = (...args) => lines.push(args.join(' '));
  t.after(() => {
    console.debug = original;
  });
  return lines;
}

async function failingCall(t, { stubPassword = PASSWORD, route, call }) {
  const stub = await startStubHac({ password: stubPassword });
  t.after(() => stub.close());
  if (route) route(stub);
  const capture = captureLogger();
  const consoleLines = captureConsoleDebug(t);
  const client = newClient(stub, { password: PASSWORD, logger: capture.logger, timeoutMs: 200 });
  t.after(() => client.close());
  const debugClient = newClient(stub, { password: PASSWORD, env: { HAC_DEBUG: 'true' }, timeoutMs: 200 });
  t.after(() => debugClient.close());
  let err;
  try {
    await call(client);
  } catch (e) {
    err = e;
  }
  await call(debugClient).catch(() => {});
  assert.ok(err, 'call must fail');
  const sessionIds = stub.requests.flatMap((r) => (String(r.headers.cookie || '').match(/JSESSIONID=([^;]+)/) || []).slice(1));
  const tokens = stub.requests.map((r) => r.headers['x-csrf-token']).filter(Boolean);
  return { err, logs: [...capture.lines, ...consoleLines], sessionIds, tokens, consoleLines };
}

const scenarios = [
  ['auth failure', { stubPassword: 'other-password', call: (c) => c.search(`SELECT ${QUERY_MARKER}`) }],
  [
    'HTTP 500 echoing the posted login form',
    {
      route: (stub) =>
        stub.route('POST', '/j_spring_security_check', (ctx) => ({ status: 500, body: `<pre>${escapeHtml(ctx.record.rawBody.toString())}</pre><p>${PASSWORD}</p>` }), { raw: true }),
      call: (c) => c.search(`SELECT ${QUERY_MARKER}`),
    },
  ],
  ['transport reset', { route: (stub) => stub.route('POST', IMPEX, { reset: true }), call: (c) => c.importImpex(`INSERT X; a\n; ${SCRIPT_MARKER}`) }],
  ['timeout', { route: (stub) => stub.route('POST', FLEX, { hang: true }), call: (c) => c.search(`SELECT ${QUERY_MARKER}`) }],
  [
    'impex failure',
    {
      route: (stub) => stub.route('POST', IMPEX, { body: '<span data-level="error" data-result="Import has encountered problems"></span>' }),
      call: (c) => c.importImpex(`INSERT X; a\n; ${SCRIPT_MARKER}`),
    },
  ],
  [
    'script failure',
    {
      route: (stub) => stub.route('POST', '/console/scripting/execute', { json: { outputText: '', stacktraceText: `failed with ${PASSWORD}` } }),
      call: (c) => c.runScript(`println "${SCRIPT_MARKER}"`),
    },
  ],
];

for (const [name, scenario] of scenarios) {
  test(`password never leaks: ${name}`, async (t) => {
    const { err, logs, sessionIds, tokens, consoleLines } = await failingCall(t, scenario);
    assertClean(renderings(err), SPELLINGS, `${name} error`);
    assertClean(logs, [...SPELLINGS, ...sessionIds, ...tokens, SCRIPT_MARKER, QUERY_MARKER], `${name} logs`);
    assert.ok(logs.length > 0, 'logger received events');
    assert.ok(consoleLines.some((l) => l.startsWith('[hybris-hac-api]')), 'HAC_DEBUG prints via console.debug');
    assertClean(renderings(err), [SCRIPT_MARKER], `${name} error (script)`);
  });
}

test('echoed ImpEx script in textarea/pre is not in errors for unknown pages and 500 pages', async (t) => {
  const echo = (ctx) => {
    const script = escapeHtml(ctx.record.field('scriptContent') || '');
    return `<html><body><textarea name="scriptContent">${script}</textarea><pre id="scriptPreview">${script}</pre><p>Unexpected page</p></body></html>`;
  };
  for (const status of [200, 500]) {
    const stub = await startStubHac();
    t.after(() => stub.close());
    stub.route('POST', IMPEX, (ctx) => ({ status, body: echo(ctx) }));
    const client = newClient(stub);
    t.after(() => client.close());
    await assert.rejects(client.importImpex(`INSERT_UPDATE User; uid[unique=true]; password\n; ${SCRIPT_MARKER}; x`), (err) => {
      assert.ok(err.bodyExcerpt.includes('Unexpected page'));
      assertClean(renderings(err), [SCRIPT_MARKER], `status ${status}`);
      return true;
    });
  }
});
