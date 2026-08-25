import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
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
 * Four parcels covering every combination that matters.
 *
 * `1-AGED-YOUNGPERMIT` is the regression: an aged roof whose permit is younger than any stall
 * floor a user might set. It qualifies through its roof and must survive regardless.
 */
const FIXTURE = `
  CREATE TABLE properties AS SELECT * FROM (VALUES
    ('1-AGED-YOUNGPERMIT', 30, 39.9605, -75.6060),
    ('2-AGED-NOPERMIT',    30, 39.9606, -75.6061),
    ('3-NEW-STALLED',       3, 39.9607, -75.6062),
    ('4-NEW-YOUNGPERMIT',   3, 39.9608, -75.6063)
  ) AS t(parcel_identifier, roof_age_years, latitude, longitude);

  CREATE TABLE permits AS SELECT * FROM (VALUES
    ('1-AGED-YOUNGPERMIT', 'P-1', 30),
    ('3-NEW-STALLED',      'P-3', ${9 * YEAR}),
    ('4-NEW-YOUNGPERMIT',  'P-4', 30)
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
  'roof_age_basis',
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

  it('keeps an aged roof whose permit is younger than the stall floor', async () => {
    // The regression. Raising the stall floor must not remove a parcel that qualified on roof age.
    await expect(
      candidates({ minRoofAge: 15, minYearsOpen: 5, requireOpenPermit: false }),
    ).resolves.toEqual(['1-AGED-YOUNGPERMIT', '2-AGED-NOPERMIT', '3-NEW-STALLED']);
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

  it('narrows to the permit signal alone when an open permit is required', async () => {
    // Roof age deliberately plays no part here — which is why the slider is disabled in this mode
    // rather than left looking live.
    await expect(
      candidates({ minRoofAge: 15, minYearsOpen: 5, requireOpenPermit: true }),
    ).resolves.toEqual(['3-NEW-STALLED']);
  });

  it('ignores the roof-age threshold entirely while a permit is required', async () => {
    const strict = await candidates({ minRoofAge: 40, minYearsOpen: 5, requireOpenPermit: true });
    const loose = await candidates({ minRoofAge: 0, minYearsOpen: 5, requireOpenPermit: true });
    expect(strict).toEqual(loose);
  });
});
