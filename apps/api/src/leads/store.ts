import { Logger } from '@aws-lambda-powertools/logger';
import {
  createLeadInputSchema,
  leadIdForParcel,
  leadSchema,
  roofAgeTier,
  weakestTier,
  type CreateLeadInput,
  type Lead,
  type LeadStatus,
  type UpdateLeadInput,
} from '@roofing/schema';
import { scoreLead } from '@roofing/shared';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

/**
 * Lead persistence.
 *
 * Single table keyed by `lead_id`, which is derived from the parcel identifier rather than
 * generated — so converting the same property twice updates one record instead of producing two
 * leads and two phone calls to one homeowner. That property is the reason every write here is an
 * idempotent upsert rather than a create.
 */

const logger = new Logger();

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export interface StoreConfig {
  tableName: string;
  /** Injected so handlers stay deterministic under test. */
  now: () => Date;
}

/**
 * Convert a property into a lead, or refresh the one that already exists.
 *
 * `created_at` is written only when absent, so re-converting a property that a rep has already
 * worked does not reset its age or its place in the pipeline. Status is likewise preserved: a
 * lead that reached `quoted` must not silently drop back to `new` because somebody clicked
 * Convert again from the map.
 */
export async function upsertLead(config: StoreConfig, input: CreateLeadInput): Promise<Lead> {
  const parsed = createLeadInputSchema.parse(input);
  const leadId = leadIdForParcel(parsed.parcel_identifier);
  const timestamp = config.now().toISOString();

  // Score and provenance are computed here, never accepted from the caller. A client that could
  // set its own score could promote its leads to the top of everyone's work queue.
  const score = scoreLead({
    roofAgeYears: parsed.snapshot.roof_age_years,
    roofAgeThreshold: parsed.roof_age_threshold,
    permitDaysOpen: parsed.snapshot.permit_days_open,
    ownerIsOutOfArea: parsed.snapshot.owner_is_out_of_area,
    lastSaleDate: parsed.snapshot.last_sale_date,
    contractorBbbScore: parsed.snapshot.contractor_bbb_score,
    now: config.now(),
  });

  const provenance = weakestTier([
    roofAgeTier(parsed.snapshot.roof_age_basis),
    parsed.snapshot.permit_number === null ? 'authoritative' : 'synthetic',
  ]);

  const note =
    parsed.note === undefined
      ? []
      : [{ note_id: `${timestamp}#0`, body: parsed.note, created_at: timestamp }];

  const result = await client.send(
    new UpdateCommand({
      TableName: config.tableName,
      Key: { lead_id: leadId },
      UpdateExpression: [
        'SET #parcel = :parcel',
        '#lat = :lat',
        '#lon = :lon',
        '#signal = :signal',
        '#score = :score',
        '#tier = :tier',
        '#snapshot = :snapshot',
        '#updated = :now',
        '#created = if_not_exists(#created, :now)',
        '#status = if_not_exists(#status, :new)',
        '#statusAt = if_not_exists(#statusAt, :now)',
        '#notes = list_append(if_not_exists(#notes, :empty), :note)',
      ].join(', '),
      // Every attribute is aliased rather than only the ones known to collide. DynamoDB's
      // reserved-word list runs to several hundred entries — `status` and `snapshot` are both on
      // it — and the failure is a runtime ValidationException that no amount of type-checking
      // catches. Aliasing uniformly costs nothing and removes the whole class of bug.
      ExpressionAttributeNames: {
        '#parcel': 'parcel_identifier',
        '#lat': 'latitude',
        '#lon': 'longitude',
        '#signal': 'source_signal',
        '#score': 'score',
        '#tier': 'provenance_tier',
        '#snapshot': 'snapshot',
        '#updated': 'updated_at',
        '#created': 'created_at',
        '#status': 'status',
        '#statusAt': 'status_changed_at',
        '#notes': 'notes',
      },
      ExpressionAttributeValues: {
        ':parcel': parsed.parcel_identifier,
        ':lat': parsed.latitude ?? null,
        ':lon': parsed.longitude ?? null,
        ':signal': parsed.source_signal,
        ':score': score,
        ':tier': provenance,
        ':snapshot': parsed.snapshot,
        ':now': timestamp,
        ':new': 'new',
        ':empty': [],
        ':note': note,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );

  return leadSchema.parse(result.Attributes);
}

/** Move a lead through the pipeline, and/or append a note. */
export async function updateLead(
  config: StoreConfig,
  leadId: string,
  input: UpdateLeadInput,
): Promise<Lead | null> {
  const timestamp = config.now().toISOString();
  const sets = ['#updated = :now'];
  const values: Record<string, unknown> = { ':now': timestamp };
  // Aliased for the same reason as the upsert above: `status` is a DynamoDB reserved word, and
  // aliasing everything means a future attribute rename cannot quietly reintroduce the problem.
  const names: Record<string, string> = { '#updated': 'updated_at' };

  if (input.status !== undefined) {
    sets.push('#status = :status', '#statusAt = :now');
    names['#status'] = 'status';
    names['#statusAt'] = 'status_changed_at';
    values[':status'] = input.status;
  }

  if (input.note !== undefined) {
    sets.push('#notes = list_append(if_not_exists(#notes, :empty), :note)');
    names['#notes'] = 'notes';
    values[':empty'] = [];
    values[':note'] = [{ note_id: `${timestamp}#n`, body: input.note, created_at: timestamp }];
  }

  const result = await client
    .send(
      new UpdateCommand({
        TableName: config.tableName,
        Key: { lead_id: leadId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        // Refuse to resurrect a deleted lead as a stub: without this, updating an id that does not
        // exist would happily create a record with a status and nothing else.
        ConditionExpression: 'attribute_exists(lead_id)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    )
    .catch((error: unknown) => {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return null;
      throw error;
    });

  return result === null ? null : leadSchema.parse(result.Attributes);
}

export async function getLead(config: StoreConfig, leadId: string): Promise<Lead | null> {
  const result = await client.send(
    new GetCommand({ TableName: config.tableName, Key: { lead_id: leadId } }),
  );
  return result.Item === undefined ? null : leadSchema.parse(result.Item);
}

/**
 * List leads, optionally filtered to one pipeline stage.
 *
 * Filtering by status uses the `by-status` index rather than a filtered scan, because a filter
 * still reads every item and pays for it — the saving is in what DynamoDB reads, not what it
 * returns. The unfiltered listing is a scan, which is correct here: a single roofing company's
 * lead table is small, and a scan of a small table is cheaper than maintaining an index whose
 * only purpose is to enumerate everything.
 */
export async function listLeads(
  config: StoreConfig,
  status: LeadStatus | null,
  limit = 200,
): Promise<Lead[]> {
  const items =
    status === null
      ? (await client.send(new ScanCommand({ TableName: config.tableName, Limit: limit }))).Items
      : (
          await client.send(
            new QueryCommand({
              TableName: config.tableName,
              IndexName: 'by-status',
              KeyConditionExpression: '#status = :status',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':status': status },
              // Oldest first: the lead that has sat longest in a stage is the one going stale.
              ScanIndexForward: true,
              Limit: limit,
            }),
          )
        ).Items;

  // Drop rows this build cannot read, but never silently. A lead written under an older schema
  // disappearing from a rep's board with no error is a worse failure than the 400 that motivated
  // this: the 400 is visible, and a board that quietly holds fewer leads than it should is not.
  // Dropping rather than throwing is deliberate — one unreadable row must not take out the board.
  const leads: Lead[] = [];

  for (const item of items ?? []) {
    const parsed = leadSchema.safeParse(item);

    if (parsed.success) {
      leads.push(parsed.data);
      continue;
    }

    logger.warn('dropping unparseable lead', {
      lead_id: typeof item['lead_id'] === 'string' ? item['lead_id'] : null,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
      })),
    });
  }

  return leads.sort((a, b) => b.score - a.score);
}
