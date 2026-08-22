import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

/**
 * The published Chester County tables, read into the agent's memory.
 *
 * The browser answers its own queries with DuckDB-WASM; the agent cannot, because it also has to
 * reason over the CRM's own lead records, which live in DynamoDB and are not in any Parquet file.
 * Rather than ship a database engine into Lambda, this reads the columns it needs with a pure-JS
 * Parquet reader — no native binary, no layer, no architecture-matched build step.
 *
 * That is affordable because the tables are small and the reader is fast: 193,000 properties
 * across fourteen columns parse in under half a second and occupy under 200 MB. The parse happens
 * once per container and is cached, so only a cold start pays for it.
 *
 * The alternative — a query engine, or Athena — would add either a native dependency that has to
 * be built for the Lambda's architecture, or a second service and a few seconds of latency per
 * tool call. Neither is worth it for a dataset this size.
 */

const s3 = new S3Client({});

/** Columns each tool can read. Anything not listed is never fetched off the wire at all. */
const PROPERTY_COLUMNS = [
  'parcel_identifier',
  'address_street',
  'address_city',
  'address_zip',
  'latitude',
  'longitude',
  'owner_name',
  'owner_is_out_of_area',
  'assessed_value',
  'last_sale_date',
  'property_type',
  'roof_age_years',
  'roof_age_basis',
  'provenance_tier',
] as const;

const PERMIT_COLUMNS = [
  'parcel_identifier',
  'permit_number',
  'improvement_type',
  'improvement_status',
  'opened_date',
  'permit_close_date',
  'days_open',
  'is_roofing',
  'contractor_name',
  'contractor_license',
  'contractor_bbb_rating',
  'contractor_bbb_score',
  'provenance_tier',
] as const;

export interface PropertyRow {
  parcel_identifier: string;
  address_street: string | null;
  address_city: string | null;
  address_zip: string | null;
  latitude: number | null;
  longitude: number | null;
  owner_name: string | null;
  owner_is_out_of_area: boolean | null;
  assessed_value: number | null;
  last_sale_date: string | null;
  property_type: string | null;
  roof_age_years: number | null;
  roof_age_basis: string | null;
  provenance_tier: string;
}

export interface PermitRow {
  parcel_identifier: string | null;
  permit_number: string | null;
  improvement_type: string | null;
  improvement_status: string | null;
  opened_date: string | null;
  permit_close_date: string | null;
  days_open: number | null;
  is_roofing: boolean;
  contractor_name: string | null;
  contractor_license: string | null;
  contractor_bbb_rating: string | null;
  contractor_bbb_score: number | null;
  provenance_tier: string;
}

export interface Dataset {
  properties: PropertyRow[];
  permits: PermitRow[];
}

/**
 * Parquet stores counts and day-differences as 64-bit integers, which arrive as BigInt.
 *
 * Left alone they reach `JSON.stringify` and throw — and they would throw inside a tool result,
 * where the failure reads as the model misbehaving rather than as a serialisation bug.
 */
function normalise(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out;
}

/** hyparquet reads through this interface; one download per container beats many range requests. */
async function bufferFrom(bucket: string, key: string): Promise<ArrayBuffer> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await result.Body?.transformToByteArray();

  if (bytes === undefined) {
    throw new Error(`Dataset object ${key} is empty or unreadable.`);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function readTable(
  bucket: string,
  key: string,
  columns: readonly string[],
): Promise<Record<string, unknown>[]> {
  const buffer = await bufferFrom(bucket, key);
  const file = {
    byteLength: buffer.byteLength,
    slice: (s: number, e?: number) => buffer.slice(s, e),
  };
  const metadata = await parquetMetadataAsync(file);

  const rows = await parquetReadObjects({
    file,
    metadata,
    compressors,
    columns: [...columns],
  });

  return rows.map(normalise);
}

let cached: Promise<Dataset> | null = null;

async function load(): Promise<Dataset> {
  const bucket = process.env['DATASET_BUCKET'];
  const prefix = process.env['DATASET_PREFIX'] ?? 'dataset';

  if (bucket === undefined || bucket === '') {
    throw new Error('DATASET_BUCKET is not configured on this function.');
  }

  const [properties, permits] = await Promise.all([
    readTable(bucket, `${prefix}/query-table.parquet`, PROPERTY_COLUMNS),
    readTable(bucket, `${prefix}/permit-table.parquet`, PERMIT_COLUMNS),
  ]);

  return {
    properties: properties as unknown as PropertyRow[],
    permits: permits as unknown as PermitRow[],
  };
}

/**
 * The dataset, parsed once per container.
 *
 * Caching the promise rather than the value means concurrent invocations during a cold start
 * share one parse instead of racing to make several, each allocating its own copy.
 */
export function getDataset(): Promise<Dataset> {
  cached ??= load().catch((error: unknown) => {
    // Clear on failure, or one transient S3 error poisons the container for the rest of its life.
    cached = null;
    throw error;
  });
  return cached;
}
