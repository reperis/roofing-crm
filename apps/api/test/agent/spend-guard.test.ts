import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The spend guard is the only thing bounding cost on a deliberately unauthenticated endpoint.
 *
 * Everything asserted here is a property that fails *quietly* when it breaks: an increment that
 * stops being atomic still returns a plausible number, a counter that stops partitioning by day
 * still allows calls, and an off-by-one at the ceiling costs or refuses exactly one call a day.
 * None of them surface as an error, which is why they are pinned rather than trusted.
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

const { reserveCall } = await import('../../src/agent/spend-guard');

// Frozen rather than injected. `reserveCall` reads the clock directly, and widening its signature
// to suit a test would be changing production shape for the test's convenience.
const NOW = new Date('2026-08-22T12:00:00.000Z');
const SECONDS_PER_DAY = 86_400;

beforeEach(() => {
  send.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function respondWith(calls: number | undefined) {
  send.mockResolvedValue({ Attributes: calls === undefined ? {} : { calls } });
}

describe('reserveCall', () => {
  it('increments atomically rather than reading and writing back', async () => {
    // Two concurrent Lambdas that each read the counter would both see room. ADD is the only
    // reason a burst cannot collectively overshoot the ceiling.
    respondWith(1);
    await reserveCall('spend', 200);

    const input = send.mock.calls[0]?.[0].input;
    expect(input.UpdateExpression).toContain('ADD calls :one');
    expect(input.ExpressionAttributeValues[':one']).toBe(1);
    expect(input.ReturnValues).toBe('UPDATED_NEW');
  });

  it('partitions the counter by UTC date, so yesterday cannot fund today', async () => {
    respondWith(1);
    await reserveCall('spend', 200);

    expect(send.mock.calls[0]?.[0].input.Key).toEqual({ pk: 'agent-calls#2026-08-22' });
  });

  it('allows the call that lands exactly on the ceiling', async () => {
    // The boundary is the whole point of a limit. One off in either direction either refuses the
    // last paid-for call or grants one nobody budgeted, every day, silently.
    respondWith(200);

    await expect(reserveCall('spend', 200)).resolves.toEqual({
      allowed: true,
      used: 200,
      limit: 200,
    });
  });

  it('refuses the first call past the ceiling', async () => {
    respondWith(201);

    await expect(reserveCall('spend', 200)).resolves.toEqual({
      allowed: false,
      used: 201,
      limit: 200,
    });
  });

  it('sets the expiry only once, so a busy day cannot extend its own counter', async () => {
    respondWith(5);
    await reserveCall('spend', 200);

    const input = send.mock.calls[0]?.[0].input;
    expect(input.UpdateExpression).toContain('expiresAt = if_not_exists(expiresAt, :ttl)');
    expect(input.ExpressionAttributeValues[':ttl']).toBe(
      Math.floor(NOW.getTime() / 1000) + 2 * SECONDS_PER_DAY,
    );
  });

  it('fails closed when DynamoDB returns no counter', async () => {
    // This read `?? 0` until this test was written, which meant an unreadable counter reported
    // zero calls used and allowed everything — the one bound on a public endpoint failing open at
    // exactly the moment it stopped working. Refusing is the conservative direction.
    respondWith(undefined);

    await expect(reserveCall('spend', 200)).resolves.toMatchObject({ allowed: false });
  });
});
