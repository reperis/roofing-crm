import type { LeadCandidate, PermitRow } from '@roofing/schema';
import { radiusBoundingBox, type LatLon } from '@roofing/shared';

import { getDb } from './duckdb';

/**
 * The questions a roofing sales team actually asks, expressed once.
 *
 * Every radius query prefilters with a bounding box before computing great-circle distance. The
 * bbox comparison is a cheap range scan DuckDB can use to skip whole row groups in the Parquet
 * file; the haversine term then trims the box's corners back to a true circle. Doing the
 * trigonometry first would force a full scan of 193,000 rows on every drag of the radius slider.
 */

/** DuckDB string literals escape a quote by doubling it. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function distanceExpression(centre: LatLon, alias = ''): string {
  const p = alias === '' ? '' : `${alias}.`;

  return `3958.7613 * 2 * asin(sqrt(
      pow(sin(radians(${p}latitude - ${centre.latitude}) / 2), 2)
    + cos(radians(${centre.latitude})) * cos(radians(${p}latitude))
    * pow(sin(radians(${p}longitude - ${centre.longitude}) / 2), 2)
  ))`;
}

function radiusPredicate(centre: LatLon, radiusMiles: number, alias = ''): string {
  const box = radiusBoundingBox(centre, radiusMiles);
  const p = alias === '' ? '' : `${alias}.`;

  return `
    ${p}latitude BETWEEN ${box.minLat} AND ${box.maxLat}
    AND ${p}longitude BETWEEN ${box.minLon} AND ${box.maxLon}
    AND ${distanceExpression(centre, alias)} <= ${radiusMiles}
  `;
}

/**
 * One open roofing permit per parcel — the one that has been open longest.
 *
 * A parcel can carry several permits, but a lead is a phone call about a property, not about a
 * permit. Collapsing to the most significant one here keeps the candidate list at one row per
 * door; the detail drawer fetches the full permit history when a rep opens a specific lead.
 */
const LONGEST_OPEN_ROOFING_PERMIT = `
  SELECT parcel_identifier, permit_number, improvement_status, days_open,
         contractor_name, contractor_bbb_rating, contractor_bbb_score,
         provenance_tier AS permit_provenance_tier
  FROM permits
  WHERE is_roofing
    AND permit_close_date IS NULL
    AND parcel_identifier IS NOT NULL
  QUALIFY row_number() OVER (
    PARTITION BY parcel_identifier ORDER BY days_open DESC NULLS LAST
  ) = 1
`;

export interface LeadCandidateFilters {
  /** Roof age threshold in years. Properties at or below this are not aged-roof leads. */
  minRoofAge: number;
  /** Only return properties that carry an open roofing permit. */
  requireOpenPermit: boolean;
  /** Minimum years a permit must have been open to count. The story's priority signal. */
  minYearsOpen: number;
  limit: number;
}

/**
 * Properties in the radius that meet at least one lead criterion.
 *
 * The two signals are OR'd, not AND'd: an aged roof with no permit is a lead, and a stalled permit
 * on a newer roof is a lead. Requiring both would collapse the list to the rare parcels that have
 * both and quietly hide most of the territory's opportunity — the opposite of what a lead-finding
 * tool is for. `requireOpenPermit` narrows it to permits on demand.
 *
 * Each threshold qualifies **its own** signal and filters nothing else. That distinction is the
 * whole point and it was wrong once: the stall floor used to be applied to the property, so a
 * parcel whose roof qualified on its own was dropped because it happened to also carry a permit
 * younger than the threshold. The list then showed fewer candidates than the "aged roofs" tile
 * directly above it claimed existed — 15,508 against 15,652, five miles out from West Chester.
 *
 * Split out from execution so the predicate can be tested against a real database. The bug was in
 * SQL semantics, and a test that asserted the shape of a string would not have caught it.
 */
