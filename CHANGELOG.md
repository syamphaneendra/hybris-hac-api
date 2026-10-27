# Changelog

All notable changes to this fork are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-10-26

Major release. The main fix (`impexImport` now waits for HAC and rejects on failure) turns calls that used to "succeed" into rejections, and several smaller changes below can break existing code.

### Fixed

- `impexImport` awaits HAC and resolves only after HAC reports success. It rejects on transport errors, HTTP errors, expired sessions and HAC-reported ImpEx failures. Upstream resolved immediately and the failure surfaced later as an unhandled rejection, which can crash Node 15+ processes.
- No more implicit globals (`configure`, `login`, `build`, `config`, `instance`, `csrfToken`, `jSession`, …). All modules use `'use strict'`.
- `HAC_USER` and `HAC_PASSWORD` are read, as the upstream README documented; `USER_NAME` and `PASSWORD` remain as fallbacks.
- The `hybrisVersion` passed to `configure()` is honoured when choosing the scripting endpoint, and versions compare numerically (`5.10` is newer than `5.7`).
- FlexibleSearch query errors are reported as `HacFlexibleSearchError` instead of "returned 0 results".
- Login failures, unexpected pages and missing cookies produce clear errors instead of `TypeError`s.
- Expired sessions are detected (redirect to the login page, 401, login page body) and recovered with one re-login and replay.
- A 403 triggers one CSRF token refresh and replay. CSRF extraction accepts any attribute order and quoting, with a hidden-input fallback; a missing token is `HacCsrfError`.
- All cookies are kept, including load-balancer affinity cookies; no manual `JSESSIONID` header.
- The self-referencing `require('hybris-hac-api/...')` is gone, so the package works from a checkout.
- Credentials, session cookies and CSRF tokens no longer appear in error objects or messages.
- The ImpEx script is no longer copied into error messages, and the ImpEx success page is no longer printed with `console.log`.
- `flexibleSearch` keys: `client.search` strips only a leading `p_`; the legacy function keeps the upstream mapping.

### Added

- `createHacClient(options)` and `HacClient` with `login()`, `importImpex()`, `search()`, `runScript()` and `close()`. One session per client, reused across calls; concurrent calls share a single login.
- `search()` returns all rows (`headers`, `columns`, `rows`, `rowCount`, `maxCount` up to 100000), and an empty result is `rows: []`.
- `importImpex()` resolves to `{ success, level, message }`; options `validationMode`, `maxThreads`, `encoding`, `legacyMode`, `enableCodeExecution`.
- `runScript()` resolves to `{ output, result, raw }`; options `scriptType`, `commit`.
- Per-call options `timeoutMs` and `retryOnTransientError`.
- Error hierarchy with stable codes: `HacError`, `HacConfigError`, `HacInputError`, `HacTransportError`, `HacTimeoutError`, `HacHttpError`, `HacAuthError`, `HacSessionExpiredError`, `HacCsrfError`, `HacResponseError`, `HacReportedError`, `HacImpexError`, `HacScriptError`, `HacFlexibleSearchError`, `HacNoResultsError`, `HacClientClosedError`. `toJSON()` is safe to log.
- Environment variables `HAC_CONTEXT_PATH`, `HAC_TIMEOUT_MS`, `HAC_CONNECT_TIMEOUT_MS`, `HAC_RETRIES`, `HAC_RETRY_DELAY_MS`, `HAC_TLS_REJECT_UNAUTHORIZED`, `HAC_CA_CERT`, `HAC_DEBUG`, with matching client options, plus `tls`, `proxy`, `logger` and `env` options.
- One transient retry per call with backoff: full retry for FlexibleSearch, connect-phase only for ImpEx and scripts unless opted in. The login sequence restarts once on a transient failure.
- Opt-in TLS verification with Node's trust store or a custom CA.
- Native proxy support (`http_proxy`/`HTTP_PROXY`, `https_proxy`/`HTTPS_PROXY` via CONNECT, `no_proxy`/`NO_PROXY`), with proxy credentials redacted.
- Structured, allow-listed debug logging (silent by default).
- TypeScript declarations (`index.d.ts`).
- Test suite against a local HAC stub, ESLint, type checking, and `lint`, `build`, `typecheck`, `check`, `test:coverage` scripts.
- `LICENSE` file, README rewrite, `docs/ARCHITECTURE.md`, `docs/USAGE-GUIDE.md`.

