# Architecture

## The constraint that shapes everything

A roofing company with three salespeople cannot carry the cost of a property-intelligence
platform. That single fact decides the whole design: the parts of this CRM that _read_ — every
map pan, radius change and filter — run with no server at all, and only the parts that _write_
cost anything to operate.

The result is a product whose standing cost is a few cents of S3 storage a month, and which still
searches 193,229 properties and 74,834 permits in well under a second.

## Two halves

|                | Read side                                    | Write side              |
| -------------- | -------------------------------------------- | ----------------------- |
| What           | Property and permit search, scoring, the map | Lead records, the agent |
| Where it runs  | The salesperson's browser                    | Lambda + DynamoDB       |
| Engine         | DuckDB-WASM over Parquet, HTTP byte ranges   | Node 22 on ARM64        |
| Cost when idle | Zero                                         | Zero                    |
| Cost per use   | Zero                                         | Fractions of a cent     |

The split is not an optimisation, it is the product's economics. A radius query touches a few row
groups of a 15 MB Parquet file and never reaches a server, so a rep can drag the radius slider all
afternoon for free. Leads are the exception because they are the one thing a rep _creates_: they
must outlive a browser tab and be visible to the whole team, which no client-side store can do.

## Why DuckDB in the browser

The published tables are served with `accept-ranges: bytes`. Parquet is columnar and carries
row-group statistics, so DuckDB fetches only the columns a query names and only the row groups
whose ranges can match. `SELECT count(*)` costs one metadata read, not a fifteen-megabyte
download.

Measured on the deployed runtime: **9–53 ms** per query against 193,229 properties, including the
radius join onto permits.

Every radius query prefilters with a bounding box before computing great-circle distance. The box
is two cheap `BETWEEN` comparisons the engine can use to skip whole row groups; haversine then
trims the box's corners back to a true circle. Doing the trigonometry first would force a full
scan on every pan of the map.

## Data comes from the Oracle pipeline, not from here

Data gathering is explicitly out of scope for this story. The property and permit tables are
produced by the [Chester County Oracle pipeline](https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-chester-county-pa)
and consumed here read-only.

`apps/web/src/data/config.ts` supports two sources behind one switch:

- **Oracle runtime** — read straight from the deployed Oracle distribution. One publisher, one
  consumer, no copied data to drift.
- **Staged copy** — the same bytes pulled into this app's bundle by `just stage-data`.

The staged copy is the **default, deliberately**. The Oracle distribution does not currently send
`access-control-allow-origin`, so a cross-origin read from this domain is blocked by the browser.
More importantly, a demo that breaks because a _different_ repository's CDN configuration changed
is a demo that fails for reasons the viewer cannot see. Set `VITE_ORACLE_DATASET_ORIGIN` to read
live once CORS is added there; nothing else changes, because the query layer only ever sees a URL.

## The agent runs its whole loop server-side

The Oracle's agent has the model write SQL for the browser to execute. This one is different on
purpose: it reasons across _two_ stores — the county Parquet and the CRM's own lead pipeline — and
only one of those is reachable from a browser tab. So the tool loop runs in Lambda, where it can
read both and also write a lead when asked.

Tools read Parquet with **hyparquet**, a pure-JS reader. No native binary, no Lambda layer, no
architecture-matched build step. Measured cold: 74,834 permits in **123 ms**, 193,229 properties
across fourteen columns in **391 ms**, roughly 200 MB of heap. Parsed once per container and
cached, so only a cold start pays.

The alternative was a native DuckDB build or Athena: one adds a binary that has to match the
Lambda's architecture, the other adds a second service and seconds of latency per tool call.
Neither is worth it for a dataset this size.

## Cost

| Component                             | Cost                                  |
| ------------------------------------- | ------------------------------------- |
| S3 storage (~170 MB bundle + dataset) | ~$0.004/mo                            |
| CloudFront                            | Free tier never expires (1 TB egress) |
| Lambda                                | Free tier never expires (1M requests) |
| DynamoDB on-demand                    | Effectively zero at this volume       |
| Anthropic (Haiku 4.5)                 | ~$0.009 per agent question            |

