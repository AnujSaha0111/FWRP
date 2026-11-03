import { Check, MapPin, Phone } from 'lucide-react';
import { lazy, Suspense } from 'react';
import type { Delivery } from '@/api/types';
import { Skeleton } from '@/components/ui/surface';
import { formatDateTime, formatQuantity } from '@/lib/format';
import { cn } from '@/lib/utils';

// Leaflet is only downloaded when a delivery is actually shown.
const RouteMap = lazy(() => import('@/components/map/RouteMap').then((m) => ({ default: m.RouteMap })));

function tel(phone: string) {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

function Stop({ kind, title, address, contact, phone }: { kind: 'pickup' | 'dropoff'; title: string; address: string; contact?: string | null; phone?: string }) {
  return (
    <div className="flex gap-3">
      <span className={cn('mt-1 size-3 shrink-0 rounded-full ring-4', kind === 'pickup' ? 'bg-accent ring-accent-soft' : 'bg-primary ring-primary-soft')} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{kind === 'pickup' ? 'Pick up from' : 'Deliver to'}</p>
        <p className="font-medium">{title}</p>
        <p className="flex items-start gap-1 text-sm text-muted-foreground">
          <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> {address}
        </p>
        <div className="mt-1 flex flex-wrap gap-x-4 text-sm">
          {phone && (
            <a href={tel(phone)} className="inline-flex items-center gap-1 text-primary hover:underline">
              <Phone className="size-3.5" aria-hidden="true" /> {phone}
            </a>
          )}
          {contact && <span className="text-muted-foreground">{contact}</span>}
        </div>
      </div>
    </div>
  );
}

const TIMELINE: Array<{ label: string; at: (d: Delivery) => string | null }> = [
  { label: 'Assigned', at: (d) => d.assignedAt },
  { label: 'Picked up', at: (d) => d.pickupTime },
  { label: 'Delivered', at: (d) => d.deliveryTime },
  { label: 'Receipt confirmed', at: (d) => d.confirmedAt },
];

export function DeliverySummary({ delivery, showMap = true }: { delivery: Delivery; showMap?: boolean }) {
  const d = delivery;
  return (
    <div className="flex flex-col gap-5">
      {showMap && (
        <Suspense fallback={<Skeleton className="h-60" />}>
          <RouteMap
            pickup={{ latitude: d.pickup.latitude, longitude: d.pickup.longitude, label: 'Pickup' }}
            dropoff={{ latitude: d.dropoff.latitude, longitude: d.dropoff.longitude, label: 'Drop-off' }}
          />
        </Suspense>
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        <Stop
          kind="pickup"
          title={d.pickup.provider.organization ?? d.pickup.provider.name}
          address={d.pickup.location}
          phone={d.pickup.provider.phone}
          contact={d.pickup.provider.contact}
        />
        <Stop kind="dropoff" title={d.dropoff.organization?.name ?? 'Recipient'} address={d.dropoff.location} contact={d.dropoff.organization?.contact} />
      </div>
      <dl className="grid gap-3 rounded-lg bg-muted/60 p-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Food</dt>
          <dd className="font-medium">{d.donation.foodName}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Quantity</dt>
          <dd className="tabular font-medium">{formatQuantity(d.donation.committedQuantity || d.donation.quantity, d.donation.unit)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Pick up by</dt>
          <dd className="font-medium">{formatDateTime(d.donation.availableUntil)}</dd>
        </div>
        {d.donation.storageRequirement && (
          <div className="sm:col-span-3">
            <dt className="text-muted-foreground">Storage</dt>
            <dd className="font-medium">{d.donation.storageRequirement}</dd>
          </div>
        )}
      </dl>
      <ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label="Delivery timeline">
        {TIMELINE.map((t) => {
          const at = t.at(d);
          return (
            <li key={t.label} className={cn('flex items-center gap-1.5', at ? 'text-foreground' : 'text-muted-foreground')}>
              <Check className={cn('size-4', at ? 'text-primary' : 'opacity-30')} aria-hidden="true" />
              {t.label}
              {at ? <span className="text-muted-foreground">· {formatDateTime(at)}</span> : <span className="sr-only">(not yet)</span>}
            </li>
          );
        })}
      </ol>
      {d.proofOfDelivery && <p className="text-sm text-muted-foreground">Proof of delivery: {d.proofOfDelivery}</p>}
    </div>
  );
}

export const PRIORITY_LABEL = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' } as const;
