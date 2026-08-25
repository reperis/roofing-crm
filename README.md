# Roofing CRM & Lead Identification UI

## Context

Roofing companies need a practical CRM for finding and qualifying residential and commercial roofing leads in their service area. The immediate requirement is a map-based CRM that helps sales teams explore local properties (Chester County, PA by default), surface roofs that are aging or have stalled open permits, and turn those signals into actionable outreach opportunities.

Data gathering and ingestion pipelines are covered by a separate user story and are **out of scope** for this work. This story assumes property, permit, and related enrichment data are already available for the UI and agent to consume.

## Description

Create a map-based roofing lead CRM that enables users to locate properties from their current GPS position or a pin drop on the map, set a search radius, and review candidate roofs that meet lead criteria—primarily roof age (for example, older than 15 years) and open roofing permits (especially permits that have remained open for many years).

The UI should present property and permit details, including contractor information and BBB rating scores where available. Users should also be able to query the platform in natural language through a RAG-backed agent to discover roofing opportunities (for example, “show me open roofing permits older than five years within five miles of West Chester”).

## Acceptance Criteria
- Default the map and search experience to Chester County, PA, with support for exploring properties in the user’s selected area.
- Allow users to center property search on current GPS location and/or a pin dropped on the map.
- Allow users to set a configurable search radius around the selected location.
- Display properties within the radius that have roofs older than a configurable age threshold (default suggestion: 15 years).
- Display properties within the radius that have open roofing permits, with emphasis on permits that have remained open for an extended period.
- Show permit details in the UI, including permit status, age/open duration, contractor name, and BBB rating score when available.
- Present a browsable list of matching roofing lead candidates derived from the map/radius filters.
- Support creating and managing CRM lead records from identified properties and permits.
- Provide a RAG-backed agent that answers natural-language queries about roofing opportunities using available property and permit data.
- Keep data gathering, ingestion, and source-system integration out of scope; consume pre-existing/available datasets.
- Show (disabled) sections on the CRM that would expand the product beyond the initial lead-identification workflow.

## Demo Transcript
- Open the CRM centered on Chester County, PA.
- Drop a pin (or use GPS) and set a search radius.
- Show roofs older than the age threshold (e.g., 15 years) within the radius.
- Highlight properties with open roofing permits, prioritizing long-open permits.
- Open a selected property/permit and review contractor details and BBB rating where available.
- Convert one or more matches into CRM lead records.
- Ask the RAG agent a natural-language query for roofing opportunities in the area and show relevant results.
- Demonstrate filtering leads by roof age, permit status/open duration, and location radius.
- Show disabled/placeholder sections for future CRM expansions beyond lead identification.

## Out of Scope
- Property, permit, ownership, or enrichment data collection and ingestion pipelines (separate story).
- Live BBB API integration beyond displaying scores already present in available data.
- Actual outbound messaging to property owners (can be mocked or deferred).

