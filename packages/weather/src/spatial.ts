/** Great-circle distance for station-to-site comparisons. */

/**
 * Great-circle distance between two points, in kilometres.
 *
 * The Haversine formula. All arguments are decimal degrees. Accuracy is within
 * ~0.5%, which is far more than station-to-site ranking needs. `a` is clamped
 * to 1 before the `asin`, so floating-point drift on near-antipodal points
 * can't push it out of domain.
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const lat1r = lat1 * toRad;
  const lat2r = lat2 * toRad;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1r) * Math.cos(lat2r) * Math.sin(dLon / 2) ** 2;
  return 6371.0 * 2.0 * Math.asin(Math.sqrt(Math.min(1.0, a)));
}
