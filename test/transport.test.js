'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startStubHac } = require('./helpers/stub-hac');
const { newClient, freePort } = require('./helpers/harness');
const { createTransport, MAX_BODY_BYTES, ACCEPT, USER_AGENT } = require('../src/http/transport');
const { resolveOptions } = require('../src/core/options');
const { encodeForm } = require('../src/http/form');
const { HacResponseError, HacTransportError, HacTimeoutError } = require('../index');

/** @param {string} host */
function transportFor(host, extra = {}) {
  const { resolved, logger, secrets } = resolveOptions({ host, env: {}, ...extra });
  return { transport: createTransport({ resolved, logger, secrets }), resolved };
}

test('every POST carries form content type, exact Content-Length, Accept, no Accept-Encoding; non-ASCII round-trips', async (t) => {
  const stub = await startStubHac();
  t.after(() => stub.close());
  const text = 'Zürich – ORDER-0001';
  stub.route('POST', '/console/flexsearch/execute', { json: { headers: ['p_name'], resultList: [[text]], exception: null } });
  const client = newClient(stub);
  t.after(() => client.close());

  await client.importImpex(`INSERT_UPDATE Product; code[unique=true]; name\n; ORDER-0001; ${text}`);
  const result = await client.search(`SELECT {name} FROM {Product} WHERE {name} = '${text}'`);
  await client.runScript(`println "${text}"`);
  assert.equal(result.rows[0].name, text);

  const posts = stub.requests.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 4); // login + 3 operations
  for (const post of posts) {
    assert.equal(post.headers['content-type'], 'application/x-www-form-urlencoded; charset=UTF-8');
    assert.equal(Number(post.headers['content-length']), post.rawBody.length);
    assert.equal(post.headers.accept, ACCEPT);
    assert.equal(post.headers['user-agent'], USER_AGENT);
    assert.equal(post.headers['accept-encoding'], undefined);
  }
  assert.ok(posts[1].field('scriptContent').includes(text));
  assert.ok(posts[2].field('flexibleSearchQuery').includes(text));
});

test('form encoding round-trips special characters exactly', async (t) => {
  const stub = await startStubHac();
  t.after(() => stub.close());
  const client = newClient(stub);
  t.after(() => client.close());
  await client.runScript('a b+c&d=é');
  const post = stub.requests.find((r) => r.sub === '/console/scripting/execute');
  assert.equal(post.field('script'), 'a b+c&d=é');
  assert.deepEqual(encodeForm([['k', 'a b']]).body.toString(), 'k=a+b');
});

test('gzip responses are rejected with HacResponseError', async (t) => {
  const stub = await startStubHac();
  t.after(() => stub.close());
  stub.route('POST', '/console/flexsearch/execute', { headers: { 'Content-Encoding': 'gzip' }, body: 'xx' });
  const client = newClient(stub);
  t.after(() => client.close());
  await assert.rejects(client.search('SELECT 1'), (err) => err instanceof HacResponseError && /unsupported Content-Encoding gzip/.test(err.message));
});

test('the stub answers 415 to a POST without the form content type', async (t) => {
  const stub = await startStubHac();
  t.after(() => stub.close());
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${stub.url}/console/impex/import`, { method: 'POST', headers: { 'Content-Type': 'text/plain' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end('x');
  });
  assert.equal(status, 415);
});

test('bodies over the 50 MiB cap are rejected', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const chunk = Buffer.alloc(1024 * 1024, 'a');
    let sent = 0;
    const pump = () => {
      while (sent <= MAX_BODY_BYTES / chunk.length + 1) {
        sent++;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { transport } = transportFor(`http://127.0.0.1:${server.address().port}`);
  t.after(() => transport.destroy());
  await assert.rejects(
    transport.send({ method: 'GET', url: `http://127.0.0.1:${server.address().port}/big`, timeoutMs: 30000, connectTimeoutMs: 5000 }),
    (err) => err instanceof HacResponseError && /exceeds/.test(err.message),
  );
});

test('connect-phase flag: closed port is connect-phase, reset after connect is not', async (t) => {
  const port = await freePort();
  const { transport } = transportFor(`http://127.0.0.1:${port}`);
  t.after(() => transport.destroy());
  await assert.rejects(transport.send({ method: 'GET', url: `http://127.0.0.1:${port}/`, timeoutMs: 5000, connectTimeoutMs: 5000 }), (err) => {
    assert.ok(err instanceof HacTransportError);
    assert.equal(err.networkCode, 'ECONNREFUSED');
    assert.equal(err.connectPhase, true);
    assert.equal(Object.keys(err).includes('connectPhase'), false);
    assert.equal(err.method, 'GET');
    assert.equal(err.path, '/');
    return true;
  });

  const server = http.createServer((req) => req.socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const resetUrl = `http://127.0.0.1:${server.address().port}/x?secret=1`;
  const reset = transportFor(resetUrl.replace(/\/x.*$/, '')).transport;
  t.after(() => reset.destroy());
  await assert.rejects(reset.send({ method: 'GET', url: resetUrl, timeoutMs: 5000, connectTimeoutMs: 5000 }), (err) => {
    assert.ok(err instanceof HacTransportError);
    assert.equal(err.networkCode, 'ECONNRESET');
    assert.equal(err.connectPhase, false);
    assert.equal(err.path, '/x');
    assert.ok(!err.message.includes('secret=1'));
    return true;
  });
});

test('connect timeout: TLS handshake never completes → HacTimeoutError{phase:connect}, connect-phase', async (t) => {
  const net = require('node:net');
  const sockets = new Set();
  const server = net.createServer((socket) => sockets.add(socket)); // accepts TCP, never speaks TLS
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  const origin = `https://127.0.0.1:${server.address().port}`;
  const { transport } = transportFor(origin);
  t.after(() => transport.destroy());
  await assert.rejects(transport.send({ method: 'GET', url: `${origin}/hac/login.jsp`, timeoutMs: 5000, connectTimeoutMs: 100 }), (err) => {
    assert.ok(err instanceof HacTimeoutError);
    assert.equal(err.phase, 'connect');
    assert.equal(err.timeoutMs, 100);
    assert.equal(err.connectPhase, true);
    return true;
  });
});

test('response timeout at transport level', async (t) => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { transport } = transportFor(origin);
  t.after(() => transport.destroy());
  const started = Date.now();
  await assert.rejects(transport.send({ method: 'GET', url: `${origin}/`, timeoutMs: 100, connectTimeoutMs: 5000 }), (err) => {
    assert.ok(err instanceof HacTimeoutError);
    assert.equal(err.phase, 'response');
    assert.equal(err.timeoutMs, 100);
    return true;
  });
  assert.ok(Date.now() - started < 3000);
});
