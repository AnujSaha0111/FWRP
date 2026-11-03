import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Building2, CircleCheck, Clock, Flag, Package, RefreshCw, Truck, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { adminApi } from '@/api/roles';
import type { ImpactKpis, MonitoringDelivery } from '@/api/types';
import { DeliveryStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardHeader, EmptyState, PageHeader, Skeleton, Stat } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { formatDateTime, formatQuantity, formatRelative } from '@/lib/format';

function minutes(value: number | null): string {
  if (value === null) return '—';
  if (value < 90) return `${Math.round(value)} min`;
  return `${(value / 60).toFixed(1)} h`;
}

export function KpiGrid({ kpis }: { kpis: ImpactKpis }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Meals redistributed" value={kpis.mealsRedistributed} hint={kpis.weightRedistributedKg > 0 ? `+ ${kpis.weightRedistributedKg} kg of food` : undefined} />
      <Stat label="Fulfillment rate" value={kpis.fulfillmentRate === null ? '—' : `${kpis.fulfillmentRate}%`} hint={`${kpis.completedDonations} of ${kpis.validDonations} valid donations`} />
      <Stat label="Expiry rate" value={kpis.expiryRate === null ? '—' : `${kpis.expiryRate}%`} hint={`${kpis.expiredDonations} expired`} />
      <Stat label="Avg. matching time" value={minutes(kpis.averageMatchingMinutes)} hint="Listing → acceptance" />
      <Stat label="Avg. pickup time" value={minutes(kpis.averagePickupMinutes)} hint="Assignment → pickup" />
      <Stat label="Avg. delivery time" value={minutes(kpis.averageDeliveryMinutes)} hint="Pickup → confirmation" />
      <Card className="p-5 sm:col-span-2">
        <p className="text-sm text-muted-foreground">Food redistributed by unit</p>
        {kpis.redistributed.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nothing confirmed yet.</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
            {kpis.redistributed.map((q) => (
              <li key={q.unit} className="tabular font-mono text-xl font-semibold">
                {formatQuantity(q.quantity, q.unit)}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Tile({ to, label, value, icon, attention }: { to: string; label: string; value: number; icon: ReactNode; attention?: boolean }) {
  return (
    <Link to={to} className="rounded-card transition-colors duration-200 hover:[&>section]:border-primary">
      <Stat label={label} value={<span className={attention && value > 0 ? 'text-accent' : undefined}>{value}</span>} icon={icon} />
    </Link>
  );
}

export function AdminDashboard() {
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: adminApi.dashboard });
  const monitoring = useQuery({ queryKey: ['monitoring'], queryFn: adminApi.monitoring });

  return (
    <>
      <PageHeader title="Platform overview" description="Live operations and the impact of the platform." />
      {dashboard.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : dashboard.isError ? (
        <Alert tone="danger">{errorMessage(dashboard.error)}</Alert>
      ) : (
        <>
          <h2 className="sr-only">Operations</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Tile to="/admin/pickups" label="Pending pickups" value={dashboard.data.pendingPickups} icon={<Clock />} attention />
            <Tile to="/admin/monitoring" label="Active deliveries" value={dashboard.data.activeDeliveries} icon={<Truck />} />
            <Tile to="/admin/reports" label="Active donations" value={dashboard.data.activeDonations} icon={<Package />} />
            <Tile to="/admin/reports" label="Completed donations" value={dashboard.data.completedDonations} icon={<CircleCheck />} />
            <Tile to="/admin/reports" label="Expired donations" value={dashboard.data.expiredDonations} icon={<AlertTriangle />} />
            <Tile to="/admin/organizations" label="Verified organizations" value={dashboard.data.verifiedOrganizations} icon={<Building2 />} />
            <Tile to="/admin/users" label="Active volunteers" value={dashboard.data.activeVolunteers} icon={<Users />} />
            <Tile to="/admin/incidents" label="Open reports" value={monitoring.data?.openIncidents ?? 0} icon={<Flag />} attention />
          </div>
          <h2 className="mb-3 mt-8 text-lg font-semibold">Impact (all time)</h2>
          <KpiGrid kpis={dashboard.data.kpis} />
        </>
      )}
      {monitoring.data && monitoring.data.pendingVerifications > 0 && (
        <Alert tone="info" className="mt-6" title={`${monitoring.data.pendingVerifications} organization(s) waiting for verification`}>
          <Link to="/admin/organizations" className="font-medium underline">
            Review them
          </Link>
        </Alert>
      )}
    </>
  );
}

function DeliveryRows({ rows, empty }: { rows: MonitoringDelivery[]; empty: string }) {
  if (rows.length === 0) return <p className="px-5 py-4 text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {rows.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="min-w-0">
            <p className="font-medium">{d.donation.foodName}</p>
            <p className="text-sm text-muted-foreground">
              {d.volunteer.name} ({d.volunteer.phone}) · pick up by {formatDateTime(d.donation.availableUntil)}
              {d.pickupTime && ` · picked up ${formatRelative(d.pickupTime)}`}
            </p>
          </div>
          <DeliveryStatusBadge status={d.status} />
        </li>
      ))}
    </ul>
  );
}

