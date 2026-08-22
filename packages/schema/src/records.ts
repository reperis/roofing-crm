import { z } from 'zod';

import { provenanceTierSchema, roofAgeBasisSchema } from './provenance';

/**
 * The upstream records this CRM reads.
 *
 * Data collection is out of scope for this story: these tables are produced by the Chester County
 * Oracle pipeline and consumed here strictly read-only. What follows is a *projection* of that
 * published schema — the columns the CRM actually uses — not a redefinition of it. Column names
 * are copied exactly, because they are what the SQL selects; a rename here is a runtime failure
 * there, and the two repositories are deployed independently.
 *
 * The upstream property table carries 49 columns (37 from the Elephant county query-table contract
 * plus 12 Chester extensions) and the permit table 31. We read 15 and 13 of them respectively.
 * Selecting only those columns is also what keeps the queries fast: Parquet is columnar, so an
 * unread column is never fetched over the wire at all.
 */

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();

/** Property columns the CRM selects. */
export const propertyProjection = [
  'parcel_identifier',
  'address_street',
  'address_city',
  'address_zip',
  'latitude',
  'longitude',
  'owner_name',
  'owner_is_out_of_area',
  'assessed_value',
  'market_value',
  'last_sale_date',
  'property_type',
  'roof_age_years',
  'roof_age_basis',
  'provenance_tier',
] as const;

export const propertyRowSchema = z.object({
  parcel_identifier: z.string().min(1),
  address_street: nullableString,
  address_city: nullableString,
  address_zip: nullableString,
  latitude: nullableNumber,
  longitude: nullableNumber,
  owner_name: nullableString,
  owner_is_out_of_area: z.boolean().nullable(),
  assessed_value: nullableNumber,
  market_value: nullableNumber,
  last_sale_date: nullableString,
  property_type: nullableString,
  roof_age_years: z.number().int().nullable(),
  roof_age_basis: roofAgeBasisSchema,
  provenance_tier: provenanceTierSchema,
});

export type PropertyRow = z.infer<typeof propertyRowSchema>;

/** Permit columns the CRM selects. Upstream calls a permit a "property improvement". */
export const permitProjection = [
  'permit_number',
  'parcel_identifier',
  'improvement_type',
  'improvement_status',
  'opened_date',
  'permit_close_date',
  'days_open',
  'is_roofing',
  'contractor_name',
  'contractor_license',
  'contractor_bbb_rating',
  'contractor_bbb_score',
  'provenance_tier',
] as const;

export const permitRowSchema = z.object({
  permit_number: nullableString,
  parcel_identifier: nullableString,
  improvement_type: nullableString,
  improvement_status: nullableString,
  opened_date: nullableString,
  /** NULL means still open. The CRM's entire permit filter rests on this one column. */
  permit_close_date: nullableString,
  days_open: z.number().int().nullable(),
  is_roofing: z.boolean(),
  contractor_name: nullableString,
  contractor_license: nullableString,
  contractor_bbb_rating: nullableString,
  contractor_bbb_score: nullableNumber,
  provenance_tier: provenanceTierSchema,
});

export type PermitRow = z.infer<typeof permitRowSchema>;

/** A property joined to its most significant open roofing permit — the CRM's core lead row. */
export const leadCandidateSchema = propertyRowSchema.extend({
  distance_miles: z.number(),
  permit_number: nullableString,
  improvement_status: nullableString,
  permit_days_open: z.number().int().nullable(),
  contractor_name: nullableString,
  contractor_bbb_rating: nullableString,
  contractor_bbb_score: nullableNumber,
  /**
   * Provenance of the joined permit, carried separately from the property's own tier.
   *
   * These genuinely differ: Chester County publishes the parcel, so the property row is
   * authoritative, while the roofing permit beside it is generated. Collapsing them upstream
   * would let a row advertise itself as sourced while its contractor name and BBB rating were
   * invented — the single most misleading thing this interface could do.
   */
  permit_provenance_tier: provenanceTierSchema.nullable(),
  /** Set once the parcel already exists in the pipeline, so the map can show what is claimed. */
  existing_lead_status: nullableString,
});

export type LeadCandidate = z.infer<typeof leadCandidateSchema>;
