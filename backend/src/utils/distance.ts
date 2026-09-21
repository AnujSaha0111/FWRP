const EARTH_RADIUS_KM = 6371.0088;

export function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

export function validateLatitude(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

export function validateLongitude(lng: number): boolean {
  return Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

export function validateCoordinates(lat: number, lng: number): { valid: boolean; error?: string } {
  if (!validateLatitude(lat)) return { valid: false, error: `latitude ${lat} must be between -90 and 90` };
  if (!validateLongitude(lng)) return { valid: false, error: `longitude ${lng} must be between -180 and 180` };
  return { valid: true };
}

export interface GeoCoordinates {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
}

export function haversineDistance(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number }
): number {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLng = toRadians(to.longitude - from.longitude);

  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

export function calculateDistanceKm(
  from: GeoCoordinates | null | undefined,
  to: GeoCoordinates | null | undefined
): number | null {
  if (!from || !to) return null;
  const fromLat = from.latitude;
  const fromLng = from.longitude;
  const toLat = to.latitude;
  const toLng = to.longitude;
  if (
    typeof fromLat !== 'number' ||
    typeof fromLng !== 'number' ||
    typeof toLat !== 'number' ||
    typeof toLng !== 'number'
  ) {
    return null;
  }
  if (
    !validateLatitude(fromLat) ||
    !validateLongitude(fromLng) ||
    !validateLatitude(toLat) ||
    !validateLongitude(toLng)
  ) {
    return null;
  }
  const distanceKm = haversineDistance(
    { latitude: fromLat, longitude: fromLng },
    { latitude: toLat, longitude: toLng }
  );
  return Number.isFinite(distanceKm) ? distanceKm : null;
}

/**
 * Batch helper — returns distance for each pair.
 */
export function haversineBatch(
  origin: { latitude: number; longitude: number },
  destinations: Array<{ latitude: number; longitude: number }>
): number[] {
  return destinations.map((d) => haversineDistance(origin, d));
}
