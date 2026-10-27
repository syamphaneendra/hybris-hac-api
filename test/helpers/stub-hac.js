'use strict';

/**
 * Programmable HAC stub on 127.0.0.1 (http or https with the test CA).
 *
 * Behaves like Spring Security form login in front of the HAC console:
 * - GET  {ctx}/login.jsp                 anonymous session cookie + CSRF token
 * - POST {ctx}/j_spring_security_check   checks credentials + _csrf, migrates the
 *                                        session, rotates the token, 302 to {ctx}/
 * - GET  {ctx}/ and {ctx}/console/impex/import   console pages with the token
 * - POST {ctx}/console/impex/import | flexsearch/execute | scripting/execute |
 *        <type>/execute              session (302 → login) and CSRF (403) checked
 *
 * Responders can be scripted per route with `stub.route(method, subPath, responders, { raw })`.
 * A responder is an object `{ status, headers, body, json, delayMs, reset, hang, redirect, pass }`
 * or a function `(ctx) => responder`. An array is consumed in order; its last entry repeats.
 * `raw: true` responders run before the session/CSRF checks.
 */

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const TLS_DIR = path.join(__dirname, '..', 'fixtures', 'tls');

/** @param {string} value */
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** @param {string|undefined} header */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

/** @param {import('node:http').IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.contextPath] '/hac' (default) or '/' for root.
 * @param {boolean} [options.tls] serve https with test/fixtures/tls/server.pem.
 * @param {string} [options.user]
 * @param {string} [options.password]
 */
