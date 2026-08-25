import { Logger } from '@aws-lambda-powertools/logger';
import {
  provenanceTierSchema,
  roofAgeBasisSchema,
  roofAgeTier,
  weakestTier,
  type ProvenanceTier,
  type RoofAgeBasis,
} from '@roofing/schema';
import { haversineMiles, radiusBoundingBox, scoreLead } from '@roofing/shared';
import { tool } from 'ai';
import { z } from 'zod';

import { listLeads, upsertLead, type StoreConfig } from '../leads/store';
import { getDataset, type PermitRow, type PropertyRow } from './dataset';

const logger = new Logger();

/**
 * The dataset's roof-age basis, or `'unknown'` when it is a value this build does not recognise.
 *
 * `'unknown'` rather than `null`: null means the field was absent, `'unknown'` means the dataset
 * said there is no basis — and a value we cannot classify is much closer to the second. Logged
 * because the previous version of this coercion swallowed a whole vocabulary change in silence,
 * and the first anyone knew of it was reps getting a 400 on the strongest parcels in the county.
 */
function basisOf(value: PropertyRow['roof_age_basis']): RoofAgeBasis {
  const parsed = roofAgeBasisSchema.safeParse(value);

  if (parsed.success) return parsed.data;

  logger.warn('unrecognised roof_age_basis in dataset', { value });
  return 'unknown';
}

/**
 * A permit's provenance tier, or `null` when the dataset does not classify it.
 *
 * Same reasoning as `basisOf`: these columns arrive as bare strings from Parquet, so the only
 * thing standing between a vocabulary change upstream and a wrong trust badge here is a parse.
 */
function tierOf(value: string | undefined): ProvenanceTier | null {
  if (value === undefined) return null;

  const parsed = provenanceTierSchema.safeParse(value);

  if (parsed.success) return parsed.data;

  logger.warn('unrecognised provenance_tier in dataset', { value });
  return null;
}

/**
 * What the agent can do.
 *
 * Tool names deliberately mirror the Elephant/Oracle MCP surface — `findPropertiesInArea`,
 * `queryPermits`, `getPropertyPermits` — so the contract a consumer already knows works here
 * unchanged. The CRM adds two of its own for the lead pipeline, which is the thing this product
 * has that the Oracle does not.
 *
 * Every tool takes structured parameters rather than SQL. That is not a limitation: it removes an
 * injection surface entirely, it lets Zod reject a malformed call before any data is touched, and
 * it means a wrong answer is a wrong *filter* the user can see in the tool call rather than a
 * subtly wrong query nobody reads.
 */

/**
 * How many rows any tool may put in front of the model.
 *
 * This is the single biggest lever on cost and quality. A radius search over Chester County
 * routinely matches thousands of parcels; feeding those back would cost more in tokens than the
 * answer is worth and would bury the signal. The model gets the top slice plus an honest total,
 * so it can say "1,906 match, here are the ten best" without ever seeing 1,906 rows.
 */
const MAX_ROWS = 25;

const ROOF_AGE_THRESHOLD = 15;

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

/** West Chester, the county seat — the default centre when a question names no place. */
const WEST_CHESTER = { latitude: 39.9601, longitude: -75.6055 };

interface Located {
  latitude: number | null;
  longitude: number | null;
}

function withinRadius<T extends Located>(
  rows: T[],
  centre: { latitude: number; longitude: number },
  radiusMiles: number,
): (T & { distance_miles: number })[] {
  const box = radiusBoundingBox(centre, radiusMiles);
  const matches: (T & { distance_miles: number })[] = [];

  for (const row of rows) {
    // Bounding box first: a pair of numeric comparisons rejects most of the county before any
    // trigonometry runs. Haversine then trims the box's corners back to a true circle.
    if (row.latitude === null || row.longitude === null) continue;
    if (row.latitude < box.minLat || row.latitude > box.maxLat) continue;
    if (row.longitude < box.minLon || row.longitude > box.maxLon) continue;

    const distance = haversineMiles(centre, {
      latitude: row.latitude,
      longitude: row.longitude,
    });
    if (distance <= radiusMiles) {
      matches.push({ ...row, distance_miles: Math.round(distance * 100) / 100 });
    }
  }

  return matches;
}

