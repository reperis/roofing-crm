import { leadIdForParcel, leadStatuses, type Lead, type LeadStatus } from '@roofing/schema';
import { useEffect, useRef, useState } from 'react';

import { createLead, getLead, updateLead } from '../data/leads';
import { getPermitsForParcel } from '../data/queries';
import { useAsync } from '../hooks/useAsync';
import { leadInputFor, type ScoredCandidate } from '../views/Prospect';
import { AsyncBoundary } from './Async';
import { ProvenanceTag, RoofAge, ScoreBar } from './Provenance';

/**
 * One property, opened.
 *
 * The results table shows a single roofing permit per parcel — the longest-open one, because a
 * lead is a phone call about a property rather than about a permit. That collapse is right for a
 * work queue and wrong for the moment a rep actually picks up the phone: by then they need the
 * parcel's whole permit history, the permit's status and number, and the contractor's licence.
 * This is where those live.
 */

const STAGE_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  quoted: 'Quoted',
  won: 'Won',
  lost: 'Lost',
};

function money(value: number | null): string {
  return value === null ? '—' : `$${value.toLocaleString('en-US')}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="drawer__field">
      <span className="drawer__label">{label}</span>
      <span className="drawer__value">{children}</span>
    </div>
  );
}

interface PipelinePanelProps {
  candidate: ScoredCandidate;
  /** The roof-age threshold the search used, so the stored score matches the displayed one. */
  roofAgeThreshold: number;
  onLeadChanged: () => void;
}

/**
 * The lead side of the property: convert it, or move the one that already exists.
 *
 * Reads the lead rather than inferring it from the row, because the pipeline lives in DynamoDB
 * and the row came from Parquet. Those two are refreshed on completely different schedules, and
 * guessing from the older one is how a rep ends up converting a property that is already
 * somebody else's active deal.
 */
function PipelinePanel({ candidate, roofAgeThreshold, onLeadChanged }: PipelinePanelProps) {
  const [revision, setRevision] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const leadId = leadIdForParcel(candidate.parcel_identifier);

  /**
   * Wrapped in an object on purpose.
   *
   * `AsyncBoundary` reads `data === null` as "nothing came back" and renders an error, but a null
   * lead is the *normal* answer here — most properties on the map have never been converted.
   * Boxing it keeps null a meaningful value rather than an absence, so the drawer offers the
   * Convert form instead of reporting a failure.
   */
  const lead = useAsync(async () => ({ lead: await getLead(leadId) }), [leadId, revision]);

  const run = async (action: () => Promise<Lead>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setNote('');
      setRevision((value) => value + 1);
      onLeadChanged();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="drawer__section">
      <h3>Pipeline</h3>

      <AsyncBoundary state={lead} label="pipeline status">
        {({ lead: existing }) =>
          existing === null ? (
            <>
              <p className="muted">Not in the pipeline yet.</p>
              <textarea
                className="drawer__note"
                rows={2}
                maxLength={2000}
                placeholder="Optional note — why this property is worth calling"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void run(() => createLead(leadInputFor(candidate, roofAgeThreshold, note)))
                }
              >
                {busy ? 'Saving…' : 'Convert to lead'}
              </button>
            </>
          ) : (
            <>
              <div className="drawer__grid">
                <Field label="Stage">
                  <select
                    className="select"
                    value={existing.status}
                    disabled={busy}
                    onChange={(event) =>
                      void run(() =>
                        updateLead(existing.lead_id, {
                          status: event.target.value as LeadStatus,
                        }),
                      )
                    }
                  >
                    {leadStatuses.map((status) => (
                      <option key={status} value={status}>
                        {STAGE_LABELS[status]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Lead score">
                  <ScoreBar score={existing.score} />
                </Field>
                <Field label="Created">{existing.created_at.slice(0, 10)}</Field>
                <Field label="Provenance">
                  <ProvenanceTag tier={existing.provenance_tier} />
                </Field>
              </div>

              {existing.notes.length > 0 && (
                <ul className="notes">
                  {existing.notes.map((entry) => (
                    <li key={entry.note_id}>
                      {entry.body}
                      <span className="cell__sub">
                        {entry.created_at.slice(0, 16).replace('T', ' ')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <textarea
                className="drawer__note"
                rows={2}
                maxLength={2000}
                placeholder="Add a note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <button
                type="button"
                className="button"
                disabled={busy || note.trim() === ''}
                onClick={() => void run(() => updateLead(existing.lead_id, { note: note.trim() }))}
              >
                {busy ? 'Saving…' : 'Add note'}
              </button>
            </>
          )
        }
      </AsyncBoundary>

      {error !== null && (
        <p className="status status--error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

interface LeadDrawerProps {
  candidate: ScoredCandidate;
  /** The roof-age threshold the search used, so the stored score matches the displayed one. */
  roofAgeThreshold: number;
  onClose: () => void;
  onLeadChanged: () => void;
}

export function LeadDrawer({
  candidate,
  roofAgeThreshold,
  onClose,
  onLeadChanged,
}: LeadDrawerProps) {
  const panel = useRef<HTMLDivElement>(null);
  const permits = useAsync(
    () => getPermitsForParcel(candidate.parcel_identifier),
    [candidate.parcel_identifier],
  );

  useEffect(() => {
    // Restore focus to whatever the rep was on before the drawer stole it.
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <>
      {/*
        Hidden from assistive technology on purpose: this is a pointer affordance, and the drawer
        is already dismissible with Escape (below). Giving it a role and a key handler would put a
        second, redundant "close" in the tab order ahead of the drawer's own content.
      */}
      <div className="drawer__backdrop" aria-hidden="true" onClick={onClose} />
      <aside
        className="drawer"
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={candidate.address_street ?? candidate.parcel_identifier}
      >
        <header className="drawer__head">
          <div>
            <h2>{candidate.address_street ?? 'Address not published'}</h2>
            <p className="muted mono">
              {candidate.parcel_identifier}
              {candidate.address_city !== null && ` · ${candidate.address_city}`} ·{' '}
              {candidate.distance_miles} mi away
            </p>
          </div>
          <button type="button" className="drawer__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <section className="drawer__section">
          <h3>Property</h3>
          <div className="drawer__grid">
            <Field label="Lead score">
              <ScoreBar score={candidate.score} />
            </Field>
            <Field label="Owner">
              {candidate.owner_name ?? <span className="muted">—</span>}
              {candidate.owner_is_out_of_area === true && (
                <span className="tag tag--fallback">out of area</span>
              )}
            </Field>
            <Field label="Roof age">
              <RoofAge years={candidate.roof_age_years} basis={candidate.roof_age_basis} />
            </Field>
            <Field label="Assessed value">{money(candidate.assessed_value)}</Field>
            <Field label="Last sale">
              {candidate.last_sale_date ?? <span className="muted">—</span>}
            </Field>
            <Field label="Property type">
              {candidate.property_type ?? <span className="muted">—</span>}
            </Field>
            <Field label="Parcel record">
              <ProvenanceTag tier={candidate.provenance_tier} />
            </Field>
          </div>
        </section>

        <section className="drawer__section">
          <h3>Permit history</h3>
          <p className="card__lede">
            Every permit on this parcel, roofing first. The results table shows only the
            longest-open roofing permit; this is the full record.
          </p>

          <AsyncBoundary
            state={permits}
            label="permits"
            empty={(data) => data.length === 0}
            emptyMessage="No permits recorded on this parcel."
          >
            {(data) => (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Permit</th>
                      <th>Work</th>
                      <th>Status</th>
                      <th>Opened</th>
                      <th className="num">Open for</th>
                      <th>Contractor</th>
                      <th>Licence</th>
                      <th>BBB</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((permit, index) => (
                      <tr key={`${permit.permit_number ?? 'permit'}-${index}`}>
                        <td className="mono">
                          {permit.permit_number ?? <span className="muted">—</span>}
                          {permit.is_roofing && <span className="tag tag--fallback">roofing</span>}
                        </td>
                        <td>{permit.improvement_type ?? <span className="muted">—</span>}</td>
                        <td>{permit.improvement_status ?? <span className="muted">—</span>}</td>
                        <td>{permit.opened_date ?? <span className="muted">—</span>}</td>
                        <td className="num">
                          {permit.permit_close_date !== null ? (
                            <span className="muted">closed</span>
                          ) : permit.days_open === null ? (
                            '—'
                          ) : (
                            `${(permit.days_open / 365).toFixed(1)} yr`
                          )}
                        </td>
                        <td>{permit.contractor_name ?? <span className="muted">—</span>}</td>
                        <td className="mono">
                          {permit.contractor_license ?? <span className="muted">—</span>}
                        </td>
                        <td>
                          {permit.contractor_bbb_rating ?? <span className="muted">—</span>}
                          {permit.contractor_bbb_score !== null && (
                            <span className="muted"> ({permit.contractor_bbb_score})</span>
                          )}
                        </td>
                        <td>
                          <ProvenanceTag tier={permit.provenance_tier} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AsyncBoundary>
        </section>

        <PipelinePanel
          candidate={candidate}
          roofAgeThreshold={roofAgeThreshold}
          onLeadChanged={onLeadChanged}
        />
      </aside>
    </>
  );
}
