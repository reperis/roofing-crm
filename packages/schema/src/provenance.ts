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
 * Basis for a roof age figure.
 *
 * Separate from the tier because a roof age can be *derived* from authoritative inputs (a permit
 * that records a re-roof date) without itself being a published field. Collapsing the two would
 * make a derived value indistinguishable from a generated one.
 */
export const roofAgeBasisSchema = z.enum(['permit', 'synthetic']).nullable();
export type RoofAgeBasis = z.infer<typeof roofAgeBasisSchema>;

/**
 * True when any part of a record depends on generated data.
 *
 * Deliberately pessimistic: a lead built from an authoritative parcel but a synthetic permit is
 * synthetic overall, because the reason a salesperson would call that homeowner is the permit.
 * Trust propagates from the weakest input, never the strongest.
 */
export function weakestTier(tiers: readonly ProvenanceTier[]): ProvenanceTier {
  return tiers.includes('synthetic') ? 'synthetic' : 'authoritative';
}
