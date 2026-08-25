/**
 * Provenance markers.
 *
 * Four of the signals this CRM sells on — roof age, roofing permits, contractor identity and BBB
 * rating — have no lawful public feed for Chester County, so upstream they are generated. A rep
 * about to phone a homeowner has to be able to tell, at a glance and without reading
 * documentation, which numbers came from a county record and which did not. That distinction is a
 * first-class part of the interface, not a footnote, and it survives conversion: a lead built on a
 * generated permit stays marked generated for its whole life in the pipeline.
 */

export type Tier = 'authoritative' | 'synthetic' | string;

const TIER_COPY: Record<string, { label: string; title: string; className: string }> = {
  authoritative: {
    label: 'Sourced',
    title: 'Retrieved from an official public source, with the request recorded.',
    className: 'tag tag--sourced',
  },
  synthetic: {
    label: 'Generated',
    title:
      'Generated upstream. No lawful public source for this field exists in Chester County — ' +
      'not source-backed, and not safe to quote to a customer.',
    className: 'tag tag--generated',
  },
};

export function ProvenanceTag({ tier }: { tier: Tier }) {
  const copy = TIER_COPY[tier] ?? { label: tier, title: 'Unknown provenance.', className: 'tag' };

  return (
    <span className={copy.className} title={copy.title}>
      {copy.label}
    </span>
  );
}

/**
 * Plain-English copy for each basis the published column emits.
 *
 * 'unknown' reads as "no basis" rather than "unknown" because this label sits directly beside a
 * number: "12 yr · unknown" says the year is unknown, which is the opposite of what the column
 * means. The provenance is what is unknown, and the roof age is missing entirely.
 */
const BASIS_COPY: Record<string, string> = {
  built_year: 'assessor year built',
  last_roof_permit: 'last roofing permit',
  construction_year_proxy: 'county year built',
  synthetic: 'generated',
  unknown: 'no basis',
};

/** Roof age is never shown without saying what it is based on. */
export function RoofAge({ years, basis }: { years: number | null; basis: string | null }) {
  if (years === null) {
    return <span className="muted">unknown</span>;
  }

  // Three states, not two. "Not generated" is not the same as "sourced": a basis this build does
  // not recognise, or one the dataset itself calls unknown, backs no claim at all — and styling it
  // like a county-sourced figure tells a rep the number came from a record when it did not.
  const generated = basis === 'synthetic';
  const backed = basis !== null && basis !== 'unknown' && basis in BASIS_COPY && !generated;
  const label = basis === null ? 'unknown basis' : (BASIS_COPY[basis] ?? basis);

  return (
    <span
      className={generated ? 'value value--generated' : backed ? 'value' : 'value value--unbacked'}
    >
      {years} yr
      <span className="value__basis" title={`Basis: ${label}`}>
        {label}
      </span>
    </span>
  );
}

/**
 * Lead score, shown as a number and a bar.
 *
 * The bar exists because a score is only useful comparatively — a rep scanning thirty rows needs
 * to see the shape of the queue, not read thirty two-digit numbers.
 */
export function ScoreBar({ score }: { score: number }) {
  const band = score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold';

  return (
    <span className={`score score--${band}`} title={`Lead score ${score} of 100`}>
      <span className="score__bar" style={{ width: `${score}%` }} />
      <span className="score__value">{score}</span>
    </span>
  );
}
