'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startStubHac } = require('./helpers/stub-hac');
const { newClient } = require('./helpers/harness');
const { HacFlexibleSearchError, HacInputError, HacResponseError, HacSessionExpiredError } = require('../index');
const { columnNames } = require('../src/operations/flexsearch');

const FLEX = '/console/flexsearch/execute';

async function setup(t, responders) {
  const stub = await startStubHac();
  t.after(() => stub.close());
  if (responders) stub.route('POST', FLEX, responders);
  const client = newClient(stub);
  t.after(() => client.close());
  return { stub, client };
}

test('search returns all rows, prefix-only p_ stripping, decoded values, nulls kept', async (t) => {
  const { stub, client } = await setup(t, {
    json: {
      headers: ['p_code', 'shop_price', 'p_name'],
      resultList: [
        ['ORDER-0001', '10', 'Caf&eacute; &amp; Bar'],
        ['ORDER-0002', null, 'Plain'],
      ],
      exception: null,
    },
  });
  const result = await client.search('SELECT {code} FROM {Order}', { maxCount: 5, user: 'reader', locale: 'de' });
  assert.deepEqual(result.headers, ['p_code', 'shop_price', 'p_name']);
  assert.deepEqual(result.columns, ['code', 'shop_price', 'name']);
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.rows[0], { code: 'ORDER-0001', shop_price: '10', name: 'Café & Bar' });
  assert.deepEqual(result.rows[1], { code: 'ORDER-0002', shop_price: null, name: 'Plain' });
  const post = stub.requests.find((r) => r.sub === FLEX);
  assert.deepEqual(post.fields, [
    ['flexibleSearchQuery', 'SELECT {code} FROM {Order}'],
    ['sqlQuery', ''],
    ['maxCount', '5'],
    ['user', 'reader'],
    ['locale', 'de'],
    ['commit', 'false'],
  ]);
  assert.ok(post.headers['x-csrf-token'], 'header-only CSRF');
});

test('zero rows → rows: [] (no error)', async (t) => {
  const { client } = await setup(t, { json: { headers: ['p_code'], resultList: [], exception: null } });
  const result = await client.search('SELECT {pk} FROM {Order}');
  assert.deepEqual(result.rows, []);
  assert.equal(result.rowCount, 0);
});

test('column collisions keep every value', async (t) => {
  assert.deepEqual(columnNames(['p_code', 'code', 'p_name']), ['p_code', 'code', 'name']);
  assert.deepEqual(columnNames(['name', 'name']), ['name', 'name#2']);
  const { client } = await setup(t, { json: { headers: ['name', 'name'], resultList: [['a', 'b']], exception: null } });
  const result = await client.search('q');
  assert.deepEqual(result.rows[0], { name: 'a', 'name#2': 'b' });
});

test('HAC exception → HacFlexibleSearchError (not "0 results")', async (t) => {
  const { client } = await setup(t, {
    json: { headers: [], resultList: [], exception: { message: 'type with code [Prodct] unknown' } },
  });
  await assert.rejects(client.search('SELECT {pk} FROM {Prodct}'), (err) => {
    assert.ok(err instanceof HacFlexibleSearchError);
    assert.equal(err.hacMessage, 'type with code [Prodct] unknown');
    assert.equal(err.attempts, 1, 'HAC-reported failures are never retried');
    return true;
  });
});

test('non-JSON, missing fields → HacResponseError; login page → expiry handling', async (t) => {
  const html = await setup(t, { body: '<html><body>Oops</body></html>' });
  await assert.rejects(html.client.search('q'), (err) => err instanceof HacResponseError && /Oops/.test(err.bodyExcerpt));
  const missing = await setup(t, { json: { foo: 1 } });
  await assert.rejects(missing.client.search('q'), HacResponseError);
  const login = await setup(t, { body: '<form action="/hac/j_spring_security_check"><input name="j_username"></form>' });
  await assert.rejects(login.client.search('q'), HacSessionExpiredError);
});

test('input validation', async (t) => {
  const { stub, client } = await setup(t);
  await assert.rejects(client.search(''), (err) => err instanceof HacInputError && err.argument === 'query');
  await assert.rejects(client.search('q', { maxCount: 0 }), (err) => err instanceof HacInputError && err.argument === 'maxCount');
  await assert.rejects(client.search('q', { maxCount: 100001 }), HacInputError);
  await assert.rejects(client.search('q', { locale: '' }), HacInputError);
  assert.equal(stub.requests.length, 0);
});
