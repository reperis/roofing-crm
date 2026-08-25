# Provenance

Four of the five signals this CRM sells on are **generated**, not sourced. That is not a shortcut
taken to save effort — no lawful public feed for them exists in Chester County — and the whole
interface is built so a salesperson can never mistake one for the other.

The reason this matters concretely: a rep is about to phone a homeowner. If the CRM tells them
"your roof is 30 years old and Malvern Roofing has had a permit open on it since 2015", and both
of those are invented, the rep repeats an invention to a stranger. Marking provenance is not a
disclaimer, it is the difference between a usable product and a liability.

## Tiers

Two values, reproduced unchanged from the upstream dataset rather than redefined here — otherwise
the two systems could drift into disagreeing about what "sourced" means. The same applies to
`roof_age_basis`, which has its own five-value vocabulary; see below for what happened the one
time this repository decided it knew better.

| Tier            | Meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `authoritative` | Read from a government system of record, with the request recorded. |
| `synthetic`     | Generated. No lawful public source for this field exists.           |

## What is sourced, and what is not

| Signal                                       | Status               | Why                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Parcels, owners, assessed values, sale dates | **Sourced**          | Chester County parcel layer, refreshed weekly. Includes owner mailing address, which is what makes absentee-owner questions answerable.                                                                                                                                                                                                                                                                      |
| Well and sewage permits                      | **Sourced**          | County EnerGov system. Not roofing work — but real permits with real statuses and open dates, which is what proves the permit model against genuine records.                                                                                                                                                                                                                                                 |
| Roof age                                     | **Mostly generated** | The CAMA-backed assessment layer publishes no year built. The county Planning Commission publishes one for 7,102 new-construction parcels (2018-2022), and those carry a sourced age. Of the rest, 168,599 carry a generated age and 17,528 carry none at all — non-residential stock the generator deliberately skips, because a roofing lead on a road easement or a utility parcel is an unworkable call. |
| Roofing permits                              | **Generated**        | The county issues no building permits at all; all 73 municipalities permit independently, and West Chester Borough — the story's own demo target — disallows automated access in `robots.txt`.                                                                                                                                                                                                               |
| Contractor identity                          | **Generated**        | Pennsylvania's Home Improvement Contractor registry returns HTTP 403 to every automated request and publishes no API or bulk export.                                                                                                                                                                                                                                                                         |
| BBB ratings                                  | **Generated**        | BBB's public site is behind an interstitial, its API returns 401 to non-partners, and its terms prohibit automated collection.                                                                                                                                                                                                                                                                               |

Counts on the deployed dataset (run `run-2026-08-22T22-33-22-490Z`): **168,599 of 175,701** roof
ages are synthetic, and **23,449 of 23,449** roofing permits are synthetic.

The 7,102 exceptions are the parcels the county publishes a year built for. Their roofs are 4-8
years old — far too young to clear any useful age threshold — so **every lead this CRM surfaces
still qualifies through a generated signal**, which is the design consequence below.

## Trust propagates from the weakest input

`weakestTier()` in `packages/schema/src/provenance.ts` is deliberately pessimistic: a lead built
on an authoritative parcel but a generated permit is a **generated lead**, because the permit — and
the contractor and BBB rating hanging off it — is the reason anyone would make the call.

This caught a real bug during development. Candidate rows were showing the _property's_ tier in
the Source column, so a row could advertise itself as "Sourced" while its contractor name and BBB
rating were invented. Rows now show the weakest tier across everything displayed in them.

The tier is stamped onto the lead at conversion and travels with it: a lead built on a generated
permit stays visibly generated after it has been assigned, worked, restaged and exported.

## Where it shows in the interface

- **Candidate list** — a `Sourced`/`Generated` tag per row, computed from the weakest input.
- **Roof age** — never rendered without its basis. `<RoofAge>` prints "30 yr · generated".
- **Detail drawer** — a provenance tag on _every permit row_, so a parcel with a sourced sewage
  permit and a generated roofing permit shows both truthfully side by side.
- **Pipeline board** — the lead's own tier, carried from conversion.
- **The agent** — instructed that provenance outranks completeness, and that it must never present
  a generated contractor or BBB rating as a business a rep could ring. `getDatasetInfo` exists so
  it can answer "how reliable is this?" with real counts rather than reassurance.
