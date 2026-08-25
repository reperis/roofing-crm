import { z } from 'zod';

/**
 * How much a value can be trusted.
 *
 * These tiers are not this repository's invention — they are published on every row of the
 * Chester County dataset this CRM consumes, and they are reproduced here unchanged. Redefining
 * them would let the two systems drift into disagreeing about what "sourced" means.
 *
 * `authoritative` — read from a government system of record (county parcel layer, EnerGov permits).
 * `synthetic`     — generated, because no lawful public feed for the field exists. Chester County
 *                   issues no building permits at all (its 73 municipalities do), the PA contractor
 *                   registry is WAF-blocked, and BBB's terms forbid automated collection.
 */
export const provenanceTierSchema = z.enum(['authoritative', 'synthetic']);
export type ProvenanceTier = z.infer<typeof provenanceTierSchema>;

/**
 * How a roof age was arrived at, matching the vocabulary the published column actually uses.
 *
 * Separate from the tier because a roof age can be *derived* from authoritative inputs (a permit
 * that records a re-roof date) without itself being a published field. Collapsing the two would
 * make a derived value indistinguishable from a generated one.
 *
 * This drifted once and it mattered: the enum listed a 'permit' basis the pipeline never emits
 * while omitting 'construction_year_proxy', which it started emitting when the county's
 * new-construction year built was ingested upstream. Converting one of those parcels to a lead
 * failed validation with a 400 — a whole class of the most trustworthy properties in the dataset
 * being the only ones a rep could not save.
 *
 * Nullable, although the published column is NOT NULL. The nullability is not for the dataset, it
 * is for history: this schema also validates lead snapshots already written to DynamoDB, and
 * `listLeads` drops rows that fail to parse. Tightening it would delete a rep's older leads from
 * their own board.
 */
export const roofAgeBasisSchema = z
  .enum(['construction_year_proxy', 'last_roof_permit', 'built_year', 'synthetic', 'unknown'])
  .nullable();
export type RoofAgeBasis = z.infer<typeof roofAgeBasisSchema>;

/**
 * The tier a roof age carries, or `null` when there is no roof age to carry one.
 *
 * `unknown` is neither authoritative nor synthetic, and folding it into either is wrong in a way
 * that shows on screen. Every one of the 17,528 `unknown` parcels has a null roof age, so there is
 * no claim to trust or distrust — and calling it authoritative marks a lead "Sourced" on the
 * strength of a number that does not exist. An absent claim contributes nothing; the lead's other
 * signals decide.
 */
export function roofAgeTier(basis: RoofAgeBasis): ProvenanceTier | null {
  switch (basis) {
    case 'built_year':
    case 'last_roof_permit':
    case 'construction_year_proxy':
      return 'authoritative';
    case 'synthetic':
      return 'synthetic';
    case 'unknown':
    case null:
      return null;
  }
}

/**
 * True when any part of a record depends on generated data.
 *
 * Deliberately pessimistic: a lead built from an authoritative parcel but a synthetic permit is
 * synthetic overall, because the reason a salesperson would call that homeowner is the permit.
 * Trust propagates from the weakest input, never the strongest.
 *
 * Nulls are accepted and ignored so that "this input makes no claim" is expressible at the one
 * place that combines claims, rather than at every call site. Three call sites each filtering
 * their own nulls is how the roof-age basis rule drifted out of agreement with itself.
 */
export function weakestTier(tiers: readonly (ProvenanceTier | null)[]): ProvenanceTier {
  return tiers.includes('synthetic') ? 'synthetic' : 'authoritative';
}
