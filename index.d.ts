/// <reference types="node" />

/**
 * hybris-hac-api: client for the SAP Commerce (Hybris) Administration Console (HAC).
 *
 * Two API styles are exported:
 * - Legacy functions (`configure`, `impexImport`, `flexibleSearch`, `executeScript`)
 *   working on a lazily created default client configured from the environment.
 * - `createHacClient(options)` / `HacClient` for explicit, typed clients.
 */

declare namespace hac {
  /** Stable error codes, one per concrete error class. */
  type HacErrorCode =
    | 'HAC_CONFIG'
    | 'HAC_INVALID_INPUT'
    | 'HAC_TRANSPORT'
    | 'HAC_TIMEOUT'
    | 'HAC_HTTP_STATUS'
    | 'HAC_AUTH'
    | 'HAC_SESSION_EXPIRED'
    | 'HAC_CSRF'
    | 'HAC_UNEXPECTED_RESPONSE'
    | 'HAC_IMPEX_FAILED'
    | 'HAC_SCRIPT_FAILED'
    | 'HAC_FLEXSEARCH_FAILED'
    | 'HAC_NO_RESULTS'
    | 'HAC_CLIENT_CLOSED';

  /** Operation that produced an error. */
  type HacOperation = 'login' | 'csrf' | 'impexImport' | 'search' | 'runScript';

  /** Minimal logger interface (console, pino, winston… all fit). */
  interface HacLoggerLike {
    debug?(message: string, fields: Record<string, unknown>): void;
    info?(message: string, fields: Record<string, unknown>): void;
    warn?(message: string, fields: Record<string, unknown>): void;
    error?(message: string, fields: Record<string, unknown>): void;
  }

  /** TLS settings. Each field falls back to its environment variable. */
  interface HacTlsOptions {
    /**
     * Verify the HAC certificate. Env: `HAC_TLS_REJECT_UNAUTHORIZED`.
     * Default: `false` (kept for compatibility), or `true` when a CA is supplied.
     */
    rejectUnauthorized?: boolean;
    /**
     * CA certificate(s) (PEM) used to verify HAC. Env: `HAC_CA_CERT` (a file path).
     * Supplying a CA turns verification on unless `rejectUnauthorized` is explicitly false.
     */
    ca?: string | Buffer | Array<string | Buffer>;
  }

  /**
   * Client options. Each field: option (when not `undefined`) > environment variable
   * (when set and not empty) > default.
   */
  interface HacClientOptions {
    /** HAC origin, e.g. `https://hac.example.com:9002`. Env: `HAC_HOST`. Required. */
    host?: string;
    /** Env: `HAC_USER`, then `USER_NAME`. Default `admin`. */
    user?: string;
    /** Env: `HAC_PASSWORD`, then `PASSWORD`. Default `nimda`. Never logged. */
    password?: string;
    /** Env: `HYBRIS_VERSION`. Default `'5.7'`. Below 5.7 the per-language scripting endpoint is used. */
    hybrisVersion?: string | number;
    /** Env: `HAC_CONTEXT_PATH`. Default `/hac`. `''` or `'/'` = root context. */
    contextPath?: string;
    /** Overall request timeout in ms. Env: `HAC_TIMEOUT_MS`. Default 120000. */
    timeoutMs?: number;
    /** Connect (TCP + TLS) timeout in ms. Env: `HAC_CONNECT_TIMEOUT_MS`. Default 10000. */
    connectTimeoutMs?: number;
    /** 0 disables transient retries and the login restart. Env: `HAC_RETRIES`. Default 1. */
    retries?: 0 | 1;
    /** Base backoff before a retry in ms. Env: `HAC_RETRY_DELAY_MS`. Default 500. */
    retryDelayMs?: number;
    /** TLS verification settings. */
    tls?: HacTlsOptions;
    /**
     * HTTP proxy URL (`http://[user:pass@]host:port`), or `false` to ignore proxy env vars.
     * Default: `http_proxy`/`HTTP_PROXY` (http hosts), `https_proxy`/`HTTPS_PROXY` (https hosts,
     * CONNECT tunnel), bypassed by `no_proxy`/`NO_PROXY`.
     */
    proxy?: string | false;
    /** Logger for structured debug/warn events. Default: silent, or console.debug when `HAC_DEBUG` is truthy. */
    logger?: HacLoggerLike;
    /** Environment to read variables from. Default `process.env`. */
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  }

