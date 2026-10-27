'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CookieJar, defaultPath, pathMatches } = require('../src/http/cookie-jar');

const ORIGIN = 'https://hac.example.com:9002';

test('stores and sends cookies for the same origin only', () => {
  const jar = new CookieJar(ORIGIN);
  jar.store(['JSESSIONID=abc; Path=/hac; HttpOnly; Secure', 'ROUTE=.node1; Path=/'], `${ORIGIN}/hac/login.jsp`);
  assert.equal(jar.header(`${ORIGIN}/hac/console/impex/import`), 'JSESSIONID=abc; ROUTE=.node1');
  assert.equal(jar.header(`${ORIGIN}/other`), 'ROUTE=.node1');
  assert.equal(jar.header('https://other.example.com:9002/hac/'), '');
  jar.store('EVIL=1; Path=/', 'https://other.example.com/');
  assert.ok(!jar.header(`${ORIGIN}/`).includes('EVIL'));
});

test('Max-Age=0 and past Expires delete; future Max-Age expires later', () => {
  let now = 1_000_000;
  const jar = new CookieJar(ORIGIN, { now: () => now });
  jar.store(['A=1; Path=/', 'B=2; Path=/; Max-Age=10', 'C=3; Path=/'], `${ORIGIN}/`);
  assert.equal(jar.header(`${ORIGIN}/`), 'A=1; B=2; C=3');
  jar.store(['A=gone; Path=/; Max-Age=0', `C=gone; Path=/; Expires=${new Date(now - 1000).toUTCString()}`], `${ORIGIN}/`);
  assert.equal(jar.header(`${ORIGIN}/`), 'B=2');
  now += 11_000;
  assert.equal(jar.header(`${ORIGIN}/`), '');
});

test('Secure cookies are only stored and sent over https', () => {
  const jar = new CookieJar('http://hac.example.com:9001');
  jar.store('S=1; Secure; Path=/', 'http://hac.example.com:9001/');
  assert.equal(jar.header('http://hac.example.com:9001/'), '');
});

test('default path and path matching follow RFC 6265', () => {
  assert.equal(defaultPath('/hac/login.jsp'), '/hac');
  assert.equal(defaultPath('/login.jsp'), '/');
  assert.equal(defaultPath(''), '/');
  assert.equal(pathMatches('/hac/console', '/hac'), true);
  assert.equal(pathMatches('/hacker', '/hac'), false);
  assert.equal(pathMatches('/hac', '/hac'), true);
  assert.equal(pathMatches('/hac/x', '/hac/'), true);
  const jar = new CookieJar(ORIGIN);
  jar.store('D=1', `${ORIGIN}/hac/login.jsp`);
  assert.equal(jar.header(`${ORIGIN}/hac/console`), 'D=1');
  assert.equal(jar.header(`${ORIGIN}/`), '');
});

test('clear removes everything; malformed headers are ignored', () => {
  const jar = new CookieJar(ORIGIN);
  jar.store(['novalue', '=x', 'K=v'], `${ORIGIN}/`);
  assert.equal(jar.header(`${ORIGIN}/`), 'K=v');
  jar.clear();
  assert.equal(jar.header(`${ORIGIN}/`), '');
});
