'use strict';

/**
 * Minimal HTTP proxy on 127.0.0.1 for tests: absolute-form forwarding for
 * http: targets and CONNECT tunnelling for https: targets, with optional
 * Basic proxy authentication.
 */

const http = require('node:http');
const net = require('node:net');

/**
 * @param {{ auth?: string|null }} [options] auth: 'user:pass' required in Proxy-Authorization.
 */
async function startStubProxy({ auth = null } = {}) {
  const requests = [];
  const connects = [];
  const sockets = new Set();
  const expected = auth ? `Basic ${Buffer.from(auth).toString('base64')}` : null;
  const authorized = (req) => !expected || req.headers['proxy-authorization'] === expected;

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (!authorized(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="stub"', 'Content-Length': 0 });
      res.end();
      return;
    }
    const target = new URL(req.url);
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const upstream = http.request(
      { hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: req.method, headers, agent: false },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Length': 0 });
      res.end();
    });
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket, head) => {
    connects.push({ target: req.url, headers: req.headers });
    sockets.add(clientSocket);
    clientSocket.on('error', () => {});
    if (!authorized(req)) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="stub"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const idx = req.url.lastIndexOf(':');
    const host = req.url.slice(0, idx).replace(/^\[|\]$/g, '');
    const port = Number(req.url.slice(idx + 1));
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    connects,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { startStubProxy };