export function MonitoringPage() {
  const monitoring = useQuery({ queryKey: ['monitoring'], queryFn: adminApi.monitoring, refetchInterval: 60_000 });
  return (
    <>
      <PageHeader
        title="Monitoring"
        description={monitoring.data ? `Updated ${formatRelative(monitoring.data.generatedAt)} · refreshes every minute` : 'Live donations and deliveries'}
        action={
          <Button variant="secondary" onClick={() => monitoring.refetch()} loading={monitoring.isFetching}>
            {!monitoring.isFetching && <RefreshCw aria-hidden="true" />} Refresh
          </Button>
        }
      />
      {monitoring.isPending ? (
        <Skeleton className="h-96" />
      ) : monitoring.isError ? (
        <Alert tone="danger">{errorMessage(monitoring.error)}</Alert>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className={monitoring.data.delayedDeliveries.length ? 'border-destructive/40' : undefined}>
            <CardHeader title="Delayed or missed" description="Pickups past their window, or on the road too long." />
            <DeliveryRows rows={monitoring.data.delayedDeliveries} empty="Nothing delayed." />
          </Card>
          <Card>
            <CardHeader
              title="Waiting for a volunteer"
              action={
                <Link to="/admin/pickups" className="text-sm font-medium text-primary hover:underline">
                  Assign
                </Link>
              }
            />
            {monitoring.data.awaitingVolunteer.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted-foreground">Every accepted donation has a volunteer.</p>
            ) : (
              <ul className="divide-y divide-border">
                {monitoring.data.awaitingVolunteer.map((d) => (
                  <li key={d.id} className="flex justify-between gap-3 px-5 py-3">
                    <span className="font-medium">{d.foodName}</span>
                    <span className="text-sm text-muted-foreground">expires {formatRelative(d.availableUntil)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Expiring soon, unclaimed" description="Listed donations nobody has accepted yet." />
            {monitoring.data.expiringUnclaimed.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted-foreground">Nothing about to expire.</p>
            ) : (
              <ul className="divide-y divide-border">
                {monitoring.data.expiringUnclaimed.map((d) => (
                  <li key={d.id} className="flex justify-between gap-3 px-5 py-3">
                    <span>
                      <span className="font-medium">{d.foodName}</span>{' '}
                      <span className="tabular text-sm text-muted-foreground">{formatQuantity(d.quantity, d.unit)}</span>
                    </span>
                    <span className="text-sm font-medium text-accent">{formatRelative(d.availableUntil)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Active deliveries" />
            {monitoring.data.activeDeliveries.length === 0 ? (
              <EmptyState icon={<Truck />} title="No deliveries on the road" />
            ) : (
              <DeliveryRows rows={monitoring.data.activeDeliveries} empty="" />
            )}
          </Card>
        </div>
      )}
    </>
  );
}
