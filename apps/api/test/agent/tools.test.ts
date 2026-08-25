import { describe, expect, it, vi } from 'vitest';

/**
 * The agent's tool surface, exercised against a fixture that mirrors the published dataset.
 *
 * The fixture carries the roof-age bases the county actually emits, because the defect these
 * tests exist for was a vocabulary mismatch that no hand-written `'synthetic'` fixture could have
 * caught: 24,630 parcels — 12.7% of the county — carried a basis the schema did not list, and
 * converting one returned 400.
 */

const upsertLead = vi.fn();
const listLeads = vi.fn();
const getDataset = vi.fn();

vi.mock('../../src/leads/store', () => ({ upsertLead, listLeads }));
vi.mock('../../src/agent/dataset', () => ({ getDataset }));

const { buildTools } = await import('../../src/agent/tools');

const NOW = new Date('2026-08-22T12:00:00.000Z');
const WEST_CHESTER = { latitude: 39.9601, longitude: -75.6055 };
const MAX_ROWS = 25;

function property(overrides: Record<string, unknown> = {}) {
  return {
    parcel_identifier: '52-4-27',
    address_street: '415 CHRISLENA LA',
    address_city: 'West Chester',
    address_zip: '19382',
    latitude: WEST_CHESTER.latitude,
    longitude: WEST_CHESTER.longitude,
    owner_name: 'DOE JOHN',
    owner_is_out_of_area: false,
    assessed_value: 210_000,
    last_sale_date: '2004-05-11',
    property_type: 'Residential',
    roof_age_years: 27,
    roof_age_basis: 'synthetic',
    provenance_tier: 'authoritative',
    ...overrides,
  };
}

function permit(overrides: Record<string, unknown> = {}) {
  return {
    parcel_identifier: '52-4-27',
    permit_number: 'SYN-R-782236',
    improvement_type: 'roofing',
    improvement_status: 'Issued',
    opened_date: '2015-05-15',
    permit_close_date: null,
    days_open: 4_117,
    is_roofing: true,
    contractor_name: 'Phoenixville Heritage Exteriors',
    contractor_license: 'SYNTHETIC-82029',
    contractor_bbb_rating: 'B',
    contractor_bbb_score: 77,
    provenance_tier: 'synthetic',
    ...overrides,
  };
}

function tools(properties: unknown[], permits: unknown[] = []) {
  upsertLead.mockReset();
  getDataset.mockResolvedValue({ properties, permits });
  upsertLead.mockImplementation((_config: unknown, input: { parcel_identifier: string }) =>
    Promise.resolve({ lead_id: `lead#${input.parcel_identifier}`, status: 'new', score: 80 }),
  );
  return buildTools({ store: { tableName: 'leads', now: () => NOW }, now: () => NOW });
}

/**
 * Invoke a tool the way the model does — through its own input schema.
 *
 * Calling `execute` directly skips Zod's defaults, so `minPermitYearsOpen` arrives undefined and
 * every permit comparison silently becomes a NaN test that filters everything out. Parsing first
 * means the defaults are part of what these tests cover rather than something they route around.
 */
async function run(tool: unknown, input: unknown) {
  const t = tool as {
    inputSchema: { parse: (i: unknown) => unknown };
    execute: (i: unknown) => Promise<unknown>;
  };
  return await t.execute(t.inputSchema.parse(input));
}

