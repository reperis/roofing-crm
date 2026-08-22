import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, rename, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

/**
 * Gzip the DuckDB WASM binaries in place after the Vite build.
 *
 * CloudFront's automatic compression only applies to objects up to 10 MB. The DuckDB runtime is
 * roughly 36 MB, so it sails past that limit and is served raw — a 36 MB download before the page
 * can answer its first query. Compressing ahead of time and serving with `Content-Encoding: gzip`
 * brings it to about 8 MB, which browsers decompress transparently.
 *
 * The files keep their original names so the hashed URLs Vite emitted stay valid; only their
 * bytes and the metadata set at upload change.
 */

const DIST_ASSETS = path.join(import.meta.dirname, '..', 'dist', 'assets');

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const entries = await readdir(DIST_ASSETS).catch(() => [] as string[]);
const wasmFiles = entries.filter((name) => name.endsWith('.wasm'));

if (wasmFiles.length === 0) {
  console.log('compress-wasm: no .wasm files in dist/assets, nothing to do');
} else {
  for (const name of wasmFiles) {
    const source = path.join(DIST_ASSETS, name);
    const temporary = `${source}.gz`;

    const before = (await stat(source)).size;
    await pipeline(
      createReadStream(source),
      createGzip({ level: 9 }),
      createWriteStream(temporary),
    );
    const after = (await stat(temporary)).size;

    await rename(temporary, source);
    console.log(`compress-wasm: ${name} ${megabytes(before)} -> ${megabytes(after)}`);
  }
}
