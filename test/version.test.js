'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVersion, usesLegacyScriptingEndpoint } = require('../src/core/version');

test('parseVersion parses major.minor numerically', () => {
  assert.deepEqual(parseVersion('5.10'), { major: 5, minor: 10 });
  assert.deepEqual(parseVersion('2205'), { major: 2205, minor: 0 });
  assert.deepEqual(parseVersion(6.7), { major: 6, minor: 7 });
  assert.equal(parseVersion('abc'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(undefined), null);
});

test('legacy scripting endpoint only below 5.7 (numeric comparison)', () => {
  const cases = [
    ['5.6', true],
    ['5.7', false],
    ['5.10', false],
    ['6.7', false],
    ['2205', false],
    ['abc', false],
    ['4.8', true],
    [5.1, true], // number 5.1 is "5.1", not "5.10"
    [5.7, false],
  ];
  for (const [version, expected] of cases) {
    assert.equal(usesLegacyScriptingEndpoint(version), expected, String(version));
  }
});
