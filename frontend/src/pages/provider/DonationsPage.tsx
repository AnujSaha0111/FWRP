import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Package, PackagePlus } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { donationsApi } from '@/api/endpoints';
import type { DonationHistoryItem, DonationStatus } from '@/api/types';
import { ACTIVE_DONATION, DonationStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Alert, Card, EmptyState, PageHeader, Skeleton } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { formatDateTime, formatQuantity, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

const TABS: Array<{ key: string; label: string; statuses: readonly DonationStatus[] | null }> = [
  { key: 'active', label: 'Active', statuses: ACTIVE_DONATION },
  { key: 'completed', label: 'Completed', statuses: ['COMPLETED'] },
  { key: 'ended', label: 'Expired & cancelled', statuses: ['EXPIRED', 'CANCELLED'] },
  { key: 'all', label: 'All', statuses: null },
];

function WindowText({ d }: { d: DonationHistoryItem }) {
  const until = new Date(d.availableUntil);
  const live = ACTIVE_DONATION.includes(d.status) && until.getTime() > Date.now();
  return (
    <span className={cn(live && until.getTime() - Date.now() < 2 * 3600_000 && 'font-medium text-accent')}>
      {live ? `Pickup by ${formatDateTime(d.availableUntil)} (${formatRelative(d.availableUntil)})` : `Window ended ${formatDateTime(d.availableUntil)}`}
    </span>
  );
}

export function DonationsPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.key === params.get('tab')) ?? TABS[0];
  const history = useQuery({ queryKey: ['donations', 'mine'], queryFn: () => donationsApi.history() });

  const counts = useMemo(() => {
    const items = history.data?.items ?? [];
    return Object.fromEntries(TABS.map((t) => [t.key, t.statuses ? items.filter((d) => t.statuses!.includes(d.status)).length : items.length]));
  }, [history.data]);
  const rows = (history.data?.items ?? []).filter((d) => !tab.statuses || tab.statuses.includes(d.status));

  return (
    <>
      <PageHeader
        title="My donations"
        action={
          <Button asChild>
            <Link to="/provider/donations/new">
              <PackagePlus aria-hidden="true" /> New donation
            </Link>
          </Button>
        }
      />

      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Donation status">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={t.key === tab.key}
            onClick={() => setParams({ tab: t.key }, { replace: true })}
            className={cn(
              '-mb-px flex min-h-11 cursor-pointer items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors duration-200',
              t.key === tab.key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
            {history.data && <span className="tabular rounded-full bg-muted px-2 text-xs text-muted-foreground">{counts[t.key]}</span>}
          </button>
        ))}
      </div>

      <Card role="tabpanel" aria-label={tab.label}>
        {history.isPending ? (
          <div className="flex flex-col gap-3 p-5">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : history.isError ? (
          <div className="p-5">
            <Alert tone="danger">{errorMessage(history.error)}</Alert>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Package />}
            title={tab.key === 'active' ? 'No active donations' : 'Nothing here yet'}
            action={
              tab.key === 'active' && (
                <Button asChild variant="secondary">
                  <Link to="/provider/donations/new">List surplus food</Link>
                </Button>
              )
            }
          >
            {tab.key === 'active' ? 'When you list food, it appears here until it is delivered.' : undefined}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((d) => (
              <li key={d.id}>
                <Link
                  to={`/provider/donations/${d.id}`}
                  className="flex min-h-16 items-center gap-4 px-5 py-3 transition-colors duration-200 hover:bg-muted"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-medium">{d.foodName}</span>
                      <DonationStatusBadge status={d.status} />
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      <span className="tabular">{formatQuantity(d.quantity, d.unit)}</span> · {d.category} · <WindowText d={d} />
                    </p>
                  </div>
                  <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {history.data && history.data.total > history.data.items.length && (
        <p className="mt-3 text-sm text-muted-foreground">Showing your latest {history.data.items.length} donations.</p>
      )}
    </>
  );
}
