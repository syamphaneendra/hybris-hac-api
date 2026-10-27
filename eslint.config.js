'use strict';

const js = require('@eslint/js');

/** Node globals used by this package (hand-listed to avoid an extra dependency). */
const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  globalThis: 'readonly',
};

module.exports = [
  {
    ignores: ['node_modules/', 'coverage/', '.agents/', 'test/fixtures/', '**/*.ts'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: {
      strict: ['error', 'global'],
      'no-implicit-globals': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['src/**/*.js', 'index.js'],
    rules: {
      'no-console': ['error', { allow: ['debug'] }],
    },
  },
];
