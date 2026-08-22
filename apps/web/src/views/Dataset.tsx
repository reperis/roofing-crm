import { AsyncBoundary } from '../components/Async';
import { resolveDatasetSource } from '../data/config';
import { getDatasetTotals } from '../data/queries';
import { useAsync } from '../hooks/useAsync';

/**
 * What the CRM is searching over, and how far it can be trusted.
 *
 * This tab exists because the answer to "is this lead real?" is not a property of any single row —
 * it is a property of the pipeline that produced it. Chester County publishes no building permits
 * at all (its 73 municipalities each run their own system), the state contractor registry is
 * WAF-blocked, and BBB's terms forbid automated collection. The records that fill those gaps are
 * generated upstream and marked as such, and a sales manager deciding whether to run a campaign
 * off this data deserves to see that plainly rather than discover it later.
 */

const SOURCE_NOTES = [
  {
    signal: 'Parcels, owners, assessed values',
    status: 'sourced' as const,
    detail: 'Chester County parcel layer, refreshed weekly. Owner mailing address included.',
  },
  {
    signal: 'Well and sewage permits',
    status: 'sourced' as const,
    detail:
      'County EnerGov permitting system. Not roofing work, but real permits with real statuses ' +
      'and open dates — they are what proves the permit model against genuine records.',
  },
  {
    signal: 'Roof age',
    status: 'generated' as const,
    detail:
      'The CAMA-backed assessment layer publishes no year built, so roof age is generated ' +
      'deterministically per parcel and always labelled. The one exception: the county Planning ' +
      'Commission publishes a year built for 7,102 new-construction parcels (2018-2022), and ' +
      'those carry a sourced roof age. Their roofs are far too young to clear a lead threshold, ' +
      'so in practice every candidate here rests on a generated age.',
  },
  {
    signal: 'Roofing permits',
    status: 'generated' as const,
    detail:
      'Chester County issues no building permits; all 73 municipalities permit independently, ' +
      'and West Chester Borough — the demo target — disallows automated access in robots.txt.',
  },
  {
    signal: 'Contractor identity',
    status: 'generated' as const,
    detail:
      "Pennsylvania's Home Improvement Contractor registry returns HTTP 403 to every automated " +
      'request and publishes no API or bulk export. Licence numbers are prefixed SYNTHETIC- so ' +
      'they cannot be mistaken for, or collide with, a real registration.',
  },
  {
    signal: 'BBB rating',
    status: 'generated' as const,
    detail:
      "BBB's public site is behind an interstitial and its API returns 401 to non-partners; " +
      'their terms of use prohibit automated collection. Ratings shown are generated.',
  },
];

export function Dataset() {
  const totals = useAsync(() => getDatasetTotals(), []);
  const source = resolveDatasetSource();

  return (
    <div className="stack">
      <section className="card">
        <h2>Coverage</h2>
        <p className="card__lede">
          Records are published by the Chester County Oracle pipeline and read here directly over
          HTTP byte ranges. This CRM collects nothing itself — data gathering is a separate story.
        </p>

        <AsyncBoundary state={totals} label="dataset totals">
          {(data) => (
            <div className="stats">
              <div className="stat">
                <span className="stat__value">{data.properties.toLocaleString('en-US')}</span>
                <span className="stat__label">properties</span>
              </div>
              <div className="stat">
                <span className="stat__value">{data.permits.toLocaleString('en-US')}</span>
                <span className="stat__label">permits</span>
              </div>
              <div className="stat">
                <span className="stat__value">{data.roofing_permits.toLocaleString('en-US')}</span>
                <span className="stat__label">roofing permits</span>
              </div>
              <div className="stat">
                <span className="stat__value">
                  {data.open_roofing_permits.toLocaleString('en-US')}
                </span>
                <span className="stat__label">still open</span>
              </div>
              <div className="stat">
                <span className="stat__value">{data.sourced_records.toLocaleString('en-US')}</span>
                <span className="stat__label">sourced permit records</span>
              </div>
              <div className="stat stat--generated">
                <span className="stat__value">
                  {data.generated_records.toLocaleString('en-US')}
                </span>
                <span className="stat__label">generated permit records</span>
              </div>
            </div>
          )}
        </AsyncBoundary>

        <p className="muted">
          Reading from <strong>{source.label}</strong>
          {source.live
            ? ' — live from the Oracle deployment.'
            : ' — a copy staged into this bundle at build time.'}
        </p>
      </section>

      <section className="card">
        <h2>What is sourced, and what is not</h2>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Signal</th>
                <th>Status</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {SOURCE_NOTES.map((note) => (
                <tr key={note.signal}>
                  <td>{note.signal}</td>
                  <td>
                    <span
                      className={
                        note.status === 'sourced' ? 'tag tag--sourced' : 'tag tag--generated'
                      }
                    >
                      {note.status === 'sourced' ? 'Sourced' : 'Generated'}
                    </span>
                  </td>
                  <td className="cell__detail">{note.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