describe('createLead', () => {
  it('converts a parcel whose roof age came from the county year built', async () => {
    // The regression. `construction_year_proxy` is 7,102 real parcels — the only ones in the
    // county with a sourced roof age — and every one of them returned 400 on conversion.
    const t = tools(
      [property({ roof_age_basis: 'construction_year_proxy', roof_age_years: 6 })],
      [permit()],
    );

    await run(t.createLead, { parcelIdentifier: '52-4-27' });

    expect(upsertLead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        snapshot: expect.objectContaining({ roof_age_basis: 'construction_year_proxy' }),
      }),
    );
  });

  it('converts a parcel that has no roof age at all', async () => {
    // 17,528 parcels report `unknown` with a null roof age. They reach the candidate list on the
    // permit signal alone, so a rep can see them — and, before this, could not save them.
    const t = tools([property({ roof_age_basis: 'unknown', roof_age_years: null })], [permit()]);

    await run(t.createLead, { parcelIdentifier: '52-4-27' });

    expect(upsertLead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        snapshot: expect.objectContaining({ roof_age_basis: 'unknown', roof_age_years: null }),
      }),
    );
  });

  it('degrades an unrecognised basis to unknown rather than discarding it', async () => {
    // 'permit' is the value this repository invented and the pipeline never emitted. The previous
    // coercion turned anything unrecognised into null, losing the distinction between "the dataset
    // says there is no basis" and "the field was absent".
    const t = tools([property({ roof_age_basis: 'permit' })], []);

    await run(t.createLead, { parcelIdentifier: '52-4-27' });

    expect(upsertLead).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        snapshot: expect.objectContaining({ roof_age_basis: 'unknown' }),
      }),
    );
  });

  it('reports a miss instead of throwing when the parcel does not exist', async () => {
    // The model must get a recoverable answer. A throw here surfaces as a 502 and ends the turn.
    const t = tools([property()], []);

    await expect(run(t.createLead, { parcelIdentifier: 'not-a-parcel' })).resolves.toMatchObject({
      created: false,
    });
    expect(upsertLead).not.toHaveBeenCalled();
  });

  it('names the signal that actually qualified the property', async () => {
    const withBoth = tools([property({ roof_age_years: 27 })], [permit()]);
    await run(withBoth.createLead, { parcelIdentifier: '52-4-27' });
    expect(upsertLead).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ source_signal: 'aged_roof_and_permit' }),
    );

    const permitOnly = tools([property({ roof_age_years: null })], [permit()]);
    await run(permitOnly.createLead, { parcelIdentifier: '52-4-27' });
    expect(upsertLead).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ source_signal: 'open_permit' }),
    );
  });
});

describe('findPropertiesInArea', () => {
  it('reports the true match count, not the number of rows it returned', async () => {
    // The documented regression: returning 25 rows silently implies 25 matches, which is how an
    // agent tells a rep there are 25 opportunities in a territory that has 40.
    const many = Array.from({ length: 40 }, (_, i) =>
      property({ parcel_identifier: `52-4-${i}`, roof_age_years: 30 }),
    );
    const t = tools(many, []);

    const result = (await run(t.findPropertiesInArea, {
      radiusMiles: 5,
      minRoofAgeYears: 15,
    })) as { total_matches: number; returned: number; rows: unknown[] };

    expect(result.total_matches).toBe(40);
    expect(result.returned).toBe(MAX_ROWS);
    expect(result.rows).toHaveLength(MAX_ROWS);
  });

  it('centres on West Chester when the question names no place', async () => {
    // The model must not invent coordinates for "around here".
    const t = tools([property({ roof_age_years: 30 })], []);

    const result = (await run(t.findPropertiesInArea, {
      radiusMiles: 5,
      minRoofAgeYears: 15,
    })) as { centre: { latitude: number; longitude: number } };

    expect(result.centre).toEqual(WEST_CHESTER);
  });

  it('keeps a county-sourced roof age authoritative until a synthetic permit weakens it', async () => {
    const sourced = tools([property({ roof_age_basis: 'construction_year_proxy' })], []);
    const noPermit = (await run(sourced.findPropertiesInArea, {
      radiusMiles: 5,
      minRoofAgeYears: 0,
    })) as { rows: { provenance: string }[] };
    expect(noPermit.rows[0]?.provenance).toBe('authoritative');

    const withPermit = tools(
      [property({ roof_age_basis: 'construction_year_proxy' })],
      [permit({ provenance_tier: 'synthetic' })],
    );
    const weakened = (await run(withPermit.findPropertiesInArea, {
      radiusMiles: 5,
      minRoofAgeYears: 0,
    })) as { rows: { provenance: string }[] };
    expect(weakened.rows[0]?.provenance).toBe('synthetic');
  });

  it('does not present a roof age with no basis as sourced', async () => {
    // `unknown` used to fall through to 'authoritative', which put a "Sourced" badge on a lead
    // whose roof age does not exist.
    const t = tools([property({ roof_age_basis: 'unknown', roof_age_years: null })], [permit()]);

    const result = (await run(t.findPropertiesInArea, {
      radiusMiles: 5,
      requireOpenPermit: true,
    })) as { rows: { roof_age_basis: string; provenance: string }[] };

    expect(result.rows[0]?.roof_age_basis).toBe('unknown');
    expect(result.rows[0]?.provenance).toBe('synthetic');
  });
});
