'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, effectiveTransientBudget, qualifies, backoffMs } = require('../src/http/retry');
const { HacTransportError, HacTimeoutError, HacHttpError, HacImpexError } = require('../src/core/errors');

/**
 * @param {string} code
 * @param {boolean} connectPhase
 */
function transport(code, connectPhase) {
  const err = new HacTransportError('x', { networkCode: code });
  Object.defineProperty(err, 'connectPhase', { value: connectPhase, enumerable: false });
  return err;
}

test('effectiveTransientBudget truth table', () => {
  const rows = [
    [0, undefined, true, 'none'],
    [0, true, false, 'none'],
    [1, false, true, 'none'],
    [1, false, false, 'none'],
    [1, undefined, false, 'connect-only'],
    [1, undefined, true, 'full'],
    [1, true, false, 'full'],
    [1, true, true, 'full'],
  ];
  for (const [clientRetries, perCall, safe, expected] of rows) {
    assert.equal(effectiveTransientBudget({ clientRetries, perCall, safe }), expected, JSON.stringify({ clientRetries, perCall, safe }));
  }
});

test('classify', () => {
  assert.equal(classify(transport('ECONNREFUSED', true)), 'connect');
  assert.equal(classify(transport('ECONNRESET', false)), 'midflight');
  assert.equal(classify(transport('EPIPE', false)), 'midflight');
  assert.equal(classify(transport('DEPTH_ZERO_SELF_SIGNED_CERT', true)), 'permanent');
  assert.equal(classify(transport('ENOTFOUND', true)), 'permanent');
  assert.equal(classify(new HacTimeoutError('x', { phase: 'connect' })), 'connect');
  assert.equal(classify(new HacTimeoutError('x', { phase: 'response' })), 'permanent');
  for (const status of [502, 503, 504]) assert.equal(classify(new HacHttpError('x', { status })), 'gateway');
  assert.equal(classify(new HacHttpError('x', { status: 500 })), 'permanent');
  assert.equal(classify(new HacHttpError('x', { status: 503, phase: 'connect' })), 'permanent');
  assert.equal(classify(new HacImpexError('x')), 'permanent');
  assert.equal(classify(new Error('x')), 'permanent');
});

test('qualifies', () => {
  assert.equal(qualifies('connect', 'connect-only'), true);
  assert.equal(qualifies('midflight', 'connect-only'), false);
  assert.equal(qualifies('gateway', 'connect-only'), false);
  assert.equal(qualifies('gateway', 'full'), true);
  assert.equal(qualifies('connect', 'none'), false);
  assert.equal(qualifies('permanent', 'full'), false);
});

test('backoffMs: base + jitter, Retry-After ≤ 5 s wins', () => {
  assert.equal(backoffMs({ retryDelayMs: 500, random: () => 0 }), 500);
  assert.equal(backoffMs({ retryDelayMs: 500, random: () => 0.999 }), 749);
  assert.equal(backoffMs({ retryDelayMs: 500, retryAfter: '2', random: () => 0 }), 2000);
  assert.equal(backoffMs({ retryDelayMs: 500, retryAfter: '30', random: () => 0 }), 500);
  assert.equal(backoffMs({ retryDelayMs: 500, retryAfter: 'Wed, 21 Oct 2015 07:28:00 GMT', random: () => 0 }), 500);
  assert.equal(backoffMs({ retryDelayMs: 0, random: () => 0.5 }), 0);
});
