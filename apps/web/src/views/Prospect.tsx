import {
  weakestTier,
  type CreateLeadInput,
  type LeadCandidate,
  type LeadSourceSignal,
  type LeadStatus,
  type ProvenanceTier,
} from '@roofing/schema';
import { scoreLead } from '@roofing/shared';
import {
  GeolocateControl,
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AsyncBoundary } from '../components/Async';
import { LeadDrawer } from '../components/LeadDrawer';
import { ProvenanceTag, RoofAge, ScoreBar } from '../components/Provenance';
import {
  DEFAULT_MIN_YEARS_OPEN,
  DEFAULT_RADIUS_MILES,
  DEFAULT_ROOF_AGE_THRESHOLD,
  MAP_RESULT_LIMIT,
  TABLE_RESULT_LIMIT,
  WEST_CHESTER,
} from '../data/config';
import { createLead, listLeads } from '../data/leads';
import { findLeadCandidates, getAreaSummary } from '../data/queries';
import { useAsync } from '../hooks/useAsync';

import type { LatLon } from '@roofing/shared';

/**
 * MapLibre 6 ships its tile worker as a separate module and does not locate it on its own — there
 * is no `new Worker(...)` and no inline Blob fallback in the main bundle, so a bundler build must
 * point at it explicitly.
 *
 * The `?worker&url` suffix matters. Plain `?url` copies the file verbatim as a static asset
 * without rewriting its imports, so the worker's own `import './maplibre-gl-shared.mjs'` resolves
 * to a path the build never emitted and the worker dies on load. `?worker&url` makes Vite bundle
 * it, inlining those dependencies.
 *
 * Getting this wrong fails in the worst possible way: the map mounts, sizes itself, accepts clicks
 * and reports no error, while its style never finishes loading — so no sources are created, no
 * tiles are ever requested, and the canvas stays empty.
 */
setWorkerUrl(maplibreWorkerUrl);

/**
 * A raster basemap, defined inline rather than fetched as a vector style.
 *
 * Deliberately the simplest thing that can work. A vector style pulls a style document, a sprite
 * sheet, glyph ranges and protobuf tiles decoded in a worker — four independent things that can
 * fail, none of which report anything useful when they do. Raster tiles are plain PNGs drawn
 * straight to the canvas: if the request succeeds, the pixels appear.
 *
 * Light rather than dark on purpose. Against a dark basemap, "failed to render" and "rendered
 * correctly" look identical.
 */
const BASEMAP: StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors © CARTO',
    },
  },
  layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
};

const RESULTS_SOURCE = 'results';
const RADIUS_SOURCE = 'radius';

interface Polygon {
  type: 'Polygon';
  coordinates: [number, number][][];
}

/** Approximate a circle as a polygon; MapLibre has no native circle geometry measured in miles. */
function circlePolygon(centre: LatLon, radiusMiles: number, steps = 96): Polygon {
  const coordinates: [number, number][] = [];
  const latDelta = radiusMiles / 69.0;
  const lonDelta = radiusMiles / (69.0 * Math.cos((centre.latitude * Math.PI) / 180));

  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * 2 * Math.PI;
    coordinates.push([
      centre.longitude + lonDelta * Math.cos(angle),
      centre.latitude + latDelta * Math.sin(angle),
    ]);
  }

  return { type: 'Polygon', coordinates: [coordinates] };
}

interface MapPoint {
  longitude: number;
  latitude: number;
  score: number;
}

interface MapPanelProps {
  centre: LatLon;
  radiusMiles: number;
  points: MapPoint[];
  onPick: (point: LatLon) => void;
}

