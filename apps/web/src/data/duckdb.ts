import * as duckdb from '@duckdb/duckdb-wasm';
import duckdbEhWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import duckdbMvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdbEh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import duckdbMvp from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';

import { resolveDatasetSource, type DatasetSource } from './config';

/**
 * DuckDB running inside the salesperson's browser.
 *
 * There is no query server behind this CRM. The published Parquet tables are read directly over
 * HTTP byte ranges, so the analytical engine is the visitor's own tab: dragging the radius slider
 * costs the business nothing, and there is no database to keep warm for a sales team of three.
 *
 * The WASM binaries ship with the bundle rather than from a public CDN — an external script origin
 * is one more thing that can be blocked by a corporate network, rate-limited, or simply go away.
 */

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: duckdbMvp, mainWorker: duckdbMvpWorker },
  eh: { mainModule: duckdbEh, mainWorker: duckdbEhWorker },
};

export interface CrmDb {
  query: <T = Record<string, unknown>>(sql: string) => Promise<T[]>;
  source: DatasetSource;
}

let instance: Promise<CrmDb> | null = null;

/** JSON cannot represent BigInt, and DuckDB returns 64-bit integers for every count. */
function normalise(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  return value;
}

async function bootstrap(): Promise<CrmDb> {
  const bundle = await duckdb.selectBundle(BUNDLES);
  if (bundle.mainWorker === null) {
    throw new Error('No compatible DuckDB WASM bundle for this browser');
  }

  const worker = new Worker(bundle.mainWorker, { type: 'module' });
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

  const connection = await db.connect();
  const source = resolveDatasetSource();

  // Views, not tables: a view resolves the remote Parquet lazily per query, so opening the CRM
  // costs one metadata read rather than a fifteen-megabyte download before the first pin drops.
  await connection.query(`
    CREATE OR REPLACE VIEW properties AS
    SELECT * FROM read_parquet('${source.propertyTable}');
  `);
  await connection.query(`
    CREATE OR REPLACE VIEW permits AS
    SELECT * FROM read_parquet('${source.permitTable}');
  `);

  return {
    source,
    query: async <T>(sql: string): Promise<T[]> => {
      const result = await connection.query(sql);
      return result.toArray().map((row) => {
        const record = row.toJSON() as Record<string, unknown>;
        return Object.fromEntries(
          Object.entries(record).map(([key, value]) => [key, normalise(value)]),
        ) as T;
      });
    },
  };
}

/** Shared connection. Bootstrapping twice would download the WASM runtime twice. */
export function getDb(): Promise<CrmDb> {
  instance ??= bootstrap();
  return instance;
}
