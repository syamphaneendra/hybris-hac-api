'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractCsrfToken, isLoginPage, extractLoginError, parseImpexResult, excerpt } = require('../src/parse/html');

const fixture = (rel) => fs.readFileSync(path.join(__dirname, 'fixtures', rel), 'utf8');

test('extractCsrfToken: meta in any attribute order, quoting and case; hidden input fallback', () => {
  assert.equal(extractCsrfToken(fixture('login/login.html')), 'tok-meta-1');
  assert.equal(extractCsrfToken(fixture('login/login-hidden-input.html')), 'tok-input-1');
  assert.equal(extractCsrfToken(fixture('console/console.html')), 'tok-console-1');
  assert.equal(extractCsrfToken("<meta content='a&amp;b' name='_csrf'>"), 'a&b');
  assert.equal(extractCsrfToken('<meta name=_csrf content=unquoted>'), 'unquoted');
  assert.equal(extractCsrfToken('<meta name="_csrf_header" content="X-CSRF-TOKEN">'), null);
  assert.equal(extractCsrfToken(fixture('console/console-no-csrf.html')), null);
  assert.equal(extractCsrfToken(''), null);
});

test('isLoginPage by URL (context prefix removed, query ignored)', () => {
  const positives = [
    ['/hac/login.jsp', '/hac'],
    ['/hac/login', '/hac'],
    ['/hac/login.jsp?error', '/hac'],
    ['https://hac.example.com/hac/login.jsp?login_error=1', '/hac'],
    ['/login.jsp', ''],
  ];
  for (const [url, basePath] of positives) assert.equal(isLoginPage({ url, basePath }), true, url);
  const negatives = [
    ['/hac/platform/relogin', '/hac'],
    ['/hac/loginhistory', '/hac'],
    ['/hac/console?next=/login', '/hac'],
    ['/hac/', '/hac'],
  ];
  for (const [url, basePath] of negatives) assert.equal(isLoginPage({ url, basePath }), false, url);
});

test('isLoginPage by body ignores echoed editor content', () => {
  assert.equal(isLoginPage({ body: fixture('login/login.html') }), true);
  assert.equal(isLoginPage({ body: '<html><input name="j_username"></html>' }), true);
  assert.equal(isLoginPage({ body: '<textarea><input name="j_username"></textarea>' }), false);
  assert.equal(isLoginPage({ body: fixture('console/console.html') }), false);
});

test('extractLoginError: decoded, collapsed, ≤ 200 chars, null when absent', () => {
  assert.equal(extractLoginError(fixture('login/login-error.html')), 'Bad & wrong credentials');
  assert.equal(extractLoginError(fixture('login/login.html')), null);
  const long = `<div id="loginErrors">${'x'.repeat(500)}</div>`;
  assert.equal(extractLoginError(long).length, 200);
});

test('parseImpexResult fixture table', () => {
  const cases = [
    ['impex/notice.html', 'success', 'notice'],
    ['impex/info.html', 'success', 'info'],
    ['impex/success.html', 'success', 'success'],
    ['impex/error.html', 'failure', 'error'],
    ['impex/warning-problems.html', 'failure', 'warning'],
    ['impex/warning-success.html', 'success', 'warning'],
    ['impex/success-string-only.html', 'success', null],
    ['impex/impexresult-only.html', 'failure', null],
    ['impex/unknown.html', 'unknown', null],
    ['impex/echo-textarea.html', 'unknown', null],
    ['login/login.html', 'login', null],
  ];
  for (const [file, kind, level] of cases) {
    const result = parseImpexResult(fixture(file), { basePath: '/hac' });
    assert.equal(result.kind, kind, file);
    assert.equal(result.level, level, file);
  }
  const error = parseImpexResult(fixture('impex/error.html'));
  assert.match(error.message, /Import has encountered problems/);
  assert.match(error.message, /unknown attributes \[Product\.nme\]/);
  assert.ok(!error.message.includes('INSERT_UPDATE'), 'script echo must not be in the result');
  assert.equal(parseImpexResult(fixture('impex/notice.html')).message, 'Import finished successfully');
});

test('excerpt removes textarea/script/style/editor pre blocks, strips tags, decodes, redacts, truncates', () => {
  const html =
    '<html><style>.a{}</style><script>var s="x"</script><textarea name="scriptContent">SECRET SCRIPT</textarea>' +
    '<pre id="scriptPreview">SECRET PREVIEW</pre><pre class="log">kept &amp; shown</pre>' +
    '<p>j_password=hunter22</p><textarea>unclosed SECRET';
  const out = excerpt(html, ['hunter22'], 500);
  assert.ok(!out.includes('SECRET'), out);
  assert.ok(!out.includes('hunter22'), out);
  assert.ok(out.includes('kept & shown'), out);
  assert.equal(excerpt('a'.repeat(1000), [], 10).length, 10);
});
