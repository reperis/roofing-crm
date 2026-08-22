import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

/**
 * A daily ceiling on model calls.
 *
 * This endpoint is deliberately unauthenticated — the whole point is that anyone can use the
 * product without credentials — which also means anyone can spend the account's balance. An
 * unguarded public endpoint in front of a metered API is an open tap.
 *
 * The counter is a DynamoDB atomic increment rather than a read-then-write, because concurrent
 * Lambda invocations would otherwise both read the same value and both decide there was room.
 * The item carries a TTL so yesterday's counters expire without any cleanup job.
 */

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export interface SpendCheck {
  allowed: boolean;
  used: number;
  limit: number;
}

const SECONDS_PER_DAY = 86_400;

/**
 * Reserve one call against today's budget.
 *
 * Increments first and compares afterwards: reserving before the expensive operation means a
 * burst of concurrent requests cannot collectively overshoot, at the cost of occasionally
 * "spending" a slot on a call that then fails. That is the right trade — the failure mode is a
 * slightly conservative limit rather than an unbounded bill.
 */
export async function reserveCall(tableName: string, dailyLimit: number): Promise<SpendCheck> {
  const today = new Date().toISOString().slice(0, 10);

  const result = await client.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk: `agent-calls#${today}` },
      UpdateExpression: 'ADD calls :one SET expiresAt = if_not_exists(expiresAt, :ttl)',
      ExpressionAttributeValues: {
        ':one': 1,
        ':ttl': Math.floor(Date.now() / 1000) + 2 * SECONDS_PER_DAY,
      },
      ReturnValues: 'UPDATED_NEW',
    }),
  );

  const used = Number(result.Attributes?.['calls'] ?? 0);
  return { allowed: used <= dailyLimit, used, limit: dailyLimit };
}
