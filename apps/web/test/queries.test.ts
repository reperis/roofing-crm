import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { roofAgeBasisSchema } from '@roofing/schema';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildLeadCandidateSql } from '../src/data/queries';

/**
 * What counts as a lead.
 *
 * This repository had no frontend tests, and the SQL layer is where the product's actual judgement
 * lives — so the one bug that reached a reviewer was here: the permit-stall floor was applied to
 * the property rather than to the permit signal, and a parcel whose roof qualified on its own was
 * dropped for carrying a permit that was too *young*. The candidate list ended up shorter than the
 * "aged roofs" tile directly above it.
 *
 * The bug was in SQL semantics, so the test executes SQL. Asserting the shape of a query string
 * would have passed against the broken predicate.
 *
 * Runs the real DuckDB in Node against a seeded four-parcel fixture — no network, no published
 * dataset, so it holds in CI.
 */

const WEST_CHESTER = { latitude: 39.9601, longitude: -75.6055 };
const YEAR = 365;

/**
 * Parcels covering every combination that matters.
 *
 * `1-AGED-YOUNGPERMIT` is one regression: an aged roof whose permit is younger than any stall
 * floor a user might set. It qualifies through its roof and must survive regardless.
 *
 * `5-PROXY-STALLED` and `6-UNKNOWN-STALLED` are the other. They carry the two roof-age bases the
 * schema used to omit — 24,630 real parcels between them — and both reach the candidate list on
 * the permit signal alone, exactly as they do in the county. A fixture that only ever said
 * 'synthetic' is why the mismatch reached production.
 */
const FIXTURE = `
  CREATE TABLE properties AS SELECT * FROM (VALUES
    ('1-AGED-YOUNGPERMIT', 30,   39.9605, -75.6060, 'synthetic'),
    ('2-AGED-NOPERMIT',    35,   39.9606, -75.6061, 'synthetic'),
    ('3-NEW-STALLED',       3,   39.9607, -75.6062, 'synthetic'),
    ('4-NEW-YOUNGPERMIT',   3,   39.9608, -75.6063, 'built_year'),
    ('5-PROXY-STALLED',     6,   39.9609, -75.6064, 'construction_year_proxy'),
    ('6-UNKNOWN-STALLED', NULL,  39.9610, -75.6065, 'unknown')
  ) AS t(parcel_identifier, roof_age_years, latitude, longitude, roof_age_basis);

  CREATE TABLE permits AS SELECT * FROM (VALUES
    ('1-AGED-YOUNGPERMIT', 'P-1', 30),
    ('3-NEW-STALLED',      'P-3', ${9 * YEAR}),
    ('4-NEW-YOUNGPERMIT',  'P-4', 30),
    ('5-PROXY-STALLED',    'P-5', ${11 * YEAR}),
    ('6-UNKNOWN-STALLED',  'P-6', ${11 * YEAR})
  ) AS t(parcel_identifier, permit_number, days_open);
`;

/** The columns the real query selects that the fixture does not carry. */
const MISSING_COLUMNS = [
  'address_street',
  'address_city',
  'address_zip',
  'owner_name',
  'owner_is_out_of_area',
  'assessed_value',
  'market_value',
  'last_sale_date',
  'property_type',
  'provenance_tier',
];

