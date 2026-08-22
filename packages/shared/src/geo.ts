/**
 * Radius maths, shared by the browser query layer and the agent's tools.
 *
 * Deliberately no reprojection here, unlike the ingestion side of this system: the dataset this
 * CRM consumes is already published in WGS84, so a state-plane converter would be dead code that
 * still had to be maintained and still pulled in proj4.
 */

export interface LatLon {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_MILES = 3958.7613;
const DEG_TO_RAD = Math.PI / 180;

/** Great-circle distance in miles between two WGS84 points. */
export function haversineMiles(a: LatLon, b: LatLon): number {
  const dLat = (b.latitude - a.latitude) * DEG_TO_RAD;
  const dLon = (b.longitude - a.longitude) * DEG_TO_RAD;
  const lat1 = a.latitude * DEG_TO_RAD;
  const lat2 = b.latitude * DEG_TO_RAD;

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * A bounding box that fully contains the given radius.
 *
 * Every radius search runs this first. The box is a pair of cheap `BETWEEN` comparisons that let
 * the query engine skip whole Parquet row groups; haversine then trims the box's corners back to
 * a true circle. Running the trigonometry first would force a full scan of 193,000 rows on every
 * pan of the map.
 */
export function radiusBoundingBox(centre: LatLon, radiusMiles: number): BoundingBox {
  const latDelta = radiusMiles / 69.0;
  // Longitude degrees shrink toward the poles; clamp the cosine so we never divide by ~0.
  const lonDelta = radiusMiles / (69.0 * Math.max(0.01, Math.cos(centre.latitude * DEG_TO_RAD)));

  return {
    minLat: centre.latitude - latDelta,
    maxLat: centre.latitude + latDelta,
    minLon: centre.longitude - lonDelta,
    maxLon: centre.longitude + lonDelta,
  };
}

/** Whether a point falls inside the circle, not merely inside its bounding box. */
export function withinRadius(centre: LatLon, point: LatLon, radiusMiles: number): boolean {
  return haversineMiles(centre, point) <= radiusMiles;
}
