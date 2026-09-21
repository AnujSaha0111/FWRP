import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calculateDistanceKm,
  haversineBatch,
  haversineDistance,
  validateLatitude,
  validateLongitude,
  validateCoordinates,
} from '../utils/distance';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');
function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.join(backendDir, ...parts), 'utf8');
}

describe('distance utils — BE-09 Haversine', () => {
  it('same location = 0km', () => {
    expect(haversineDistance({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 })).toBeCloseTo(0, 5);
  });

  it('known distance: NYC to London ~5570km', () => {
    const nyc = { latitude: 40.7128, longitude: -74.006 };
    const london = { latitude: 51.5074, longitude: -0.1278 };
    const dist = haversineDistance(nyc, london);
    expect(dist).toBeGreaterThan(5500);
    expect(dist).toBeLessThan(5700);
  });

  it('Delhi to Mumbai ~1150km', () => {
    const delhi = { latitude: 28.6139, longitude: 77.209 };
    const mumbai = { latitude: 19.076, longitude: 72.8777 };
    const dist = haversineDistance(delhi, mumbai);
    expect(dist).toBeGreaterThan(1100);
    expect(dist).toBeLessThan(1200);
  });

  it('antipodal points ~20015km', () => {
    const dist = haversineDistance({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 });
    expect(dist).toBeCloseTo(20015, -2);
  });

  it('invalid latitude rejected', () => {
    expect(validateLatitude(91)).toBe(false);
    expect(validateLatitude(-91)).toBe(false);
    expect(validateLatitude(45)).toBe(true);
  });

  it('invalid longitude rejected', () => {
    expect(validateLongitude(181)).toBe(false);
    expect(validateLongitude(-181)).toBe(false);
    expect(validateLongitude(0)).toBe(true);
  });

  it('validateCoordinates returns error for bad lat', () => {
    expect(validateCoordinates(91, 0).valid).toBe(false);
    expect(validateCoordinates(0, 200).valid).toBe(false);
    expect(validateCoordinates(45, 90).valid).toBe(true);
  });

  it('distance handles 90 and -90 latitude boundaries', () => {
    const d = haversineDistance({ latitude: 90, longitude: 0 }, { latitude: -90, longitude: 0 });
    expect(d).toBeCloseTo(20015, -2);
  });
});

// MATCH-03 — null-safe distance boundary for matching inputs. Distance
// calculation ONLY: no scoring/normalization (`distanceScore`), no geocoding,
// no map API, no database, no mutation.
const NYC = { latitude: 40.7128, longitude: -74.006 };
const LONDON = { latitude: 51.5074, longitude: -0.1278 };

describe('distance utils — MATCH-03 null-safe boundary', () => {
  it('identical coordinates return 0 km', () => {
    expect(calculateDistanceKm(NYC, { ...NYC })).toBe(0);
  });

  it('known city pair NYC–London ≈ 5570 km (tolerance ±25 km)', () => {
    // Well-established great-circle distance (~5570.23 km). The ±25 km
    // (~0.45%) tolerance accommodates reasonable Earth-radius choices.
    const d = calculateDistanceKm(NYC, LONDON)!;
    expect(d).toBeGreaterThan(5545);
    expect(d).toBeLessThan(5595);
  });

  it('is symmetric', () => {
    expect(calculateDistanceKm(NYC, LONDON)).toBe(calculateDistanceKm(LONDON, NYC));
  });

  it('ordinary valid coordinates produce positive finite kilometers', () => {
    const d = calculateDistanceKm(NYC, LONDON);
    expect(Number.isFinite(d)).toBe(true);
    expect(d!).toBeGreaterThan(0);
  });

  it('accepts latitude boundary values', () => {
    expect(
      calculateDistanceKm({ latitude: 90, longitude: 0 }, { latitude: -90, longitude: 0 })
    ).toBeCloseTo(20015.11, -2);
    expect(
      calculateDistanceKm({ latitude: -90, longitude: 0 }, { latitude: 0, longitude: 0 })
    ).toBeCloseTo(10007.56, -2);
  });

  it('accepts longitude boundary values', () => {
    expect(
      calculateDistanceKm({ latitude: 0, longitude: 180 }, { latitude: 0, longitude: 0 })
    ).toBeCloseTo(20015.11, -2);
    expect(
      calculateDistanceKm({ latitude: 0, longitude: -180 }, { latitude: 0, longitude: 0 })
    ).toBeCloseTo(20015.11, -2);
  });

  it('returns null for invalid latitude', () => {
    for (const latitude of [90.0001, -90.0001, 91, -91, 1000]) {
      expect(calculateDistanceKm({ latitude, longitude: 0 }, NYC)).toBeNull();
    }
  });

  it('returns null for invalid longitude', () => {
    for (const longitude of [180.0001, -180.0001, 181, -181, 1000]) {
      expect(calculateDistanceKm({ latitude: 0, longitude }, NYC)).toBeNull();
    }
  });

  it('returns null for NaN coordinates', () => {
    expect(calculateDistanceKm({ latitude: NaN, longitude: 0 }, NYC)).toBeNull();
    expect(calculateDistanceKm({ latitude: 0, longitude: NaN }, NYC)).toBeNull();
    expect(calculateDistanceKm(NYC, { latitude: NaN, longitude: NaN })).toBeNull();
  });

  it('returns null for Infinity / -Infinity coordinates', () => {
    expect(calculateDistanceKm({ latitude: Infinity, longitude: 0 }, NYC)).toBeNull();
    expect(calculateDistanceKm({ latitude: -Infinity, longitude: 0 }, NYC)).toBeNull();
    expect(calculateDistanceKm({ latitude: 0, longitude: Infinity }, NYC)).toBeNull();
    expect(calculateDistanceKm(NYC, { latitude: 0, longitude: -Infinity })).toBeNull();
  });

  it('returns null for missing/null/undefined coordinates or points', () => {
    expect(calculateDistanceKm({ latitude: null, longitude: null }, NYC)).toBeNull();
    expect(calculateDistanceKm({ latitude: undefined, longitude: undefined }, NYC)).toBeNull();
    expect(calculateDistanceKm({ latitude: 40, longitude: null }, NYC)).toBeNull();
    expect(calculateDistanceKm(null, NYC)).toBeNull();
    expect(calculateDistanceKm(NYC, undefined)).toBeNull();
  });

  it('does not mutate its inputs', () => {
    const from = { ...NYC };
    const to = { ...LONDON };
    const fromSnapshot = { ...from };
    const toSnapshot = { ...to };
    calculateDistanceKm(from, to);
    expect(from).toEqual(fromSnapshot);
    expect(to).toEqual(toSnapshot);
  });

  it('is deterministic across repeated calculations', () => {
    expect(calculateDistanceKm(NYC, LONDON)).toBe(calculateDistanceKm(NYC, LONDON));
  });
});

