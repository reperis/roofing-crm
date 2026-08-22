import { leadStatuses, type Lead, type LeadStatus } from '@roofing/schema';
import { useCallback, useState } from 'react';

import { AsyncBoundary } from '../components/Async';
import { ProvenanceTag, RoofAge, ScoreBar } from '../components/Provenance';
import { listLeads, updateLead } from '../data/leads';
import { useAsync } from '../hooks/useAsync';

/**
 * The sales pipeline.
 *
 * Leads live server-side, so this is the one view in the product backed by an API rather than by
 * the browser's own query engine. Everything here is a record a rep created deliberately, which
 * is why it is worth persisting when the map's 500-row result set is not.
 */

const STAGE_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  quoted: 'Quoted',
  won: 'Won',
  lost: 'Lost',
};

function daysSince(iso: string): number {
  return Math.floor((Date.now() - Date.parse(iso)) / (24 * 60 * 60 * 1000));
}

function LeadRow({ lead, onChanged }: { lead: Lead; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const move = async (status: LeadStatus) => {
    setBusy(true);
    setError(null);
    try {
      await updateLead(lead.lead_id, { status });
      onChanged();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const stalled = daysSince(lead.status_changed_at);

  return (
    <tr>
      <td>
        <ScoreBar score={lead.score} />
      </td>
      <td>
        {lead.snapshot.address_street ?? <span className="muted">—</span>}
        <span className="cell__sub mono">{lead.parcel_identifier}</span>
      </td>
      <td>
        {lead.snapshot.owner_name ?? <span className="muted">—</span>}
        {lead.snapshot.owner_is_out_of_area === true && (
          <span className="tag tag--fallback">out of area</span>
        )}
      </td>
      <td>
        <RoofAge years={lead.snapshot.roof_age_years} basis={lead.snapshot.roof_age_basis} />
      </td>
      <td className="num">
        {lead.snapshot.permit_days_open === null
          ? '—'
          : `${(lead.snapshot.permit_days_open / 365).toFixed(1)} yr`}
      </td>
      <td>{lead.snapshot.contractor_name ?? <span className="muted">—</span>}</td>
      <td className="num">
        {stalled === 0 ? 'today' : `${stalled}d`}
        {stalled > 14 && <span className="tag tag--fallback">stalled</span>}
      </td>
      <td>
        <select
          className="select"
          value={lead.status}
          disabled={busy}
          onChange={(event) => void move(event.target.value as LeadStatus)}
        >
          {leadStatuses.map((status) => (
            <option key={status} value={status}>
              {STAGE_LABELS[status]}
            </option>
          ))}
        </select>
        {error !== null && <span className="cell__sub status--error">{error}</span>}
      </td>
      <td>
        <ProvenanceTag tier={lead.provenance_tier} />
      </td>
    </tr>
  );
}

export function Pipeline() {
  const [stage, setStage] = useState<LeadStatus | null>(null);
  // Bumped after every mutation to force a refetch; the server owns lead state, so re-reading is
  // more honest than patching a local copy and hoping it matches.
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  const leads = useAsync(() => listLeads(stage), [stage, revision]);

  const counts = (leads.data ?? []).reduce<Record<string, number>>((totals, lead) => {
    totals[lead.status] = (totals[lead.status] ?? 0) + 1;
    return totals;
  }, {});

  return (
    <div className="stack">
      <section className="card">
        <h2>Pipeline</h2>
        <p className="card__lede">
          Leads converted from the map. Records persist server-side, so the whole team sees the
          same board — and a lead keeps the signal values it was created from, even after the
          county dataset is republished.
        </p>

        <div className="controls">
          <button
            type="button"
            className={`chip ${stage === null ? 'chip--active' : ''}`}
            onClick={() => setStage(null)}
          >
            All
          </button>
          {leadStatuses.map((status) => (
            <button
              key={status}
              type="button"
              className={`chip ${stage === status ? 'chip--active' : ''}`}
              onClick={() => setStage(status)}
            >
              {STAGE_LABELS[status]}
              {counts[status] !== undefined && stage === null && (
                <span className="chip__count">{counts[status]}</span>
              )}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>{stage === null ? 'All leads' : `${STAGE_LABELS[stage]} leads`}</h2>
        <AsyncBoundary
          state={leads}
          label="leads"
          empty={(data) => data.length === 0}
          emptyMessage="No leads yet. Convert a candidate from the Prospect tab to start a pipeline."
        >
          {(data) => (
            <>
              <p className="muted">{data.length} lead{data.length === 1 ? '' : 's'}.</p>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Score</th>
                      <th>Address</th>
                      <th>Owner</th>
                      <th>Roof age</th>
                      <th className="num">Permit open</th>
                      <th>Contractor</th>
                      <th className="num">In stage</th>
                      <th>Stage</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((lead) => (
                      <LeadRow key={lead.lead_id} lead={lead} onChanged={refresh} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </AsyncBoundary>
      </section>
    </div>
  );
}
