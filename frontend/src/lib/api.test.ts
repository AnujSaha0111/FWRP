import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setSessionExpiredHandler } from './api';

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => setSessionExpiredHandler(null));

describe('api client', () => {
  it('unwraps the data envelope and sends cookies with JSON bodies', async () => {
    const fetchMock = vi.fn(async () => respond(200, { success: true, data: { ok: 1 } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/api/x', { method: 'POST', body: { a: 1 }, query: { page: 2, empty: '' } })).resolves.toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/x?page=2');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: '{"a":1}' });
  });

  it('turns error envelopes into ApiError with field details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: [{ field: 'email', message: 'Taken' }] } })
      )
    );
    const err = await api('/api/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect((err as ApiError).fieldError('email')).toBe('Taken');
  });

  it('refreshes the session once on 401 and retries the request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Token expired' } }))
      .mockResolvedValueOnce(respond(200, { success: true, data: {} }))
      .mockResolvedValueOnce(respond(200, { success: true, data: { again: true } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/api/notifications')).resolves.toEqual({ again: true });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/notifications', '/api/auth/refresh', '/api/notifications']);
  });

  it('reports an expired session when the refresh fails', async () => {
    const expired = vi.fn();
    setSessionExpiredHandler(expired);
    vi.stubGlobal('fetch', vi.fn(async () => respond(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Session expired' } })));
    await expect(api('/api/users/me')).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('never refresh-loops on the auth endpoints themselves', async () => {
    const fetchMock = vi.fn(async () => respond(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Bad credentials' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/api/auth/login', { method: 'POST', body: {} })).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps network failures to a friendly error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(api('/api/x')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
