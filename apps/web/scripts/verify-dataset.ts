import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';
import { roofAgeBasisSchema } from '@roofing/schema';

/**
 * Check the staged dataset against the vocabulary this app compiles against.
 *
 * This exists because the two drifted once and nothing caught it: the pipeline began publishing
 * `construction_year_proxy`, the CRM's enum did not list it, and the first symptom was a rep
 * getting a 400 on 12.7% of the county. Nothing in CI can catch that — `public/dataset/` is
 * gitignored and the workflow deliberately stages no data — so the check belongs where the drift
 * actually enters, which is `just refresh`.
 */

const DATASET = resolve(import.meta.dirname, '..', 'public', 'dataset', 'query-table.parquet');

if (!existsSync(DATASET)) {
  console.error(`No staged dataset at ${DATASET}. Run \`just stage-data\` first.`);
  process.exit(1);
}

const connection = await (await DuckDBInstance.create(':memory:')).connect();
const reader = await connection.runAndReadAll(
  `SELECT DISTINCT roof_age_basis AS basis FROM read_parquet('${DATASET.split(sep).join('/')}')`,
);

// Checked with the same schema the lead API validates against, rather than against a list of
// accepted values copied out of it. A copy is one more thing that can drift, which is the exact
// failure this script exists to catch.
const published = reader.getRowObjects().map((row) => (row['basis'] ?? null) as string | null);
const unknown = published.filter((basis) => !roofAgeBasisSchema.safeParse(basis).success);

console.log(
  `Published roof_age_basis values: ${published
    .map((b) => b ?? 'NULL')
    .sort()
    .join(', ')}`,
);

if (unknown.length > 0) {
  console.error(
    `\nThe dataset publishes ${unknown.length} roof-age basis value(s) this build does not accept:` +
      `\n  ${unknown.map((b) => b ?? 'NULL').join(', ')}` +
      `\n\nEvery parcel carrying one of these will fail lead conversion with a 400.` +
      `\nAdd them to roofAgeBasisSchema in packages/schema/src/provenance.ts, and give each one` +
      `\ncopy in BASIS_COPY and a tier in roofAgeTier before shipping.`,
  );
  process.exit(1);
}

console.log(`All ${published.length} published values are accepted by roofAgeBasisSchema.`);
