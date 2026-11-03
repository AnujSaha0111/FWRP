import { useQuery } from '@tanstack/react-query';
import { CircleCheck, Clock, Package, PackagePlus, Percent } from 'lucide-react';
import { Link } from 'react-router';
import { analyticsApi } from '@/api/endpoints';
import type { ProviderDashboard as Dashboard, QuantityByUnit } from '@/api/types';
import { useProfile } from '@/auth/AuthProvider';
import { DonationStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardBody, CardHeader, EmptyState, PageHeader, Skeleton, Stat } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { formatQuantity, formatRelative } from '@/lib/format';

function Quantities({ items, empty }: { items: QuantityByUnit[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2">
      {items.map((q) => (
        <li key={q.unit} className="tabular font-mono text-xl font-semibold">
          {formatQuantity(q.quantity, q.unit)}
        </li>
      ))}
    </ul>
  );
}

export function ProviderDashboard() {
  const { user } = useProfile();
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: () => analyticsApi.dashboard<Dashboard>() });

  return (
    <>
      <PageHeader
        title={`Hello, ${user.name.split(' ')[0]}`}
        description="Your donations at a glance."
        action={
          <Button asChild>
            <Link to="/provider/donations/new">
              <PackagePlus aria-hidden="true" /> New donation
            </Link>
          </Button>
        }
      />

      {dashboard.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : dashboard.isError ? (
        <Alert tone="danger">{errorMessage(dashboard.error)}</Alert>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Active donations" value={dashboard.data.activeDonations} icon={<Package />} hint="Listed or on their way" />
            <Stat label="Completed" value={dashboard.data.completedDonations} icon={<CircleCheck />} hint="Received by a recipient" />
            <Stat label="Expired" value={dashboard.data.expiredDonations} icon={<Clock />} hint="Not claimed in time" />
            <Stat
              label="Fulfillment rate"
              value={dashboard.data.fulfillmentRate === null ? '—' : `${dashboard.data.fulfillmentRate}%`}
              icon={<Percent />}
              hint="Completed of all listed"
            />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <Card>
              <CardHeader title="Your impact" description="Food that reached people through FWRP." />
              <CardBody className="flex flex-col gap-5">
                <div>
                  <p className="mb-2 text-sm text-muted-foreground">Redistributed (confirmed by recipients)</p>
                  <Quantities items={dashboard.data.quantityRedistributed} empty="Nothing delivered yet." />
                </div>
                <div>
                  <p className="mb-2 text-sm text-muted-foreground">Listed in total</p>
                  <Quantities items={dashboard.data.quantityDonated} empty="No donations listed yet." />
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Recent activity"
                action={
                  <Link to="/provider/donations" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
                    All donations
                  </Link>
                }
              />
              {dashboard.data.recentActivity.length === 0 ? (
                <EmptyState
                  icon={<Package />}
                  title="No donations yet"
                  action={
                    <Button asChild variant="secondary">
                      <Link to="/provider/donations/new">List your first donation</Link>
                    </Button>
                  }
                >
                  List surplus food and nearby recipients are matched automatically.
                </EmptyState>
              ) : (
                <ul className="divide-y divide-border">
                  {dashboard.data.recentActivity.map((a) => (
                    <li key={a.donationId}>
                      <Link
                        to={`/provider/donations/${a.donationId}`}
                        className="flex min-h-14 items-center justify-between gap-3 px-5 py-3 transition-colors duration-200 hover:bg-muted"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{a.foodName}</span>
                          <span className="text-sm text-muted-foreground">Updated {formatRelative(a.updatedAt)}</span>
                        </span>
                        <DonationStatusBadge status={a.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
