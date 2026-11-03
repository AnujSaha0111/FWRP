import { Navigate, Outlet, useLocation } from 'react-router';
import type { Role } from '@/api/types';
import { ROLE_HOME, useAuth } from './AuthProvider';

function FullPageSpinner() {
  return (
    <div className="flex min-h-dvh items-center justify-center" role="status" aria-live="polite">
      <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** Signed-in users only; remembers where they were going. */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

/** Restricts a route subtree to one role; others go to their own home. */
export function RequireRole({ role }: { role: Role }) {
  const { profile } = useAuth();
  if (!profile) return null;
  if (profile.user.role !== role) return <Navigate to={ROLE_HOME[profile.user.role]} replace />;
  return <Outlet />;
}

/** Auth pages: signed-in users are sent to their home instead. */
export function PublicOnly() {
  const { status, profile } = useAuth();
  if (status === 'loading') return <FullPageSpinner />;
  if (profile) return <Navigate to={ROLE_HOME[profile.user.role]} replace />;
  return <Outlet />;
}

export function RoleHomeRedirect() {
  const { status, profile } = useAuth();
  if (status === 'loading') return <FullPageSpinner />;
  return <Navigate to={profile ? ROLE_HOME[profile.user.role] : '/login'} replace />;
}
