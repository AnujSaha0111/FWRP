import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, HandHeart, Package, Truck } from 'lucide-react';
import { useState, type ComponentType } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { z } from 'zod';
import { authApi } from '@/api/endpoints';
import type { OrganizationType } from '@/api/types';
import { ROLE_HOME, useAuth } from '@/auth/AuthProvider';
import { LocationPicker } from '@/components/map/LocationPicker';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form-controls';
import { Alert } from '@/components/ui/surface';
import { applyServerErrors } from '@/lib/forms';
import { titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AuthLayout } from './AuthLayout';

type RegRole = 'PROVIDER' | 'RECIPIENT' | 'VOLUNTEER';

const ROLES: Array<{ role: RegRole; title: string; text: string; icon: ComponentType<{ className?: string }> }> = [
  { role: 'PROVIDER', title: 'I have surplus food', text: 'Restaurants, hotels, cafeterias, caterers and stores listing food to donate.', icon: Package },
  { role: 'RECIPIENT', title: 'We need food', text: 'Shelters, NGOs, food banks and community kitchens receiving donations.', icon: HandHeart },
  { role: 'VOLUNTEER', title: 'I can deliver', text: 'Volunteers who pick up donations and drive them to recipients.', icon: Truck },
];

const ORG_TYPES: Record<'PROVIDER' | 'RECIPIENT', OrganizationType[]> = {
  PROVIDER: ['RESTAURANT', 'HOTEL', 'CAFETERIA', 'SUPERMARKET', 'EVENT_ORGANIZER', 'OTHER'],
  RECIPIENT: ['NGO', 'SHELTER', 'COMMUNITY_KITCHEN', 'FOOD_BANK', 'OTHER'],
};

const schema = z
  .object({
    role: z.enum(['PROVIDER', 'RECIPIENT', 'VOLUNTEER']),
    name: z.string().trim().min(1, 'Enter your name').max(200),
    email: z.email('Enter a valid email address'),
    phone: z.string().trim().regex(/^\+?[0-9\s\-()]{7,20}$/, 'Enter a valid phone number, e.g. +91 98450 12345'),
    password: z.string().min(8, 'Use at least 8 characters').max(128),
    orgName: z.string().trim().max(200).optional(),
    organizationType: z.string().optional(),
    address: z.string().trim().max(500).optional(),
    location: z.object({ latitude: z.number(), longitude: z.number() }).nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.role === 'VOLUNTEER') return;
    if (!v.orgName) ctx.addIssue({ code: 'custom', path: ['orgName'], message: 'Enter your organization name' });
    if (!v.address) ctx.addIssue({ code: 'custom', path: ['address'], message: 'Enter the street address' });
    if (!v.location) ctx.addIssue({ code: 'custom', path: ['location'], message: 'Place the pin on your location' });
    else if (v.location.latitude === 0 && v.location.longitude === 0) {
      ctx.addIssue({ code: 'custom', path: ['location'], message: 'Choose your real location' });
    }
  });

type Values = z.infer<typeof schema>;

const SERVER_FIELDS = ['name', 'email', 'phone', 'password', 'orgName', 'address', 'organizationType'] as const;

export function RegisterPage() {
  const [role, setRole] = useState<RegRole | null>(null);

  return (
    <AuthLayout
      title={role ? 'Create your account' : 'Join FWRP'}
      description={role ? ROLES.find((r) => r.role === role)!.text : 'Tell us how you will use the platform.'}
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      {role ? <RegisterForm role={role} onBack={() => setRole(null)} /> : <RolePicker onPick={setRole} />}
    </AuthLayout>
  );
}

