import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/**
 * The Anthropic API key, read from SSM Parameter Store at cold start.
 *
 * Deliberately not a Lambda environment variable. Environment variables are rendered into the
 * CloudFormation template, which is stored in CloudFormation itself and staged in an S3 bucket —
 * a key placed there sits in plaintext in several places nobody thinks to look at again, and
 * survives in template history after any rotation.
 *
 * An SSM SecureString is encrypted with KMS, readable only by this function's execution role, and
 * rotatable without a redeploy. Standard parameters are free, so this costs nothing.
 */

const ssm = new SSMClient({});

let cached: Promise<string> | null = null;

async function fetchKey(): Promise<string> {
  const name = process.env['ANTHROPIC_API_KEY_PARAMETER'];
  if (name === undefined || name === '') {
    throw new Error('ANTHROPIC_API_KEY_PARAMETER is not configured on this function.');
  }

  const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = result.Parameter?.Value;

  if (value === undefined || value === '') {
    throw new Error(`SSM parameter ${name} is empty.`);
  }
  return value;
}

/**
 * Resolve the key, fetching once per container.
 *
 * Caching the promise rather than the value means concurrent invocations during a cold start
 * share one SSM call instead of racing to make several.
 */
export function getAnthropicApiKey(): Promise<string> {
  cached ??= fetchKey().catch((error: unknown) => {
    // Clear the cache on failure, otherwise one transient SSM error poisons the container for the
    // rest of its life.
    cached = null;
    throw error;
  });
  return cached;
}
