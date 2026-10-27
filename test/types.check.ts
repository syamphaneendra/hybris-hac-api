// Static type checks for index.d.ts (checked by `npm run build`, never executed).

import hac = require('../index');
import type { HacErrorCode, ImpexResult, SearchResult, ScriptResult, HacClientOptions } from '../index';

async function legacyApi(): Promise<void> {
  const self: typeof hac = hac.configure('https://hac.example.com', 'admin', '<password>', 5.7);
  hac.configure('https://hac.example.com', undefined, undefined, '5.7');
  self.configure();

  const imported: void = await hac.impexImport('INSERT_UPDATE Product; code[unique=true]\n; ORDER-0001');
  void imported;

  const row: Record<string, string> = await hac.flexibleSearch('SELECT {pk} FROM {Product}');
  const code: string = row.code;
  void code;

  const raw: Record<string, any> = await hac.executeScript('println "hello"', false);
  await hac.executeScript('println "hello"', 'true', 'groovy');
  await hac.executeScript('println "hello"');
  void raw;
}

async function clientApi(): Promise<void> {
  const options: HacClientOptions = {
    host: 'https://hac.example.com',
    retries: 0,
    retryDelayMs: 0,
    contextPath: '',
    tls: { rejectUnauthorized: true, ca: ['-----BEGIN CERTIFICATE-----'] },
    proxy: false,
    env: {},
  };
  const client = hac.createHacClient(options);
  const other: hac.HacClient = new hac.HacClient({ proxy: 'http://proxy.example.com:3128' });
  other.close();

  await client.login();
  const impex: ImpexResult = await client.importImpex('REMOVE Product; code[unique=true]', {
    validationMode: 'IMPORT_RELAXED',
    maxThreads: 4,
    retryOnTransientError: false,
  });
  const ok: true = impex.success;
  const level: string | null = impex.level;
  void ok;
  void level;

  const result: SearchResult = await client.search('SELECT {pk} FROM {Product}', { maxCount: 10 });
  const first: string | null | undefined = result.rows[0]?.[result.columns[0]];
  const count: number = result.rowCount;
  void first;
  void count;

  const script: ScriptResult = await client.runScript('println "hi"', { commit: false, timeoutMs: 1000 });
  const output: string = script.output;
  void output;
  client.close();
}

function describe(err: unknown): string {
  if (!(err instanceof hac.HacError)) return 'other';
  const code: HacErrorCode | string = err.code;
  if (err instanceof hac.HacImpexError) {
    const literal: 'HAC_IMPEX_FAILED' = err.code;
    return `${literal} ${err.level ?? ''} ${err.result ?? ''}`;
  }
  if (err instanceof hac.HacTimeoutError) {
    const phase: 'connect' | 'response' | undefined = err.phase;
    return `${phase}`;
  }
  switch (code) {
    case 'HAC_AUTH':
      return 'auth';
    case 'HAC_SESSION_EXPIRED':
      return 'expired';
    default:
      return `${err.status ?? ''} ${err.attempts ?? ''}`;
  }
}

void legacyApi;
void clientApi;
void describe;

export {};
