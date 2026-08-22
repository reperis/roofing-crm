/**
 * Lead scoring.
 *
 * A radius search over Chester County routinely returns thousands of matching parcels. A list that
 * long is not a work queue, so the CRM has to have an opinion about which door to knock on first.
 *
 * The weights below are *business assumptions*, not measurements — nobody has closed-won data for
 * this territory yet. They are gathered here as named constants, rather than scattered through the
 * query layer, precisely so a roofing company can retune them against their own conversion history
 * without touching anything else. Each one records the reasoning it rests on.
 */

export interface ScoreInputs {
  roofAgeYears: number | null;
  /** Age threshold currently configured in the UI; scoring is relative to what the user asked for. */
  roofAgeThreshold: number;
  permitDaysOpen: number | null;
  ownerIsOutOfArea: boolean | null;
  lastSaleDate: string | null;
  contractorBbbScore: number | null;
  /** Reference point for "how long ago", passed in so scoring stays a pure function. */
  now: Date;
}

export const SCORE_WEIGHTS = {
  /** Roof age is the primary signal the story names; it carries the largest single share. */
  roofAge: 40,
  /** A roofing permit still open after years is a stalled job — the strongest buying signal. */
  stalledPermit: 35,
  /** Absentee owners are landlords: a different, often faster, purchasing decision. */
  absenteeOwner: 10,
  /** An owner who has not sold in a decade is investing in the property, not staging it to sell. */
  settledOwner: 10,
  /** A weakly-rated incumbent contractor is a displaceable one. */
  weakIncumbent: 5,
} as const;

/** A roof this far past the threshold earns the full roof-age share. */
const ROOF_AGE_SATURATION_YEARS = 15;
/** A permit open this long earns the full stalled-permit share. Five years is the story's own bar. */
const PERMIT_SATURATION_DAYS = 5 * 365;
const SETTLED_OWNER_YEARS = 10;
/** BBB scores run 0-100; below this the incumbent is weak enough to be worth displacing. */
const WEAK_BBB_SCORE = 80;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function yearsSince(isoDate: string | null, now: Date): number | null {
  if (isoDate === null || isoDate === '') return null;
  const parsed = Date.parse(isoDate);
  if (Number.isNaN(parsed)) return null;
  return (now.getTime() - parsed) / (365.25 * 24 * 60 * 60 * 1000);
}

/**
 * Score a lead from 0 to 100.
 *
 * Ramps rather than thresholds: a roof one year over the line should not score the same as one
 * fifteen years over, and a cliff edge at the threshold would make the ordering jump around every
 * time a rep nudged the slider.
 */
export function scoreLead(inputs: ScoreInputs): number {
  let score = 0;

  if (inputs.roofAgeYears !== null) {
    const yearsOver = inputs.roofAgeYears - inputs.roofAgeThreshold;
    if (yearsOver > 0) {
      score += SCORE_WEIGHTS.roofAge * clamp01(yearsOver / ROOF_AGE_SATURATION_YEARS);
    }
  }

  if (inputs.permitDaysOpen !== null && inputs.permitDaysOpen > 0) {
    score += SCORE_WEIGHTS.stalledPermit * clamp01(inputs.permitDaysOpen / PERMIT_SATURATION_DAYS);
  }

  if (inputs.ownerIsOutOfArea === true) {
    score += SCORE_WEIGHTS.absenteeOwner;
  }

  const ownedYears = yearsSince(inputs.lastSaleDate, inputs.now);
  if (ownedYears !== null && ownedYears >= SETTLED_OWNER_YEARS) {
    score += SCORE_WEIGHTS.settledOwner;
  }

  if (inputs.contractorBbbScore !== null && inputs.contractorBbbScore < WEAK_BBB_SCORE) {
    score += SCORE_WEIGHTS.weakIncumbent;
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}