async function startStubHac({ contextPath = '/hac', tls = false, user = 'admin', password = 'nimda', port = 0 } = {}) {
  const ctx = contextPath === '/' ? '' : contextPath;
  let tokenCounter = 0;
  let sessionCounter = 0;
  const newToken = () => `csrf-${++tokenCounter}-${Math.random().toString(36).slice(2, 10)}`;
  const newSessionId = () => `SID${++sessionCounter}${Math.random().toString(36).slice(2, 10)}`;
  /** @type {Map<string, { auth: boolean, csrf: string }>} */
  const sessions = new Map();
  /** @type {Map<string, { responders: any[], index: number, raw: boolean }>} */
  const routes = new Map();
  const sockets = new Set();

  const stub = {
    contextPath: ctx === '' ? '/' : ctx,
    origin: '',
    url: '',
    port: 0,
    /** Recorded requests. */
    requests: [],
    /** Where the console pages put the token: 'meta' | 'input' | 'none'. */
    landingCsrf: 'meta',
    consoleCsrf: 'meta',
    loginCsrf: 'meta',
    /** When false, the login page has no #loginErrors element on login_error. */
    loginErrorElement: true,
    route(method, subPath, responders, { raw = false } = {}) {
      routes.set(`${method} ${subPath}`, { responders: [].concat(responders), index: 0, raw });
      return stub;
    },
    clearRoutes() {
      routes.clear();
    },
    /** Invalidates every session (next console request → 302 login). */
    expireSessions() {
      sessions.clear();
    },
    /** Rotates every session's CSRF token (next console POST → 403). */
    rotateCsrf() {
      for (const s of sessions.values()) s.csrf = newToken();
    },
    count(method, subPath) {
      return stub.requests.filter((r) => r.method === method && r.sub === subPath).length;
    },
    sequence() {
      return stub.requests.map((r) => `${r.method} ${r.sub}`);
    },
    reset() {
      stub.requests.length = 0;
    },
    /** Stops listening (connections refused) but keeps sessions and routes. */
    async suspend() {
      for (const s of sockets) s.destroy();
      if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
      // let the client notice the closed keep-alive sockets
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
    /** Listens again on the same port. */
    async resume() {
      await new Promise((resolve) => server.listen(stub.port, '127.0.0.1', resolve));
    },
    async close() {
      for (const s of sockets) s.destroy();
      if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
    },
  };

  const csrfMarkup = (mode, token) => {
    if (mode === 'meta') return `<meta name="_csrf" content="${token}"/><meta name="_csrf_header" content="X-CSRF-TOKEN"/>`;
    if (mode === 'input') return `<input type="hidden" name="_csrf" value="${token}"/>`;
    return '';
  };

  const loginHtml = (session, withError) =>
    `<!DOCTYPE html><html><head><title>Login</title>${csrfMarkup(stub.loginCsrf, session.csrf)}</head><body>` +
    `<form action="${ctx}/j_spring_security_check" method="POST">` +
    `<input type="text" name="j_username"/><input type="password" name="j_password"/>` +
    `<input type="hidden" name="_csrf" value="${session.csrf}"/><button type="submit">login</button></form>` +
    (withError && stub.loginErrorElement ? '<div id="loginErrors">Bad credentials</div>' : '') +
    '</body></html>';

  const consoleHtml = (mode, token, extra = '') =>
    `<!DOCTYPE html><html><head><title>HAC</title>${csrfMarkup(mode, token)}</head><body><div id="console">${extra}</div></body></html>`;

  const impexSuccessHtml = (script) =>
    consoleHtml(
      'meta',
      'page-token',
      `<textarea name="scriptContent">${escapeHtml(script)}</textarea>` +
        '<span id="impexResult" data-level="notice" data-result="Import finished successfully"></span>',
    );

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {Record<string, any>} headers
   * @param {string|Buffer} [body]
   */
  function send(res, status, headers, body = '') {
    if (res.headersSent || res.destroyed) return;
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    res.writeHead(status, { 'Content-Length': payload.length, ...headers });
    res.end(payload);
  }

  function nextResponder(route) {
    const responder = route.responders[Math.min(route.index, route.responders.length - 1)];
    route.index++;
    return responder;
  }

  /**
   * Sends a scripted response. Returns false when the responder says "pass".
   */
  async function respond(c, responder, fallback) {
    let r = typeof responder === 'function' ? await responder(c) : responder;
    if (r === undefined || r === null) r = { pass: true };
    if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
    if (r.reset) {
      c.req.socket.destroy();
      return;
    }
    if (r.hang) return;
    if (r.pass) {
      await fallback(r.headers || {});
      return;
    }
    if (r.redirect) {
      send(c.res, r.status || 302, { Location: r.redirect, ...(r.headers || {}) });
      return;
    }
    if (r.json !== undefined) {
      send(c.res, r.status || 200, { 'Content-Type': 'application/json;charset=UTF-8', ...(r.headers || {}) }, JSON.stringify(r.json));
      return;
    }
    send(c.res, r.status || 200, { 'Content-Type': 'text/html;charset=UTF-8', ...(r.headers || {}) }, r.body || '');
  }

  const sessionCookie = (id) => `JSESSIONID=${id}; Path=${ctx || '/'}; HttpOnly`;

  async function defaultHandler(c, extraHeaders) {
    const { req, res, record, cookies } = c;
    const sub = record.sub;
    let session = sessions.get(cookies.JSESSIONID);

    if (req.method === 'GET' && (sub === '/login.jsp' || sub === '/login')) {
      const headers = { 'Content-Type': 'text/html;charset=UTF-8', ...extraHeaders };
      if (!session) {
        const id = newSessionId();
        session = { auth: false, csrf: newToken() };
        sessions.set(id, session);
        headers['Set-Cookie'] = [sessionCookie(id)].concat(extraHeaders['Set-Cookie'] || []);
      }
      send(res, 200, headers, loginHtml(session, record.query.includes('login_error')));
      return;
    }

    if (req.method === 'POST' && sub === '/j_spring_security_check') {
      const f = Object.fromEntries(record.fields);
      const ok = session && f._csrf === session.csrf && f.j_username === user && f.j_password === password;
      if (!ok) {
        send(res, 302, { Location: `${ctx}/login.jsp?login_error=1`, ...extraHeaders });
        return;
      }
      sessions.delete(cookies.JSESSIONID);
      const id = newSessionId();
      sessions.set(id, { auth: true, csrf: newToken() });
      send(res, 302, {
        Location: `${ctx}/`,
        'Set-Cookie': [sessionCookie(id), 'ROUTE=.node1; Path=/'].concat(extraHeaders['Set-Cookie'] || []),
      });
      return;
    }

    const needsAuth = sub === '/' || sub.startsWith('/console/');
    if (!needsAuth) {
      send(res, 404, { 'Content-Type': 'text/html' }, '<html><body>Not Found</body></html>');
      return;
    }
    if (!session || !session.auth) {
      send(res, 302, { Location: `${ctx}/login.jsp`, ...extraHeaders });
      return;
    }

    if (req.method === 'GET') {
      const mode = sub === '/' ? stub.landingCsrf : stub.consoleCsrf;
      send(res, 200, { 'Content-Type': 'text/html;charset=UTF-8', ...extraHeaders }, consoleHtml(mode, session.csrf));
      return;
    }

    // Console POST: CSRF check (header or body field).
    const bodyToken = record.fields.find(([k]) => k === '_csrf');
    const token = req.headers['x-csrf-token'] || (bodyToken && bodyToken[1]);
    if (token !== session.csrf) {
      send(res, 403, { 'Content-Type': 'text/html' }, '<html><body>Forbidden</body></html>');
      return;
    }
    const route = routes.get(`${req.method} ${sub}`);
    const business = async (extra) => {
      if (sub === '/console/impex/import') {
        const script = (record.fields.find(([k]) => k === 'scriptContent') || [])[1] || '';
        send(res, 200, { 'Content-Type': 'text/html;charset=UTF-8', ...extra }, impexSuccessHtml(script));
      } else if (sub === '/console/flexsearch/execute') {
        send(res, 200, { 'Content-Type': 'application/json', ...extra }, JSON.stringify({ headers: [], resultList: [], exception: null }));
      } else if (/^\/console\/[A-Za-z]+\/execute$/.test(sub)) {
        send(res, 200, { 'Content-Type': 'application/json', ...extra }, JSON.stringify({ outputText: '', executionResult: null, stacktraceText: '' }));
      } else {
        send(res, 404, {}, 'Not Found');
      }
    };
    if (route && !route.raw) {
      await respond(c, nextResponder(route), business);
      return;
    }
    await business(extraHeaders);
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://stub.invalid');
    const rawBody = await readBody(req);
    let sub = null;
    if (ctx === '') sub = url.pathname;
    else if (url.pathname === ctx || url.pathname.startsWith(`${ctx}/`)) sub = url.pathname.slice(ctx.length) || '/';
    const contentType = String(req.headers['content-type'] || '');
    const isForm = contentType.startsWith('application/x-www-form-urlencoded');
    const fields = isForm ? [...new URLSearchParams(rawBody.toString('utf8'))] : [];
    const record = {
      method: req.method,
      path: url.pathname,
      sub: sub === null ? url.pathname : sub,
      query: url.search,
      headers: req.headers,
      rawBody,
      fields,
      field: (name) => {
        const hit = fields.find(([k]) => k === name);
        return hit ? hit[1] : undefined;
      },
    };
    stub.requests.push(record);
    if (req.method === 'POST' && !isForm) {
      send(res, 415, { 'Content-Type': 'text/plain' }, 'Unsupported Media Type');
      return;
    }
    const c = { req, res, record, cookies: parseCookies(req.headers.cookie), stub };
    try {
      const route = routes.get(`${req.method} ${record.sub}`);
      if (route && route.raw) {
        await respond(c, nextResponder(route), (extra) => defaultHandler(c, extra));
        return;
      }
      await defaultHandler(c, {});
    } catch (err) {
      send(res, 500, {}, String(err && err.stack));
    }
  }

  const server = tls
    ? https.createServer(
        { key: fs.readFileSync(path.join(TLS_DIR, 'server.key')), cert: fs.readFileSync(path.join(TLS_DIR, 'server.pem')) },
        handler,
      )
    : http.createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  stub.port = server.address().port;
  stub.origin = `${tls ? 'https' : 'http'}://127.0.0.1:${stub.port}`;
  stub.url = `${stub.origin}${ctx}`;
  return stub;
}

module.exports = { startStubHac, escapeHtml };