### Changed (check before upgrading)

1. `impexImport` waits for HAC and rejects on failure (see Fixed). Pipelines that passed while imports silently failed will now fail.
2. Implicit globals are gone. Code that read `global.config` or called the globals directly breaks.
3. Rejections are `HacError` subclasses instead of axios errors. Use `err.status` instead of `err.response.status`, and `err.code` to branch.
4. ImpEx failure messages have a new format (`Impex import failed (level=<level>):` plus HAC's result) and no longer contain the script.
5. `HAC_USER`/`HAC_PASSWORD` take precedence over `USER_NAME`/`PASSWORD` when both are set.
6. The `hybrisVersion` from `configure()` is honoured. For the legacy API, `HYBRIS_VERSION` is read once when the package is loaded; changing `process.env.HYBRIS_VERSION` later has no effect (use `configure()`).
7. One login per client instead of one per call. Requests send `User-Agent: hybris-hac-api/<version>`.
8. Transient failures are retried once by default (`HAC_RETRIES=0` turns this off).
9. Legacy `flexibleSearch` reports HAC query exceptions as `HacFlexibleSearchError`, and malformed responses or login pages as their own errors, instead of "0 results".
10. `configure()` returns the module exports object instead of `this`.
11. Empty or non-string scripts and queries reject with `HacInputError` before any request.
12. Node.js 18 or later is required (`engines`). axios, axios-cookiejar-support, tough-cookie and jsdom are no longer dependencies.
13. `config.HAC_PASSWORD` (deep require `src/config`) is non-enumerable, so it no longer shows up in `console.log(config)` or `JSON.stringify(config)`.
14. Redirects are followed only within the `HAC_HOST` origin (at most 5 hops). A redirect to another origin, including `http` to `https`, is `HacHttpError` naming the target origin.
15. Legacy `executeScript` validates `scriptType` (letters only).
16. A script response without `stacktraceText` rejects with `HacResponseError`.
17. `HAC_HOST` with credentials, a query, a hash or a non-http(s) scheme is rejected with `HacConfigError`. The missing-`HAC_HOST` message is unchanged.
18. The deep-require `login()` reuses the current session instead of always logging in again.
19. Proxies are handled natively: lower-case env names are checked first, `https:` proxy URLs are not supported, and a failed CONNECT is `HacHttpError` with `phase: 'connect'`.
20. New sockets have a 10 s connect timeout (`HAC_CONNECT_TIMEOUT_MS`), on top of the existing 2-minute overall timeout.
21. Response bodies are limited to 50 MiB, and compressed responses are rejected.

### Kept

The four exported functions with their arguments, defaults and resolved shapes; the deep-require paths and export names; the env names `HAC_HOST`, `USER_NAME`, `PASSWORD`, `HYBRIS_VERSION`; the `admin`/`nimda` defaults; TLS verification off by default; the legacy form fields; the "0 results" and "HAC Script error occurred" messages; `instanceof Error` for every rejection; CommonJS and ESM imports.

### Security

- Dependency audit: 0 known vulnerabilities (upstream's dependency tree had 7).
- TLS verification remains off by default for compatibility. Enable it with `HAC_TLS_REJECT_UNAUTHORIZED=true` or `HAC_CA_CERT`.

## [1.1.9] - upstream

Last upstream release by Alexandr Grisin, published on npm as `hybris-hac-api@1.1.9`. See [AlexGrisin/hybris-hac-api](https://github.com/AlexGrisin/hybris-hac-api) for its history.
