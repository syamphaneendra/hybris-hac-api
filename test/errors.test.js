'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const errors = require('../src/core/errors');
const hac = require('../index');

const EXPECTED = {
  HacConfigError: ['HAC_CONFIG', 'HacError'],
  HacInputError: ['HAC_INVALID_INPUT', 'HacError'],
  HacTransportError: ['HAC_TRANSPORT', 'HacError'],
  HacTimeoutError: ['HAC_TIMEOUT', 'HacTransportError'],
  HacHttpError: ['HAC_HTTP_STATUS', 'HacError'],
  HacAuthError: ['HAC_AUTH', 'HacError'],
  HacSessionExpiredError: ['HAC_SESSION_EXPIRED', 'HacError'],
  HacCsrfError: ['HAC_CSRF', 'HacError'],
  HacResponseError: ['HAC_UNEXPECTED_RESPONSE', 'HacError'],
  HacImpexError: ['HAC_IMPEX_FAILED', 'HacReportedError'],
  HacScriptError: ['HAC_SCRIPT_FAILED', 'HacReportedError'],
  HacFlexibleSearchError: ['HAC_FLEXSEARCH_FAILED', 'HacReportedError'],
  HacNoResultsError: ['HAC_NO_RESULTS', 'HacError'],
  HacClientClosedError: ['HAC_CLIENT_CLOSED', 'HacError'],
};

test('every error class has its code, name and parent, and extends Error', () => {
  for (const [name, [code, parent]] of Object.entries(EXPECTED)) {
    const Ctor = errors[name];
    const err = new Ctor('boom');
    assert.equal(err.name, name);
    assert.equal(err.code, code);
    assert.ok(err instanceof errors[parent], `${name} instanceof ${parent}`);
    assert.ok(err instanceof errors.HacError);
    assert.ok(err instanceof Error);
    assert.equal(hac[name], Ctor, `${name} exported from index`);
    assert.equal(errors.ERROR_CODES[name], code);
  }
  assert.equal(hac.HacError, errors.HacError);
  assert.equal(hac.HacReportedError, errors.HacReportedError);
});

test('toJSON keeps scalar fields and extras, never cause', () => {
  const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const err = new errors.HacTransportError('failed', {
    networkCode: 'ECONNREFUSED',
    method: 'POST',
    path: '/hac/console/impex/import',
    operation: 'impexImport',
    attempts: 2,
    cause,
  });
  assert.equal(err.cause, cause);
  const json = JSON.parse(JSON.stringify(err));
  assert.deepEqual(json, {
    name: 'HacTransportError',
    code: 'HAC_TRANSPORT',
    message: 'failed',
    operation: 'impexImport',
    method: 'POST',
    path: '/hac/console/impex/import',
    attempts: 2,
    networkCode: 'ECONNREFUSED',
  });
});

test('unknown detail keys are not copied; undefined fields are not own properties', () => {
  const err = new errors.HacImpexError('x', { level: 'error', result: 'r', body: 'secret body' });
  assert.equal(err.level, 'error');
  assert.equal(err.result, 'r');
  assert.equal(Object.prototype.hasOwnProperty.call(err, 'body'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(err, 'status'), false);
});

test('withAttempts stamps attempts and a missing operation', () => {
  const err = new errors.HacHttpError('x', { status: 503 });
  assert.equal(errors.withAttempts(err, 2, 'search'), err);
  assert.equal(err.attempts, 2);
  assert.equal(err.operation, 'search');
  errors.withAttempts(err, 3, 'impexImport');
  assert.equal(err.operation, 'search');
  const plain = new Error('plain');
  assert.equal(errors.withAttempts(plain, 1), plain);
  assert.equal(plain.attempts, undefined);
});
