import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, PackageCheck, Truck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { deliveriesApi } from '@/api/endpoints';
import { recipientApi } from '@/api/roles';
import type { Delivery } from '@/api/types';
import { DeliverySummary } from '@/components/DeliverySummary';
import { DeliveryStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Tabs } from '@/components/ui/extras';
import { Field, Input, Textarea } from '@/components/ui/form-controls';
import { Alert, Card, CardBody, CardHeader, EmptyState, PageHeader, Skeleton } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { formatDateTime, formatQuantity } from '@/lib/format';

export function RecipientDeliveriesPage() {
  const [tab, setTab] = useState<'incoming' | 'done'>('incoming');
  const deliveries = useQuery({ queryKey: ['deliveries', 'recipient'], queryFn: () => recipientApi.deliveries() });
  const all = deliveries.data?.items ?? [];
  const incoming = all.filter((d) => d.status !== 'CONFIRMED');
  const rows = tab === 'incoming' ? incoming : all.filter((d) => d.status === 'CONFIRMED');

  return (
    <>
      <PageHeader title="Deliveries" description="Food on its way to you. Confirm what you received once it arrives." />
      <Tabs
        label="Deliveries"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'incoming', label: 'Incoming', count: deliveries.data ? incoming.length : undefined },
          { value: 'done', label: 'Received', count: deliveries.data ? all.length - incoming.length : undefined },
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
          <EmptyState icon={<Truck />} title={tab === 'incoming' ? 'Nothing on the way' : 'No completed deliveries yet'}>
            {tab === 'incoming' ? 'Accepted donations appear here once a volunteer is assigned.' : undefined}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((d) => (
              <li key={d.id}>
                <Link to={`/recipient/deliveries/${d.id}`} className="flex min-h-16 items-center gap-4 px-5 py-3 transition-colors duration-200 hover:bg-muted">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{d.donation.foodName}</span>
                      <DeliveryStatusBadge status={d.status} />
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      <span className="tabular">{formatQuantity(d.donation.committedQuantity || d.donation.quantity, d.donation.unit)}</span> from{' '}
                      {d.pickup.provider.organization ?? d.pickup.provider.name} · volunteer {d.volunteer.name}
                    </p>
                  </div>
                  {d.status === 'DELIVERED' && <span className="text-sm font-medium text-accent">Confirm receipt</span>}
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

export function RecipientDeliveryPage() {
  const { id = '' } = useParams();
  const delivery = useQuery({ queryKey: ['deliveries', 'detail', id], queryFn: () => deliveriesApi.get(id) });

  return (
    <>
      <Link to="/recipient/deliveries" className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Deliveries
      </Link>
      {delivery.isPending ? (
        <Skeleton className="h-96" />
      ) : delivery.isError ? (
        <Alert tone="danger">{errorMessage(delivery.error)}</Alert>
      ) : (
        <>
          <PageHeader title={delivery.data.delivery.donation.foodName} description={<DeliveryStatusBadge status={delivery.data.delivery.status} />} />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader title="Delivery" description={`Volunteer: ${delivery.data.delivery.volunteer.name}, ${delivery.data.delivery.volunteer.phone}`} />
              <CardBody>
                <DeliverySummary delivery={delivery.data.delivery} />
              </CardBody>
            </Card>
            <ConfirmCard delivery={delivery.data.delivery} />
          </div>
        </>
      )}
    </>
  );
}

const confirmSchema = z.object({
  quantityReceived: z.number({ error: 'Enter a number' }).positive('Must be more than 0'),
  receiverName: z.string().trim().max(200),
  notes: z.string().trim().max(2000),
});

function ConfirmCard({ delivery }: { delivery: Delivery }) {
  const queryClient = useQueryClient();
  const expected = delivery.donation.committedQuantity || delivery.donation.quantity;
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof confirmSchema>>({
    resolver: zodResolver(confirmSchema),
    defaultValues: { quantityReceived: expected, receiverName: '', notes: '' },
  });

  const confirm = useMutation({
    mutationFn: (v: z.infer<typeof confirmSchema>) =>
      recipientApi.confirmReceipt(delivery.id, {
        quantityReceived: v.quantityReceived,
        ...(v.receiverName ? { receiverName: v.receiverName } : {}),
        ...(v.notes ? { notes: v.notes } : {}),
      }),
    onSuccess: () => {
      for (const key of ['deliveries', 'requirements', 'dashboard', 'matches']) queryClient.invalidateQueries({ queryKey: [key] });
      toast.success('Receipt confirmed. Thank you!');
    },
    onError: (err) => {
      const message = applyServerErrors(err, form.setError, ['quantityReceived', 'receiverName', 'notes'] as const);
      if (message) setError(message);
    },
  });

  if (delivery.status === 'CONFIRMED') {
    return (
      <Card>
        <CardHeader title="Received" />
        <CardBody>
          <p className="flex items-center gap-2">
            <PackageCheck className="size-5 text-primary" aria-hidden="true" />
            <span>
              <span className="tabular font-medium">{formatQuantity(delivery.quantityReceived ?? expected, delivery.donation.unit)}</span> confirmed{' '}
              {formatDateTime(delivery.confirmedAt)}
              {delivery.receiverName && ` by ${delivery.receiverName}`}.
            </span>
          </p>
        </CardBody>
      </Card>
    );
  }

  if (delivery.status !== 'DELIVERED') {
    return (
      <Card>
        <CardHeader title="Confirm receipt" />
        <CardBody>
          <p className="text-sm text-muted-foreground">You can confirm once the volunteer marks the food as delivered.</p>
        </CardBody>
      </Card>
    );
  }

  const { errors } = form.formState;
  return (
    <Card>
      <CardHeader title="Confirm receipt" description="This completes the donation and updates your requirement." />
      <CardBody>
        <form
          onSubmit={form.handleSubmit((v) => {
            setError(null);
            confirm.mutate(v);
          })}
          className="flex flex-col gap-4"
          noValidate
        >
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label={`Quantity received (${delivery.donation.unit})`} hint={`Expected ${expected}. Enter less if some was missing or unusable.`} error={errors.quantityReceived?.message}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="number" min={0} step="any" inputMode="decimal" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('quantityReceived', { valueAsNumber: true })} />
            )}
          </Field>
          <Field label="Received by" hint="Optional: who took delivery." error={errors.receiverName?.message}>
            {({ id, describedBy, invalid }) => <Input id={id} autoComplete="name" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('receiverName')} />}
          </Field>
          <Field label="Notes" error={errors.notes?.message}>
            {({ id, describedBy, invalid }) => <Textarea id={id} rows={3} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('notes')} />}
          </Field>
          <Button type="submit" loading={confirm.isPending}>
            Confirm receipt
          </Button>
          <Link to={`/reports?donation=${delivery.donation.id}`} className="text-center text-sm font-medium text-muted-foreground underline-offset-4 hover:underline">
            Something wrong with this delivery? Report it
          </Link>
        </form>
      </CardBody>
    </Card>
  );
}
