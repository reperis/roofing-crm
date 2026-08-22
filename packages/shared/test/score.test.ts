import { describe, expect, it } from 'vitest';

import { SCORE_WEIGHTS, scoreLead, type ScoreInputs } from '../src/score';

const NOW = new Date('2026-08-22T00:00:00.000Z');

function inputs(overrides: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    roofAgeYears: null,
    roofAgeThreshold: 15,
    permitDaysOpen: null,
    ownerIsOutOfArea: null,
    lastSaleDate: null,
    contractorBbbScore: null,
    now: NOW,
    ...overrides,
  };
}

describe('scoreLead', () => {
  it('scores a property with no signals at zero', () => {
    expect(scoreLead(inputs())).toBe(0);
  });

  it('ignores a roof that has not reached the threshold', () => {
    expect(scoreLead(inputs({ roofAgeYears: 14, roofAgeThreshold: 15 }))).toBe(0);
  });

  it('ramps rather than stepping as a roof ages past the threshold', () => {
    const justOver = scoreLead(inputs({ roofAgeYears: 16 }));
    const wellOver = scoreLead(inputs({ roofAgeYears: 25 }));

    expect(justOver).toBeGreaterThan(0);
    expect(wellOver).toBeGreaterThan(justOver);
  });

  it('caps the roof-age contribution at its weight', () => {
    // A 200-year-old roof is a data error, not a better lead than a 40-year-old one.
    expect(scoreLead(inputs({ roofAgeYears: 200 }))).toBe(SCORE_WEIGHTS.roofAge);
  });

  it('scores a permit open for five years at the full stalled-permit weight', () => {
    expect(scoreLead(inputs({ permitDaysOpen: 5 * 365 }))).toBe(SCORE_WEIGHTS.stalledPermit);
  });

  it('tracks the threshold the user configured, not a hardcoded fifteen', () => {
    // Same roof, lower bar: it is further past the line, so it must score higher.
    const strictThreshold = scoreLead(inputs({ roofAgeYears: 20, roofAgeThreshold: 20 }));
    const looseThreshold = scoreLead(inputs({ roofAgeYears: 20, roofAgeThreshold: 5 }));

    expect(strictThreshold).toBe(0);
    expect(looseThreshold).toBeGreaterThan(0);
  });

  it('credits an owner who has held the property for over a decade', () => {
    expect(scoreLead(inputs({ lastSaleDate: '2005-06-01' }))).toBe(SCORE_WEIGHTS.settledOwner);
    expect(scoreLead(inputs({ lastSaleDate: '2024-06-01' }))).toBe(0);
  });

  it('ignores an unparseable sale date instead of counting it as a long tenure', () => {
    expect(scoreLead(inputs({ lastSaleDate: 'not a date' }))).toBe(0);
    expect(scoreLead(inputs({ lastSaleDate: '' }))).toBe(0);
  });

  it('never exceeds 100 when every signal fires at once', () => {
    const everything = scoreLead(
      inputs({
        roofAgeYears: 40,
        permitDaysOpen: 6000,
        ownerIsOutOfArea: true,
        lastSaleDate: '1998-01-01',
        contractorBbbScore: 55,
      }),
    );

    expect(everything).toBe(100);
  });

  it('is a pure function of its inputs', () => {
    const args = inputs({ roofAgeYears: 22, permitDaysOpen: 900 });
    expect(scoreLead(args)).toBe(scoreLead(args));
  });
});
