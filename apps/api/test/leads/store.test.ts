import { leadIdForParcel } from '@roofing/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The store is exercised against a stubbed DynamoDB document client.
 *
 * What matters here is the *shape of the writes* — which attributes are guarded by
 * `if_not_exists`, whether the score is recomputed server-side, whether an update refuses to
 * create a record. Those are the decisions that would silently corrupt a rep's pipeline, and none
 * of them need a real table to verify.
 */

const send = vi.fn();

vi.mock('@aws-sdk/lib-dynamodb', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/lib-dynamodb')>('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send }) },
  };
});

const { listLeads, updateLead, upsertLead } = await import('../../src/leads/store');

const NOW = new Date('2026-08-22T12:00:00.000Z');
const config = { tableName: 'leads', now: () => NOW };

const SNAPSHOT = {
  address_street: '305 W UNION ST',
  address_city: 'West Chester',
  address_zip: '19382',
  owner_name: 'BARDZIK EDWARD S III',
  owner_is_out_of_area: true,
  assessed_value: 133_110,
  last_sale_date: '2004-03-02',
  roof_age_years: 30,
  roof_age_basis: 'synthetic' as const,
  permit_number: 'SYN-R-100200',
  permit_status: 'Issued',
  permit_days_open: 4_160,
  contractor_name: 'Malvern Roofing & Siding Inc.',
  contractor_bbb_rating: 'A',
  contractor_bbb_score: 90,
};

function storedLead(overrides: Record<string, unknown> = {}) {
  return {
    lead_id: leadIdForParcel('1-9-597'),
    parcel_identifier: '1-9-597',
    latitude: 39.96,
    longitude: -75.6,
    status: 'new',
    source_signal: 'aged_roof_and_permit',
    score: 95,
    provenance_tier: 'synthetic',
    snapshot: SNAPSHOT,
    notes: [],
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    status_changed_at: NOW.toISOString(),
    ...overrides,
  };
}

/** `noUncheckedIndexedAccess` makes every mock-call lookup optional; assert once, here. */
function firstInput(): Record<string, unknown> {
  const call = send.mock.calls[0];
  if (call === undefined) throw new Error('expected the store to issue a DynamoDB command');
  return (call[0] as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  send.mockReset();
});

describe('upsertLead', () => {
  it('derives the key from the parcel so converting twice updates one record', async () => {
    send.mockResolvedValue({ Attributes: storedLead() });

    await upsertLead(config, {
      parcel_identifier: '1-9-597',
      source_signal: 'aged_roof_and_permit',
      snapshot: SNAPSHOT,
    });

    expect(firstInput().Key).toEqual({ lead_id: 'lead#1-9-597' });
  });

  it('preserves created_at, status and stage timestamp on re-conversion', async () => {
    // A lead that reached `quoted` must not drop back to `new` because a rep clicked Convert
    // again from the map, and its age must not reset.
    send.mockResolvedValue({ Attributes: storedLead() });

    await upsertLead(config, {
      parcel_identifier: '1-9-597',
      source_signal: 'manual',
      snapshot: SNAPSHOT,
    });

    const expression = firstInput().UpdateExpression as string;
    expect(expression).toContain('#created = if_not_exists(#created, :now)');
    expect(expression).toContain('#status = if_not_exists(#status, :new)');
    expect(expression).toContain('#statusAt = if_not_exists(#statusAt, :now)');
  });

  it('computes the score server-side rather than trusting the caller', async () => {
    send.mockResolvedValue({ Attributes: storedLead() });

    await upsertLead(config, {
      parcel_identifier: '1-9-597',
      source_signal: 'aged_roof_and_permit',
      snapshot: SNAPSHOT,
      // A hostile client trying to jump the queue.
      ...({ score: 100, provenance_tier: 'authoritative' } as Record<string, unknown>),
    });

    const values = firstInput().ExpressionAttributeValues as Record<string, unknown>;
    // 30 yr roof (15 over threshold), permit open 4160 days, absentee owner, 20+ yr tenure.
    expect(values[':score']).toBe(95);
    expect(values[':tier']).toBe('synthetic');
  });

  it('aliases every attribute name so reserved words cannot reach DynamoDB', async () => {
    // `snapshot` and `status` are both DynamoDB reserved words. An unaliased name produces a
    // runtime ValidationException that no type-check catches, so assert the expression contains
    // no bare identifiers at all.
    send.mockResolvedValue({ Attributes: storedLead() });

    await upsertLead(config, {
      parcel_identifier: '1-9-597',
      source_signal: 'manual',
      snapshot: SNAPSHOT,
    });

    const expression = firstInput().UpdateExpression as string;
    const names = firstInput().ExpressionAttributeNames as Record<string, string>;

    // Strip every `#alias` and `:value` token. Whatever survives is what DynamoDB would parse as
    // a bare attribute name, and none of the real names may appear there. Value placeholders have
    // to go too: `:score` contains "score" and would otherwise look like an unaliased attribute.
    const withoutAliases = expression.replace(/[#:][A-Za-z]+/g, '');

    // Sanity-check the stripping itself, so this cannot pass by removing too much.
    expect(withoutAliases).toContain('if_not_exists');

    for (const attribute of Object.values(names)) {
      expect(withoutAliases).not.toContain(attribute);
    }

    expect(Object.values(names)).toContain('snapshot');
    expect(Object.values(names)).toContain('status');
  });

  it('marks a lead synthetic when its permit is generated', async () => {
    send.mockResolvedValue({ Attributes: storedLead() });

    await upsertLead(config, {
      parcel_identifier: '1-9-597',
      source_signal: 'open_permit',
      snapshot: SNAPSHOT,
    });

    const values = firstInput().ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':tier']).toBe('synthetic');
  });
});

