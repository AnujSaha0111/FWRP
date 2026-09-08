import type { Organization, OrganizationsPage, VerificationStatus } from './types';

export class ApiRequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: T;
    error?: { code?: string; message?: string };
  } | null;
  if (!res.ok || body?.success === false) {
    throw new ApiRequestError(res.status, body?.error?.code ?? 'REQUEST_FAILED', body?.error?.message ?? `Request failed (${res.status})`);
  }
  return (body as { data: T }).data;
}

export const adminOrganizationsApi = {
  list: (status?: VerificationStatus | ''): Promise<OrganizationsPage> =>
    apiFetch<OrganizationsPage>(`/api/admin/organizations${status ? `?status=${status}` : ''}`),
  review: (id: string): Promise<{ organization: Organization }> =>
    apiFetch(`/api/admin/organizations/${id}/review`, { method: 'PUT' }),
  verify: (id: string, action: 'VERIFY' | 'REJECT', reason?: string): Promise<{ organization: Organization }> =>
    apiFetch(`/api/admin/organizations/${id}/verify`, {
      method: 'PUT',
      body: JSON.stringify(reason === undefined ? { action } : { action, reason }),
    }),
};

export const myOrganizationApi = {
  get: (): Promise<{ organization: Organization }> => apiFetch('/api/organizations/me'),
};
