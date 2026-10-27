'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseConsoleJson } = require('../src/parse/json');

test('JSON bodies are parsed by content type or leading brace', () => {
  assert.deepEqual(parseConsoleJson({ body: '{"a":1}', contentType: 'application/json' }), { kind: 'json', value: { a: 1 } });
  assert.deepEqual(parseConsoleJson({ body: '  {"a":2}' }), { kind: 'json', value: { a: 2 } });
  assert.deepEqual(parseConsoleJson({ body: '[1]' }), { kind: 'json', value: [1] });
});

test('JSON containing login-like text is still JSON', () => {
  const body = JSON.stringify({ outputText: '<input name="j_username">' });
  assert.equal(parseConsoleJson({ body }).kind, 'json');
});

test('login page bodies are detected; anything else is invalid', () => {
  const login = fs.readFileSync(path.join(__dirname, 'fixtures', 'login', 'login.html'), 'utf8');
  assert.deepEqual(parseConsoleJson({ body: login, contentType: 'text/html' }), { kind: 'login' });
  assert.deepEqual(parseConsoleJson({ body: '{broken', contentType: 'application/json' }), { kind: 'invalid' });
  assert.deepEqual(parseConsoleJson({ body: '<html>error</html>' }), { kind: 'invalid' });
  assert.deepEqual(parseConsoleJson({ body: '' }), { kind: 'invalid' });
});
