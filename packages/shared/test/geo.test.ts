import { describe, expect, it } from 'vitest';

import { haversineMiles, radiusBoundingBox, withinRadius, type LatLon } from '../src/geo';

const WEST_CHESTER: LatLon = { latitude: 39.9601, longitude: -75.6055 };
const PHILADELPHIA: LatLon = { latitude: 39.9526, longitude: -75.1652 };

describe('haversineMiles', () => {
  it('returns zero for a point against itself', () => {
    expect(haversineMiles(WEST_CHESTER, WEST_CHESTER)).toBe(0);
  });

  it('measures a known distance', () => {
    // West Chester to central Philadelphia is roughly 23 miles.
    expect(haversineMiles(WEST_CHESTER, PHILADELPHIA)).toBeCloseTo(23.4, 0);
  });

  it('is symmetric', () => {
    expect(haversineMiles(WEST_CHESTER, PHILADELPHIA)).toBeCloseTo(
      haversineMiles(PHILADELPHIA, WEST_CHESTER),
      10,
    );
  });
});

describe('radiusBoundingBox', () => {
  it('fully contains the circle it approximates', () => {
    const radius = 5;
    const box = radiusBoundingBox(WEST_CHESTER, radius);

    // Every compass point at exactly the radius must fall inside the box, or the bbox prefilter
    // would discard rows the haversine pass was supposed to judge.
    const north = { latitude: WEST_CHESTER.latitude + radius / 69.0, longitude: WEST_CHESTER.longitude };
    const east = {
      latitude: WEST_CHESTER.latitude,
      longitude:
        WEST_CHESTER.longitude + radius / (69.0 * Math.cos((WEST_CHESTER.latitude * Math.PI) / 180)),
    };

    expect(north.latitude).toBeLessThanOrEqual(box.maxLat);
    expect(east.longitude).toBeLessThanOrEqual(box.maxLon);
    expect(box.minLat).toBeLessThan(WEST_CHESTER.latitude);
    expect(box.minLon).toBeLessThan(WEST_CHESTER.longitude);
  });

  it('widens longitude more than latitude at this latitude', () => {
    const box = radiusBoundingBox(WEST_CHESTER, 5);
    const latSpan = box.maxLat - box.minLat;
    const lonSpan = box.maxLon - box.minLon;

    // A degree of longitude is shorter than a degree of latitude away from the equator, so the
    // box has to span more of them to cover the same distance.
    expect(lonSpan).toBeGreaterThan(latSpan);
  });

  it('does not divide by zero at the pole', () => {
    const box = radiusBoundingBox({ latitude: 90, longitude: 0 }, 5);
    expect(Number.isFinite(box.minLon)).toBe(true);
    expect(Number.isFinite(box.maxLon)).toBe(true);
  });
});

describe('withinRadius', () => {
  it('excludes a point outside the circle that is inside the bounding box', () => {
    // The corner of a bounding box is further from the centre than its edge — this is precisely
    // the case the haversine pass exists to reject.
    const box = radiusBoundingBox(WEST_CHESTER, 5);
    const corner: LatLon = { latitude: box.maxLat, longitude: box.maxLon };

    expect(withinRadius(WEST_CHESTER, corner, 5)).toBe(false);
    expect(haversineMiles(WEST_CHESTER, corner)).toBeGreaterThan(5);
  });

  it('includes a point comfortably inside', () => {
    expect(withinRadius(WEST_CHESTER, { latitude: 39.97, longitude: -75.61 }, 5)).toBe(true);
  });
});