## Reference
- [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit)
- [Elephant Oracle Skills](https://github.com/elephant-xyz/skills)

---

# Implementation

## Live runtime

**https://d3a3829mcmqae7.cloudfront.net** — public, HTTPS, no credentials, no setup.

| Tab | What it does |
|---|---|
| **Prospect** | Map centred on Chester County. Drop a pin or use GPS, set a radius, set a roof-age threshold and a minimum permit-open duration. Returns scored lead candidates. Click any row to open the property. |
| **Pipeline** | CRM lead records. Filter by stage, move leads through the funnel, see what has gone stale. |
| **Ask** | Natural-language questions about the territory, answered from the same records plus your pipeline — with the rows the answer was written from. |
| **Dataset** | Coverage, and exactly which signals are sourced versus generated. |

Sections beyond lead identification — Estimates, Jobs, Invoicing, Outreach — are shown disabled,
with a note on what each would do.

## The workflow it supports

1. Centre the map on a territory, by pin or by GPS.
2. Filter to roofs past an age threshold and/or roofing permits open beyond a duration.
3. Read the ranked candidate list — scored on roof age, how long a permit has stalled, absentee
   ownership, owner tenure, and how weak the incumbent contractor is.
4. Open a property for its full permit history, contractor licence and BBB rating.
5. Convert it to a lead. Converting the same parcel twice updates one record rather than
   producing two calls to one homeowner.
6. Work the pipeline, or ask the agent to find the next opportunity.

## What it is searching

Consumed read-only from the Chester County Oracle pipeline. This repository collects nothing —
data gathering is a separate story.

| | |
|---|---|
| Properties | **193,229** |
| Permits | **73,856** (50,407 sourced, 23,449 generated) |
| Roofing permits | 23,449, of which **5,177 still open** |
| Within 5 mi of West Chester | 33,877 properties · 15,652 roofs over 15 yr · 923 open roofing permits · 326 open over 5 yr · 1,421 out-of-area owners |
| Query latency | **9–53 ms**, in the browser, no query server |

## Provenance

Roofing permits, contractor identity and BBB ratings are **generated** — Chester County issues no
building permits, and the state contractor registry and BBB both refuse automated access. Roof age
is generated too, with one exception: the county Planning Commission publishes a year built for
7,102 new-construction parcels, and those carry a sourced age. Those roofs are 4–8 years old, far
too young to clear a lead threshold, so every candidate this CRM surfaces still rests on a
generated signal.

Every generated value is marked as such in the data and in the interface, and a lead built on one
stays marked for life.

Full detail, including why each source is unavailable: [docs/provenance.md](docs/provenance.md).

## Why the API is unauthenticated

The lead API takes no credentials, and that is a consequence of the zero-credential demo runtime
rather than a missing check. It is also structural: the CloudFront origin request policy in front
of `/api` allow-lists exactly one header, `content-type`
([`roofing-crm-stack.ts`](../apps/api/cdk/lib/roofing-crm-stack.ts)). An `Authorization` header
would be stripped at the edge before the origin ever saw it, so adding auth means changing the
distribution and introducing an identity provider — not adding an `if` to the handler.

What bounds it today: API Gateway throttling at 20 requests per second with a burst of 40; a daily
ceiling on model calls, which is the only thing between an anonymous visitor and the account
balance, and which fails closed if its counter cannot be read; upserts keyed by parcel, so a repeat
write updates one record instead of creating duplicates; and no data beyond what Chester County
already publishes — owner names and assessed values are public record.

What it costs, plainly: anyone with the URL can create and modify leads, and the agent's
`createLead` tool reaches that same surface with no human review gate, so a well-phrased question
can put a property on the team's board. For production the first three changes would be a signed
session cookie checked at the edge — cookie forwarding is configured separately from headers, so
it survives the allow-list that a bearer token does not — per-user attribution on every lead, and a
confirmation step before the agent writes anything.

## Running it

Requires Node 24, pnpm 11 and [just](https://github.com/casey/just).

```bash
just setup           # install
just stage-data      # pull the published dataset from the Oracle runtime
just dev             # http://localhost:5173
just test            # the full Vitest suite, all four workspaces
just type-check
just verify-dataset  # check the staged dataset against the schema's vocabulary
```

Deploying needs AWS credentials for `us-east-2` and one out-of-band secret — CloudFormation cannot
create a SecureString, and routing the key through a template parameter would defeat the point:

```bash
aws ssm put-parameter --name /roofing-crm/anthropic-api-key \
  --type SecureString --value "<key>" --overwrite --region us-east-2

just bootstrap       # once per account/region
just deploy
```

## Architecture

The read side has **no server**: published Parquet is fetched over HTTP byte ranges and DuckDB
runs in the salesperson's browser, so panning the map costs nothing. The write side — leads, and
the agent — is Lambda plus DynamoDB, billed per request. Standing cost is a fraction of a cent of S3 a
month.

The agent runs its whole tool loop server-side because it reasons across two stores at once, the
county dataset and the team's pipeline, and only one of those is reachable from a browser tab. It
reads Parquet with a pure-JS reader — no native binary, no Lambda layer.

Full detail, including six problems that only surfaced against real infrastructure:
[docs/architecture.md](docs/architecture.md) · [docs/agent.md](docs/agent.md).

## Layout

```
apps/web       Vite + React SPA — map, pipeline board, agent UI, in-browser query layer
apps/api       CDK stack, leads API, agent runtime
packages/schema  Zod schemas: leads, provenance, consumed record projections
packages/shared  Radius geometry and lead scoring, shared by browser and Lambda
```

`packages/shared` is small but load-bearing: `scoreLead()` ranks the map's results in the browser
*and* stamps the score on write in the leads API, so the number a rep sees is the number stored.

## Documentation

- [docs/architecture.md](docs/architecture.md) — the two halves, cost, and what deploying taught us
- [docs/provenance.md](docs/provenance.md) — what is sourced, what is generated, and how trust propagates
- [docs/agent.md](docs/agent.md) — tool surface, spend bounds, and the prompt rules that exist because they were broken