describe('MATCH-03 scope guards (distance calculation only)', () => {
  const src = readRepoFile('src', 'utils', 'distance.ts');
  // Assess executable code, not the explanatory doc comments.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('has no database/Prisma access', () => {
    expect(code).not.toMatch(
      /prisma|getPrisma|\$transaction|\.findUnique\(|\.findMany\(|\.create\(|\.update\(|\.delete\(/i
    );
  });

  it('has no network/map/geocoding calls', () => {
    expect(code).not.toMatch(
      /fetch\(|axios|XMLHttpRequest|navigator|geocod|nominatim|mapbox|google.?maps|postgis|ST_DWithin/i
    );
  });

  it('has no scoring, normalization, weights, or matching_config', () => {
    expect(code).not.toMatch(
      /distanceScore|quantityScore|foodScore|timeScore|priorityScore|matchingScore|weightedSum|MAX_DISTANCE|matching_config/i
    );
    expect(code).not.toMatch(/\bclamp\b|score\s*\(/i);
  });

  it('has no Match/Allocation/route/API wiring', () => {
    expect(code).not.toMatch(/\bMatch\b|\ballocation\b|express|router|controller/i);
  });

  it('has no status/quantity mutation, transportation, or AI/ML', () => {
    expect(code).not.toMatch(/status\s*:\s*['"]|quantityFulfilled\s*[:=]|transition/i);
    expect(code).not.toMatch(/transport|volunteer|tensorflow|openai/i);
  });
});

// MATCH-04 — dedicated distance correctness / edge-case verification:
// same location, antipodal, invalid coordinates, cardinal movement, longitude
// wrap, and the checklist's < 50ms / 100-pair performance requirement.
describe('MATCH-04 distance correctness & edge cases', () => {
  it('same location returns exactly 0 km', () => {
    expect(calculateDistanceKm(NYC, { ...NYC })).toBe(0);
    expect(haversineDistance(NYC, { ...NYC })).toBe(0);
  });

  it('antipodal points ≈ half Earth circumference (20015.11 km)', () => {
    // NYC (40.7128, -74.006) antipode = (-40.7128, 105.994), in-range.
    const nycAntipode = { latitude: -40.7128, longitude: 105.994 };
    expect(calculateDistanceKm(NYC, nycAntipode)).toBeCloseTo(20015.11, -2);
    expect(
      calculateDistanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 })
    ).toBeCloseTo(20015.11, -2);
  });

  it('north/south movement: 1° of latitude ≈ 111.2 km', () => {
    const north = calculateDistanceKm({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })!;
    const south = calculateDistanceKm({ latitude: -1, longitude: 0 }, { latitude: 0, longitude: 0 })!;
    for (const d of [north, south]) {
      expect(d).toBeGreaterThan(111.0);
      expect(d).toBeLessThan(111.4);
    }
  });

  it('east/west movement scales with latitude (1° longitude)', () => {
    const equator = calculateDistanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })!;
    const at60 = calculateDistanceKm({ latitude: 60, longitude: 0 }, { latitude: 60, longitude: 1 })!;
    expect(equator).toBeGreaterThan(111.0);
    expect(equator).toBeLessThan(111.4);
    // cos(60°) = 0.5 => ~55.6 km.
    expect(at60).toBeGreaterThan(55.4);
    expect(at60).toBeLessThan(55.8);
    expect(equator).toBeGreaterThan(at60 * 1.9);
  });

  it('handles antimeridian / longitude wrap (179° ↔ -179° = 2°)', () => {
    const acrossWrap = calculateDistanceKm(
      { latitude: 0, longitude: 179 },
      { latitude: 0, longitude: -179 }
    )!;
    const noWrap = calculateDistanceKm(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 2 }
    )!;
    expect(acrossWrap).toBeCloseTo(noWrap, 6);
    expect(acrossWrap).toBeGreaterThan(222.0);
    expect(acrossWrap).toBeLessThan(222.8);
  });

  it('computes 100 pairs in well under 50ms', () => {
    const origin = { latitude: 40.7128, longitude: -74.006 };
    const destinations = Array.from({ length: 100 }, (_, i) => ({
      latitude: -60 + i * 1.2,
      longitude: -170 + i * 1.2,
    }));
    const start = performance.now();
    const results = haversineBatch(origin, destinations);
    const elapsedMs = performance.now() - start;
    expect(results).toHaveLength(100);
    expect(results.every((d) => Number.isFinite(d) && d >= 0)).toBe(true);
    expect(elapsedMs).toBeLessThan(50);
  });
});
