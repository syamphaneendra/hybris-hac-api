'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSecrets, redact } = require('../src/core/redact');

const MARKER = 'S3cr3t Pa55!*';

test('buildSecrets yields raw, encodeURIComponent and URLSearchParams spellings, longest first', () => {
  const secrets = buildSecrets({ password: MARKER });
  assert.ok(secrets.includes(MARKER));
  assert.ok(secrets.includes(encodeURIComponent(MARKER)));
  assert.ok(secrets.includes(new URLSearchParams({ p: MARKER }).toString().slice(2)));
  for (let i = 1; i < secrets.length; i++) assert.ok(secrets[i - 1].length >= secrets[i].length);
});

test('secrets shorter than 3 characters are not masked', () => {
  assert.deepEqual(buildSecrets({ password: 'ab' }), []);
  assert.deepEqual(buildSecrets({}), []);
});

test('redact masks every spelling of the password and proxy password', () => {
  const secrets = buildSecrets({ password: MARKER, proxyPassword: 'Px-Mark3r' });
  const text = [
    MARKER,
    encodeURIComponent(MARKER),
    new URLSearchParams({ p: MARKER }).toString().slice(2),
    'proxy Px-Mark3r',
  ].join(' | ');
  const out = redact(text, secrets);
  assert.ok(!out.includes('S3cr3t'), out);
  assert.ok(!out.includes('Px-Mark3r'), out);
});

test('redact masks cookies, CSRF tokens, j_password, proxy auth and URL userinfo', () => {
  const input = [
    'j_username=admin&j_password=hunter22&_csrf=tok-123',
    'Cookie: JSESSIONID=ABCDEF123; ROUTE=.node1',
    '<meta name="_csrf" content="meta-token-1"/>',
    '<meta content="meta-token-2" name="_csrf"/>',
    '<input type="hidden" name="_csrf" value="input-token-3"/>',
    'X-CSRF-TOKEN: header-token-4',
    'Proxy-Authorization: Basic dXNlcjpwYXNz',
    'http://user:pw@proxy.example.com:3128',
  ].join('\n');
  const out = redact(input);
  for (const leaked of ['hunter22', 'tok-123', 'ABCDEF123', 'meta-token-1', 'meta-token-2', 'input-token-3', 'header-token-4', 'dXNlcjpwYXNz', 'user:pw@']) {
    assert.ok(!out.includes(leaked), `${leaked} leaked: ${out}`);
  }
  assert.ok(out.includes('ROUTE=.node1'));
  assert.ok(out.includes('http://***@proxy.example.com:3128'));
});
