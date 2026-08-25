import { Logger } from '@aws-lambda-powertools/logger';
import { createLeadInputSchema, leadStatusSchema, updateLeadInputSchema } from '@roofing/schema';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { parseJsonBody } from '../http';
import { getLead, listLeads, updateLead, upsertLead, type StoreConfig } from './store';

/**
 * The CRM's lead records.
 *
 * Everything else in this product is read-only and runs in the browser — property and permit
 * queries never touch a server. Leads are the exception because they are the one thing a rep
 * creates: they have to outlive a browser tab and be visible to the rest of the team, which a
 * client-side store cannot do.
 */

const logger = new Logger();

const TABLE_NAME = process.env['LEADS_TABLE_NAME'] ?? '';

const config: StoreConfig = {
  tableName: TABLE_NAME,
  now: () => new Date(),
};

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      // The API is served through the same CloudFront distribution as the site, so browsers treat
      // it as same-origin and never send a preflight. This header is here for direct callers.
      'access-control-allow-origin': '*',
      // Lead data is per-team state; a cached response would show one rep another's stale board.
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const leadId = event.pathParameters?.['leadId'];

  if (TABLE_NAME === '') {
    logger.error('LEADS_TABLE_NAME is not configured on this function');
    return json(500, { error: 'Lead store is not configured.' });
  }

  try {
    if (method === 'GET' && leadId === undefined) {
      const requested = event.queryStringParameters?.['status'];
      const status = requested === undefined ? null : leadStatusSchema.safeParse(requested);

      if (status !== null && !status.success) {
        return json(400, { error: `Unknown pipeline stage: ${requested}` });
      }

      const leads = await listLeads(config, status === null ? null : status.data);
      return json(200, { leads, count: leads.length });
    }

    if (method === 'GET') {
      const lead = await getLead(config, leadId as string);
      return lead === null ? json(404, { error: 'No such lead.' }) : json(200, { lead });
    }

    if (method === 'POST') {
      const body = parseJsonBody(event.body);
      if (body === null) {
        return json(400, { error: 'The request body is not valid JSON.' });
      }

      const parsed = createLeadInputSchema.safeParse(body);
      if (!parsed.success) {
        return json(400, { error: 'Invalid lead.', detail: parsed.error.issues });
      }

      const lead = await upsertLead(config, parsed.data);
      logger.info('lead upserted', { lead_id: lead.lead_id, score: lead.score });
      return json(200, { lead });
    }

    if (method === 'PATCH' && leadId !== undefined) {
      const body = parseJsonBody(event.body);
      if (body === null) {
        return json(400, { error: 'The request body is not valid JSON.' });
      }

      const parsed = updateLeadInputSchema.safeParse(body);
      if (!parsed.success) {
        return json(400, { error: 'Invalid update.', detail: parsed.error.issues });
      }

      const lead = await updateLead(config, leadId, parsed.data);
      return lead === null ? json(404, { error: 'No such lead.' }) : json(200, { lead });
    }

    return json(405, { error: `${method} is not supported on this path.` });
  } catch (error: unknown) {
    // Body parsing and DynamoDB failures land here. The message is deliberately generic: the
    // endpoint is public, and echoing an AWS error back to an anonymous caller leaks topology.
    logger.error('lead request failed', { error, method, leadId });
    return json(500, { error: 'Could not complete the request.' });
  }
}
