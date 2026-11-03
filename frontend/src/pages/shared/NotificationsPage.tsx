import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { notificationsApi } from '@/api/endpoints';
import type { AppNotification, Role } from '@/api/types';
import { useProfile } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { Alert, Card, EmptyState, PageHeader, Skeleton } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { formatRelative, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Where a notification should take its reader (only screens that exist). */
export function notificationLink(n: AppNotification, role: Role): string | null {
  if (!n.entityId) return null;
  switch (n.entityType) {
    case 'Donation':
      if (role === 'PROVIDER') return `/provider/donations/${n.entityId}`;
      if (role === 'ADMIN') return '/admin/pickups';
      return null;
    case 'Delivery':
      if (role === 'VOLUNTEER') return `/volunteer/deliveries/${n.entityId}`;
      if (role === 'RECIPIENT') return `/recipient/deliveries/${n.entityId}`;
      if (role === 'ADMIN') return '/admin/monitoring';
      return null;
    case 'Match':
      return role === 'RECIPIENT' ? '/recipient/matches' : null;
    case 'Requirement':
      return role === 'RECIPIENT' ? '/recipient/requirements' : null;
    case 'Incident':
      return role === 'ADMIN' ? '/admin/incidents' : '/reports';
    case 'Organization':
      return '/profile';
    default:
      return null;
  }
}

export function NotificationsPage() {
  const { user } = useProfile();
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);

  const list = useQuery({
    queryKey: ['notifications', 'list', { unreadOnly, page }],
    queryFn: () => notificationsApi.list(page, unreadOnly),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
  const markRead = useMutation({ mutationFn: notificationsApi.markRead, onSuccess: invalidate });
  const markAll = useMutation({ mutationFn: notificationsApi.markAllRead, onSuccess: invalidate });

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Updates about your donations, deliveries and reports."
        action={
          <Button variant="secondary" onClick={() => markAll.mutate()} loading={markAll.isPending}>
            {!markAll.isPending && <CheckCheck aria-hidden="true" />}
            Mark all as read
          </Button>
        }
      />

      <div className="mb-4 inline-flex rounded-lg border border-border bg-card p-1" role="group" aria-label="Filter notifications">
        {[
          { value: false, label: 'All' },
          { value: true, label: 'Unread' },
        ].map((f) => (
          <button
            key={f.label}
            type="button"
            aria-pressed={unreadOnly === f.value}
            onClick={() => {
              setUnreadOnly(f.value);
              setPage(1);
            }}
            className={cn(
              'min-h-9 cursor-pointer rounded-md px-4 text-sm font-medium transition-colors duration-200',
              unreadOnly === f.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <Card>
        {list.isPending ? (
          <ul className="divide-y divide-border">
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="flex flex-col gap-2 px-5 py-4">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-4 w-2/3" />
              </li>
            ))}
          </ul>
        ) : list.isError ? (
          <div className="p-5">
            <Alert tone="danger">{errorMessage(list.error)}</Alert>
          </div>
        ) : list.data.items.length === 0 ? (
          <EmptyState icon={<Bell />} title={unreadOnly ? 'No unread notifications' : 'No notifications yet'}>
            You will be notified when something changes on your donations, deliveries or reports.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {list.data.items.map((n) => {
              const href = notificationLink(n, user.role);
              return (
                <li key={n.id} className={cn('flex gap-3 px-5 py-4', !n.isRead && 'bg-primary-soft/40')}>
                  <span
                    className={cn('mt-2 size-2 shrink-0 rounded-full', n.isRead ? 'bg-transparent' : 'bg-primary')}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <p className={cn('font-medium', !n.isRead && 'text-foreground')}>
                        {!n.isRead && <span className="sr-only">Unread: </span>}
                        {n.title}
                      </p>
                      <time dateTime={n.createdAt} title={formatDateTime(n.createdAt)} className="text-sm text-muted-foreground">
                        {formatRelative(n.createdAt)}
                      </time>
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">{n.message}</p>
                    <div className="mt-2 flex flex-wrap gap-3">
                      {href && (
                        <Link
                          to={href}
                          onClick={() => !n.isRead && markRead.mutate(n.id)}
                          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                        >
                          View
                        </Link>
                      )}
                      {!n.isRead && (
                        <button
                          type="button"
                          onClick={() => markRead.mutate(n.id)}
                          className="cursor-pointer text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                        >
                          Mark as read
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {list.data && list.data.totalPages > 1 && (
        <nav className="mt-4 flex items-center justify-between" aria-label="Pages">
          <Button variant="secondary" size="sm" disabled={!list.data.hasPrev} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft aria-hidden="true" /> Newer
          </Button>
          <span className="tabular text-sm text-muted-foreground">
            Page {list.data.page} of {list.data.totalPages}
          </span>
          <Button variant="secondary" size="sm" disabled={!list.data.hasNext} onClick={() => setPage((p) => p + 1)}>
            Older <ChevronRight aria-hidden="true" />
          </Button>
        </nav>
      )}
    </>
  );
}
