'use strict';

/**
 * Shared test helpers: clients wired to a stub, a capturing logger, a closed
 * port, and an unhandled-rejection guard.
 */

const net = require('node:net');

const TEST_HOOKS = Symbol.for('hybris-hac-api.test');

/** Variables that must not leak into tests from the developer machine. */
const SCRUBBED_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'HAC_HOST',
  'HAC_USER',
  'HAC_PASSWORD',
  'USER_NAME',
  'PASSWORD',
  'HYBRIS_VERSION',
  'HAC_CONTEXT_PATH',
  'HAC_TIMEOUT_MS',
  'HAC_CONNECT_TIMEOUT_MS',
  'HAC_RETRIES',
  'HAC_RETRY_DELAY_MS',
  'HAC_TLS_REJECT_UNAUTHORIZED',
  'HAC_CA_CERT',
  'HAC_DEBUG',
];

/** Removes environment variables that would change library behaviour. */
function scrubEnv() {
  for (const name of SCRUBBED_ENV) delete process.env[name];
}

/**
 * Test hooks: zero-delay sleep and deterministic jitter.
 * @param {object} [extra]
 */
function hooks(extra = {}) {
  return { sleep: async () => {}, random: () => 0, ...extra };
}

/**
 * Client for a stub with explicit env {} (no machine env), zero retry delay.
 * @param {{ origin: string, contextPath: string }} stub
 * @param {object} [overrides]
 */
function newClient(stub, overrides = {}) {
  const { [TEST_HOOKS]: extraHooks, ...rest } = overrides;
  // Lazy require: legacy tests scrub process.env before the package loads.
  const { createHacClient } = require('../../index');
  return createHacClient({
    host: stub.origin,
    contextPath: stub.contextPath,
    user: 'admin',
    password: 'nimda',
    env: {},
    retryDelayMs: 0,
    ...rest,
    [TEST_HOOKS]: hooks(extraHooks),
  });
}

/** Logger that records every call as one string per line. */
function captureLogger() {
  const lines = [];
  const record =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  return {
    lines,
    logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
    text: () => lines.join('\n'),
  };
}

/** A local port with nothing listening on it. */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Installs an unhandledRejection listener for the duration of a test.
 * @param {import('node:test').TestContext} t
 * @returns {{ assertNone(): void }}
 */
function noUnhandledRejection(t) {
  const seen = [];
  const listener = (reason) => seen.push(reason);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  return {
    assertNone() {
      if (seen.length) throw new Error(`unhandled rejection(s): ${seen.map(String).join('; ')}`);
    },
  };
}

module.exports = { TEST_HOOKS, scrubEnv, hooks, newClient, captureLogger, freePort, noUnhandledRejection };
