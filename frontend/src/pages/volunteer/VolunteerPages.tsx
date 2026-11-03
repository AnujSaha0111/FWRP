import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarClock, CalendarPlus, ChevronRight, CircleCheck, Clock, Trash2, Truck } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { volunteerApi } from '@/api/roles';
import type { Delivery, DeliveryStatus } from '@/api/types';
import { useProfile } from '@/auth/AuthProvider';
import { DeliverySummary } from '@/components/DeliverySummary';
import { DeliveryStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Tabs } from '@/components/ui/extras';
import { Field, Input } from '@/components/ui/form-controls';
import { Alert, Card, CardBody, CardHeader, EmptyState, PageHeader, Skeleton, Stat } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { formatDateTime, formatQuantity, formatRelative, toLocalInput } from '@/lib/format';

const ACTIVE: DeliveryStatus[] = ['ACCEPTED', 'AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT'];

function useMyDeliveries() {
  return useQuery({ queryKey: ['deliveries', 'volunteer'], queryFn: () => volunteerApi.deliveries() });
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['deliveries'] });
  queryClient.invalidateQueries({ queryKey: ['dashboard'] });
}

// ---------------------------------------------------------------- dashboard

export function VolunteerDashboard() {
  const { user } = useProfile();
  const dashboard = useQuery({ queryKey: ['dashboard'], queryFn: volunteerApi.dashboard });
  const deliveries = useMyDeliveries();
  const offers = deliveries.data?.items.filter((d) => d.status === 'ASSIGNED') ?? [];
  const current = deliveries.data?.items.find((d) => ACTIVE.includes(d.status));

  return (
    <>
      <PageHeader title={`Hello, ${user.name.split(' ')[0]}`} description="Thank you for moving food to where it is needed." />
      {offers.length > 0 && (
        <Alert tone="warning" className="mb-6" title={offers.length === 1 ? 'You have a new pickup request' : `You have ${offers.length} new pickup requests`}>
          <Link to={`/volunteer/deliveries/${offers[0].id}`} className="font-medium underline">
            Review and accept
          </Link>
        </Alert>
      )}
      {dashboard.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : dashboard.isError ? (
        <Alert tone="danger">{errorMessage(dashboard.error)}</Alert>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Active deliveries" value={dashboard.data.activeDeliveries} icon={<Truck />} />
          <Stat label="Completed" value={dashboard.data.completedDeliveries} icon={<CircleCheck />} />
          <Stat label="Upcoming availability" value={dashboard.data.upcomingAvailabilityWindows} icon={<CalendarClock />} hint="Time windows you offered" />
          <Stat
            label="Avg. time to pickup"
            value={dashboard.data.averagePickupMinutes === null ? '—' : `${Math.round(dashboard.data.averagePickupMinutes)} min`}
            icon={<Clock />}
          />
        </div>
      )}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Current delivery" />
          <CardBody>
            {current ? (
              <Link to={`/volunteer/deliveries/${current.id}`} className="flex items-center justify-between gap-3 rounded-lg p-1 hover:bg-muted">
                <span className="min-w-0">
                  <span className="block font-medium">{current.donation.foodName}</span>
                  <span className="text-sm text-muted-foreground">
                    {current.pickup.provider.organization ?? current.pickup.location} → {current.dropoff.organization?.name ?? current.dropoff.location}
                  </span>
                </span>
                <DeliveryStatusBadge status={current.status} />
              </Link>
            ) : (
              <p className="text-sm text-muted-foreground">No delivery in progress.</p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Get more pickups" />
          <CardBody className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">Administrators assign pickups to volunteers who are available at the time. Add the hours you can drive.</p>
            <div>
              <Button asChild variant="secondary">
                <Link to="/volunteer/availability">
                  <CalendarPlus aria-hidden="true" /> Set availability
                </Link>
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- availability

export function AvailabilityPage() {
  const queryClient = useQueryClient();
  const windows = useQuery({ queryKey: ['availability'], queryFn: volunteerApi.availability });
  const now = new Date();
  const [from, setFrom] = useState(toLocalInput(now));
  const [until, setUntil] = useState(toLocalInput(new Date(now.getTime() + 4 * 3600_000)));
  const [formError, setFormError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => volunteerApi.addAvailability(new Date(from).toISOString(), new Date(until).toISOString()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['availability'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success('Availability added');
    },
    onError: (err) => setFormError(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: volunteerApi.removeAvailability,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['availability'] });
      toast.success('Availability removed');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const a = new Date(from).getTime();
    const b = new Date(until).getTime();
    if (!from || !until || Number.isNaN(a) || Number.isNaN(b)) return setFormError('Choose both times.');
    if (b <= a) return setFormError('The end must be after the start.');
    if (b <= Date.now()) return setFormError('The end must be in the future.');
    if (b - a > 7 * 24 * 3600_000) return setFormError('A window can be at most 7 days.');
    add.mutate();
  }

  return (
    <>
      <PageHeader title="Availability" description="When you can pick up and deliver. You are only assigned pickups inside these windows." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader title="Add a window" />
          <CardBody>
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
              {formError && <Alert tone="danger">{formError}</Alert>}
              <Field label="From">{({ id }) => <Input id={id} type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
              <Field label="Until">{({ id }) => <Input id={id} type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />}</Field>
              <div>
                <Button type="submit" loading={add.isPending}>
                  <CalendarPlus aria-hidden="true" /> Add window
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Upcoming windows" />
          {windows.isPending ? (
            <CardBody>
              <Skeleton className="h-12" />
            </CardBody>
          ) : windows.isError ? (
            <CardBody>
              <Alert tone="danger">{errorMessage(windows.error)}</Alert>
            </CardBody>
          ) : windows.data.windows.length === 0 ? (
            <EmptyState icon={<CalendarClock />} title="No availability yet">
              Add the hours you can drive so administrators can assign you pickups.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {windows.data.windows.map((w) => {
                const live = new Date(w.availableFrom).getTime() <= Date.now();
                return (
                  <li key={w.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <span>
                      <span className="block font-medium">
                        {formatDateTime(w.availableFrom)} – {formatDateTime(w.availableUntil)}
                      </span>
                      <span className="text-sm text-muted-foreground">{live ? `Now, until ${formatRelative(w.availableUntil)}` : `Starts ${formatRelative(w.availableFrom)}`}</span>
                    </span>
                    <Button variant="ghost" size="icon" aria-label={`Remove window starting ${formatDateTime(w.availableFrom)}`} onClick={() => remove.mutate(w.id)} disabled={remove.isPending}>
                      <Trash2 className="size-5" aria-hidden="true" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- assignments

export function AssignmentsPage() {
  const deliveries = useMyDeliveries();
  const [tab, setTab] = useState<'offers' | 'active' | 'done'>('offers');
  const all = deliveries.data?.items ?? [];
  const groups = {
    offers: all.filter((d) => d.status === 'ASSIGNED'),
    active: all.filter((d) => ACTIVE.includes(d.status)),
    done: all.filter((d) => d.status === 'DELIVERED' || d.status === 'CONFIRMED'),
  };
  const rows = groups[tab];

  return (
    <>
      <PageHeader title="Assignments" description="Pickups assigned to you." />
      <Tabs
        label="Assignments"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'offers', label: 'New', count: deliveries.data ? groups.offers.length : undefined },
          { value: 'active', label: 'In progress', count: deliveries.data ? groups.active.length : undefined },
          { value: 'done', label: 'Done', count: deliveries.data ? groups.done.length : undefined },
        ]}
      />
      <Card role="tabpanel">
        {deliveries.isPending ? (
          <div className="p-5">
            <Skeleton className="h-14" />
          </div>
        ) : deliveries.isError ? (
          <div className="p-5">
            <Alert tone="danger">{errorMessage(deliveries.error)}</Alert>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Truck />} title={tab === 'offers' ? 'No new requests' : tab === 'active' ? 'Nothing in progress' : 'No completed deliveries yet'}>
            {tab === 'offers' ? 'Keep your availability up to date to receive pickups.' : undefined}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((d) => (
              <li key={d.id}>
                <Link to={`/volunteer/deliveries/${d.id}`} className="flex min-h-16 items-center gap-4 px-5 py-3 transition-colors duration-200 hover:bg-muted">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{d.donation.foodName}</span>
                      <DeliveryStatusBadge status={d.status} />
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {d.pickup.provider.organization ?? d.pickup.location} → {d.dropoff.organization?.name ?? d.dropoff.location} · pick up by{' '}
                      {formatDateTime(d.donation.availableUntil)}
                    </p>
                  </div>
                  <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- delivery

const NEXT: Partial<Record<DeliveryStatus, { to: 'AT_PICKUP' | 'PICKED_UP' | 'IN_TRANSIT' | 'DELIVERED'; label: string; help: string }>> = {
  ACCEPTED: { to: 'AT_PICKUP', label: 'I’m at the pickup', help: 'Tap when you arrive. The provider can then confirm the handover.' },
  AT_PICKUP: { to: 'PICKED_UP', label: 'I’ve collected the food', help: 'Check the quantity and storage notes before leaving.' },
  PICKED_UP: { to: 'IN_TRANSIT', label: 'I’m on my way', help: 'Head to the drop-off address below.' },
  IN_TRANSIT: { to: 'DELIVERED', label: 'Delivered', help: 'Optionally add proof, like a photo link or the receiver’s name.' },
};

export function VolunteerDeliveryPage() {
  const { id = '' } = useParams();
  const delivery = useQuery({ queryKey: ['deliveries', 'detail', id], queryFn: () => volunteerApi.delivery(id) });

  return (
    <>
      <Link to="/volunteer/deliveries" className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Assignments
      </Link>
      {delivery.isPending ? (
        <Skeleton className="h-96" />
      ) : delivery.isError ? (
        <Alert tone="danger">{errorMessage(delivery.error)}</Alert>
      ) : (
        <>
          <PageHeader
            title={delivery.data.delivery.donation.foodName}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <DeliveryStatusBadge status={delivery.data.delivery.status} />
                <span className="tabular">
                  {formatQuantity(delivery.data.delivery.donation.committedQuantity || delivery.data.delivery.donation.quantity, delivery.data.delivery.donation.unit)}
                </span>
              </span>
            }
          />
          <div className="flex flex-col gap-6">
            <NextStep delivery={delivery.data.delivery} />
            <Card>
              <CardHeader title="Route" />
              <CardBody>
                <DeliverySummary delivery={delivery.data.delivery} />
              </CardBody>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function NextStep({ delivery }: { delivery: Delivery }) {
  const queryClient = useQueryClient();
  const [declining, setDeclining] = useState(false);
  const [proof, setProof] = useState('');

  const respond = useMutation({
    mutationFn: ({ action, reason }: { action: 'ACCEPT' | 'DECLINE'; reason?: string }) => volunteerApi.respond(delivery.id, action, reason),
    onSuccess: (_r, { action }) => {
      invalidate(queryClient);
      setDeclining(false);
      toast.success(action === 'ACCEPT' ? 'Pickup accepted. Thank you!' : 'Pickup declined. An administrator will reassign it.');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const advance = useMutation({
    mutationFn: (to: 'AT_PICKUP' | 'PICKED_UP' | 'IN_TRANSIT' | 'DELIVERED') => volunteerApi.advance(delivery.id, to, to === 'DELIVERED' && proof.trim() ? proof.trim() : undefined),
    onSuccess: () => {
      invalidate(queryClient);
      toast.success('Status updated');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (delivery.status === 'ASSIGNED') {
    return (
      <Card className="border-accent/40">
        <CardBody className="flex flex-col gap-4">
          <div>
            <p className="font-semibold">New pickup request</p>
            <p className="text-sm text-muted-foreground">
              Pick up by {formatDateTime(delivery.donation.availableUntil)} ({formatRelative(delivery.donation.availableUntil)}). Accept if you can make it.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="lg" onClick={() => respond.mutate({ action: 'ACCEPT' })} loading={respond.isPending && !declining}>
              Accept pickup
            </Button>
            <Button size="lg" variant="secondary" onClick={() => setDeclining(true)}>
              I can’t make it
            </Button>
          </div>
        </CardBody>
        <ConfirmDialog
          open={declining}
          onOpenChange={setDeclining}
          title="Decline this pickup?"
          description="An administrator will assign another volunteer."
          confirmLabel="Decline pickup"
          destructive
          reasonLabel="Reason (optional)"
          reasonRequired={false}
          loading={respond.isPending}
          onConfirm={(reason) => respond.mutate({ action: 'DECLINE', reason: reason || undefined })}
        />
      </Card>
    );
  }

  const next = NEXT[delivery.status];
  if (!next) {
    return (
      <Alert tone="success" title={delivery.status === 'CONFIRMED' ? 'Delivery complete' : 'Delivered'}>
        {delivery.status === 'CONFIRMED'
          ? `The recipient confirmed receipt${delivery.quantityReceived !== null ? ` of ${formatQuantity(delivery.quantityReceived, delivery.donation.unit)}` : ''}. Thank you!`
          : 'Waiting for the recipient to confirm what they received.'}
      </Alert>
    );
  }

  return (
    <Card className="border-primary/40">
      <CardBody className="flex flex-col gap-4">
        <div>
          <p className="font-semibold">Next step</p>
          <p className="text-sm text-muted-foreground">{next.help}</p>
        </div>
        {next.to === 'DELIVERED' && (
          <Field label="Proof of delivery (optional)" hint="Photo link, receiver name or a reference code.">
            {({ id }) => <Input id={id} value={proof} onChange={(e) => setProof(e.target.value)} maxLength={2000} />}
          </Field>
        )}
        {delivery.handoverConfirmedAt && <p className="text-sm text-primary">The provider confirmed the handover.</p>}
        <div>
          <Button size="lg" onClick={() => advance.mutate(next.to)} loading={advance.isPending}>
            {next.label}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
