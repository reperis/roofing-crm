import { describe, expect, it } from 'vitest';

import { type RoofAgeBasis, roofAgeBasisSchema, roofAgeTier, weakestTier } from '../src/provenance';

// The vocabulary the Chester County pipeline actually publishes. Kept as a literal rather than
// derived from the schema so that a change to the schema has to disagree with something.
const PUBLISHED_BASES: RoofAgeBasis[] = [
  'built_year',
  'last_roof_permit',
  'construction_year_proxy',
  'synthetic',
  'unknown',
];

describe('roofAgeBasisSchema', () => {
  it('accepts every basis the published column emits', () => {
    for (const basis of PUBLISHED_BASES) {
      expect(roofAgeBasisSchema.parse(basis)).toBe(basis);
    }
  });

  it('rejects the "permit" basis this repository invented', () => {
    // The pipeline has never emitted 'permit' — it emits 'last_roof_permit'. The invented value
    // is what pushed 'construction_year_proxy' and 'unknown' out of the enum, so it stays dead.
    expect(roofAgeBasisSchema.safeParse('permit').success).toBe(false);
  });

  it('accepts null, because stored leads predate this vocabulary', () => {
    // Not dataset tolerance: the published column is NOT NULL. This is for lead snapshots already
    // in DynamoDB, which listLeads drops when they fail to parse.
    expect(roofAgeBasisSchema.parse(null)).toBeNull();
  });
});

describe('roofAgeTier', () => {
  it('treats every derived-from-record basis as authoritative', () => {
    expect(roofAgeTier('built_year')).toBe('authoritative');
    expect(roofAgeTier('last_roof_permit')).toBe('authoritative');
    expect(roofAgeTier('construction_year_proxy')).toBe('authoritative');
  });

  it('treats a generated roof age as synthetic', () => {
    expect(roofAgeTier('synthetic')).toBe('synthetic');
  });

  it('gives an absent claim no tier at all', () => {
    // Every 'unknown' parcel in the dataset has a null roof age. Calling that authoritative would
    // label a lead "Sourced" on the strength of a number that does not exist.
    expect(roofAgeTier('unknown')).toBeNull();
    expect(roofAgeTier(null)).toBeNull();
  });
});

describe('weakestTier', () => {
  it('propagates trust from the weakest input', () => {
    expect(weakestTier(['authoritative', 'synthetic'])).toBe('synthetic');
    expect(weakestTier(['authoritative', 'authoritative'])).toBe('authoritative');
  });

  it('ignores inputs that make no claim', () => {
    expect(weakestTier([null, 'synthetic'])).toBe('synthetic');
    expect(weakestTier([null, 'authoritative'])).toBe('authoritative');
  });

  it('defaults to authoritative when nothing claims anything', () => {
    // Fail-open, and pinned deliberately. Only reachable for a record with neither a roof-age
    // basis nor a permit, which nothing in the candidate query qualifies. If that ever changes,
    // this test is the thing that has to be argued with.
    expect(weakestTier([])).toBe('authoritative');
    expect(weakestTier([null, null])).toBe('authoritative');
  });
});