function MapPanel({ centre, radiusMiles, points, onPick }: MapPanelProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    if (container.current === null || map.current !== null) return;

    const instance = new MapLibreMap({
      container: container.current,
      style: BASEMAP,
      center: [WEST_CHESTER.longitude, WEST_CHESTER.latitude],
      zoom: 11,
      attributionControl: { compact: true },
    });

    instance.addControl(new NavigationControl(), 'top-right');
    // Centring on the rep's own position is one of the story's two required ways to start a
    // search; the other is the map click handler below.
    instance.addControl(new GeolocateControl({ trackUserLocation: false }), 'top-right');

    instance.on('click', (event: MapMouseEvent) => {
      pickRef.current({ latitude: event.lngLat.lat, longitude: event.lngLat.lng });
    });

    // Without this a tile or style failure is entirely silent — the map simply stays empty.
    instance.on('error', (event) => {
      console.error('[map]', event.error?.message ?? event);
    });

    instance.on('load', () => {
      instance.addSource(RADIUS_SOURCE, {
        type: 'geojson',
        data: { type: 'Feature', geometry: circlePolygon(centre, radiusMiles), properties: {} },
      });
      instance.addLayer({
        id: 'radius-fill',
        type: 'fill',
        source: RADIUS_SOURCE,
        // Slightly stronger than it would be on a dark basemap; a light ground washes it out.
        paint: { 'fill-color': '#1f6feb', 'fill-opacity': 0.12 },
      });
      instance.addLayer({
        id: 'radius-line',
        type: 'line',
        source: RADIUS_SOURCE,
        paint: { 'line-color': '#1f6feb', 'line-width': 2, 'line-dasharray': [2, 2] },
      });

      instance.addSource(RESULTS_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      instance.addLayer({
        id: 'results-dots',
        type: 'circle',
        source: RESULTS_SOURCE,
        paint: {
          // Hotter leads render larger, so the shape of the opportunity is visible at a glance
          // without reading a single row of the table.
          'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 2.5, 100, 7],
          /**
           * Colour is lead score, not provenance.
           *
           * Provenance was the obvious choice and it was wrong: every roofing permit is generated
           * (23,449 of 23,449), and roof age is sourced for only the 7,102 parcels the county
           * publishes a year built for — new construction from 2018-2022, whose roofs are far too
           * young to qualify as a lead. A candidate only qualifies through one of those signals,
           * so in practice the flag is true for every dot that reaches the map. A colour channel
           * encoding a near-constant is worse than no legend. Score is what actually varies and
           * what decides the next door to knock on.
           *
           * Thresholds match the score bars in the table below, so the map and the list agree
           * about what counts as a hot lead. Darker shades than the table's: these sit on a
           * light basemap, not a dark card.
           */
          'circle-color': ['step', ['get', 'score'], '#3d6a8f', 40, '#bf8700', 70, '#d1242f'],
          'circle-opacity': 0.85,
          'circle-stroke-width': 0.6,
          'circle-stroke-color': '#ffffff',
        },
      });

      setReady(true);
    });

    map.current = instance;
    (globalThis as unknown as { __map: MapLibreMap }).__map = instance;
    return () => {
      instance.remove();
      map.current = null;
    };
    // Mount once; subsequent prop changes are pushed through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready || map.current === null) return;
    const source = map.current.getSource(RADIUS_SOURCE) as GeoJSONSource | undefined;
    source?.setData({
      type: 'Feature',
      geometry: circlePolygon(centre, radiusMiles),
      properties: {},
    });
  }, [ready, centre, radiusMiles]);

  useEffect(() => {
    if (!ready || map.current === null) return;
    const source = map.current.getSource(RESULTS_SOURCE) as GeoJSONSource | undefined;
    source?.setData({
      type: 'FeatureCollection',
      features: points.map((point) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
        properties: { score: point.score },
      })),
    });
  }, [ready, points]);

  return <div className="map" ref={container} />;
}

export interface ScoredCandidate extends LeadCandidate {
  score: number;
  /** Weakest provenance across everything shown in the row. */
  rowTier: ProvenanceTier;
}

function money(value: number | null): string {
  return value === null ? '—' : `$${value.toLocaleString('en-US')}`;
}

/**
 * Everything the CRM records about a property at the moment a rep decides to call.
 *
 * Extracted rather than inlined because a property can be converted from two places — the row
 * button and the detail drawer — and both must send a byte-identical snapshot. If they drifted,
 * the same parcel would carry a different record of what was true at capture time depending on
 * which control the rep happened to click.
 *
 * The snapshot is the whole point of the lead model: it survives the dataset being republished,
 * so "why did I call this person?" stays answerable weeks later.
 */
