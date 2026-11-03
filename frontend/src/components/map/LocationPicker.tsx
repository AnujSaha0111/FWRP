import { Crosshair, MapPin } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CircleMarker, MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form-controls';

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Bengaluru: the seeded demo city, used until the user picks a point. */
const DEFAULT_CENTER: [number, number] = [12.9716, 77.5946];

function ClickToPick({ onPick }: { onPick: (p: LatLng) => void }) {
  useMapEvents({
    click: (e) => onPick({ latitude: round(e.latlng.lat), longitude: round(e.latlng.lng) }),
  });
  return null;
}

function Recenter({ value }: { value: LatLng | null }) {
  const map = useMap();
  useEffect(() => {
    if (value) map.setView([value.latitude, value.longitude], Math.max(map.getZoom(), 14));
  }, [map, value]);
  return null;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Pick a location by clicking the map, using the device location, or typing
 * coordinates (the keyboard/screen-reader path — the map itself is pointer-only).
 * There is no geocoding service, so the address text is entered separately.
 */
export function LocationPicker({
  value,
  onChange,
  error,
  height = 260,
}: {
  value: LatLng | null;
  onChange: (value: LatLng | null) => void;
  error?: string;
  height?: number;
}) {
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  // While the user types, the fields show their draft (possibly incomplete);
  // otherwise they show the current value. Map clicks clear the draft.
  const [draft, setDraft] = useState<{ lat: string; lng: string } | null>(null);
  const lat = draft?.lat ?? (value ? String(value.latitude) : '');
  const lng = draft?.lng ?? (value ? String(value.longitude) : '');

  function pick(point: LatLng) {
    setDraft(null);
    onChange(point);
  }

  function commitTyped(nextLat: string, nextLng: string) {
    setDraft({ lat: nextLat, lng: nextLng });
    const a = Number(nextLat);
    const b = Number(nextLng);
    const valid = nextLat !== '' && nextLng !== '' && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180;
    onChange(valid ? { latitude: round(a), longitude: round(b) } : null);
  }

  function useMyLocation() {
    if (!('geolocation' in navigator)) {
      setGeoError('Your browser cannot share its location. Click the map instead.');
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        pick({ latitude: round(pos.coords.latitude), longitude: round(pos.coords.longitude) });
      },
      () => {
        setLocating(false);
        setGeoError('Location permission was denied. Click the map to place the pin instead.');
      },
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <MapPin className="size-4" aria-hidden="true" />
          Click the map to place the pin.
        </p>
        <Button type="button" variant="secondary" size="sm" onClick={useMyLocation} loading={locating}>
          {!locating && <Crosshair aria-hidden="true" />}
          Use my location
        </Button>
      </div>
      <div
        className={`overflow-hidden rounded-lg border ${error ? 'border-destructive' : 'border-input'}`}
        style={{ height }}
        aria-label="Map: click to choose the location"
        role="application"
      >
        <MapContainer center={value ? [value.latitude, value.longitude] : DEFAULT_CENTER} zoom={value ? 14 : 12} className="h-full w-full">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ClickToPick onPick={pick} />
          <Recenter value={value} />
          {value && (
            <CircleMarker
              center={[value.latitude, value.longitude]}
              radius={9}
              pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#047857', fillOpacity: 1 }}
            />
          )}
        </MapContainer>
      </div>
      {geoError && <p className="text-sm text-accent">{geoError}</p>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Latitude" error={error}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              inputMode="decimal"
              value={lat}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              onChange={(e) => commitTyped(e.target.value, lng)}
            />
          )}
        </Field>
        <Field label="Longitude">
          {({ id }) => (
            <Input
              id={id}
              inputMode="decimal"
              value={lng}
              onChange={(e) => commitTyped(lat, e.target.value)}
            />
          )}
        </Field>
      </div>
    </div>
  );
}
