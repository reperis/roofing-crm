# The lead-research agent

Natural-language questions about the territory, answered from the same records the map uses plus
the team's own pipeline. Lives in the **Ask** tab; `POST /api/agent`.

## Shape

The whole tool loop runs in Lambda. The model calls tools, the tools read the published Parquet
and the CRM's DynamoDB lead table, and the model answers from what came back.

That differs from the Oracle's agent, which has the model write SQL for the browser to run, and
the difference is deliberate: this agent reasons across _two_ stores, and only one of them is
reachable from a browser tab. Running the loop server-side is also what lets it add a lead when
asked.

```
question → [ Lambda: Haiku 4.5 + tools ] → answer + the rows it read
                        │
                        ├── hyparquet over S3 → county properties & permits
                        └── DynamoDB           → the team's pipeline
```

- Model: **`claude-haiku-4-5`** — retrieval, filtering and short summarisation, not deep reasoning.
- Access: **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`), `generateText` with
  `stopWhen: stepCountIs(5)`. Provider SDKs are not used.
- Key: an **SSM SecureString**, never a Lambda environment variable — an env var is rendered into
  the CloudFormation template and staged in S3, where it would outlive any rotation. The function's
  IAM policy is scoped to that one parameter.

## Tools

Names mirror the Elephant/Oracle MCP surface where they overlap, so a consumer written against
that contract works here unchanged. The last two are this product's own.

| Tool                   | Purpose                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `findPropertiesInArea` | Radius search with roof-age and permit filters; returns scored candidates.          |
| `queryPermits`         | Open roofing permits, longest-open first, optionally near a point or by contractor. |
| `getPropertyPermits`   | Every permit on one parcel.                                                         |
| `getDatasetInfo`       | Coverage and provenance — what is sourced, what is generated, and why.              |
| `listLeads`            | The team's current pipeline, optionally by stage.                                   |
| `createLead`           | Add a property to the pipeline by parcel identifier.                                |

Every tool takes **structured parameters, not SQL**. That removes an injection surface entirely,
lets Zod reject a malformed call before any data is touched, and means a wrong answer shows up as
a visibly wrong _filter_ in the UI rather than a subtly wrong query nobody reads.

`createLead` writes through the same `upsertLead()` the REST API uses, so a lead the agent creates
is identical to one a rep converts from the map — including the idempotent `lead_id`, so asking
twice does not produce two phone calls to one homeowner.

## Answers are auditable

The response carries the answer, the tool calls with their arguments, and **the rows the model
actually read**. The UI renders all three. A summary a reader cannot check is just an assertion,
and over a dataset where four signals are generated, "trust the paragraph" is exactly the wrong
contract.

## Bounds

The endpoint is unauthenticated by design — the product is meant to be usable without credentials
— which also means anyone can spend the account's model budget.

| Bound             | Value                 | Why                                                                                                                        |
| ----------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Rows into context | 25 per tool           | The single biggest cost lever. A radius search matches thousands; the model gets the top slice plus an honest total.       |
| Output tokens     | 1,000                 | Answers are summaries, not reports.                                                                                        |
| Steps             | 5                     | A confused model cannot loop through the budget.                                                                           |
| Calls per day     | 200                   | Atomic DynamoDB counter with a TTL, reserved _before_ the model call so concurrent requests cannot collectively overshoot. |
| Gateway           | Rate + burst throttle | Bounds a spike.                                                                                                            |

Typical call: ~7,500 input and ~300 output tokens — about **$0.009**. When the daily ceiling is
reached the agent returns a 429 explaining that the map, filters and pipeline all still work.

## Prompt rules that exist because they were broken

Each of these was a real, observed failure, fixed in `src/agent/prompt.ts`:

- **Never generalise from the sample.** It reported "only one property has an out-of-area owner"
  having seen 25 of 10,197 matches — a confident false statement about the whole territory. It now
  says "of the 25 strongest I examined, one has…".
- **Never say "listed above".** It referred to rows the user could not see. The rows are now
  returned and rendered, and the phrasing is forbidden.
- **Never guess coordinates.** It invented an approximate latitude/longitude for West Chester
  instead of omitting them and letting the tool default there.
- **Provenance outranks completeness.** Generated contractor names and BBB ratings must be
  labelled, and never presented as businesses a rep could ring.

## Verified behaviour

Figures below are anchored to dataset run `run-2026-08-22T22-33-22-490Z`. Anchoring them is
deliberate: an unqualified count in a document silently becomes wrong the moment the upstream
pipeline republishes, and a stale number in a provenance document is worse than no number.

| Question                                                | Result                                                 |
| ------------------------------------------------------- | ------------------------------------------------------ |
| Open roofing permits >5 yrs within 5 mi of West Chester | 326 — matches the Prospect tile exactly                |
| Roofs >20 yrs with an out-of-area owner                 | 2,248 matched, 25 read, correctly qualified            |
| What is in my pipeline                                  | Read the leads from DynamoDB                           |
| Add parcel 52-5H-82 to my pipeline                      | Wrote `lead#52-5H-82`, confirmed via the REST API      |
| How reliable is this data                               | Cited real counts and named all four generated signals |
