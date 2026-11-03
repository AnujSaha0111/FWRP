import { zodResolver } from '@hookform/resolvers/zod';
import { MailCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { authApi } from '@/api/endpoints';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form-controls';
import { Alert } from '@/components/ui/surface';
import { ApiError, errorMessage } from '@/lib/api';
import { AuthLayout } from './AuthLayout';

const backToLogin = (
  <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
    Back to sign in
  </Link>
);

const forgotSchema = z.object({ email: z.email('Enter a valid email address') });

export function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof forgotSchema>>({ resolver: zodResolver(forgotSchema), defaultValues: { email: '' } });

  async function onSubmit({ email }: z.infer<typeof forgotSchema>) {
    setError(null);
    try {
      await authApi.forgotPassword(email.trim().toLowerCase());
      setSentTo(email.trim());
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (sentTo) {
    return (
      <AuthLayout title="Check your email" footer={backToLogin}>
        <div className="flex flex-col items-center gap-3 rounded-card border border-border bg-card p-6 text-center shadow-card">
          <span className="rounded-full bg-primary-soft p-3 text-primary">
            <MailCheck className="size-6" aria-hidden="true" />
          </span>
          <p>
            If an account exists for <strong className="font-medium">{sentTo}</strong>, we sent a link to reset the password. It works once and
            expires in 30 minutes.
          </p>
          <p className="text-sm text-muted-foreground">No email? Check spam, or try again in a few minutes.</p>
        </div>
      </AuthLayout>
    );
  }

  const { errors, isSubmitting } = form.formState;
  return (
    <AuthLayout title="Reset your password" description="Enter your account email and we will send you a reset link." footer={backToLogin}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Email" error={errors.email?.message}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="email" autoComplete="email" autoFocus aria-describedby={describedBy} aria-invalid={invalid} {...form.register('email')} />
          )}
        </Field>
        <Button type="submit" size="lg" loading={isSubmitting}>
          Send reset link
        </Button>
      </form>
    </AuthLayout>
  );
}

const resetSchema = z
  .object({
    newPassword: z.string().min(8, 'Use at least 8 characters').max(128),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'The passwords do not match' });

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof resetSchema>>({ resolver: zodResolver(resetSchema), defaultValues: { newPassword: '', confirm: '' } });

  async function onSubmit({ newPassword }: z.infer<typeof resetSchema>) {
    setError(null);
    try {
      await authApi.resetPassword(token, newPassword);
      navigate('/login', { replace: true, state: { notice: 'Password changed. Sign in with your new password.' } });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'INVALID_RESET_TOKEN'
          ? 'This reset link is invalid, already used, or expired. Request a new one.'
          : errorMessage(err)
      );
    }
  }

  if (!token) {
    return (
      <AuthLayout title="Reset link missing" footer={backToLogin}>
        <Alert tone="warning">
          Open the link from your reset email, or{' '}
          <Link to="/forgot-password" className="font-medium text-primary underline">
            request a new one
          </Link>
          .
        </Alert>
      </AuthLayout>
    );
  }

  const { errors, isSubmitting } = form.formState;
  return (
    <AuthLayout title="Choose a new password" description="Signing in elsewhere will end once you change it." footer={backToLogin}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
        {error && (
          <Alert tone="danger">
            {error}{' '}
            <Link to="/forgot-password" className="font-medium underline">
              Request a new link
            </Link>
          </Alert>
        )}
        <Field label="New password" hint="At least 8 characters." error={errors.newPassword?.message}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="password" autoComplete="new-password" autoFocus aria-describedby={describedBy} aria-invalid={invalid} {...form.register('newPassword')} />
          )}
        </Field>
        <Field label="Confirm new password" error={errors.confirm?.message}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('confirm')} />
          )}
        </Field>
        <Button type="submit" size="lg" loading={isSubmitting}>
          Change password
        </Button>
      </form>
    </AuthLayout>
  );
}
