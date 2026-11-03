import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Flag, HandHeart, MapPin, Pencil, Phone, RefreshCw, Truck, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { deliveriesApi, donationsApi, matchesApi } from '@/api/endpoints';
import type { Delivery, DonationDetail, DonationStatus } from '@/api/types';
import { CANCELLABLE, DeliveryStatusBadge, DonationStatusBadge, EDITABLE } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Skeleton } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { formatDateTime, formatQuantity, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

const STEPS: Array<{ label: string; reached: readonly DonationStatus[] }> = [
  { label: 'Listed', reached: ['AVAILABLE', 'MATCHED', 'ACCEPTED', 'PICKUP_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'] },
  { label: 'Accepted', reached: ['ACCEPTED', 'PICKUP_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'] },
  { label: 'Volunteer assigned', reached: ['PICKUP_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'] },
  { label: 'Picked up', reached: ['PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'] },
  { label: 'Delivered', reached: ['DELIVERED', 'COMPLETED'] },
  { label: 'Completed', reached: ['COMPLETED'] },
];

function Progress({ status }: { status: DonationStatus }) {
  if (status === 'EXPIRED' || status === 'CANCELLED' || status === 'DRAFT') return null;
  const current = STEPS.filter((s) => s.reached.includes(status)).length - 1;
  return (
    <ol className="grid grid-cols-3 gap-y-4 sm:grid-cols-6" aria-label="Donation progress">
      {STEPS.map((s, i) => {
        const done = i <= current;
        return (
          <li key={s.label} className="flex flex-col items-center gap-1.5 text-center" aria-current={i === current ? 'step' : undefined}>
            <span
              className={cn(
                'flex size-8 items-center justify-center rounded-full border-2 text-sm font-semibold',
                done ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground'
              )}
            >
              {done ? <Check className="size-4" aria-hidden="true" /> : i + 1}
            </span>
            <span className={cn('text-xs', done ? 'font-medium text-foreground' : 'text-muted-foreground')}>
              {s.label}
              <span className="sr-only">{done ? ' (done)' : ' (pending)'}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

export function DonationDetailPage() {
  const { id = '' } = useParams();
  const donation = useQuery({ queryKey: ['donation', id], queryFn: () => donationsApi.get(id) });

  const back = (
    <Link to="/provider/donations" className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
      <ArrowLeft className="size-4" aria-hidden="true" /> My donations
    </Link>
  );

  if (donation.isPending)
    return (
      <>
        {back}
        <Skeleton className="mb-4 h-10 w-1/2" />
        <Skeleton className="h-72" />
      </>
    );
  if (donation.isError)
    return (
      <>
        {back}
        <Alert tone="danger">{errorMessage(donation.error)}</Alert>
      </>
    );

  const d = donation.data.donation;
  return (
    <>
      {back}
      <PageHeader title={d.foodName} description={<span className="flex flex-wrap items-center gap-2"><DonationStatusBadge status={d.status} /> <span className="tabular">{formatQuantity(d.quantity, d.unit)}</span> · {d.category}</span>} action={<Actions donation={d} />} />

      <div className="flex flex-col gap-6">
        <Card>
          <CardBody>
            <Progress status={d.status} />
            {d.status === 'EXPIRED' && <Alert tone="warning" title="This donation expired">Nobody accepted it before the pickup window closed.</Alert>}
            {d.status === 'CANCELLED' && <Alert tone="info" title="This donation was cancelled" />}
          </CardBody>
        </Card>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="grid gap-4 sm:grid-cols-2">
                <Detail label="Type">{d.foodType}</Detail>
                <Detail label="Quantity">
                  <span className="tabular">{formatQuantity(d.quantity, d.unit)}</span>
                </Detail>
                <Detail label="Available from">{formatDateTime(d.availableFrom)}</Detail>
                <Detail label="Pick up by">
                  {formatDateTime(d.availableUntil)}
                  {new Date(d.availableUntil).getTime() > Date.now() && (
                    <span className="block text-sm text-muted-foreground">{formatRelative(d.availableUntil)}</span>
                  )}
                </Detail>
                <Detail label="Pickup address">
                  <span className="flex items-start gap-1.5">
                    <MapPin className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    {d.pickupLocation}
                  </span>
                </Detail>
                <Detail label="Storage">{d.storageRequirement ?? '—'}</Detail>
                {d.description && (
                  <div className="sm:col-span-2">
                    <Detail label="Notes">{d.description}</Detail>
                  </div>
                )}
                <div className="sm:col-span-2">
                  <Detail label="Donation ID">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">{d.id}</code>
                  </Detail>
                </div>
              </dl>
            </CardBody>
          </Card>

          <div className="flex flex-col gap-6">
            <DeliveryCard donation={d} />
            <RecipientCard donation={d} />
          </div>
        </div>
      </div>
    </>
  );
}

function Actions({ donation }: { donation: DonationDetail }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({
    mutationFn: () => donationsApi.cancel(donation.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['donation', donation.id] });
      queryClient.invalidateQueries({ queryKey: ['donations'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setConfirming(false);
      toast.success('Donation cancelled');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="flex flex-wrap gap-2">
      {EDITABLE.includes(donation.status) && (
        <Button asChild variant="secondary">
          <Link to={`/provider/donations/${donation.id}/edit`}>
            <Pencil aria-hidden="true" /> Edit
          </Link>
        </Button>
      )}
      {CANCELLABLE.includes(donation.status) && (
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          <XCircle aria-hidden="true" /> Cancel donation
        </Button>
      )}
      <Button asChild variant="ghost">
        <Link to={`/reports?donation=${donation.id}`}>
          <Flag aria-hidden="true" /> Report a problem
        </Link>
      </Button>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Cancel this donation?"
        description="Recipients will no longer see it, and its matches are withdrawn. This cannot be undone."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button variant="destructive" onClick={() => cancel.mutate()} loading={cancel.isPending}>
              Cancel donation
            </Button>
          </>
        }
      />
    </div>
  );
}

/** Matches while unclaimed; the accepting recipient afterwards. */
function RecipientCard({ donation }: { donation: DonationDetail }) {
  const queryClient = useQueryClient();
  const open = donation.status === 'AVAILABLE' || donation.status === 'MATCHED';
  const claimed = ['ACCEPTED', 'PICKUP_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'].includes(donation.status);
  const status = open ? 'RECOMMENDED' : 'ACCEPTED';
  const matches = useQuery({
    queryKey: ['matches', 'donation', donation.id, status],
    queryFn: () => matchesApi.forDonation(donation.id, status),
    enabled: open || claimed,
  });
  const refresh = useMutation({
    mutationFn: () => matchesApi.refreshDonation(donation.id),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['matches', 'donation', donation.id] });
      toast.success(r.recommended === 1 ? '1 recipient matched' : `${r.recommended} recipients matched`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (!open && !claimed) return null;

  return (
    <Card>
      <CardHeader
        title={open ? 'Matched recipients' : 'Recipient'}
        description={open ? 'Verified organizations nearby whose needs fit this donation, best match first.' : undefined}
        action={
          open && (
            <Button variant="ghost" size="sm" onClick={() => refresh.mutate()} loading={refresh.isPending}>
              {!refresh.isPending && <RefreshCw aria-hidden="true" />}
              Refresh
            </Button>
          )
        }
      />
      {matches.isPending ? (
        <CardBody>
          <Skeleton className="h-14" />
        </CardBody>
      ) : matches.isError ? (
        <CardBody>
          <Alert tone="danger">{errorMessage(matches.error)}</Alert>
        </CardBody>
      ) : matches.data.items.length === 0 ? (
        <EmptyState icon={<HandHeart />} title={open ? 'No matches yet' : 'Recipient details unavailable'}>
          {open ? 'No verified recipient nearby needs this right now. You will be notified as soon as one matches.' : undefined}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {matches.data.items.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-4 px-5 py-3">
              <div className="min-w-0">
                <p className="font-medium">{m.requirement.organization.name}</p>
                <p className="text-sm text-muted-foreground">
                  Needs <span className="tabular">{m.requirement.quantityRequired - m.requirement.quantityFulfilled}</span> · {m.requirement.foodCategory} ·{' '}
                  <span className="tabular">{m.distance.toFixed(1)} km</span> away
                </p>
              </div>
              {open ? (
                <Badge tone={m.matchingScore >= 0.75 ? 'success' : m.matchingScore >= 0.5 ? 'info' : 'neutral'} title="Match score">
                  <span className="tabular">{Math.round(m.matchingScore * 100)}%</span> match
                </Badge>
              ) : (
                <Badge tone="success">Accepted</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DeliveryCard({ donation }: { donation: DonationDetail }) {
  const queryClient = useQueryClient();
  const relevant = ['PICKUP_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'].includes(donation.status);
  const deliveries = useQuery({
    queryKey: ['deliveries', 'donation', donation.id],
    queryFn: () => deliveriesApi.list({ donationId: donation.id }),
    enabled: relevant,
  });
  const handover = useMutation({
    mutationFn: (deliveryId: string) => deliveriesApi.confirmHandover(deliveryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deliveries', 'donation', donation.id] });
      queryClient.invalidateQueries({ queryKey: ['donation', donation.id] });
      toast.success('Handover confirmed');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (donation.status === 'ACCEPTED') {
    return (
      <Card>
        <CardHeader title="Pickup" />
        <CardBody>
          <Alert tone="info" title="Waiting for a volunteer">
            A recipient accepted this donation. An administrator is assigning a volunteer to collect it.
          </Alert>
        </CardBody>
      </Card>
    );
  }
  if (!relevant) return null;

  const current: Delivery | undefined = deliveries.data?.items.find((x) => !x.needsReassignment) ?? deliveries.data?.items[0];
  const canHandover = current && !current.handoverConfirmedAt && ['AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED'].includes(current.status);

  return (
    <Card>
      <CardHeader title="Pickup & delivery" action={current && <DeliveryStatusBadge status={current.status} />} />
      <CardBody>
        {deliveries.isPending ? (
          <Skeleton className="h-24" />
        ) : deliveries.isError ? (
          <Alert tone="danger">{errorMessage(deliveries.error)}</Alert>
        ) : !current ? (
          <p className="text-sm text-muted-foreground">No delivery yet.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <span className="rounded-lg bg-muted p-2 text-muted-foreground">
                <Truck className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="font-medium">{current.volunteer.name}</p>
                <a href={`tel:${current.volunteer.phone.replace(/\s/g, '')}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                  <Phone className="size-3.5" aria-hidden="true" /> {current.volunteer.phone}
                </a>
              </div>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Detail label="Delivering to">{current.dropoff.organization?.name ?? current.dropoff.location}</Detail>
              <Detail label="Assigned">{formatDateTime(current.assignedAt)}</Detail>
              <Detail label="Picked up">{formatDateTime(current.pickupTime)}</Detail>
              <Detail label="Delivered">{formatDateTime(current.deliveryTime)}</Detail>
              {current.quantityReceived !== null && (
                <Detail label="Received">
                  <span className="tabular">{formatQuantity(current.quantityReceived, donation.unit)}</span>
                </Detail>
              )}
            </dl>
            {current.handoverConfirmedAt ? (
              <p className="flex items-center gap-1.5 text-sm text-primary">
                <Check className="size-4" aria-hidden="true" /> You confirmed the handover {formatRelative(current.handoverConfirmedAt)}.
              </p>
            ) : canHandover ? (
              <div className="flex flex-col gap-2 rounded-lg bg-primary-soft p-4">
                <p className="text-sm">
                  {current.status === 'AT_PICKUP'
                    ? 'The volunteer is at your pickup point. Confirm once you have handed over the food.'
                    : 'Confirm that you handed the food to the volunteer.'}
                </p>
                <div>
                  <Button onClick={() => handover.mutate(current.id)} loading={handover.isPending}>
                    Confirm handover
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">You can confirm the handover once the volunteer arrives at the pickup point.</p>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
