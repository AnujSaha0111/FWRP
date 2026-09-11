import { describe, it, expect } from 'vitest';
import { haversineDistance, validateLatitude, validateLongitude, validateCoordinates } from '../utils/distance';

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
