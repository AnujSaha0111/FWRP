import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Flag, Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { incidentsApi } from '@/api/endpoints';
import type { Incident, IncidentStatus } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Alert, Badge, Card, EmptyState, PageHeader, Skeleton, type Tone } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { formatDateTime } from '@/lib/format';

const STATUS: Record<IncidentStatus, { label: string; tone: Tone }> = {
  OPEN: { label: 'Open', tone: 'info' },
  UNDER_REVIEW: { label: 'Under review', tone: 'warning' },
  RESOLVED: { label: 'Resolved', tone: 'success' },
  DISMISSED: { label: 'Dismissed', tone: 'neutral' },
};

export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  // `?donation=<id>` (from a donation page) opens the dialog as a dispute.
  const donationId = params.get('donation') ?? undefined;
  const [open, setOpen] = useState(Boolean(donationId));
  const list = useQuery({ queryKey: ['incidents', 'mine'], queryFn: incidentsApi.mine });

  return (
    <>
      <PageHeader
        title="Reports & disputes"
        description="Report a problem with an account or a donation. An administrator reviews every report."
        action={
          <Button onClick={() => setOpen(true)}>
            <Plus aria-hidden="true" /> New report
          </Button>
        }
      />
      <Card>
        {list.isPending ? (
          <div className="flex flex-col gap-3 p-5">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : list.isError ? (
          <div className="p-5">
            <Alert tone="danger">{errorMessage(list.error)}</Alert>
          </div>
        ) : list.data.items.length === 0 ? (
          <EmptyState icon={<Flag />} title="No reports yet">
            If a pickup goes wrong, food quality is a problem, or someone behaves inappropriately, file a report.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {list.data.items.map((i) => (
              <IncidentRow key={i.id} incident={i} />
            ))}
          </ul>
        )}
      </Card>
      <NewReportDialog
        open={open}
        donationId={donationId}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next && donationId) setParams({}, { replace: true });
        }}
      />
    </>
  );
}

function IncidentRow({ incident }: { incident: Incident }) {
  const s = STATUS[incident.status];
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{incident.reason}</p>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {incident.type === 'DISPUTE' ? 'Dispute about a donation' : `Report about ${incident.subjectUser?.name ?? 'an account'}`} ·{' '}
        {formatDateTime(incident.createdAt)}
      </p>
      <p className="mt-2 text-sm">{incident.description}</p>
      {incident.resolution && (
        <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-sm">
          <span className="font-medium">Administrator: </span>
          {incident.resolution}
        </p>
      )}
    </li>
  );
}

const schema = z
  .object({
    type: z.enum(['DISPUTE', 'ACCOUNT_REPORT']),
    donationId: z.string().trim(),
    subjectUserId: z.string().trim(),
    reason: z.string().trim().min(3, 'Give a short reason (3+ characters)').max(200),
    description: z.string().trim().min(10, 'Describe what happened (10+ characters)').max(5000),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'DISPUTE' && !v.donationId) ctx.addIssue({ code: 'custom', path: ['donationId'], message: 'Enter the donation ID' });
    if (v.type === 'ACCOUNT_REPORT' && !v.subjectUserId) ctx.addIssue({ code: 'custom', path: ['subjectUserId'], message: 'Enter the account ID' });
  });

type Values = z.infer<typeof schema>;

function NewReportDialog({ open, onOpenChange, donationId }: { open: boolean; onOpenChange: (open: boolean) => void; donationId?: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    values: { type: 'DISPUTE', donationId: donationId ?? '', subjectUserId: '', reason: '', description: '' },
  });
  const type = form.watch('type');

  const create = useMutation({
    mutationFn: (v: Values) =>
      incidentsApi.create({
        type: v.type,
        reason: v.reason,
        description: v.description,
        ...(v.type === 'DISPUTE' ? { donationId: v.donationId } : { subjectUserId: v.subjectUserId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['incidents'] });
      toast.success('Report sent to the administrators');
      form.reset();
      onOpenChange(false);
    },
    onError: (err) => {
      const message = applyServerErrors(err, form.setError, ['donationId', 'subjectUserId', 'reason', 'description'] as const);
      if (message) setError(message);
    },
  });

  const { errors } = form.formState;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New report"
      description="Only you and the administrators can see this report."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-report" loading={create.isPending}>
            Send report
          </Button>
        </>
      }
    >
      <form
        id="new-report"
        onSubmit={form.handleSubmit((v) => {
          setError(null);
          create.mutate(v);
        })}
        className="flex flex-col gap-4"
        noValidate
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="What is it about?">
          {({ id }) => (
            <Select id={id} {...form.register('type')}>
              <option value="DISPUTE">A donation or delivery</option>
              <option value="ACCOUNT_REPORT">Another user’s account</option>
            </Select>
          )}
        </Field>
        {type === 'DISPUTE' ? (
          <Field label="Donation ID" hint="Shown on the donation page." error={errors.donationId?.message}>
            {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('donationId')} />}
          </Field>
        ) : (
          <Field label="Account ID" hint="Ask an administrator if you do not know it." error={errors.subjectUserId?.message}>
            {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('subjectUserId')} />}
          </Field>
        )}
        <Field label="Reason" hint="For example: food spoiled, no-show, wrong quantity." error={errors.reason?.message}>
          {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('reason')} />}
        </Field>
        <Field label="What happened?" error={errors.description?.message}>
          {({ id, describedBy, invalid }) => <Textarea id={id} rows={5} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('description')} />}
        </Field>
      </form>
    </Dialog>
  );
}
