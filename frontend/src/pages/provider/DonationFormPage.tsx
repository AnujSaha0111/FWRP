import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { categoriesApi, donationsApi, organizationApi } from '@/api/endpoints';
import type { DonationDetail, DonationInput } from '@/api/types';
import { LocationPicker } from '@/components/map/LocationPicker';
import { EDITABLE } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls';
import { Alert, Card, CardBody, CardHeader, PageHeader, Skeleton } from '@/components/ui/surface';
import { errorMessage } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { toLocalInput } from '@/lib/format';

const UNITS = ['meals', 'portions', 'kg', 'loaves', 'trays', 'litres', 'packets', 'boxes'];

const schema = z
  .object({
    foodName: z.string().trim().min(1, 'Name the food').max(500),
    category: z.string().min(1, 'Choose a category'),
    foodType: z.string().trim().min(1, 'Describe the type, e.g. Vegetarian').max(200),
    quantity: z.number({ error: 'Enter a number' }).positive('Must be more than 0'),
    unit: z.string().trim().min(1, 'Enter a unit').max(100),
    availableFrom: z.string().min(1, 'Choose when pickup can start'),
    availableUntil: z.string().min(1, 'Choose the pickup deadline'),
    pickupLocation: z.string().trim().min(1, 'Enter the pickup address').max(500),
    customLocation: z.boolean(),
    pickupPoint: z.object({ latitude: z.number(), longitude: z.number() }).nullable(),
    storageRequirement: z.string().trim().max(500),
    description: z.string().trim().max(10000),
  })
  .superRefine((v, ctx) => {
    const from = new Date(v.availableFrom).getTime();
    const until = new Date(v.availableUntil).getTime();
    if (v.availableFrom && v.availableUntil && until <= from) {
      ctx.addIssue({ code: 'custom', path: ['availableUntil'], message: 'The deadline must be after the start' });
    } else if (v.availableUntil && until <= Date.now()) {
      ctx.addIssue({ code: 'custom', path: ['availableUntil'], message: 'The deadline must be in the future' });
    }
    if (v.customLocation && !v.pickupPoint) {
      ctx.addIssue({ code: 'custom', path: ['pickupPoint'], message: 'Place the pin on the pickup point' });
    }
  });

type Values = z.infer<typeof schema>;

const SERVER_FIELDS = ['foodName', 'category', 'foodType', 'quantity', 'unit', 'availableFrom', 'availableUntil', 'pickupLocation', 'storageRequirement', 'description'] as const;

function toInput(v: Values): DonationInput {
  return {
    foodName: v.foodName,
    category: v.category,
    foodType: v.foodType,
    quantity: v.quantity,
    unit: v.unit,
    availableFrom: new Date(v.availableFrom).toISOString(),
    availableUntil: new Date(v.availableUntil).toISOString(),
    pickupLocation: v.pickupLocation,
    ...(v.customLocation && v.pickupPoint ? { pickupLatitude: v.pickupPoint.latitude, pickupLongitude: v.pickupPoint.longitude } : {}),
    ...(v.storageRequirement ? { storageRequirement: v.storageRequirement } : {}),
    ...(v.description ? { description: v.description } : {}),
  };
}

export function DonationFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const donation = useQuery({ queryKey: ['donation', id], queryFn: () => donationsApi.get(id!), enabled: editing });
  const org = useQuery({ queryKey: ['organization', 'mine'], queryFn: organizationApi.mine, enabled: !editing });
  const categories = useQuery({ queryKey: ['categories'], queryFn: categoriesApi.list, staleTime: 30 * 60_000 });

  const back = editing ? `/provider/donations/${id}` : '/provider/donations';
  const header = (
    <>
      <Link to={back} className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> {editing ? 'Back to donation' : 'My donations'}
      </Link>
      <PageHeader
        title={editing ? 'Edit donation' : 'New donation'}
        description={editing ? undefined : 'Describe the surplus food. Nearby verified recipients are matched as soon as you save.'}
      />
    </>
  );

  const loading = (editing && donation.isPending) || (!editing && org.isPending) || categories.isPending;
  const failed = donation.error ?? categories.error;
  if (loading)
    return (
      <>
        {header}
        <Skeleton className="h-96" />
      </>
    );
  if (failed)
    return (
      <>
        {header}
        <Alert tone="danger">{errorMessage(failed)}</Alert>
      </>
    );
  if (editing && donation.data && !EDITABLE.includes(donation.data.donation.status)) {
    return (
      <>
        {header}
        <Alert tone="warning" title="This donation can no longer be edited">
          Donations can be edited only while they are available. Once a recipient accepts, the details are locked so the pickup stays
          reliable.
        </Alert>
      </>
    );
  }

  return (
    <>
      {header}
      <DonationForm
        existing={donation.data?.donation}
        defaultAddress={org.data?.organization.address ?? ''}
        categories={categories.data!.categories.map((c) => c.name)}
      />
    </>
  );
}

