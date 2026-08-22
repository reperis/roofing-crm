import type { CreateLeadInput, Lead, LeadStatus, UpdateLeadInput } from '@roofing/schema';

import { resolveApiBase } from './config';

/**
 * Client for the lead records API.
 *
 * The only part of this product that talks to a server. Property and permit queries run entirely
 * in the browser against published Parquet; leads are different because they are the one thing a
 * rep creates, and they have to outlive a tab and be visible to the rest of the team.
 *
 * Served from the site's own origin under `/api`, so there is no CORS preflight and no key.
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${resolveApiBase()}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    // Surface the API's own message where it sent one — "Unknown pipeline stage: archived" is a
    // great deal more useful to a rep than "request failed".
    const detail = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => null);
    throw new Error(detail ?? `Request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

export async function listLeads(status: LeadStatus | null = null): Promise<Lead[]> {
  const query = status === null ? '' : `?status=${encodeURIComponent(status)}`;
  const body = await request<{ leads: Lead[] }>(`/leads${query}`);
  return body.leads;
}

/**
 * One lead, or null if the property has never been converted.
 *
 * A 404 is the *normal* answer here — most properties on the map are not leads — so it resolves
 * to null rather than throwing. Treating "not a lead yet" as an error would make the drawer show
 * a red failure banner for the common case.
 */
export async function getLead(leadId: string): Promise<Lead | null> {
  const response = await fetch(`${resolveApiBase()}/leads/${encodeURIComponent(leadId)}`, {
    headers: { 'content-type': 'application/json' },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => null);
    throw new Error(detail ?? `Request failed (${response.status})`);
  }

  const body = (await response.json()) as { lead: Lead };
  return body.lead;
}

/** Convert a property into a lead. Idempotent — the same parcel always yields the same record. */
export async function createLead(input: CreateLeadInput): Promise<Lead> {
  const body = await request<{ lead: Lead }>('/leads', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return body.lead;
}

export async function updateLead(leadId: string, input: UpdateLeadInput): Promise<Lead> {
  const body = await request<{ lead: Lead }>(`/leads/${encodeURIComponent(leadId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return body.lead;
}
