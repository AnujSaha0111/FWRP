import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Leaflet cannot render in jsdom; tests use a plain stand-in for the map picker.
vi.mock('@/components/map/LocationPicker', () => ({
  LocationPicker: ({ onChange, error }: { onChange: (v: { latitude: number; longitude: number }) => void; error?: string }) => (
    <div>
      <button type="button" onClick={() => onChange({ latitude: 12.97, longitude: 77.59 })}>
        Set test location
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});
