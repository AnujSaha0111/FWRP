import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CheckCircle2, Clock, Truck, UserCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { adminApi } from '@/api/roles';
import type { Organization, VerificationStatus } from '@/api/types';
import { VerificationBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ConfirmDialog, Tabs } from '@/components/ui/extras';
import { Alert, Card, CardHeader, EmptyState, PageHeader, Skeleton } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { formatDateTime, formatQuantity, formatRelative, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------- organization verification

type VerifyAction = { kind: 'REVIEW' | 'VERIFY' | 'REJECT'; org: Organization };

export function VerificationPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<VerificationStatus>('PENDING');
  const [action, setAction] = useState<VerifyAction | null>(null);
  const list = useQuery({ queryKey: ['organizations', status], queryFn: () => adminApi.organizations(status) });

  const run = useMutation({
    mutationFn: ({ kind, org, reason }: VerifyAction & { reason?: string }) =>
      kind === 'REVIEW' ? adminApi.reviewOrganization(org.id) : adminApi.verifyOrganization(org.id, kind, reason),
    onSuccess: (_r, { kind, org }) => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['monitoring'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setAction(null);
      toast.success(kind === 'REVIEW' ? `${org.name} is under review` : kind === 'VERIFY' ? `${org.name} verified` : `${org.name} rejected`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <PageHeader title="Organization verification" description="Providers and recipients can take part in matching only after verification." />
      <Tabs
        label="Verification status"
        value={status}
        onChange={setStatus}
        items={(['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'] as const).map((s) => ({ value: s, label: titleCase(s) }))}
      />
      <Card role="tabpanel">
        {list.isPending ? (
          <div className="p-5">
            <Skeleton className="h-14" />
          </div>
        ) : list.isError ? (
          <div className="p-5">
            <Alert tone="danger">{errorMessage(list.error)}</Alert>
          </div>
        ) : list.data.items.length === 0 ? (
          <EmptyState icon={<Building2 />} title={`No ${titleCase(status).toLowerCase()} organizations`} />
        ) : (
          <ul className="divide-y divide-border">
            {list.data.items.map((org) => (
              <li key={org.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{org.name}</span>
                    <VerificationBadge status={org.verificationStatus} />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {titleCase(org.type)} · {org.address}
                    {org.contactInformation && ` · ${org.contactInformation}`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Registered {formatDateTime(org.createdAt)} ·{' '}
                    <a
                      href={`https://www.openstreetmap.org/?mlat=${org.latitude}&mlon=${org.longitude}#map=17/${org.latitude}/${org.longitude}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      View location
                    </a>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {org.verificationStatus === 'PENDING' && (
                    <Button variant="secondary" size="sm" onClick={() => setAction({ kind: 'REVIEW', org })}>
                      Start review
                    </Button>
                  )}
                  {org.verificationStatus === 'UNDER_REVIEW' && (
                    <>
                      <Button size="sm" onClick={() => setAction({ kind: 'VERIFY', org })}>
                        <CheckCircle2 aria-hidden="true" /> Verify
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setAction({ kind: 'REJECT', org })}>
                        Reject
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {action && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setAction(null)}
          title={action.kind === 'REVIEW' ? `Start reviewing ${action.org.name}?` : action.kind === 'VERIFY' ? `Verify ${action.org.name}?` : `Reject ${action.org.name}?`}
          description={
            action.kind === 'VERIFY'
              ? 'It can then list donations or receive them, and its members are notified.'
              : action.kind === 'REJECT'
                ? 'Its members are notified with your reason. Verification decisions are final.'
                : 'Marks it as being checked so other administrators know.'
          }
          confirmLabel={action.kind === 'REVIEW' ? 'Start review' : action.kind === 'VERIFY' ? 'Verify' : 'Reject'}
          destructive={action.kind === 'REJECT'}
          reasonLabel={action.kind === 'REJECT' ? 'Reason (sent to the organization)' : undefined}
          loading={run.isPending}
          onConfirm={(reason) => run.mutate({ ...action, reason: reason || undefined })}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- pickup queue

type AssignTarget = { donationId: string; foodName: string; deliveryId?: string };

export function PickupQueuePage() {
  const pending = useQuery({ queryKey: ['pending'], queryFn: adminApi.pending, refetchInterval: 60_000 });
  const [target, setTarget] = useState<AssignTarget | null>(null);

  return (
    <>
      <PageHeader title="Pickup queue" description="Accepted donations that need a volunteer, soonest deadline first." />
      {pending.isPending ? (
        <Skeleton className="h-64" />
      ) : pending.isError ? (
        <Alert tone="danger">{errorMessage(pending.error)}</Alert>
      ) : (
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Waiting for a volunteer" />
            {pending.data.awaitingVolunteer.length === 0 ? (
              <EmptyState icon={<CheckCircle2 />} title="All caught up">
                Every accepted donation has a volunteer.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-border">
                {pending.data.awaitingVolunteer.map((d) => {
                  const urgent = new Date(d.availableUntil).getTime() - Date.now() < 2 * 3600_000;
                  return (
                    <li key={d.donationId} className="flex flex-wrap items-center gap-4 px-5 py-4">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{d.foodName}</p>
                        <p className="text-sm text-muted-foreground">
                          <span className="tabular">{formatQuantity(d.quantity, d.unit)}</span> · {d.pickupLocation} → {d.recipientOrganization ?? 'recipient'}
                        </p>
                        <p className={cn('flex items-center gap-1 text-sm', urgent ? 'font-medium text-accent' : 'text-muted-foreground')}>
                          <Clock className="size-3.5" aria-hidden="true" /> Pick up by {formatDateTime(d.availableUntil)} ({formatRelative(d.availableUntil)})
                        </p>
                      </div>
                      <Button onClick={() => setTarget({ donationId: d.donationId, foodName: d.foodName })}>
                        <UserCheck aria-hidden="true" /> Assign volunteer
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Declined by the volunteer" description="These need another volunteer." />
            {pending.data.declined.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted-foreground">No declined assignments.</p>
            ) : (
              <ul className="divide-y divide-border">
                {pending.data.declined.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{d.donation.foodName}</p>
                      <p className="text-sm text-muted-foreground">
                        Declined by {d.volunteer.name} {d.declinedAt && formatRelative(d.declinedAt)}
                        {d.declineReason && `: “${d.declineReason}”`}
                      </p>
                    </div>
                    <Button variant="secondary" onClick={() => setTarget({ donationId: d.donation.id, foodName: d.donation.foodName, deliveryId: d.id })}>
                      Reassign
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
      {target && <AssignDialog target={target} onClose={() => setTarget(null)} />}
    </>
  );
}

function AssignDialog({ target, onClose }: { target: AssignTarget; onClose: () => void }) {
  const queryClient = useQueryClient();
  const volunteers = useQuery({ queryKey: ['volunteers', 'available', target.donationId], queryFn: () => adminApi.availableVolunteers(target.donationId) });
  const [chosen, setChosen] = useState<string | null>(null);

  const assign = useMutation({
    mutationFn: (volunteerId: string) => (target.deliveryId ? adminApi.reassign(target.deliveryId, volunteerId) : adminApi.assign(target.donationId, volunteerId)),
    onSuccess: () => {
      for (const key of ['pending', 'monitoring', 'dashboard']) queryClient.invalidateQueries({ queryKey: [key] });
      toast.success('Volunteer assigned and notified');
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${target.deliveryId ? 'Reassign' : 'Assign'} “${target.foodName}”`}
      description="Volunteers who are free during the pickup window."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => chosen && assign.mutate(chosen)} disabled={!chosen} loading={assign.isPending}>
            Assign
          </Button>
        </>
      }
    >
      {volunteers.isPending ? (
        <Skeleton className="h-24" />
      ) : volunteers.isError ? (
        <Alert tone="danger">{errorMessage(volunteers.error)}</Alert>
      ) : volunteers.data.volunteers.length === 0 ? (
        <EmptyState icon={<Truck />} title="No volunteer is free in this window">
          Ask volunteers to add availability between {formatDateTime(volunteers.data.from)} and {formatDateTime(volunteers.data.until)}.
        </EmptyState>
      ) : (
        <fieldset>
          <legend className="sr-only">Choose a volunteer</legend>
          <ul className="flex flex-col gap-2">
            {volunteers.data.volunteers.map((v) => (
              <li key={v.id}>
                <label
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors duration-200',
                    chosen === v.id ? 'border-primary bg-primary-soft' : 'border-border hover:bg-muted'
                  )}
                >
                  <input type="radio" name="volunteer" value={v.id} checked={chosen === v.id} onChange={() => setChosen(v.id)} className="mt-1 size-4 accent-[var(--color-primary)]" />
                  <span>
                    <span className="block font-medium">{v.name}</span>
                    <span className="block text-sm text-muted-foreground">{v.phone}</span>
                    <span className="block text-sm text-muted-foreground">
                      Free {v.windows.map((w) => `${formatDateTime(w.availableFrom)} – ${formatDateTime(w.availableUntil)}`).join(', ')}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
    </Dialog>
  );
}