/** One open roofing permit per parcel — the longest-open one, which is the strongest signal. */
function longestOpenRoofingPermits(permits: PermitRow[]): Map<string, PermitRow> {
  const best = new Map<string, PermitRow>();

  for (const permit of permits) {
    if (!permit.is_roofing) continue;
    if (permit.permit_close_date !== null) continue;
    if (permit.parcel_identifier === null) continue;

    const current = best.get(permit.parcel_identifier);
    if (current === undefined || (permit.days_open ?? 0) > (current.days_open ?? 0)) {
      best.set(permit.parcel_identifier, permit);
    }
  }

  return best;
}

function scoreOf(property: PropertyRow, permit: PermitRow | undefined, now: Date): number {
  return scoreLead({
    roofAgeYears: property.roof_age_years,
    roofAgeThreshold: ROOF_AGE_THRESHOLD,
    permitDaysOpen: permit?.days_open ?? null,
    ownerIsOutOfArea: property.owner_is_out_of_area,
    lastSaleDate: property.last_sale_date,
    contractorBbbScore: permit?.contractor_bbb_score ?? null,
    now,
  });
}

/**
 * Trim a result set to what the model sees, and say what was trimmed.
 *
 * The count is as important as the rows. Returning ten rows silently implies ten matches, which
 * is how an agent ends up telling a salesperson there are ten opportunities in a territory that
 * has two thousand.
 */
function capped<T>(rows: T[], limit: number) {
  return {
    total_matches: rows.length,
    returned: Math.min(rows.length, limit),
    rows: rows.slice(0, limit),
  };
}

export interface ToolContext {
  store: StoreConfig;
  now: () => Date;
}

