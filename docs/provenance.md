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
the two systems could drift into disagreeing about what "sourced" means.

| Tier            | Meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `authoritative` | Read from a government system of record, with the request recorded. |
| `synthetic`     | Generated. No lawful public source for this field exists.           |

## What is sourced, and what is not

| Signal                                       | Status        | Why                                                                                                                                                                                            |
| -------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parcels, owners, assessed values, sale dates | **Sourced**   | Chester County parcel layer, refreshed weekly. Includes owner mailing address, which is what makes absentee-owner questions answerable.                                                        |
| Well and sewage permits                      | **Sourced**   | County EnerGov system. Not roofing work — but real permits with real statuses and open dates, which is what proves the permit model against genuine records.                                   |
| Roof age                                     | **Generated** | No Chester County source publishes year built or roof age, including the CAMA-backed assessment layer.                                                                                         |
| Roofing permits                              | **Generated** | The county issues no building permits at all; all 73 municipalities permit independently, and West Chester Borough — the story's own demo target — disallows automated access in `robots.txt`. |
| Contractor identity                          | **Generated** | Pennsylvania's Home Improvement Contractor registry returns HTTP 403 to every automated request and publishes no API or bulk export.                                                           |
| BBB ratings                                  | **Generated** | BBB's public site is behind an interstitial, its API returns 401 to non-partners, and its terms prohibit automated collection.                                                                 |

Counts on the deployed dataset: **175,579 of 175,579** roof ages are synthetic, and **24,427 of
24,427** roofing permits are synthetic. There are no exceptions — which has a design consequence,
below.

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
  always with `roof_age_basis = 'synthetic'`.
- **Deterministic.** Values are seeded from the parcel's own identifier, so the same property
  yields the same roof age on every run, on any machine.

A strictly-sourced view of the data is therefore always available:
`WHERE roof_age_basis <> 'synthetic' AND provenance_tier = 'authoritative'`.
