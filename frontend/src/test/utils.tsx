import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import { createQueryClient, Providers } from '@/App';
import { routes } from '@/router';

type Handler = (body: unknown, url: URL) => { status?: number; data?: unknown; error?: unknown } | undefined;

/**
 * Fake backend: `"METHOD /api/path"` → handler. Unknown routes answer 404, and
 * every call is recorded so tests can assert on payloads.
 */
export function mockApi(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    const handler = handlers[`${method} ${url.pathname}`];
    const result = handler?.(body, url);
    if (!result) {
      return new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }), { status: 404 });
    }
    const status = result.status ?? 200;
    const payload = status >= 400 ? { success: false, error: result.error } : { success: true, data: result.data };
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

export function renderRoute(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  const utils = render(
    <Providers client={client}>
      <RouterProvider router={router} />
    </Providers>
  );
  return { ...utils, router, client };
}

export function profile(role: 'PROVIDER' | 'RECIPIENT' | 'VOLUNTEER' | 'ADMIN' = 'PROVIDER', verification = 'VERIFIED') {
  return {
    user: {
      id: `u-${role.toLowerCase()}`,
      name: 'Ravi Kumar',
      email: 'ravi@example.com',
      phone: '+91 98450 10000',
      role,
      organizationId: role === 'PROVIDER' || role === 'RECIPIENT' ? 'org-1' : null,
      status: 'ACTIVE',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
    organization:
      role === 'PROVIDER' || role === 'RECIPIENT'
        ? { id: 'org-1', name: 'Spice Route', type: 'RESTAURANT', address: '12 MG Road', verificationStatus: verification }
        : null,
  };
}

export const emptyPage = { items: [], total: 0, page: 1, limit: 20, totalPages: 1, hasNext: false, hasPrev: false };