function RolePicker({ onPick }: { onPick: (role: RegRole) => void }) {
  return (
    <fieldset>
      <legend className="sr-only">Choose your role</legend>
      <div className="flex flex-col gap-3">
        {ROLES.map(({ role, title, text, icon: Icon }) => (
          <button
            key={role}
            type="button"
            onClick={() => onPick(role)}
            className="flex cursor-pointer items-start gap-4 rounded-card border border-border bg-card p-4 text-left shadow-card transition-colors duration-200 hover:border-primary hover:bg-primary-soft"
          >
            <span className="rounded-lg bg-primary-soft p-2.5 text-primary">
              <Icon className="size-5" aria-hidden="true" />
            </span>
            <span>
              <span className="block font-medium">{title}</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">{text}</span>
            </span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function RegisterForm({ role, onBack }: { role: RegRole; onBack: () => void }) {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const needsOrg = role !== 'VOLUNTEER';

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      role,
      name: '',
      email: '',
      phone: '',
      password: '',
      orgName: '',
      address: '',
      organizationType: needsOrg ? ORG_TYPES[role][0] : undefined,
      location: null,
    },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(v: Values) {
    setError(null);
    const email = v.email.trim().toLowerCase();
    try {
      await authApi.register({
        role,
        name: v.name,
        email,
        phone: v.phone,
        password: v.password,
        ...(needsOrg
          ? {
              orgName: v.orgName,
              address: v.address,
              organizationType: v.organizationType as OrganizationType,
              latitude: v.location!.latitude,
              longitude: v.location!.longitude,
            }
          : {}),
      });
      const profile = await login(email, v.password);
      navigate(ROLE_HOME[profile.user.role], { replace: true });
    } catch (err) {
      const message = applyServerErrors(err, form.setError, SERVER_FIELDS);
      if (message) setError(message);
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
      <button type="button" onClick={onBack} className="-mt-2 flex w-fit cursor-pointer items-center gap-1 rounded-md text-sm font-medium text-primary hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Change role
      </button>
      {error && <Alert tone="danger">{error}</Alert>}

      <Field label="Your name" required error={errors.name?.message}>
        {({ id, describedBy, invalid }) => <Input id={id} autoComplete="name" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('name')} />}
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Email" required error={errors.email?.message}>
          {({ id, describedBy, invalid }) => <Input id={id} type="email" autoComplete="email" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('email')} />}
        </Field>
        <Field label="Phone" required error={errors.phone?.message}>
          {({ id, describedBy, invalid }) => <Input id={id} type="tel" autoComplete="tel" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('phone')} />}
        </Field>
      </div>
      <Field label="Password" required hint="At least 8 characters." error={errors.password?.message}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('password')} />
        )}
      </Field>

      {needsOrg && (
        <fieldset className="flex flex-col gap-5 border-t border-border pt-5">
          <legend className="float-left mb-1 w-full text-base font-semibold">Your organization</legend>
          <div className="grid gap-5 sm:grid-cols-[1fr_12rem]">
            <Field label="Organization name" required error={errors.orgName?.message}>
              {({ id, describedBy, invalid }) => <Input id={id} autoComplete="organization" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('orgName')} />}
            </Field>
            <Field label="Type" required>
              {({ id }) => (
                <Select id={id} {...form.register('organizationType')}>
                  {ORG_TYPES[role].map((t) => (
                    <option key={t} value={t}>
                      {titleCase(t)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Street address" required error={errors.address?.message}>
            {({ id, describedBy, invalid }) => <Input id={id} autoComplete="street-address" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('address')} />}
          </Field>
          <div className="flex flex-col gap-1.5">
            <p className={cn('text-sm font-medium')}>
              Location on the map<span className="ml-0.5 text-destructive" aria-hidden="true">*</span>
            </p>
            <p className="text-sm text-muted-foreground">Used to match you with nearby {role === 'PROVIDER' ? 'recipients' : 'donations'}.</p>
            <Controller
              control={form.control}
              name="location"
              render={({ field }) => <LocationPicker value={field.value} onChange={field.onChange} error={errors.location?.message} />}
            />
          </div>
          <p className="text-sm text-muted-foreground">An administrator verifies new organizations before they can take part in matching.</p>
        </fieldset>
      )}

      <Button type="submit" size="lg" loading={isSubmitting}>
        Create account
      </Button>
    </form>
  );
}