export function buildLeadCandidateSql(
  centre: LatLon,
  radiusMiles: number,
  filters: LeadCandidateFilters,
): string {
  const minDaysOpen = Math.round(filters.minYearsOpen * 365);

  // A permit only counts once it has been open at least as long as the stall floor.
  const permitSignal = `(m.permit_number IS NOT NULL AND m.days_open >= ${minDaysOpen})`;
  const roofSignal = `p.roof_age_years > ${filters.minRoofAge}`;

  // Requiring a permit narrows to that signal alone; roof age plays no part, which is why the
  // slider is disabled in that mode rather than left looking live.
  const qualifies = filters.requireOpenPermit ? permitSignal : `(${roofSignal} OR ${permitSignal})`;
  const permitJoin = filters.requireOpenPermit ? 'JOIN' : 'LEFT JOIN';

  const half = Math.max(1, Math.floor(filters.limit / 2));

  // The cap has to spend itself on every signal in play.
  //
  // It used to order by permit stall and then cut, which meant every returned row carried a
  // permit and not one aged-roof lead could reach the screen — 500 of 500, beneath a tile saying
  // 15,652 aged roofs existed. The client then sorted that biased sample by score and called it
  // "best first".
  //
  // Ranking cannot move into SQL: `scoreLead` is the business policy, and it is shared with the
  // leads API so a converted lead stores the number the rep saw. Duplicating it as a CASE
  // expression is the drift that shared function exists to prevent. So the query stops deciding
  // *who wins* and decides only *who is considered*.
  const strongest = (where: string, orderBy: string, take: number): string => `
    (SELECT * FROM considered
      ${where}
      ORDER BY ${orderBy} DESC NULLS LAST, parcel_identifier
      LIMIT ${take})`;

  // Requiring a permit leaves one signal, and one signal has nothing to share the budget with —
  // the split exists to stop two signals crowding each other out, not as a ritual.
  const selection = filters.requireOpenPermit
    ? strongest('', 'permit_days_open', filters.limit)
    : [
        strongest('WHERE permit_number IS NOT NULL', 'permit_days_open', half),
        strongest('', 'roof_age_years', half),
      ].join('\n    UNION');

  return `
    WITH open_roofing AS (${LONGEST_OPEN_ROOFING_PERMIT}),
    considered AS (
      SELECT p.parcel_identifier, p.address_street, p.address_city, p.address_zip,
             p.latitude, p.longitude, p.owner_name, p.owner_is_out_of_area,
             p.assessed_value, p.market_value, p.last_sale_date, p.property_type,
             p.roof_age_years, p.roof_age_basis, p.provenance_tier,
             round(${distanceExpression(centre, 'p')}, 2) AS distance_miles,
             m.permit_number, m.improvement_status,
             m.days_open AS permit_days_open,
             m.contractor_name, m.contractor_bbb_rating, m.contractor_bbb_score,
             m.permit_provenance_tier,
             NULL AS existing_lead_status
      FROM properties AS p
      ${permitJoin} open_roofing AS m USING (parcel_identifier)
      WHERE ${radiusPredicate(centre, radiusMiles, 'p')}
        AND ${qualifies}
    )
    -- No outer LIMIT: each branch is already capped, so their union cannot exceed the budget,
    -- and re-sorting before a final cut is exactly how the bias got in. The order below is for
    -- determinism only; the client ranks by score.
    SELECT * FROM (
      ${selection}
    )
    ORDER BY permit_days_open DESC NULLS LAST, roof_age_years DESC NULLS LAST;
  `;
}

export async function findLeadCandidates(
  centre: LatLon,
  radiusMiles: number,
  filters: LeadCandidateFilters,
): Promise<LeadCandidate[]> {
  const db = await getDb();

  // Asserted, not parsed, and deliberately so. Validating every row would run a Zod schema over
  // ~25 fields × up to 500 rows on the query path this app sells as taking tens of milliseconds,
  // to guard a display surface where the honest failure is showing the value as it arrived. The
  // boundary that matters is the write: `createLeadInputSchema` parses on the way into the store,
  // and `just verify-dataset` checks the published vocabulary against the schema after every
  // refresh. Both are free; this would not be.
  return db.query<LeadCandidate>(buildLeadCandidateSql(centre, radiusMiles, filters));
}

