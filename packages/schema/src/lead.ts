import { z } from 'zod';

import { provenanceTierSchema, roofAgeBasisSchema } from './provenance';

/**
 * The sales pipeline.
 *
 * Ordered deliberately: the array index is the stage's position in the funnel, which is what the
 * board UI sorts on and what conversion counts are computed from. `lost` sits at the end as a
 * terminal state rather than a stage anyone advances into on purpose.
 */
export const leadStatuses = ['new', 'contacted', 'qualified', 'quoted', 'won', 'lost'] as const;

export const leadStatusSchema = z.enum(leadStatuses);
export type LeadStatus = z.infer<typeof leadStatusSchema>;

/** Which signal put this property on the list. Drives the default outreach script. */
export const leadSourceSignalSchema = z.enum([
  /** Roof exceeded the configured age threshold. */
  'aged_roof',
  /** A roofing permit is open, and has been for a long time. */
  'open_permit',
  /** Both signals fired on the same parcel — the strongest lead there is. */
  'aged_roof_and_permit',
  /** A rep added the property by hand from the map. */
  'manual',
]);
export type LeadSourceSignal = z.infer<typeof leadSourceSignalSchema>;

/**
 * What was true about the property at the moment the lead was created.
 *
 * This is a copy, not a join, and that is the point. The underlying county dataset is republished
 * on a schedule: permits close, owners change, roof-age estimates move. A lead that only held a
 * parcel number would silently rewrite its own history every time the dataset refreshed, and a rep
 * looking at a three-week-old lead could no longer answer "why did I call this person?".
 *
 * The live record stays queryable through the parcel identifier whenever the current state is what
 * matters. The snapshot answers a different question and both are needed.
 */
export const leadSnapshotSchema = z.object({
  address_street: z.string().nullable(),
  address_city: z.string().nullable(),
  address_zip: z.string().nullable(),
  owner_name: z.string().nullable(),
  /** Owner's mailing address sits outside the property's municipality - an absentee landlord. */
  owner_is_out_of_area: z.boolean().nullable(),
  assessed_value: z.number().nullable(),
  last_sale_date: z.string().nullable(),
  roof_age_years: z.number().int().nullable(),
  roof_age_basis: roofAgeBasisSchema,
  permit_number: z.string().nullable(),
  permit_status: z.string().nullable(),
  permit_days_open: z.number().int().nullable(),
  contractor_name: z.string().nullable(),
  contractor_bbb_rating: z.string().nullable(),
  contractor_bbb_score: z.number().nullable(),
});

export type LeadSnapshot = z.infer<typeof leadSnapshotSchema>;

export const leadNoteSchema = z.object({
  note_id: z.string().min(1),
  body: z.string().min(1).max(2000),
  created_at: z.string().min(1),
});

export type LeadNote = z.infer<typeof leadNoteSchema>;

export const leadSchema = z.object({
  /**
   * Derived from the parcel identifier, never random.
   *
   * Two reps working the same map area will convert the same property, and a CRM that answers
   * that with two lead records is worse than useless — it produces two phone calls to one
   * homeowner. A deterministic id makes conversion idempotent: the second write updates the
   * first lead instead of racing it.
   */
  lead_id: z.string().min(1),
  parcel_identifier: z.string().min(1),

  latitude: z.number().nullable(),
  longitude: z.number().nullable(),

  status: leadStatusSchema,
  source_signal: leadSourceSignalSchema,

  /**
   * Ranking score, 0-100. Recomputed on write rather than stored by the client, so that a lead
   * cannot be promoted up the list by a caller sending whatever number it likes.
   */
  score: z.number().int().min(0).max(100),

  /**
   * Weakest tier across every input the lead rests on.
   *
   * Carried onto the lead itself rather than looked up from the property, because the whole point
   * is that this travels with the record: a lead built on a generated permit must still be
   * visibly generated after it has been assigned, worked and exported.
   */
  provenance_tier: provenanceTierSchema,

  snapshot: leadSnapshotSchema,
  notes: z.array(leadNoteSchema),

  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  /** When the lead last changed stage - the input to any "stalled in pipeline" report. */
  status_changed_at: z.string().min(1),
});

export type Lead = z.infer<typeof leadSchema>;

/** Fields a client is allowed to set when converting a property into a lead. */
export const createLeadInputSchema = z.object({
  parcel_identifier: z.string().min(1),
  source_signal: leadSourceSignalSchema,
  /**
   * The roof-age threshold a score was measured against.
   *
   * Carried on the request because it is a property of the *search*, not of the parcel: a rep
   * hunting 30-year roofs and a rep hunting 10-year roofs are asking different questions and get
   * different scores for the same house. The server previously assumed 15 and recomputed against
   * it, so the number stored silently disagreed with the number on screen whenever the slider had
   * moved — and both documents claim those are the same number.
   *
   * The *score* stays server-owned; only the question is accepted from the caller.
   */
  roof_age_threshold: z.number().int().min(0).max(40).default(15),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  snapshot: leadSnapshotSchema,
  note: z.string().min(1).max(2000).optional(),
});

/**
 * What a client sends, not what the server ends up with.
 *
 * `z.input` rather than `z.infer` deliberately: fields with defaults are optional to a caller and
 * present after parsing, and conflating the two makes every caller restate a default that exists
 * precisely so they need not.
 */
export type CreateLeadInput = z.input<typeof createLeadInputSchema>;

/** Fields a client is allowed to change afterwards. Score and provenance are server-owned. */
export const updateLeadInputSchema = z.object({
  status: leadStatusSchema.optional(),
  note: z.string().min(1).max(2000).optional(),
});

export type UpdateLeadInput = z.infer<typeof updateLeadInputSchema>;

/** One parcel, one lead. */
export function leadIdForParcel(parcelIdentifier: string): string {
  return `lead#${parcelIdentifier}`;
}