export function buildTools(context: ToolContext) {
  return {
    findPropertiesInArea: tool({
      description:
        'Find properties near a point that match roofing lead criteria: roof age over a ' +
        'threshold and/or an open roofing permit. Returns the highest-scoring matches with the ' +
        'total number that matched. Use this for questions about opportunities in an area.',
      inputSchema: z.object({
        latitude: latitude
          .optional()
          .describe(
            'Centre of the search. Defaults to West Chester if the question names no place.',
          ),
        longitude: longitude.optional(),
        radiusMiles: z.number().min(0.1).max(30).default(5),
        minRoofAgeYears: z
          .number()
          .int()
          .min(0)
          .max(100)
          .default(ROOF_AGE_THRESHOLD)
          .describe('Only count roofs strictly older than this.'),
        requireOpenPermit: z
          .boolean()
          .default(false)
          .describe('Restrict to properties that currently have an open roofing permit.'),
        minPermitYearsOpen: z
          .number()
          .min(0)
          .max(60)
          .default(0)
          .describe('Only count permits that have been open at least this long.'),
      }),
      execute: async (input) => {
        const { properties, permits } = await getDataset();
        const now = context.now();
        const centre = {
          latitude: input.latitude ?? WEST_CHESTER.latitude,
          longitude: input.longitude ?? WEST_CHESTER.longitude,
        };

        const openPermits = longestOpenRoofingPermits(permits);
        const minDays = Math.round(input.minPermitYearsOpen * 365);

        const matches = withinRadius(properties, centre, input.radiusMiles)
          .map((property) => {
            const permit = openPermits.get(property.parcel_identifier);
            return { property, permit };
          })
          .filter(({ property, permit }) => {
            const permitQualifies = permit !== undefined && (permit.days_open ?? 0) >= minDays;
            if (input.requireOpenPermit) return permitQualifies;

            const roofQualifies =
              property.roof_age_years !== null && property.roof_age_years > input.minRoofAgeYears;
            return roofQualifies || permitQualifies;
          })
          .map(({ property, permit }) => ({
            parcel_identifier: property.parcel_identifier,
            address: property.address_street,
            city: property.address_city,
            owner: property.owner_name,
            owner_out_of_area: property.owner_is_out_of_area,
            assessed_value: property.assessed_value,
            last_sale_date: property.last_sale_date,
            roof_age_years: property.roof_age_years,
            roof_age_basis: basisOf(property.roof_age_basis),
            distance_miles: property.distance_miles,
            permit_number: permit?.permit_number ?? null,
            permit_status: permit?.improvement_status ?? null,
            permit_years_open:
              permit?.days_open == null ? null : Math.round((permit.days_open / 365) * 10) / 10,
            contractor: permit?.contractor_name ?? null,
            contractor_bbb_rating: permit?.contractor_bbb_rating ?? null,
            lead_score: scoreOf(property, permit, now),
            provenance: weakestTier([
              roofAgeTier(basisOf(property.roof_age_basis)),
              tierOf(permit?.provenance_tier),
            ]),
          }))
          .sort((a, b) => b.lead_score - a.lead_score);

        return { centre, radius_miles: input.radiusMiles, ...capped(matches, MAX_ROWS) };
      },
    }),

    queryPermits: tool({
      description:
        'Find open roofing permits, optionally near a point, longest-open first. Use this for ' +
        'questions specifically about permits, stalled jobs, or contractors.',
      inputSchema: z.object({
        latitude: latitude.optional(),
        longitude: longitude.optional(),
        radiusMiles: z.number().min(0.1).max(30).optional(),
        minYearsOpen: z.number().min(0).max(60).default(0),
        contractorNameContains: z.string().max(100).optional(),
      }),
      execute: async (input) => {
        const { properties, permits } = await getDataset();
        const minDays = Math.round(input.minYearsOpen * 365);

        const byParcel = new Map(
          properties.map((property) => [property.parcel_identifier, property]),
        );
        const needle = input.contractorNameContains?.toLowerCase();

        let open = [...longestOpenRoofingPermits(permits).values()].filter(
          (permit) => (permit.days_open ?? 0) >= minDays,
        );

        if (needle !== undefined && needle !== '') {
          open = open.filter((permit) => permit.contractor_name?.toLowerCase().includes(needle));
        }

        let located = open.map((permit) => {
          const property = byParcel.get(permit.parcel_identifier ?? '');
          return {
            permit,
            latitude: property?.latitude ?? null,
            longitude: property?.longitude ?? null,
            property,
          };
        });

        if (input.radiusMiles !== undefined) {
          const centre = {
            latitude: input.latitude ?? WEST_CHESTER.latitude,
            longitude: input.longitude ?? WEST_CHESTER.longitude,
          };
          located = withinRadius(located, centre, input.radiusMiles);
        }

        const rows = located
          .map(({ permit, property }) => ({
            parcel_identifier: permit.parcel_identifier,
            address: property?.address_street ?? null,
            owner: property?.owner_name ?? null,
            permit_number: permit.permit_number,
            permit_status: permit.improvement_status,
            opened_date: permit.opened_date,
            years_open:
              permit.days_open == null ? null : Math.round((permit.days_open / 365) * 10) / 10,
            contractor: permit.contractor_name,
            contractor_licence: permit.contractor_license,
            contractor_bbb_rating: permit.contractor_bbb_rating,
            contractor_bbb_score: permit.contractor_bbb_score,
            provenance: permit.provenance_tier,
          }))
          .sort((a, b) => (b.years_open ?? 0) - (a.years_open ?? 0));

        return capped(rows, MAX_ROWS);
      },
    }),

    getPropertyPermits: tool({
      description:
        'Every permit on one parcel, roofing first. Use when asked about a specific property.',
      inputSchema: z.object({
        parcelIdentifier: z.string().min(1).max(40),
      }),
      execute: async (input) => {
        const { properties, permits } = await getDataset();
        const property = properties.find((row) => row.parcel_identifier === input.parcelIdentifier);

        if (property === undefined) {
          return { found: false, parcel_identifier: input.parcelIdentifier };
        }

        const rows = permits
          .filter((permit) => permit.parcel_identifier === input.parcelIdentifier)
          .sort((a, b) => Number(b.is_roofing) - Number(a.is_roofing))
          .slice(0, MAX_ROWS);

        return {
          found: true,
          property: {
            parcel_identifier: property.parcel_identifier,
            address: property.address_street,
            owner: property.owner_name,
            roof_age_years: property.roof_age_years,
            roof_age_basis: basisOf(property.roof_age_basis),
            assessed_value: property.assessed_value,
            last_sale_date: property.last_sale_date,
          },
          permits: rows,
        };
      },
    }),

    getDatasetInfo: tool({
      description:
        'Coverage and provenance of the underlying data: how many records exist and which ' +
        'signals are generated rather than sourced. Use this whenever asked how reliable an ' +
        'answer is, or where the data comes from.',
      inputSchema: z.object({}),
      execute: async () => {
        const { properties, permits } = await getDataset();
        const roofing = permits.filter((permit) => permit.is_roofing);

        return {
          county: 'Chester County, Pennsylvania',
          properties: properties.length,
          permits: permits.length,
          roofing_permits: roofing.length,
          open_roofing_permits: roofing.filter((permit) => permit.permit_close_date === null)
            .length,
          sourced_permits: permits.filter((p) => p.provenance_tier === 'authoritative').length,
          generated_permits: permits.filter((p) => p.provenance_tier === 'synthetic').length,
          generated_signals: [
            'roof age (no Chester County source publishes year built or roof age)',
            'roofing permits (the county issues none; its 73 municipalities permit independently)',
            'contractor identity (the PA registry blocks automated access)',
            'BBB ratings (terms of use prohibit automated collection)',
          ],
          sourced_signals: [
            'parcels, owners, assessed values, sale dates (county parcel layer)',
            'well and sewage permits (county EnerGov system)',
          ],
        };
      },
    }),

    listLeads: tool({
      description:
        "The team's current CRM pipeline. Use for questions about existing leads, what stage " +
        'they are in, or what has gone stale.',
      inputSchema: z.object({
        status: z
          .enum(['new', 'contacted', 'qualified', 'quoted', 'won', 'lost'])
          .optional()
          .describe('Restrict to one pipeline stage.'),
      }),
      execute: async (input) => {
        const leads = await listLeads(context.store, input.status ?? null);

        return capped(
          leads.map((lead) => ({
            lead_id: lead.lead_id,
            parcel_identifier: lead.parcel_identifier,
            address: lead.snapshot.address_street,
            owner: lead.snapshot.owner_name,
            status: lead.status,
            score: lead.score,
            roof_age_years: lead.snapshot.roof_age_years,
            contractor: lead.snapshot.contractor_name,
            provenance: lead.provenance_tier,
            status_changed_at: lead.status_changed_at,
          })),
          MAX_ROWS,
        );
      },
    }),

    createLead: tool({
      description:
        'Add one property to the CRM pipeline by its parcel identifier. Converting the same ' +
        'parcel twice updates the existing lead rather than creating a duplicate. Only call this ' +
        'when the user has clearly asked for a property to be added.',
      inputSchema: z.object({
        parcelIdentifier: z.string().min(1).max(40),
        note: z.string().max(500).optional().describe('Why this property is worth calling.'),
      }),
      execute: async (input) => {
        const { properties, permits } = await getDataset();
        const property = properties.find((row) => row.parcel_identifier === input.parcelIdentifier);

        if (property === undefined) {
          return { created: false, reason: `No parcel ${input.parcelIdentifier} in the dataset.` };
        }

        const permit = longestOpenRoofingPermits(permits).get(property.parcel_identifier);
        const agedRoof = property.roof_age_years !== null && property.roof_age_years > 0;

        const lead = await upsertLead(context.store, {
          parcel_identifier: property.parcel_identifier,
          // The agent searches at its own fixed threshold, so it scores at the same one.
          roof_age_threshold: ROOF_AGE_THRESHOLD,
          source_signal:
            agedRoof && permit !== undefined
              ? 'aged_roof_and_permit'
              : permit !== undefined
                ? 'open_permit'
                : 'aged_roof',
          latitude: property.latitude,
          longitude: property.longitude,
          snapshot: {
            address_street: property.address_street,
            address_city: property.address_city,
            address_zip: property.address_zip,
            owner_name: property.owner_name,
            owner_is_out_of_area: property.owner_is_out_of_area,
            assessed_value: property.assessed_value,
            last_sale_date: property.last_sale_date,
            roof_age_years: property.roof_age_years,
            roof_age_basis: basisOf(property.roof_age_basis),
            permit_number: permit?.permit_number ?? null,
            permit_status: permit?.improvement_status ?? null,
            permit_days_open: permit?.days_open ?? null,
            contractor_name: permit?.contractor_name ?? null,
            contractor_bbb_rating: permit?.contractor_bbb_rating ?? null,
            contractor_bbb_score: permit?.contractor_bbb_score ?? null,
          },
          ...(input.note === undefined ? {} : { note: input.note }),
        });

        return {
          created: true,
          lead_id: lead.lead_id,
          score: lead.score,
          status: lead.status,
          provenance: lead.provenance_tier,
        };
      },
    }),
  };
}