- **Dataset tab** — the table above, with the reason for each gap.

## Why the map does _not_ colour by provenance

It used to. It was wrong.

Every roofing permit is synthetic, and roof age is sourced for only the 7,102 parcels the county
publishes a year built for — 2018-2022 new construction, whose roofs are too young to clear any
useful age threshold. Since a candidate only qualifies through one of those two signals, the
"generated" flag was `true` for effectively every dot that reached the map. The colour channel
encoded a near-constant, and a legend promising a distinction the data cannot make is worse than
no legend at all.

Dots now colour by lead score — the thing that actually varies and that decides which door to
knock on — using the same three bands as the score bars in the table, so the map and the list
never disagree. Provenance stays where it varies meaningfully: per row and per permit.

## Safeguards on generated values

Applied upstream, and relied on here:

- **Contractor licences are `SYNTHETIC-#####`.** Real Pennsylvania registrations look like
  `PA012345`; a generated number in that shape could pass for real or collide with a real
  contractor's.
- **Contractor names** combine Chester County place names with generic trade words — plausible
  without impersonating any specific business.
- **`built_year` is never populated.** Writing a generated value into a column consumers read as
  assessor-sourced is indistinguishable from fabrication. Only `roof_age_years` is generated, and
  a generated one always carries `roof_age_basis = 'synthetic'`.
- **Deterministic.** Values are seeded from the parcel's own identifier, so the same property
  yields the same roof age on every run, on any machine.

## The roof-age basis vocabulary

`roof_age_basis` says how a roof age was arrived at, and it is the upstream column's vocabulary
reproduced verbatim — five values, not the two this repository once assumed:

| Basis                     | Rows in the county | Meaning                                               |
| ------------------------- | -----------------: | ----------------------------------------------------- |
| `synthetic`               |            168,599 | Generated, seeded from the parcel identifier.         |
| `unknown`                 |             17,528 | No roof age at all — the column is null on every one. |
| `construction_year_proxy` |              7,102 | Derived from the county's published year built.       |
| `last_roof_permit`        |                  0 | Derived from a permit recording a re-roof.            |
| `built_year`              |                  0 | Read from an assessor year built.                     |

The last two are published by the pipeline but do not occur in the current extract. They are
accepted anyway, because the contract is the pipeline's vocabulary and not the sample it happens
to have produced today.

This drifted once and it was expensive. The enum here listed a `permit` basis the pipeline never
emits, and omitted `construction_year_proxy` and `unknown` — so lead conversion returned a 400 for
all 24,630 parcels carrying one of them, 12.7% of the county.

Worth being exact about who could hit it, because the two paths differ:

- **From the map.** Only `construction_year_proxy`, and only with the roof-age threshold set below
  those parcels' 4–8 years — 877 of them inside the default five-mile radius at a threshold of 0.
  `unknown` parcels never reach the candidate list at all: their roof age is null, and every one of
  the 5,177 open roofing permits attaches to a `synthetic` parcel, so neither signal qualifies them.
- **From the agent, or any direct call.** `createLead` takes a parcel identifier, so all 24,630 are
  reachable there — and that path failed harder, throwing inside the store rather than returning a
  400, which surfaces as a 500.

The type system hid all of it: the browser asserts DuckDB rows rather than parsing them, so the
value travelled from Parquet to the API before anything objected.

`just verify-dataset` now checks the published values against `roofAgeBasisSchema` and is chained
into `just refresh`. It is a recipe rather than a test because `apps/web/public/dataset/` is
gitignored and CI stages no data — a test reading the real extract would fail in CI or sit there
permanently skipped. **Re-staging the dataset without running it is how this drifts again.**

A strictly-sourced view of the data is therefore always available:
`WHERE roof_age_basis IN ('built_year', 'last_roof_permit', 'construction_year_proxy')
AND provenance_tier = 'authoritative'`.

Note that this is narrower than the older `roof_age_basis <> 'synthetic'`, which also admitted
`unknown` — a row that asserts nothing rather than one that asserts something sourced.
