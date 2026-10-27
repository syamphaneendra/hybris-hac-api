'use strict';

// Cross-platform test runner: runs every test/*.test.js file with node:test.
// Directory discovery (`node --test test/`) is not used because it would also
// pick up test/helpers/*.js.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(dir, f));

if (files.length === 0) {
  console.log('no test files found in test/');
  process.exit(0);
}

const args = ['--test'];
if (process.argv.includes('--coverage')) args.push('--experimental-test-coverage');
args.push(...files);

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