No VPC, so no NAT Gateway. No database server. No Route53 hosted zone — the default
`*.cloudfront.net` domain provides HTTPS for free.

The agent endpoint is unauthenticated by design, which means anyone can spend the account's model
budget. That is bounded by a daily call counter in DynamoDB (atomic increment, TTL, reserved
_before_ the model call so concurrent requests cannot collectively overshoot), a five-step
ceiling, a 1,000-token output cap, a 25-row cap on what any tool may put in front of the model,
and API Gateway throttling.

## Findings from deploying

Six things that only surfaced against real infrastructure. Each is now covered by a test.

1. **CloudFront does not compress objects over 10 MB.** The DuckDB WASM runtime is ~34 MB, so it
   shipped raw. `apps/web/scripts/compress-wasm.ts` gzips at build time and a second
   `BucketDeployment` sets `contentEncoding: 'gzip'`. **34.3 MB → 7.7 MB.** Without the matching
   header the browser receives gzip bytes labelled as WebAssembly and fails to instantiate.

2. **DuckDB-WASM cannot resolve root-relative URLs.** `/dataset/x.parquet` fails with "No files
   found that match the pattern" — which reads like a missing dataset and is actually a malformed
   URL. Must be absolute.

3. **`snapshot` is a DynamoDB reserved word.** Every lead write failed with a runtime
   `ValidationException`. Unit tests asserting on the expression _string_ could not catch it. Now
   **every** attribute is aliased rather than the known collisions, because the reserved list runs
   to hundreds of entries.

4. **CloudFront's managed CORS origin-request policies drop query strings.** `?status=won` reached
   the Lambda as an unfiltered list request, so the API returned _the wrong rows rather than an
   error_ — the worst available failure mode. Replaced with a policy forwarding all query strings
   and no `Host` header (API Gateway routes on `Host` and 403s on a foreign one).

5. **Custom error responses are distribution-wide.** `404 → /index.html` was rewriting the leads
   API's "no such lead" into a 200 carrying HTML. Only 403 is mapped now; S3 behind origin access
   control answers a missing key with 403, so SPA deep links still resolve.

6. **MapLibre 6 does not locate its own tile worker.** A bundler build must call `setWorkerUrl()`
   with `?worker&url` — plain `?url` copies the file without rewriting its imports. Getting it
   wrong fails silently: the map mounts, sizes itself, accepts clicks and reports no error while
   never requesting a single tile.

## Browser automation cannot verify the map

Third-party requests are blocked in the instrumented Chrome used for automated checks, so the
basemap never loads there — and the Oracle's known-good map shows identical symptoms. Map
rendering was confirmed by a human in a normal browser window. Do not diagnose the map from
automation output.

## Repository layout

```
apps/
  web/          Vite + React SPA. Map, pipeline board, agent UI, in-browser query layer.
  api/          CDK stack, leads API, agent runtime.
packages/
  schema/       Zod schemas: leads, provenance, the consumed record projections.
  shared/       Radius geometry and lead scoring, shared by browser and Lambda.
  tsconfig/     Shared TypeScript configurations.
```

`packages/shared` matters more than its size suggests: `scoreLead()` is called by the browser to
rank the map's results _and_ by the leads API to stamp a score on write. One implementation, so
the number a rep sees on the map is the number stored on the lead.

## Deviations from the golden path

None material. TypeScript everywhere, AWS `us-east-2`, CDK as the only IaC, Vitest, Prettier +
ESLint, `tsc` for typecheck, Powertools on every Lambda, LLM access through the Vercel AI SDK
rather than a provider SDK.

Two conscious choices worth naming:

- **Anthropic directly, not Bedrock.** `stack-ai-sdk-for-llm` mandates the Vercel AI SDK, which
  this uses; Bedrock would add partner pricing and setup for no benefit here.
- **No PagerDuty or DLQ alarms.** The observability rules assume a service with an on-call
  rotation. This is a demonstration runtime with no on-call; structured logging and X-Ray tracing
  are wired, and paging a rotation that does not exist would be theatre.
