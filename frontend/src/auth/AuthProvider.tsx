import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { authApi, profileApi } from '@/api/endpoints';
import type { Profile, Role } from '@/api/types';
import { ApiError, setSessionExpiredHandler } from '@/lib/api';

// Session state = the current user's profile (GET /api/users/me). The access
// token lives in an httpOnly cookie, so the app never touches tokens; the API
// client refreshes it transparently and calls the expiry handler when the
// session cannot be renewed (suspended account, password reset, signed out).

export const SESSION_KEY = ['session'] as const;

type Status = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: Status;
  profile: Profile | null;
  login: (email: string, password: string) => Promise<Profile>;
  logout: () => Promise<void>;
  reload: () => Promise<unknown>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function loadSession(): Promise<Profile | null> {
  try {
    return await profileApi.me();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: SESSION_KEY, queryFn: loadSession, staleTime: 5 * 60_000, retry: false });

  useEffect(() => {
    setSessionExpiredHandler(() => {
      queryClient.setQueryData(SESSION_KEY, null);
      // Drop every cached page of the previous session.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] });
    });
    return () => setSessionExpiredHandler(null);
  }, [queryClient]);

  const login = useCallback(
    async (email: string, password: string) => {
      await authApi.login(email, password);
      const profile = await profileApi.me();
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] });
      queryClient.setQueryData(SESSION_KEY, profile);
      return profile;
    },
    [queryClient]
  );

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => undefined);
    queryClient.clear();
    queryClient.setQueryData(SESSION_KEY, null);
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    const status: Status = session.isPending ? 'loading' : session.data ? 'authenticated' : 'anonymous';
    return { status, profile: session.data ?? null, login, logout, reload: () => session.refetch() };
  }, [session, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Signed-in profile; only call inside routes guarded by <RequireAuth>. */
export function useProfile(): Profile {
  const { profile } = useAuth();
  if (!profile) throw new Error('useProfile used outside an authenticated route');
  return profile;
}

export const ROLE_HOME: Record<Role, string> = {
  PROVIDER: '/provider',
  RECIPIENT: '/recipient',
  VOLUNTEER: '/volunteer',
  ADMIN: '/admin',
};

export const ROLE_LABEL: Record<Role, string> = {
  PROVIDER: 'Food provider',
  RECIPIENT: 'Recipient organization',
  VOLUNTEER: 'Volunteer',
  ADMIN: 'Administrator',
};
