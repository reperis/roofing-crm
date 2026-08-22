import { createAnthropic } from '@ai-sdk/anthropic';
import { Logger } from '@aws-lambda-powertools/logger';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { generateText, stepCountIs } from 'ai';
import { z } from 'zod';

import { SYSTEM_PROMPT } from './prompt';
import { getAnthropicApiKey } from './secret';
import { reserveCall } from './spend-guard';
import { buildTools } from './tools';

/**
 * The natural-language lead-research agent.
 *
 * The whole loop runs here: the model calls tools, the tools read the published Parquet and the
 * CRM's own lead table, and the model answers from what came back. That is different from the
 * Oracle's agent, which generates SQL for the browser to run — and the difference is deliberate.
 * This agent has to reason across two stores at once, the county dataset and the team's pipeline,
 * and only one of those is reachable from a browser tab.
 *
 * Everything expensive is bounded: a daily call ceiling, a step ceiling, an output-token ceiling,
 * and a row ceiling inside every tool. The endpoint is public by design, so those bounds are the
 * only thing standing between a curious visitor and the account's balance.
 */

const logger = new Logger();

/** Haiku: this is retrieval, filtering and short summarisation, not deep reasoning. */
const MODEL = 'claude-haiku-4-5';

/** Bounds on a single call, so no one request can run away with the budget. */
const MAX_OUTPUT_TOKENS = 1000;
const MAX_STEPS = 5;

const DAILY_LIMIT = Number(process.env['AGENT_DAILY_CALL_LIMIT'] ?? '200');
const SPEND_TABLE = process.env['SPEND_TABLE_NAME'] ?? '';
const LEADS_TABLE = process.env['LEADS_TABLE_NAME'] ?? '';

const agentRequest = z.object({
  question: z.string().min(3).max(500),
});

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST,OPTIONS',
  'content-type': 'application/json',
  'cache-control': 'no-store',
};

const reply = (status: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: CORS,
  body: JSON.stringify(body),
});

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (event.requestContext.http.method === 'OPTIONS') {
    return reply(204, {});
  }

  if (SPEND_TABLE === '' || LEADS_TABLE === '') {
    logger.error('agent function is missing table configuration');
    return reply(500, { error: 'The agent is not configured.' });
  }

  const parsed = agentRequest.safeParse(JSON.parse(event.body ?? '{}'));
  if (!parsed.success) {
    return reply(400, { error: 'Ask a question between 3 and 500 characters.' });
  }

  // Reserve before spending. A burst of concurrent requests cannot collectively overshoot, at the
  // cost of occasionally reserving a slot for a call that then fails.
  const budget = await reserveCall(SPEND_TABLE, DAILY_LIMIT);
  if (!budget.allowed) {
    logger.warn('daily agent budget exhausted', { used: budget.used, limit: budget.limit });
    return reply(429, {
      error:
        'The assistant has reached its daily question limit. The map, filters and pipeline all ' +
        'still work — only the natural-language answers are paused until tomorrow.',
    });
  }

  try {
    const provider = createAnthropic({ apiKey: await getAnthropicApiKey() });
    const tools = buildTools({
      store: { tableName: LEADS_TABLE, now: () => new Date() },
      now: () => new Date(),
    });

    const started = Date.now();
    const result = await generateText({
      model: provider(MODEL),
      system: SYSTEM_PROMPT,
      prompt: parsed.data.question,
      tools,
      // Bounded so a confused model cannot loop through the budget. Five is enough for the
      // realistic worst case: look up coverage, search an area, then answer.
      stopWhen: stepCountIs(MAX_STEPS),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    // Surfaced to the UI so a reader can see which filters produced the answer, rather than
    // taking the prose on trust.
    const toolCalls = result.steps.flatMap((step) =>
      step.toolCalls.map((call) => ({ tool: call.toolName, input: call.input })),
    );

    /**
     * The rows the answer was written from.
     *
     * Returned so the UI can render them as a table beside the prose. A summary a reader cannot
     * check is just an assertion — and with four of this dataset's signals generated, "trust the
     * paragraph" is exactly the wrong contract. The last tool result wins, because that is the
     * one the model was looking at when it wrote the answer.
     */
    const evidence = result.steps
      .flatMap((step) => step.toolResults)
      .map((toolResult) => toolResult.output as { rows?: unknown[]; total_matches?: number })
      .filter((output) => Array.isArray(output?.rows))
      .at(-1);

    logger.info('agent answered', {
      ms: Date.now() - started,
      steps: result.steps.length,
      tools: toolCalls.map((call) => call.tool),
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      budget_used: budget.used,
    });

    return reply(200, {
      answer: result.text,
      toolCalls,
      rows: evidence?.rows ?? [],
      totalMatches: evidence?.total_matches ?? null,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
      budget: { used: budget.used, limit: budget.limit },
    });
  } catch (error: unknown) {
    logger.error('agent request failed', { error });
    return reply(502, { error: 'The assistant could not answer that. Please try again.' });
  }
}
