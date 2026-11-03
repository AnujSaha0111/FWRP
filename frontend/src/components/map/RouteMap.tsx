import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from 'react-leaflet';

export interface MapPoint {
  latitude: number | null;
  longitude: number | null;
  label: string;
}

/**
 * Pickup → drop-off overview. Points without coordinates are skipped; the
 * addresses are always shown in text next to the map, so the map is a visual
 * aid, not the only source of the information.
 */
export function RouteMap({ pickup, dropoff, height = 240 }: { pickup: MapPoint; dropoff: MapPoint; height?: number }) {
  // Pickup amber, drop-off green, regardless of which points have coordinates.
  const points = [
    { ...pickup, color: '#b45309' },
    { ...dropoff, color: '#047857' },
  ].filter((p): p is MapPoint & { latitude: number; longitude: number; color: string } => p.latitude !== null && p.longitude !== null);
  if (points.length === 0) return null;
  const bounds = points.map((p) => [p.latitude, p.longitude] as [number, number]);

  return (
    <div className="overflow-hidden rounded-lg border border-border" style={{ height }} aria-hidden="true">
      <MapContainer
        bounds={bounds.length > 1 ? bounds : undefined}
        center={bounds.length === 1 ? bounds[0] : undefined}
        zoom={bounds.length === 1 ? 14 : undefined}
        boundsOptions={{ padding: [32, 32] }}
        scrollWheelZoom={false}
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {bounds.length > 1 && <Polyline positions={bounds} pathOptions={{ color: '#475569', weight: 3, dashArray: '6 8' }} />}
        {points.map((p) => (
          <CircleMarker
            key={p.label}
            center={[p.latitude, p.longitude]}
            radius={9}
            pathOptions={{ color: '#ffffff', weight: 3, fillColor: p.color, fillOpacity: 1 }}
          >
            <Tooltip permanent direction="top" offset={[0, -10]}>
              {p.label}
            </Tooltip>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