  /** Options every operation accepts. */
  interface CallOptions {
    /** Overrides the client timeout for this call. */
    timeoutMs?: number;
    /**
     * `undefined`: operation default (safe ops: full single retry; unsafe ops: connect-phase only).
     * `false`: no transient retry. `true`: full single retry, also for unsafe ops.
     * Client `retries: 0` always wins.
     */
    retryOnTransientError?: boolean;
  }

  interface ImpexOptions extends CallOptions {
    /** Default `IMPORT_STRICT`. */
    validationMode?: 'IMPORT_STRICT' | 'IMPORT_RELAXED';
    /** 1..64, default 16. */
    maxThreads?: number;
    /** Default `UTF-8`. */
    encoding?: string;
    /** Default false. */
    legacyMode?: boolean;
    /** Default false. */
    enableCodeExecution?: boolean;
  }

  interface ImpexResult {
    success: true;
    /** HAC result level (`notice`, `info`, …) or null when not reported. */
    level: string | null;
    /** HAC result text, e.g. `Import finished successfully`. */
    message: string;
  }

  interface SearchOptions extends CallOptions {
    /** 1..100000, default 200. */
    maxCount?: number;
    /** HAC "execute as" user, default `admin`. */
    user?: string;
    /** Default `en`. */
    locale?: string;
  }

  interface SearchResult {
    /** Headers as HAC returns them, e.g. `p_code`. */
    headers: string[];
    /** Unique column names: leading `p_` removed unless that collides; duplicates get `#2`, `#3`… */
    columns: string[];
    /** Rows keyed by `columns`; values HTML-decoded, nulls kept. */
    rows: Array<Record<string, string | null>>;
    rowCount: number;
  }

  interface ScriptOptions extends CallOptions {
    /** Default true. */
    commit?: boolean;
    /** Letters only, default `groovy`. */
    scriptType?: string;
  }

  interface ScriptResult {
    /** HAC `outputText`. */
    output: string;
    /** HAC `executionResult`. */
    result: unknown;
    /** Full HAC JSON. */
    raw: Record<string, unknown>;
  }