export function leadInputFor(row: ScoredCandidate, note?: string): CreateLeadInput {
  return {
    parcel_identifier: row.parcel_identifier,
    source_signal: signalFor(row),
    latitude: row.latitude,
    longitude: row.longitude,
    snapshot: {
      address_street: row.address_street,
      address_city: row.address_city,
      address_zip: row.address_zip,
      owner_name: row.owner_name,
      owner_is_out_of_area: row.owner_is_out_of_area,
      assessed_value: row.assessed_value,
      last_sale_date: row.last_sale_date,
      roof_age_years: row.roof_age_years,
      roof_age_basis: row.roof_age_basis,
      permit_number: row.permit_number,
      permit_status: row.improvement_status,
      permit_days_open: row.permit_days_open,
      contractor_name: row.contractor_name,
      contractor_bbb_rating: row.contractor_bbb_rating,
      contractor_bbb_score: row.contractor_bbb_score,
    },
    ...(note === undefined || note.trim() === '' ? {} : { note: note.trim() }),
  };
}

/** Convert straight from the results table, without opening the property. */
function ConvertButton({ row, onConverted }: { row: ScoredCandidate; onConverted: () => void }) {
  const [state, setState] = useState<'idle' | 'saving' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  const convert = async () => {
    setState('saving');
    setError(null);
    try {
      await createLead(leadInputFor(row));
      onConverted();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState('failed');
    }
  };

  return (
    <>
      <button
        type="button"
        className="button button--small"
        disabled={state === 'saving'}
        onClick={(event) => {
          // The row itself opens the drawer; converting must not do both.
          event.stopPropagation();
          void convert();
        }}
      >
        {state === 'saving' ? 'Saving…' : 'Convert'}
      </button>
      {error !== null && <span className="cell__sub status--error">{error}</span>}
    </>
  );
}

/** Which signal put this property on the list — drives the default outreach script. */
export function signalFor(row: ScoredCandidate): LeadSourceSignal {
  const agedRoof = row.roof_age_years !== null && row.roof_age_years > 0;
  const permit = row.permit_number !== null;

  if (agedRoof && permit) return 'aged_roof_and_permit';
  if (permit) return 'open_permit';
  return 'aged_roof';
}

