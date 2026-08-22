import { mkdir, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Pull the published Oracle dataset into the web app so the site can serve it same-origin.
 *
 * Data collection is out of scope for this story: these artifacts are produced by the Oracle
 * pipeline and consumed here read-only. Serving them from our own origin rather than fetching the
 * Oracle distribution directly is deliberate — that distribution sends no `Access-Control-Allow-
 * Origin`, so a cross-origin DuckDB range request from this app would be blocked by the browser.
 *
 * This was three lines of `mkdir -p` and `curl` in the justfile, which meant every recipe needed a
 * POSIX shell. On Windows `just` resolves bare `bash` against PATH, and where WSL is installed that
 * is a Linux environment with no Node in it, so the command failed with an error naming neither the
 * shell nor the cause. Doing the fetch in Node removes the shell from the question.
 */

const ORACLE_ORIGIN = process.env['ORACLE_ORIGIN'] ?? 'https://d3dix6yacibswc.cloudfront.net';

const TARGET = path.join(import.meta.dirname, '..', 'public', 'dataset');

const ARTIFACTS = ['query-table.parquet', 'permit-table.parquet', 'run-ledger.json'];

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

await mkdir(TARGET, { recursive: true });

console.log(`Staging from ${ORACLE_ORIGIN}\n`);

for (const artifact of ARTIFACTS) {
  const url = `${ORACLE_ORIGIN}/dataset/${artifact}`;
  const response = await fetch(url);

  // A 404 here means the Oracle runtime has not published, which is a different problem from a
  // network failure and worth saying out loud rather than writing an HTML error page to disk as
  // though it were a Parquet file.
  if (!response.ok) {
    console.error(`stage-data: ${url} returned HTTP ${response.status}`);
    process.exit(1);
  }

  const target = path.join(TARGET, artifact);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  console.log(`  ${artifact.padEnd(22)} ${megabytes((await stat(target)).size)}`);
}

console.log(`\nStaged into ${TARGET}`);