  /** Base class of every error raised by this package. */
  class HacError extends Error {
    constructor(message: string, details?: Record<string, unknown>);
    readonly code: HacErrorCode | string;
    operation?: HacOperation | string;
    method?: string;
    /** Request path only (no host, no query string). */
    path?: string;
    status?: number;
    /** Number of sends of the operation request. */
    attempts?: number;
    cause?: unknown;
    /** Safe serialisation (never includes `cause`). */
    toJSON(): Record<string, unknown>;
  }
  /** Invalid or missing configuration. */
  class HacConfigError extends HacError {
    readonly code: 'HAC_CONFIG';
    variable?: string;
  }
  /** Invalid script/query/option; no request was sent. */
  class HacInputError extends HacError {
    readonly code: 'HAC_INVALID_INPUT';
    argument?: string;
  }
  /** Socket, DNS or TLS failure. */
  class HacTransportError extends HacError {
    readonly code: 'HAC_TRANSPORT' | 'HAC_TIMEOUT';
    networkCode?: string;
  }
  /** Connect or overall deadline exceeded. */
  class HacTimeoutError extends HacTransportError {
    readonly code: 'HAC_TIMEOUT';
    phase?: 'connect' | 'response';
    timeoutMs?: number;
  }
  /** Unexpected HTTP status or redirect. */
  class HacHttpError extends HacError {
    readonly code: 'HAC_HTTP_STATUS';
    bodyExcerpt?: string;
    redirectOrigin?: string;
    /** `'connect'` for a failed proxy CONNECT. */
    phase?: 'connect';
  }
  /** HAC rejected the login. */
  class HacAuthError extends HacError {
    readonly code: 'HAC_AUTH';
    reason?: string;
  }
  /** Still redirected to the login page after one re-login and replay. */
  class HacSessionExpiredError extends HacError {
    readonly code: 'HAC_SESSION_EXPIRED';
  }
  /** No CSRF token found, or 403 again after a token refresh. */
  class HacCsrfError extends HacError {
    readonly code: 'HAC_CSRF';
  }
  /** Response could not be parsed or has an unknown shape. */
  class HacResponseError extends HacError {
    readonly code: 'HAC_UNEXPECTED_RESPONSE';
    bodyExcerpt?: string;
  }
  /** Base class of failures reported by HAC itself. */
  class HacReportedError extends HacError {
    readonly code: 'HAC_IMPEX_FAILED' | 'HAC_SCRIPT_FAILED' | 'HAC_FLEXSEARCH_FAILED';
  }
  /** HAC reported an ImpEx failure. */
  class HacImpexError extends HacReportedError {
    readonly code: 'HAC_IMPEX_FAILED';
    level?: string | null;
    result?: string;
  }
  /** HAC returned a stacktrace for a script. */
  class HacScriptError extends HacReportedError {
    readonly code: 'HAC_SCRIPT_FAILED';
    stacktrace?: string;
    output?: unknown;
  }
  /** HAC returned an exception for a FlexibleSearch query. */
  class HacFlexibleSearchError extends HacReportedError {
    readonly code: 'HAC_FLEXSEARCH_FAILED';
    hacMessage?: string;
  }
  /** Legacy `flexibleSearch` only: zero rows. */
  class HacNoResultsError extends HacError {
    readonly code: 'HAC_NO_RESULTS';
    query?: string;
  }
  /** Call on a closed (or retired) client. */
  class HacClientClosedError extends HacError {
    readonly code: 'HAC_CLIENT_CLOSED';
  }

  /** A HAC session with typed operations. */
  class HacClient {
    /** Resolves options + env; throws HacConfigError synchronously. No network I/O. */
    constructor(options?: HacClientOptions);
    /** Optional explicit login; no-op when authenticated, joins an in-flight login. */
    login(): Promise<void>;
    /** Immediate close; in-flight calls fail, later calls reject with HacClientClosedError. Idempotent. */
    close(): void;
    /** Imports ImpEx; resolves only after HAC reported success. */
    importImpex(script: string, options?: ImpexOptions): Promise<ImpexResult>;
    /** FlexibleSearch returning all rows (an empty result is `rows: []`). */
    search(query: string, options?: SearchOptions): Promise<SearchResult>;
    /** Executes a script (Groovy, commit true by default). */
    runScript(script: string, options?: ScriptOptions): Promise<ScriptResult>;
    toJSON(): { host: string; contextPath: string; state: string };
  }

  /** Creates a client; throws HacConfigError synchronously on invalid options. */
  function createHacClient(options?: HacClientOptions): HacClient;

  /**
   * Overrides the default client configuration (each argument only when truthy).
   * Returns the module exports object.
   */
  function configure(host?: string, user?: string, password?: string, hybrisVersion?: string | number): typeof hac;

  /** Imports ImpEx with the default client; resolves only after HAC reported success. */
  function impexImport(script: string): Promise<void>;

  /** Runs a FlexibleSearch query and resolves the first row (keys without the first `p_`). */
  function flexibleSearch(query: string): Promise<Record<string, string>>;

  /** Executes a script and resolves the raw HAC JSON. */
  function executeScript(script: string, commit?: string | boolean, scriptType?: string): Promise<Record<string, any>>;
}

export = hac;