describe('buildLeadCandidateSql', () => {
  let connection: DuckDBConnection;

  beforeAll(async () => {
    connection = await (await DuckDBInstance.create(':memory:')).connect();
    await connection.run(FIXTURE);

    // Widen the fixture to the query's full projection, and add the permit columns it reads.
    for (const column of MISSING_COLUMNS) {
      await connection.run(`ALTER TABLE properties ADD COLUMN ${column} VARCHAR;`);
    }
    for (const column of ['improvement_status', 'contractor_name', 'contractor_bbb_rating']) {
      await connection.run(`ALTER TABLE permits ADD COLUMN ${column} VARCHAR;`);
    }
    for (const column of ['contractor_bbb_score']) {
      await connection.run(`ALTER TABLE permits ADD COLUMN ${column} DOUBLE;`);
    }
    await connection.run(`ALTER TABLE permits ADD COLUMN is_roofing BOOLEAN DEFAULT TRUE;`);
    await connection.run(`ALTER TABLE permits ADD COLUMN permit_close_date VARCHAR;`);
    await connection.run(`ALTER TABLE permits ADD COLUMN provenance_tier VARCHAR;`);
    await connection.run(`UPDATE permits SET is_roofing = TRUE;`);
  }, 60_000);

  const candidates = async (filters: {
    minRoofAge: number;
    minYearsOpen: number;
    requireOpenPermit: boolean;
  }): Promise<string[]> => {
    const sql = buildLeadCandidateSql(WEST_CHESTER, 5, { ...filters, limit: 100 });
    const rows = (await connection.runAndReadAll(sql)).getRowObjects();
    return rows.map((row) => String(row['parcel_identifier'])).sort();
  };

  it('returns no candidate the lead API would refuse to save', async () => {
    // The seam the defect crossed. Every basis the candidate query can surface has to be one the
    // write boundary accepts, or a rep sees a row on the map, clicks Convert, and gets a 400 —
    // which is exactly what 24,630 parcels did. Asserting the two ends against each other is the
    // cheapest place to catch the next vocabulary change, and it costs nothing at runtime.
    const sql = buildLeadCandidateSql(WEST_CHESTER, 5, {
      minRoofAge: 0,
      minYearsOpen: 0,
      requireOpenPermit: false,
      limit: 100,
    });
    const rows = (await connection.runAndReadAll(sql)).getRowObjects();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const basis = row['roof_age_basis'];
      expect(
        roofAgeBasisSchema.safeParse(basis === undefined ? null : basis).success,
        `basis ${String(basis)} on ${String(row['parcel_identifier'])} must be convertible`,
      ).toBe(true);
    }
  });

  it('keeps an aged roof whose permit is younger than the stall floor', async () => {
    // The regression. Raising the stall floor must not remove a parcel that qualified on roof age.
    await expect(
      candidates({ minRoofAge: 15, minYearsOpen: 5, requireOpenPermit: false }),
    ).resolves.toEqual([
      '1-AGED-YOUNGPERMIT',
      '2-AGED-NOPERMIT',
      '3-NEW-STALLED',
      '5-PROXY-STALLED',
      '6-UNKNOWN-STALLED',
    ]);
  });

  it('does not shrink the list as the stall floor rises', async () => {
    // The user-visible symptom: dragging "Permit open at least" upward removed aged-roof leads.
    const atZero = await candidates({ minRoofAge: 15, minYearsOpen: 0, requireOpenPermit: false });
    const atFive = await candidates({ minRoofAge: 15, minYearsOpen: 5, requireOpenPermit: false });
    const agedRoofs = ['1-AGED-YOUNGPERMIT', '2-AGED-NOPERMIT'];

    for (const parcel of agedRoofs) {
      expect(atZero).toContain(parcel);
      expect(atFive).toContain(parcel);
    }
  });

  it('treats the two signals as alternatives, not requirements', async () => {
    // A new roof with a stalled permit is a lead; an old roof with no permit is a lead.
    const rows = await candidates({ minRoofAge: 15, minYearsOpen: 5, requireOpenPermit: false });
    expect(rows).toContain('2-AGED-NOPERMIT');
    expect(rows).toContain('3-NEW-STALLED');
  });

  it('excludes a parcel that qualifies on neither signal', async () => {
    await expect(
      candidates({ minRoofAge: 15, minYearsOpen: 5, requireOpenPermit: false }),
    ).resolves.not.toContain('4-NEW-YOUNGPERMIT');
  });

  it('lets both signals through the row cap, not just the stalled permits', async () => {
    // The cap exists to bound the payload, and it used to be applied to a list sorted by permit
    // stall alone — so every returned row carried a permit and no aged-roof lead could reach the
    // screen, sitting under a tile that said 15,652 of them existed. Ordering by one signal and
    // then cutting is what made the client-side "best first" rank a biased sample.
    const sql = buildLeadCandidateSql(WEST_CHESTER, 5, {
      minRoofAge: 15,
      minYearsOpen: 0,
      requireOpenPermit: false,
      limit: 2,
    });
    const rows = (await connection.runAndReadAll(sql)).getRowObjects();

    const withPermit = rows.filter((row) => row['permit_number'] !== null);
    const agedOnly = rows.filter((row) => row['permit_number'] === null);

    expect(withPermit.length).toBeGreaterThan(0);
    expect(agedOnly.length).toBeGreaterThan(0);
  });

  it('narrows to the permit signal alone when an open permit is required', async () => {
    // Roof age deliberately plays no part here — which is why the slider is disabled in this mode
    // rather than left looking live.
    await expect(
      candidates({ minRoofAge: 15, minYearsOpen: 5, requireOpenPermit: true }),
    ).resolves.toEqual(['3-NEW-STALLED', '5-PROXY-STALLED', '6-UNKNOWN-STALLED']);
  });

  it('ignores the roof-age threshold entirely while a permit is required', async () => {
    const strict = await candidates({ minRoofAge: 40, minYearsOpen: 5, requireOpenPermit: true });
    const loose = await candidates({ minRoofAge: 0, minYearsOpen: 5, requireOpenPermit: true });
    expect(strict).toEqual(loose);
  });
});