export interface AreaSummary {
  properties_in_radius: number;
  aged_roofs: number;
  open_roofing_permits: number;
  long_open_permits: number;
  absentee_owners: number;
  generated_signals: number;
}

/** Headline counts for the current search area. One query, so the numbers cannot disagree. */
export async function getAreaSummary(
  centre: LatLon,
  radiusMiles: number,
  minRoofAge: number,
  minYearsOpen: number,
): Promise<AreaSummary> {
  const db = await getDb();
  const minDaysOpen = Math.round(minYearsOpen * 365);

  const [row] = await db.query<AreaSummary>(`
    WITH open_roofing AS (${LONGEST_OPEN_ROOFING_PERMIT}),
    in_radius AS (
      SELECT p.parcel_identifier, p.roof_age_years, p.roof_age_basis, p.owner_is_out_of_area,
             m.permit_number, m.days_open, m.permit_provenance_tier
      FROM properties AS p
      LEFT JOIN open_roofing AS m USING (parcel_identifier)
      WHERE ${radiusPredicate(centre, radiusMiles, 'p')}
    )
    SELECT count(*) AS properties_in_radius,
           count(*) FILTER (WHERE roof_age_years > ${minRoofAge}) AS aged_roofs,
           count(*) FILTER (WHERE permit_number IS NOT NULL) AS open_roofing_permits,
           count(*) FILTER (WHERE days_open >= ${minDaysOpen}) AS long_open_permits,
           count(*) FILTER (WHERE owner_is_out_of_area) AS absentee_owners,
           count(*) FILTER (
             WHERE roof_age_basis = 'synthetic' OR permit_provenance_tier = 'synthetic'
           ) AS generated_signals
    FROM in_radius;
  `);

  return (
    row ?? {
      properties_in_radius: 0,
      aged_roofs: 0,
      open_roofing_permits: 0,
      long_open_permits: 0,
      absentee_owners: 0,
      generated_signals: 0,
    }
  );
}

/** Every permit on one parcel, for the lead detail drawer. Roofing first, then longest-open. */
export async function getPermitsForParcel(parcelIdentifier: string): Promise<PermitRow[]> {
  const db = await getDb();

  return db.query<PermitRow>(`
    SELECT permit_number, parcel_identifier, improvement_type, improvement_status,
           opened_date, permit_close_date, days_open, is_roofing,
           contractor_name, contractor_license, contractor_bbb_rating, contractor_bbb_score,
           provenance_tier
    FROM permits
    WHERE parcel_identifier = ${quote(parcelIdentifier)}
    ORDER BY is_roofing DESC, days_open DESC NULLS LAST
    LIMIT 50;
  `);
}

export interface DatasetTotals {
  properties: number;
  permits: number;
  roofing_permits: number;
  open_roofing_permits: number;
  sourced_records: number;
  generated_records: number;
}

/** Whole-dataset totals, so the CRM can show the scale of what it is searching over. */
export async function getDatasetTotals(): Promise<DatasetTotals> {
  const db = await getDb();

  const [row] = await db.query<DatasetTotals>(`
    SELECT
      (SELECT count(*) FROM properties) AS properties,
      (SELECT count(*) FROM permits) AS permits,
      (SELECT count(*) FROM permits WHERE is_roofing) AS roofing_permits,
      (SELECT count(*) FROM permits WHERE is_roofing AND permit_close_date IS NULL)
        AS open_roofing_permits,
      (SELECT count(*) FROM permits WHERE provenance_tier = 'authoritative') AS sourced_records,
      (SELECT count(*) FROM permits WHERE provenance_tier = 'synthetic') AS generated_records;
  `);

  return (
    row ?? {
      properties: 0,
      permits: 0,
      roofing_permits: 0,
      open_roofing_permits: 0,
      sourced_records: 0,
      generated_records: 0,
    }
  );
}
