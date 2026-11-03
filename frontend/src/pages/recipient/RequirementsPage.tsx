import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Pencil, Plus, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { categoriesApi } from '@/api/endpoints';
import { recipientApi } from '@/api/roles';
import type { Priority, Requirement, RequirementStatus } from '@/api/types';
import { useProfile } from '@/auth/AuthProvider';
import { PRIORITY_LABEL } from '@/components/DeliverySummary';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ConfirmDialog, Tabs } from '@/components/ui/extras';
import { Field, Input, Select } from '@/components/ui/form-controls';
import { Alert, Badge, Card, EmptyState, PageHeader, Skeleton, type Tone } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { formatDateTime, formatRelative, toLocalInput } from '@/lib/format';
import { remaining, useOpenRequirements } from './RecipientPages';

const STATUS: Record<RequirementStatus, { label: string; tone: Tone }> = {
  OPEN: { label: 'Open', tone: 'info' },
  PARTIALLY_FULFILLED: { label: 'Partly fulfilled', tone: 'warning' },
  FULFILLED: { label: 'Fulfilled', tone: 'success' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};

const PRIORITY_TONE: Record<Priority, Tone> = { LOW: 'neutral', MEDIUM: 'info', HIGH: 'warning', CRITICAL: 'danger' };
const ACTIVE: RequirementStatus[] = ['OPEN', 'PARTIALLY_FULFILLED'];

export function RequirementsPage() {
  const { organization } = useProfile();
  const queryClient = useQueryClient();
  const requirements = useOpenRequirements();
  const [tab, setTab] = useState<'active' | 'closed'>('active');
  const [editing, setEditing] = useState<Requirement | 'new' | null>(null);
  const [cancelling, setCancelling] = useState<Requirement | null>(null);
  const verified = organization?.verificationStatus === 'VERIFIED';

  const cancel = useMutation({
    mutationFn: (r: Requirement) => recipientApi.cancelRequirement(r.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requirements'] });
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      setCancelling(null);
      toast.success('Requirement cancelled');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const all = requirements.data ?? [];
  const rows = all.filter((r) => (tab === 'active' ? ACTIVE.includes(r.status) : !ACTIVE.includes(r.status)));

  return (
    <>
      <PageHeader
        title="Requirements"
        description="What your organization needs. Matching donations are suggested automatically."
        action={
          <Button onClick={() => setEditing('new')} disabled={!verified} title={verified ? undefined : 'Available once your organization is verified'}>
            <Plus aria-hidden="true" /> New requirement
          </Button>
        }
      />
      <Tabs
        label="Requirement status"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'active', label: 'Active', count: requirements.data ? all.filter((r) => ACTIVE.includes(r.status)).length : undefined },
          { value: 'closed', label: 'Closed', count: requirements.data ? all.filter((r) => !ACTIVE.includes(r.status)).length : undefined },
        ]}
      />
      <Card role="tabpanel">
        {requirements.isPending ? (
          <div className="flex flex-col gap-3 p-5">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : requirements.isError ? (
          <div className="p-5">
            <Alert tone="danger">{errorMessage(requirements.error)}</Alert>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<ClipboardList />} title={tab === 'active' ? 'No active requirements' : 'No closed requirements'}>
            {tab === 'active' ? 'Add what you need (for example 60 vegetarian meals by 8 pm) and nearby donations are matched to it.' : undefined}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const pct = Math.min(100, Math.round((r.quantity_fulfilled / r.quantity_required) * 100));
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {r.food_category} · {r.food_type}
                      </span>
                      <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                      <Badge tone={PRIORITY_TONE[r.priority]}>{PRIORITY_LABEL[r.priority]} priority</Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Needed by {formatDateTime(r.required_by)}
                      {ACTIVE.includes(r.status) && ` (${formatRelative(r.required_by)})`} · {r.location}
                    </p>
                    <div className="mt-2 flex items-center gap-3">
                      <div className="h-2 w-40 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Fulfilled">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="tabular text-sm text-muted-foreground">
                        {r.quantity_fulfilled} of {r.quantity_required} received
                      </span>
                    </div>
                  </div>
                  {ACTIVE.includes(r.status) && (
                    <div className="flex gap-2">
                      <Button variant="secondary" size="sm" onClick={() => setEditing(r)}>
                        <Pencil aria-hidden="true" /> Edit
                      </Button>
                      {r.status === 'OPEN' && (
                        <Button variant="ghost" size="sm" onClick={() => setCancelling(r)}>
                          <XCircle aria-hidden="true" /> Cancel
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {editing && <RequirementDialog existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {cancelling && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setCancelling(null)}
          title="Cancel this requirement?"
          description={`${cancelling.food_category} · ${remaining(cancelling)} still needed. Matches for it are withdrawn.`}
          confirmLabel="Cancel requirement"
          destructive
          loading={cancel.isPending}
          onConfirm={() => cancel.mutate(cancelling)}
        />
      )}
    </>
  );
}

const schema = z
  .object({
    food_category: z.string().min(1, 'Choose a category'),
    food_type: z.string().trim().min(1, 'Describe the type, e.g. Vegetarian').max(200),
    quantity_required: z.number({ error: 'Enter a number' }).positive('Must be more than 0'),
    required_by: z.string().min(1, 'Choose a deadline'),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    location: z.string().trim().min(1, 'Where should food be delivered?').max(500),
  })
  .superRefine((v, ctx) => {
    if (v.required_by && new Date(v.required_by).getTime() <= Date.now()) {
      ctx.addIssue({ code: 'custom', path: ['required_by'], message: 'The deadline must be in the future' });
    }
  });

type Values = z.infer<typeof schema>;

function RequirementDialog({ existing, onClose }: { existing?: Requirement; onClose: () => void }) {
  const { organization } = useProfile();
  const queryClient = useQueryClient();
  const categories = useQuery({ queryKey: ['categories'], queryFn: categoriesApi.list, staleTime: 30 * 60_000 });
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: existing
      ? {
          food_category: existing.food_category,
          food_type: existing.food_type,
          quantity_required: existing.quantity_required,
          required_by: toLocalInput(existing.required_by),
          priority: existing.priority,
          location: existing.location,
        }
      : {
          food_category: '',
          food_type: '',
          quantity_required: undefined as unknown as number,
          required_by: toLocalInput(new Date(Date.now() + 6 * 3600_000)),
          priority: 'MEDIUM',
          location: organization?.address ?? '',
        },
  });

  const save = useMutation({
    mutationFn: (v: Values) => {
      const input = { ...v, required_by: new Date(v.required_by).toISOString() };
      return existing ? recipientApi.updateRequirement(existing.id, input) : recipientApi.createRequirement(input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['requirements'] });
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(existing ? 'Requirement updated' : 'Requirement added. Looking for matching donations…');
      onClose();
    },
    onError: (err) => {
      const message = applyServerErrors(err, form.setError, ['food_category', 'food_type', 'quantity_required', 'required_by', 'priority', 'location'] as const);
      if (message) setError(message);
    },
  });

  const { errors } = form.formState;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={existing ? 'Edit requirement' : 'New requirement'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="requirement-form" loading={save.isPending}>
            {existing ? 'Save changes' : 'Add requirement'}
          </Button>
        </>
      }
    >
      <form
        id="requirement-form"
        onSubmit={form.handleSubmit((v) => {
          setError(null);
          save.mutate(v);
        })}
        className="grid gap-4 sm:grid-cols-2"
        noValidate
      >
        {error && (
          <Alert tone="danger" className="sm:col-span-2">
            {error}
          </Alert>
        )}
        <Field label="Category" required error={errors.food_category?.message}>
          {({ id, describedBy, invalid }) => (
            <Select id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('food_category')}>
              <option value="" disabled>
                Choose a category
              </option>
              {categories.data?.categories.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Type" required hint="Vegetarian, Bread, Fruit…" error={errors.food_type?.message}>
          {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('food_type')} />}
        </Field>
        <Field label="Quantity needed" required error={errors.quantity_required?.message}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="number" min={0} step="any" inputMode="decimal" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('quantity_required', { valueAsNumber: true })} />
          )}
        </Field>
        <Field label="Priority" required>
          {({ id }) => (
            <Select id={id} {...form.register('priority')}>
              {(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Needed by" required error={errors.required_by?.message} className="sm:col-span-2">
          {({ id, describedBy, invalid }) => <Input id={id} type="datetime-local" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('required_by')} />}
        </Field>
        <Field label="Delivery location" required hint="Where volunteers should bring the food." error={errors.location?.message} className="sm:col-span-2">
          {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('location')} />}
        </Field>
      </form>
    </Dialog>
  );
}
