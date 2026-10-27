'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startStubHac } = require('./helpers/stub-hac');
const { newClient } = require('./helpers/harness');
const { HacAuthError, HacCsrfError, HacHttpError, HacSessionExpiredError, HacTransportError } = require('../index');

const FLEX = '/console/flexsearch/execute';
const ROWS = { json: { headers: ['p_code'], resultList: [['ORDER-0001']], exception: null } };

async function setup(t, stubOptions, clientOptions) {
  const stub = await startStubHac(stubOptions);
  t.after(() => stub.close());
  const client = newClient(stub, clientOptions);
  t.after(() => client.close());
  return { stub, client };
}

test('three concurrent operations share a single login', async (t) => {
  const { stub, client } = await setup(t);
  stub.route('POST', FLEX, ROWS);
  await Promise.all([client.search('q1'), client.search('q2'), client.search('q3')]);
  assert.equal(stub.count('GET', '/login.jsp'), 1);
  assert.equal(stub.count('POST', '/j_spring_security_check'), 1);
  assert.equal(stub.count('POST', FLEX), 3);
  await client.search('q4');
  assert.equal(stub.count('POST', '/j_spring_security_check'), 1, 'session reused');
});

test('login sends legacy fields in order, uses the rotated post-login token', async (t) => {
  const { stub, client } = await setup(t);
  await client.search('q');
  const loginPost = stub.requests.find((r) => r.sub === '/j_spring_security_check');
  assert.deepEqual(
    loginPost.fields.map(([k]) => k),
    ['j_username', 'j_password', 'submit', '_csrf'],
  );
  const loginPageToken = loginPost.field('_csrf');
  const op = stub.requests.find((r) => r.sub === FLEX);
  assert.ok(op.headers['x-csrf-token']);
  assert.notEqual(op.headers['x-csrf-token'], loginPageToken);
  assert.ok(op.headers.cookie.includes('JSESSIONID='));
  assert.ok(op.headers.cookie.includes('ROUTE=.node1'), 'affinity cookie kept');
});

test('CSRF token in a hidden input only, and missing token → HacCsrfError before the operation', async (t) => {
  const { stub, client } = await setup(t);
  stub.loginCsrf = 'input';
  stub.landingCsrf = 'input';
  await client.search('q');
  assert.equal(stub.count('POST', FLEX), 1);

  const other = await setup(t);
  other.stub.landingCsrf = 'none';
  other.stub.consoleCsrf = 'none';
  await assert.rejects(other.client.search('q'), (err) => err instanceof HacCsrfError && err.operation === 'login');
  assert.equal(other.stub.count('POST', FLEX), 0);
  assert.equal(other.stub.count('GET', '/console/impex/import'), 1, 'refresh page tried');
});

test('landing page without token falls back to the CSRF refresh page', async (t) => {
  const { stub, client } = await setup(t);
  stub.landingCsrf = 'none';
  await client.search('q');
  assert.equal(stub.count('GET', '/console/impex/import'), 1);
  assert.equal(stub.count('POST', FLEX), 1);
});

test('wrong password → HacAuthError with #loginErrors text; generic reason without it; 500 → HacHttpError', async (t) => {
  const bad = await setup(t, {}, { password: 'wrong-pass' });
  await assert.rejects(bad.client.search('q'), (err) => {
    assert.ok(err instanceof HacAuthError);
    assert.equal(err.reason, 'Bad credentials');
    assert.equal(err.operation, 'login');
    assert.match(err.message, /^HAC login failed: Bad credentials/);
    return true;
  });

  const generic = await setup(t, {}, { password: 'wrong-pass' });
  generic.stub.loginErrorElement = false;
  await assert.rejects(generic.client.search('q'), (err) => err instanceof HacAuthError && /login rejected \(unexpected response, status 302\)/.test(err.reason));

  const broken = await setup(t);
  broken.stub.route('POST', '/j_spring_security_check', { status: 500, body: '<h1>Internal error</h1>' }, { raw: true });
  await assert.rejects(broken.client.search('q'), (err) => err instanceof HacHttpError && err.status === 500 && err.operation === 'login');
});

test('session expired once → re-login and one replay; always → HacSessionExpiredError{attempts:2}', async (t) => {
  const { stub, client } = await setup(t);
  stub.route('POST', FLEX, ROWS);
  await client.search('warm-up');
  stub.expireSessions();
  const result = await client.search('q');
  assert.equal(result.rowCount, 1);
  assert.equal(stub.count('POST', '/j_spring_security_check'), 2);

  const always = await setup(t);
  always.stub.route('POST', FLEX, { redirect: '/hac/login.jsp' }, { raw: true });
  await assert.rejects(always.client.search('q'), (err) => {
    assert.ok(err instanceof HacSessionExpiredError);
    assert.equal(err.attempts, 2);
    assert.equal(err.operation, 'search');
    return true;
  });
  assert.equal(always.stub.count('POST', FLEX), 2);
});

test('login page body (200) on a console POST counts as expiry', async (t) => {
  const { stub, client } = await setup(t);
  const loginBody = '<html><form action="/hac/j_spring_security_check"><input name="j_username"></form></html>';
  stub.route('POST', FLEX, [{ body: loginBody }, ROWS], { raw: true });
  const result = await client.search('q');
  assert.equal(result.rowCount, 1);
  assert.equal(stub.count('POST', '/j_spring_security_check'), 2);
});

