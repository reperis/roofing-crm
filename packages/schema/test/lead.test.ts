import { describe, expect, it } from 'vitest';

import {
  createLeadInputSchema,
  leadIdForParcel,
  leadSchema,
  leadStatuses,
  updateLeadInputSchema,
} from '../src/lead';
import { weakestTier } from '../src/provenance';

const SNAPSHOT = {
  address_street: '123 Gay St',
  address_city: 'West Chester',
  address_zip: '19380',
  owner_name: 'DOE JOHN',
  owner_is_out_of_area: false,
  assessed_value: 210_000,
  last_sale_date: '2004-05-11',
  roof_age_years: 27,
  roof_age_basis: 'synthetic' as const,
  permit_number: 'SYNTH-00042',
  permit_status: 'Issued',
  permit_days_open: 2_400,
  contractor_name: 'Brandywine Roofing Co',
  contractor_bbb_rating: 'B',
  contractor_bbb_score: 72,
};

describe('leadIdForParcel', () => {
  it('derives the same id for the same parcel', () => {
    // Two reps converting one property must not produce two leads, and therefore two phone
    // calls to one homeowner.
    expect(leadIdForParcel('47-05-0123')).toBe(leadIdForParcel('47-05-0123'));
  });

  it('derives different ids for different parcels', () => {
    expect(leadIdForParcel('47-05-0123')).not.toBe(leadIdForParcel('47-05-0124'));
  });
});

describe('weakestTier', () => {
  it('returns authoritative only when every input is authoritative', () => {
    expect(weakestTier(['authoritative', 'authoritative'])).toBe('authoritative');
  });

  it('degrades to synthetic when any input is generated', () => {
    // A lead built on a real parcel but a generated permit is a generated lead: the permit is
    // the reason anyone would make the call.
    expect(weakestTier(['authoritative', 'synthetic'])).toBe('synthetic');
  });

  it('treats an empty input list as authoritative', () => {
    expect(weakestTier([])).toBe('authoritative');
  });
});

describe('createLeadInputSchema', () => {
  it('accepts a conversion from a map result', () => {
    const parsed = createLeadInputSchema.safeParse({
      parcel_identifier: '47-05-0123',
      source_signal: 'aged_roof_and_permit',
      latitude: 39.96,
      longitude: -75.6,
      snapshot: SNAPSHOT,
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts every roof-age basis the dataset publishes', () => {
    // The regression this exists for: 24,630 parcels — 12.7% of the county — carried a basis the
    // enum did not list, so converting one returned 400 and the rep saw "Invalid lead" on the
    // properties with the strongest permit signal in the dataset.
    for (const basis of [
      'built_year',
      'last_roof_permit',
      'construction_year_proxy',
      'synthetic',
      'unknown',
      null,
    ]) {
      const parsed = createLeadInputSchema.safeParse({
        parcel_identifier: '47-05-0123',
        source_signal: 'open_permit',
        snapshot: { ...SNAPSHOT, roof_age_basis: basis },
      });

      expect(parsed.success, `basis ${String(basis)} must convert`).toBe(true);
    }
  });

  it('rejects the roof-age basis this repository invented', () => {
    const parsed = createLeadInputSchema.safeParse({
      parcel_identifier: '47-05-0123',
      source_signal: 'open_permit',
      snapshot: { ...SNAPSHOT, roof_age_basis: 'permit' },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects a lead with no parcel to hang off', () => {
    const parsed = createLeadInputSchema.safeParse({
      parcel_identifier: '',
      source_signal: 'manual',
      snapshot: SNAPSHOT,
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses a client-supplied score', () => {
    // Score and provenance are server-owned. Accepting them from the client would let a caller
    // promote its own leads to the top of the queue.
    const parsed = createLeadInputSchema.safeParse({
      parcel_identifier: '47-05-0123',
      source_signal: 'manual',
      snapshot: SNAPSHOT,
      score: 100,
      provenance_tier: 'authoritative',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('score');
      expect(parsed.data).not.toHaveProperty('provenance_tier');
    }
  });

  it('caps note length rather than storing unbounded text', () => {
    const parsed = createLeadInputSchema.safeParse({
      parcel_identifier: '47-05-0123',
      source_signal: 'manual',
      snapshot: SNAPSHOT,
      note: 'x'.repeat(2001),
    });

    expect(parsed.success).toBe(false);
  });
});

describe('updateLeadInputSchema', () => {
  it('accepts every pipeline stage', () => {
    for (const status of leadStatuses) {
      expect(updateLeadInputSchema.safeParse({ status }).success).toBe(true);
    }
  });

  it('rejects a stage that is not in the pipeline', () => {
    expect(updateLeadInputSchema.safeParse({ status: 'archived' }).success).toBe(false);
  });
});

describe('leadSchema', () => {
  it('round-trips a fully populated lead', () => {
    const lead = {
      lead_id: leadIdForParcel('47-05-0123'),
      parcel_identifier: '47-05-0123',
      latitude: 39.96,
      longitude: -75.6,
      status: 'new' as const,
      source_signal: 'aged_roof_and_permit' as const,
      score: 87,
      provenance_tier: 'synthetic' as const,
      snapshot: SNAPSHOT,
      notes: [],
      created_at: '2026-08-22T12:00:00.000Z',
      updated_at: '2026-08-22T12:00:00.000Z',
      status_changed_at: '2026-08-22T12:00:00.000Z',
    };

    expect(leadSchema.safeParse(lead).success).toBe(true);
  });

  it('rejects a score outside 0-100', () => {
    const lead = {
      lead_id: leadIdForParcel('47-05-0123'),
      parcel_identifier: '47-05-0123',
      latitude: null,
      longitude: null,
      status: 'new' as const,
      source_signal: 'manual' as const,
      score: 140,
      provenance_tier: 'authoritative' as const,
      snapshot: SNAPSHOT,
      notes: [],
      created_at: '2026-08-22T12:00:00.000Z',
      updated_at: '2026-08-22T12:00:00.000Z',
      status_changed_at: '2026-08-22T12:00:00.000Z',
    };

    expect(leadSchema.safeParse(lead).success).toBe(false);
  });
});
