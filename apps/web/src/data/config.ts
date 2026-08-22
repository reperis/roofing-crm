/**
 * Where the CRM reads its property and permit records from.
 *
 * Data gathering is out of scope for this story. These tables are published by the Chester County
 * Oracle pipeline and consumed here read-only, over HTTP, with byte-range requests — which is what
 * lets the browser answer a radius query by fetching a few row groups instead of downloading
 * fifteen megabytes.
 *
 * Two sources, one switch:
 *
 * - **Oracle runtime** — read straight from the deployed Oracle distribution. This is the honest
 *   architecture: one publisher, one consumer, no copied data to drift. It requires the Oracle
 *   distribution to send CORS headers, since the CRM is served from a different origin.
 * - **Site origin** — a copy staged into this app's own bundle by `just stage-data`. Same bytes,
 *   same queries, no cross-origin dependency.
 *
 * The site-origin copy is the default deliberately. A demo that breaks because a *different*
 * repository's CDN configuration changed is a demo that fails for reasons the viewer cannot see,
 * and the runtime has to be reachable at all times. Point `VITE_ORACLE_DATASET_ORIGIN` at the
 * Oracle distribution to switch; nothing else in the app changes, because the query layer only
 * ever sees a URL.
 */

export interface DatasetSource {
  label: string;
  /** Whether these bytes come from the live Oracle deployment or a staged copy. */
  live: boolean;
  propertyTable: string;
  permitTable: string;
  runLedger: string;
}

/**
 * Absolute URLs, always.
 *
 * DuckDB's HTTP filesystem has no notion of the page's origin, so a root-relative path is read as
 * a local filename and fails with "no files found that match the pattern" — which reads like a
 * missing dataset rather than a malformed URL.
 */
function datasetAt(origin: string, label: string, live: boolean): DatasetSource {
  const base = origin.replace(/\/+$/, '');

  return {
    label,
    live,
    propertyTable: `${base}/dataset/query-table.parquet`,
    permitTable: `${base}/dataset/permit-table.parquet`,
    runLedger: `${base}/dataset/run-ledger.json`,
  };
}

export function resolveDatasetSource(): DatasetSource {
  const oracleOrigin = import.meta.env['VITE_ORACLE_DATASET_ORIGIN'];

  if (typeof oracleOrigin === 'string' && oracleOrigin !== '') {
    return datasetAt(oracleOrigin, 'Oracle runtime', true);
  }
  return datasetAt(globalThis.location.origin, 'Staged copy', false);
}

/** Where the leads API lives. Same-origin behind CloudFront, so no CORS and no key. */
export function resolveApiBase(): string {
  const configured = import.meta.env['VITE_API_BASE'];
  return typeof configured === 'string' && configured !== ''
    ? configured.replace(/\/+$/, '')
    : `${globalThis.location.origin}/api`;
}

/** Default map centre — West Chester, the county seat and the story's named demo target. */
export const WEST_CHESTER = { latitude: 39.9601, longitude: -75.6055 } as const;

export const DEFAULT_RADIUS_MILES = 5;
export const DEFAULT_ROOF_AGE_THRESHOLD = 15;
/** The story calls out permits "open for many years" as the priority signal. */
export const DEFAULT_MIN_YEARS_OPEN = 5;

/** Result caps. The map degrades badly past a few hundred pins, and the point is a work queue. */
export const MAP_RESULT_LIMIT = 500;
export const TABLE_RESULT_LIMIT = 250;