export function Prospect() {
  const [centre, setCentre] = useState<LatLon>(WEST_CHESTER);
  const [radius, setRadius] = useState(DEFAULT_RADIUS_MILES);
  const [minRoofAge, setMinRoofAge] = useState(DEFAULT_ROOF_AGE_THRESHOLD);
  const [minYearsOpen, setMinYearsOpen] = useState(0);
  const [requireOpenPermit, setRequireOpenPermit] = useState(false);
  const [selected, setSelected] = useState<ScoredCandidate | null>(null);
  /**
   * Bumped whenever a lead is created or restaged, to refetch the pipeline marks.
   *
   * The server owns lead state, so re-reading it is more honest than patching a local copy and
   * hoping it still matches what the rest of the team sees.
   */
  const [leadRevision, setLeadRevision] = useState(0);
  const onLeadChanged = useCallback(() => setLeadRevision((value) => value + 1), []);

  const summary = useAsync(
    () => getAreaSummary(centre, radius, minRoofAge, DEFAULT_MIN_YEARS_OPEN),
    [centre, radius, minRoofAge],
  );

  /**
   * Which parcels are already in the pipeline.
   *
   * Fetched once for the whole board rather than per row: a rep needs to see at a glance which
   * doors the team has already claimed, and after a page reload a converted property would
   * otherwise look identical to an untouched one — which is how two reps phone one homeowner.
   */
  const pipeline = useAsync(() => listLeads(), [leadRevision]);
  const claimed = useMemo(() => {
    const marks = new Map<string, LeadStatus>();
    for (const lead of pipeline.data ?? []) marks.set(lead.parcel_identifier, lead.status);
    return marks;
  }, [pipeline.data]);

  const candidates = useAsync(
    () =>
      findLeadCandidates(centre, radius, {
        minRoofAge,
        requireOpenPermit,
        minYearsOpen,
        limit: MAP_RESULT_LIMIT,
      }),
    [centre, radius, minRoofAge, requireOpenPermit, minYearsOpen],
  );

  /**
   * Scoring runs here rather than in SQL.
   *
   * The weights are a business policy that a roofing company should be able to retune, and the
   * same function has to produce the same number when the leads API writes a score on conversion.
   * One implementation in TypeScript, shared by both, cannot drift the way a duplicated CASE
   * expression in SQL would.
   */
  const scored: ScoredCandidate[] = useMemo(() => {
    const now = new Date();

    return (candidates.data ?? [])
      .map((row) => ({
        ...row,
        // A row is only as trustworthy as its weakest input. A parcel published by the county
        // that carries a generated permit is a generated lead, because the permit — and the
        // contractor and BBB rating hanging off it — is the reason anyone would make the call.
        rowTier: weakestTier([
          row.provenance_tier,
          ...(row.permit_provenance_tier === null ? [] : [row.permit_provenance_tier]),
          ...(row.roof_age_basis === 'synthetic' ? (['synthetic'] as const) : []),
        ]),
        score: scoreLead({
          roofAgeYears: row.roof_age_years,
          roofAgeThreshold: minRoofAge,
          permitDaysOpen: row.permit_days_open,
          ownerIsOutOfArea: row.owner_is_out_of_area,
          lastSaleDate: row.last_sale_date,
          contractorBbbScore: row.contractor_bbb_score,
          now,
        }),
      }))
      .sort((a, b) => b.score - a.score);
  }, [candidates.data, minRoofAge]);

  const mapPoints: MapPoint[] = scored
    .filter((row) => row.latitude !== null && row.longitude !== null)
    .map((row) => ({
      latitude: row.latitude as number,
      longitude: row.longitude as number,
      score: row.score,
    }));

  return (
    <div className="stack">
      <section className="card">
        <h2>Search area</h2>
        <p className="card__lede">
          Click the map to drop a pin, or use the locate control to centre on your current position.
          Defaults to West Chester.
        </p>

        <div className="controls">
          <label>
            Radius
            <input
              type="range"
              min={0.5}
              max={20}
              step={0.5}
              value={radius}
              onChange={(event) => setRadius(Number(event.target.value))}
            />
            <output>{radius} mi</output>
          </label>

          {/*
            Disabled rather than ignored. Requiring an open permit narrows to that signal alone, so
            roof age genuinely plays no part — and a slider that moves while changing nothing is a
            worse lie than one that visibly does not apply.
          */}
          <label className={requireOpenPermit ? 'control--inactive' : ''}>
            Roof older than
            <input
              type="range"
              min={0}
              max={40}
              step={1}
              value={minRoofAge}
              disabled={requireOpenPermit}
              onChange={(event) => setMinRoofAge(Number(event.target.value))}
            />
            <output>{requireOpenPermit ? 'not applied' : `${minRoofAge} yr`}</output>
          </label>

          <label>
            Permit open at least
            <input
              type="range"
              min={0}
              max={20}
              step={1}
              value={minYearsOpen}
              onChange={(event) => setMinYearsOpen(Number(event.target.value))}
            />
            <output>{minYearsOpen} yr</output>
          </label>

          <label className="controls__check">
            <input
              type="checkbox"
              checked={requireOpenPermit}
              onChange={(event) => setRequireOpenPermit(event.target.checked)}
            />
            Open roofing permit only
          </label>

          <span className="muted">
            Pin {centre.latitude.toFixed(4)}, {centre.longitude.toFixed(4)}
          </span>
        </div>

        <MapPanel centre={centre} radiusMiles={radius} points={mapPoints} onPick={setCentre} />

        <div className="legend">
          <span className="legend__item">
            <span className="legend__dot legend__dot--hot" /> 70+
          </span>
          <span className="legend__item">
            <span className="legend__dot legend__dot--warm" /> 40–69
          </span>
          <span className="legend__item">
            <span className="legend__dot legend__dot--cold" /> under 40
          </span>
          <span className="muted">
            Colour and size are lead score. Provenance is not on the map: almost every roofing
            signal in this county is generated, so the map would be one colour and tell you nothing
            — see the Source column below and the Dataset tab.
          </span>
        </div>
      </section>

      <section className="card">
        <h2>What is in this area</h2>
        <AsyncBoundary state={summary} label="area totals">
          {(data) => (
            <div className="stats">
              <div className="stat">
                <span className="stat__value">
                  {data.properties_in_radius.toLocaleString('en-US')}
                </span>
                <span className="stat__label">properties in radius</span>
              </div>
              <div className="stat">
                <span className="stat__value">{data.aged_roofs.toLocaleString('en-US')}</span>
                <span className="stat__label">roofs over {minRoofAge} yr</span>
              </div>
              <div className="stat">
                <span className="stat__value">
                  {data.open_roofing_permits.toLocaleString('en-US')}
                </span>
                <span className="stat__label">open roofing permits</span>
              </div>
              <div className="stat">
                <span className="stat__value">
                  {data.long_open_permits.toLocaleString('en-US')}
                </span>
                <span className="stat__label">open over {DEFAULT_MIN_YEARS_OPEN} yr</span>
              </div>
              <div className="stat">
                <span className="stat__value">{data.absentee_owners.toLocaleString('en-US')}</span>
                <span className="stat__label">out-of-area owners</span>
              </div>
              <div className="stat stat--generated">
                <span className="stat__value">
                  {data.generated_signals.toLocaleString('en-US')}
                </span>
                <span className="stat__label">carry a generated signal</span>
              </div>
            </div>
          )}
        </AsyncBoundary>
      </section>

      <section className="card">
        <h2>Lead candidates</h2>
        <p className="card__lede">
          Ranked by lead score: roof age past your threshold, how long a roofing permit has sat
          open, absentee ownership, tenure, and how weak the incumbent contractor is.
        </p>

        <AsyncBoundary
          state={candidates}
          label="lead candidates"
          empty={() => scored.length === 0}
          emptyMessage="No candidates here. Widen the radius, lower the roof age, or clear the permit filter."
        >
          {() => (
            <>
              <p className="muted">
                {scored.length.toLocaleString('en-US')} shown
                {scored.length >= MAP_RESULT_LIMIT ? ` (capped at ${MAP_RESULT_LIMIT})` : ''}, best
                first.
              </p>
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
                      <th>BBB</th>
                      <th className="num">Assessed</th>
                      <th className="num">Distance</th>
                      <th>Source</th>
                      <th>Lead</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scored.slice(0, TABLE_RESULT_LIMIT).map((row) => (
                      <tr
                        key={row.parcel_identifier}
                        className="row--clickable"
                        tabIndex={0}
                        role="button"
                        aria-label={`Open ${row.address_street ?? row.parcel_identifier}`}
                        onClick={() => setSelected(row)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelected(row);
                          }
                        }}
                      >
                        <td>
                          <ScoreBar score={row.score} />
                        </td>
                        <td>
                          {row.address_street ?? <span className="muted">—</span>}
                          <span className="cell__sub mono">{row.parcel_identifier}</span>
                        </td>
                        <td>
                          {row.owner_name ?? <span className="muted">—</span>}
                          {row.owner_is_out_of_area === true && (
                            <span className="tag tag--fallback">out of area</span>
                          )}
                        </td>
                        <td>
                          <RoofAge years={row.roof_age_years} basis={row.roof_age_basis} />
                        </td>
                        <td className="num">
                          {row.permit_days_open === null
                            ? '—'
                            : `${(row.permit_days_open / 365).toFixed(1)} yr`}
                        </td>
                        <td>{row.contractor_name ?? <span className="muted">—</span>}</td>
                        <td>
                          {row.contractor_bbb_rating ?? <span className="muted">—</span>}
                          {row.contractor_bbb_score !== null && (
                            <span className="muted"> ({row.contractor_bbb_score})</span>
                          )}
                        </td>
                        <td className="num">{money(row.assessed_value)}</td>
                        <td className="num">{row.distance_miles} mi</td>
                        <td>
                          <ProvenanceTag tier={row.rowTier} />
                        </td>
                        <td>
                          {claimed.has(row.parcel_identifier) ? (
                            <span className="tag tag--sourced">
                              {claimed.get(row.parcel_identifier)}
                            </span>
                          ) : (
                            <ConvertButton row={row} onConverted={onLeadChanged} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </AsyncBoundary>
      </section>

      {selected !== null && (
        <LeadDrawer
          candidate={selected}
          onClose={() => setSelected(null)}
          onLeadChanged={onLeadChanged}
        />
      )}
    </div>
  );
}
