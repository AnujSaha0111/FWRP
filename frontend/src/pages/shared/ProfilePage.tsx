import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { authApi, organizationApi, profileApi } from '@/api/endpoints';
import type { Organization } from '@/api/types';
import { ROLE_LABEL, SESSION_KEY, useProfile } from '@/auth/AuthProvider';
import { LocationPicker } from '@/components/map/LocationPicker';
import { VerificationBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form-controls';
import { Alert, Card, CardBody, CardHeader, PageHeader, Skeleton } from '@/components/ui/surface';
import { ApiError } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { titleCase } from '@/lib/format';

export function ProfilePage() {
  const { user, organization } = useProfile();
  return (
    <>
      <PageHeader title="Profile" description={`${ROLE_LABEL[user.role]} account`} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <PersonalCard />
          <PasswordCard />
        </div>
        {organization && <OrganizationCard />}
      </div>
    </>
  );
}

const personalSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(200),
  phone: z.string().trim().regex(/^\+?[0-9\s\-()]{7,20}$/, 'Enter a valid phone number'),
});

function PersonalCard() {
  const { user } = useProfile();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof personalSchema>>({
    resolver: zodResolver(personalSchema),
    defaultValues: { name: user.name, phone: user.phone },
  });

  async function onSubmit(values: z.infer<typeof personalSchema>) {
    setError(null);
    try {
      const profile = await profileApi.update(values);
      queryClient.setQueryData(SESSION_KEY, profile);
      form.reset(values);
      toast.success('Profile saved');
    } catch (err) {
      const message = applyServerErrors(err, form.setError, ['name', 'phone'] as const);
      if (message) setError(message);
    }
  }

  const { errors, isSubmitting, isDirty } = form.formState;
  return (
    <Card>
      <CardHeader title="Personal details" description={user.email} />
      <CardBody>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Name" error={errors.name?.message}>
            {({ id, describedBy, invalid }) => <Input id={id} autoComplete="name" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('name')} />}
          </Field>
          <Field label="Phone" error={errors.phone?.message}>
            {({ id, describedBy, invalid }) => <Input id={id} type="tel" autoComplete="tel" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('phone')} />}
          </Field>
          <div>
            <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
              Save changes
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z.string().min(8, 'Use at least 8 characters').max(128),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'The passwords do not match' });

function PasswordCard() {
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
  });

  async function onSubmit(v: z.infer<typeof passwordSchema>) {
    setError(null);
    try {
      await authApi.changePassword(v.currentPassword, v.newPassword);
      form.reset();
      toast.success('Password changed. Other devices have been signed out.');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        form.setError('currentPassword', { type: 'server', message: 'Current password is incorrect' });
      } else {
        const message = applyServerErrors(err, form.setError, ['currentPassword', 'newPassword'] as const);
        if (message) setError(message);
      }
    }
  }

  const { errors, isSubmitting } = form.formState;
  return (
    <Card>
      <CardHeader title="Change password" description="Changing it signs you out on other devices." />
      <CardBody>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Current password" error={errors.currentPassword?.message}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="password" autoComplete="current-password" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('currentPassword')} />
            )}
          </Field>
          <Field label="New password" hint="At least 8 characters." error={errors.newPassword?.message}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('newPassword')} />
            )}
          </Field>
          <Field label="Confirm new password" error={errors.confirm?.message}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('confirm')} />
            )}
          </Field>
          <div>
            <Button type="submit" loading={isSubmitting}>
              Change password
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

const orgSchema = z.object({
  name: z.string().trim().min(1, 'Enter the organization name').max(200),
  address: z.string().trim().min(1, 'Enter the address').max(500),
  contactInformation: z.string().trim().max(500),
  location: z.object({ latitude: z.number(), longitude: z.number() }).nullable(),
}).superRefine((v, ctx) => {
  if (!v.location) ctx.addIssue({ code: 'custom', path: ['location'], message: 'Place the pin on your location' });
});

function OrganizationCard() {
  const org = useQuery({ queryKey: ['organization', 'mine'], queryFn: organizationApi.mine });
  return (
    <Card>
      <CardHeader
        title="Organization"
        description={org.data ? titleCase(org.data.organization.type) : undefined}
        action={org.data && <VerificationBadge status={org.data.organization.verificationStatus} />}
      />
      <CardBody>
        {org.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
            <Skeleton className="h-64" />
          </div>
        ) : org.isError ? (
          <Alert tone="danger">Could not load your organization.</Alert>
        ) : (
          <OrganizationForm organization={org.data.organization} />
        )}
      </CardBody>
    </Card>
  );
}

function OrganizationForm({ organization }: { organization: Organization }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof orgSchema>>({
    resolver: zodResolver(orgSchema),
    defaultValues: {
      name: organization.name,
      address: organization.address,
      contactInformation: organization.contactInformation ?? '',
      location: { latitude: organization.latitude, longitude: organization.longitude },
    },
  });

  const save = useMutation({
    mutationFn: (v: z.infer<typeof orgSchema>) =>
      organizationApi.update({
        name: v.name,
        address: v.address,
        ...(v.contactInformation ? { contactInformation: v.contactInformation } : {}),
        latitude: v.location!.latitude,
        longitude: v.location!.longitude,
      }),
    onSuccess: async (data, v) => {
      queryClient.setQueryData(['organization', 'mine'], data);
      await queryClient.invalidateQueries({ queryKey: SESSION_KEY });
      form.reset(v);
      toast.success('Organization saved');
    },
    onError: (err) => {
      const message = applyServerErrors(err, form.setError, ['name', 'address', 'contactInformation'] as const);
      if (message) setError(message);
    },
  });

  const { errors, isDirty } = form.formState;
  return (
    <form
      onSubmit={form.handleSubmit((v) => {
        setError(null);
        save.mutate(v);
      })}
      className="flex flex-col gap-4"
      noValidate
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Name" error={errors.name?.message}>
        {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('name')} />}
      </Field>
      <Field label="Street address" error={errors.address?.message}>
        {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('address')} />}
      </Field>
      <Field label="Contact (email or phone)" hint="Shown to volunteers and partners for coordination." error={errors.contactInformation?.message}>
        {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('contactInformation')} />}
      </Field>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">Location</p>
        <p className="text-sm text-muted-foreground">Moving the pin re-scores your matches with the new distances.</p>
        <Controller
          control={form.control}
          name="location"
          render={({ field }) => <LocationPicker value={field.value} onChange={field.onChange} error={errors.location?.message} height={220} />}
        />
      </div>
      <div>
        <Button type="submit" loading={save.isPending} disabled={!isDirty}>
          Save organization
        </Button>
      </div>
    </form>
  );
}