describe('updateLead', () => {
  it('stamps status_changed_at when the stage moves', async () => {
    send.mockResolvedValue({ Attributes: storedLead({ status: 'contacted' }) });

    await updateLead(config, 'lead#1-9-597', { status: 'contacted' });

    const expression = firstInput().UpdateExpression as string;
    expect(expression).toContain('#statusAt = :now');
  });

  it('refuses to create a record for an unknown lead', async () => {
    // Without the condition, PATCHing a nonexistent id would write a stub with a status and
    // nothing else — a lead with no parcel, no score and no snapshot.
    send.mockResolvedValue({ Attributes: storedLead() });

    await updateLead(config, 'lead#nope', { status: 'won' });

    expect(firstInput().ConditionExpression).toBe('attribute_exists(lead_id)');
  });

  it('returns null instead of throwing when the lead does not exist', async () => {
    const failure = Object.assign(new Error('conditional request failed'), {
      name: 'ConditionalCheckFailedException',
    });
    send.mockRejectedValue(failure);

    await expect(updateLead(config, 'lead#nope', { status: 'won' })).resolves.toBeNull();
  });

  it('propagates unexpected failures rather than reporting a missing lead', async () => {
    send.mockRejectedValue(new Error('throughput exceeded'));

    await expect(updateLead(config, 'lead#1-9-597', { status: 'won' })).rejects.toThrow(
      'throughput exceeded',
    );
  });
});

describe('listLeads', () => {
  it('queries the by-status index rather than filtering a scan', async () => {
    send.mockResolvedValue({ Items: [storedLead({ status: 'contacted' })] });

    await listLeads(config, 'contacted');

    expect(firstInput().IndexName).toBe('by-status');
    expect(firstInput().FilterExpression).toBeUndefined();
  });

  it('returns leads best-scoring first', async () => {
    send.mockResolvedValue({
      Items: [
        storedLead({ lead_id: 'lead#a', parcel_identifier: 'a', score: 40 }),
        storedLead({ lead_id: 'lead#b', parcel_identifier: 'b', score: 90 }),
      ],
    });

    const leads = await listLeads(config, null);
    expect(leads.map((lead) => lead.score)).toEqual([90, 40]);
  });

  it('drops malformed items instead of failing the whole listing', async () => {
    // One corrupt record must not take down a rep's entire board.
    send.mockResolvedValue({ Items: [storedLead(), { lead_id: 'lead#broken' }] });

    const leads = await listLeads(config, null);
    expect(leads).toHaveLength(1);
  });
});