test('403 once → token refreshed and one replay; persistent 403 → HacCsrfError', async (t) => {
  const { stub, client } = await setup(t);
  stub.route('POST', FLEX, ROWS);
  await client.search('warm-up');
  stub.rotateCsrf();
  await client.search('q');
  assert.equal(stub.count('GET', '/console/impex/import'), 1);

  const always = await setup(t);
  always.stub.route('POST', FLEX, { status: 403 }, { raw: true });
  await assert.rejects(always.client.search('q'), (err) => err instanceof HacCsrfError && err.status === 403 && err.attempts === 2);
});

test('cookie jar over the wire: deletion via Max-Age=0', async (t) => {
  const { stub, client } = await setup(t);
  stub.route('GET', '/login.jsp', { pass: true, headers: { 'Set-Cookie': ['TMP=1; Path=/', 'KEEP=1; Path=/'] } }, { raw: true });
  stub.route('POST', FLEX, [{ pass: true, headers: { 'Set-Cookie': 'TMP=; Path=/; Max-Age=0' } }, ROWS]);
  await client.search('q1');
  await client.search('q2');
  const [first, second] = stub.requests.filter((r) => r.sub === FLEX);
  assert.ok(first.headers.cookie.includes('TMP=1'));
  assert.ok(second.headers.cookie.includes('KEEP=1'));
  assert.ok(!second.headers.cookie.includes('TMP='));
});

test('redirects: same-origin followed, cross-origin rejected with origin only, 6 hops rejected', async (t) => {
  const same = await setup(t);
  same.stub.route('GET', '/login.jsp', [{ redirect: '/hac/login' }], { raw: true });
  same.stub.route('GET', '/login', { pass: true }, { raw: true });
  // '/login' is served by the default login handler
  await same.client.search('q');
  assert.equal(same.stub.count('GET', '/login'), 1);

  const other = await startStubHac({ tls: true });
  t.after(() => other.close());
  const cross = await setup(t);
  cross.stub.route('GET', '/login.jsp', { redirect: `${other.origin}/hac/login.jsp?next=/secret` }, { raw: true });
  await assert.rejects(cross.client.search('q'), (err) => {
    assert.ok(err instanceof HacHttpError);
    assert.equal(err.redirectOrigin, other.origin);
    assert.match(err.message, /set HAC_HOST/);
    assert.ok(!err.message.includes('/secret'));
    assert.ok(!err.message.includes('/hac/login.jsp'));
    return true;
  });
  assert.equal(other.requests.length, 0, 'no request reached the other origin');

  const loop = await setup(t);
  loop.stub.route('GET', '/login.jsp', { redirect: '/hac/login.jsp' }, { raw: true });
  await assert.rejects(loop.client.search('q'), (err) => err instanceof HacHttpError && /too many redirects \(>5\)/.test(err.message));
  assert.equal(loop.stub.count('GET', '/login.jsp'), 6);

  const opCross = await setup(t);
  opCross.stub.route('POST', FLEX, { redirect: `${other.origin}/hac/x` }, { raw: true });
  await assert.rejects(opCross.client.search('q'), (err) => err instanceof HacHttpError && err.redirectOrigin === other.origin);
});

test('login restart: reset on POST once → whole sequence restarted with a cleared jar', async (t) => {
  const { stub, client } = await setup(t);
  stub.route('POST', '/j_spring_security_check', [{ reset: true }, { pass: true }], { raw: true });
  await client.search('q');
  assert.deepEqual(stub.sequence().slice(0, 4), [
    'GET /login.jsp',
    'POST /j_spring_security_check',
    'GET /login.jsp',
    'POST /j_spring_security_check',
  ]);
  const posts = stub.requests.filter((r) => r.sub === '/j_spring_security_check');
  const gets = stub.requests.filter((r) => r.sub === '/login.jsp');
  assert.equal(gets[1].headers.cookie, undefined, 'jar cleared before restart');
  assert.notEqual(posts[1].field('_csrf'), posts[0].field('_csrf'));

  const twice = await setup(t);
  twice.stub.route('POST', '/j_spring_security_check', { reset: true }, { raw: true });
  await assert.rejects(twice.client.search('q'), (err) => err instanceof HacTransportError && err.operation === 'login');
  assert.equal(twice.stub.count('POST', '/j_spring_security_check'), 2);

  const none = await setup(t, {}, { retries: 0 });
  none.stub.route('POST', '/j_spring_security_check', { reset: true }, { raw: true });
  await assert.rejects(none.client.search('q'), HacTransportError);
  assert.equal(none.stub.count('POST', '/j_spring_security_check'), 1);
});

test('concurrency: one expiry seen by 3 requests → one re-login; one CSRF rotation → one refresh', async (t) => {
  const { stub, client } = await setup(t);
  stub.route('POST', FLEX, ROWS);
  await client.search('warm-up');
  stub.reset();
  stub.expireSessions();
  await Promise.all([client.search('a'), client.search('b'), client.search('c')]);
  assert.equal(stub.count('POST', '/j_spring_security_check'), 1);
  assert.equal(stub.count('GET', '/login.jsp'), 1);
  assert.equal(stub.count('POST', FLEX), 6);

  stub.reset();
  stub.rotateCsrf();
  await Promise.all([client.search('a'), client.search('b'), client.search('c')]);
  assert.equal(stub.count('GET', '/console/impex/import'), 1);
  assert.equal(stub.count('POST', FLEX), 6);
  assert.equal(stub.count('POST', '/j_spring_security_check'), 0);
});