function DonationForm({ existing, defaultAddress, categories }: { existing?: DonationDetail; defaultAddress: string; categories: string[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const now = new Date();

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: existing
      ? {
          foodName: existing.foodName,
          category: existing.category,
          foodType: existing.foodType,
          quantity: existing.quantity,
          unit: existing.unit,
          availableFrom: toLocalInput(existing.availableFrom),
          availableUntil: toLocalInput(existing.availableUntil),
          pickupLocation: existing.pickupLocation,
          customLocation: existing.pickupLatitude !== null,
          pickupPoint:
            existing.pickupLatitude !== null && existing.pickupLongitude !== null
              ? { latitude: existing.pickupLatitude, longitude: existing.pickupLongitude }
              : null,
          storageRequirement: existing.storageRequirement ?? '',
          description: existing.description ?? '',
        }
      : {
          foodName: '',
          category: '',
          foodType: '',
          quantity: undefined as unknown as number,
          unit: 'meals',
          availableFrom: toLocalInput(now),
          availableUntil: toLocalInput(new Date(now.getTime() + 4 * 3600_000)),
          pickupLocation: defaultAddress,
          customLocation: false,
          pickupPoint: null,
          storageRequirement: '',
          description: '',
        },
  });

  const save = useMutation({
    mutationFn: (v: Values) => (existing ? donationsApi.update(existing.id, toInput(v)) : donationsApi.create(toInput(v))),
    onSuccess: ({ donation }) => {
      queryClient.invalidateQueries({ queryKey: ['donations'] });
      queryClient.invalidateQueries({ queryKey: ['donation', donation.id] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(existing ? 'Donation updated' : 'Donation listed. Matching nearby recipients…');
      navigate(`/provider/donations/${donation.id}`, { replace: true });
    },
    onError: (err) => {
      const message = applyServerErrors(err, form.setError, SERVER_FIELDS);
      if (message) setError(message);
    },
  });

  const { errors } = form.formState;
  const customLocation = form.watch('customLocation');
  const reg = (name: keyof Values) => form.register(name);

  return (
    <form
      onSubmit={form.handleSubmit((v) => {
        setError(null);
        save.mutate(v);
      })}
      className="flex flex-col gap-6"
      noValidate
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <Card>
        <CardHeader title="Food" />
        <CardBody className="grid gap-5 sm:grid-cols-2">
          <Field label="What is it?" required hint="For example: Vegetable biryani" error={errors.foodName?.message} className="sm:col-span-2">
            {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...reg('foodName')} />}
          </Field>
          <Field label="Category" required error={errors.category?.message}>
            {({ id, describedBy, invalid }) => (
              <Select id={id} aria-describedby={describedBy} aria-invalid={invalid} {...reg('category')}>
                <option value="" disabled>
                  Choose a category
                </option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Type" required hint="Vegetarian, Non-vegetarian, Bread…" error={errors.foodType?.message}>
            {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...reg('foodType')} />}
          </Field>
          <Field label="Quantity" required error={errors.quantity?.message}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                {...form.register('quantity', { valueAsNumber: true })}
              />
            )}
          </Field>
          <Field label="Unit" required error={errors.unit?.message}>
            {({ id, describedBy, invalid }) => (
              <>
                <Input id={id} list="unit-options" aria-describedby={describedBy} aria-invalid={invalid} {...reg('unit')} />
                <datalist id="unit-options">
                  {UNITS.map((u) => (
                    <option key={u} value={u} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field label="Storage" hint="For example: Keep refrigerated" error={errors.storageRequirement?.message} className="sm:col-span-2">
            {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...reg('storageRequirement')} />}
          </Field>
          <Field label="Notes for the recipient" error={errors.description?.message} className="sm:col-span-2">
            {({ id, describedBy, invalid }) => <Textarea id={id} rows={3} aria-describedby={describedBy} aria-invalid={invalid} {...reg('description')} />}
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Pickup" description="Recipients can only accept while the window is open; it expires automatically afterwards." />
        <CardBody className="grid gap-5 sm:grid-cols-2">
          <Field label="Available from" required error={errors.availableFrom?.message}>
            {({ id, describedBy, invalid }) => <Input id={id} type="datetime-local" aria-describedby={describedBy} aria-invalid={invalid} {...reg('availableFrom')} />}
          </Field>
          <Field label="Pick up by" required error={errors.availableUntil?.message}>
            {({ id, describedBy, invalid }) => <Input id={id} type="datetime-local" aria-describedby={describedBy} aria-invalid={invalid} {...reg('availableUntil')} />}
          </Field>
          <Field label="Pickup address" required error={errors.pickupLocation?.message} className="sm:col-span-2">
            {({ id, describedBy, invalid }) => <Input id={id} autoComplete="street-address" aria-describedby={describedBy} aria-invalid={invalid} {...reg('pickupLocation')} />}
          </Field>
          <label className="flex cursor-pointer items-start gap-3 sm:col-span-2">
            <input type="checkbox" className="mt-1 size-4 cursor-pointer accent-[var(--color-primary)]" {...form.register('customLocation')} />
            <span>
              <span className="block text-sm font-medium">Pickup is somewhere other than my organization</span>
              <span className="block text-sm text-muted-foreground">Otherwise matching uses your organization’s location.</span>
            </span>
          </label>
          {customLocation && (
            <div className="sm:col-span-2">
              <Controller
                control={form.control}
                name="pickupPoint"
                render={({ field }) => <LocationPicker value={field.value} onChange={field.onChange} error={errors.pickupPoint?.message} />}
              />
            </div>
          )}
        </CardBody>
      </Card>

      <div className="flex flex-wrap justify-end gap-3">
        <Button asChild variant="secondary">
          <Link to={existing ? `/provider/donations/${existing.id}` : '/provider/donations'}>Cancel</Link>
        </Button>
        <Button type="submit" loading={save.isPending}>
          {existing ? 'Save changes' : 'List donation'}
        </Button>
      </div>
    </form>
  );
}
