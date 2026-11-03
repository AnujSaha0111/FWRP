// Thin fetch wrapper for the FWRP API.
//
// - Same-origin `/api/...` paths (Vite proxies them in development), so the
//   httpOnly session cookies are sent automatically (`credentials: 'include'`).
// - Unwraps the `{ success, data }` envelope; failures become ApiError with the
//   backend's code, message and per-field details.
// - On a 401 it refreshes the session once (single-flight) and retries, so an
//   expired 15-minute access token never interrupts the user. Auth endpoints
//   themselves are never retried.

export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: FieldError[];

  constructor(status: number, code: string, message: string, details: FieldError[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Message for one form field, if the backend reported one. */
  fieldError(field: string): string | undefined {
    return this.details.find((d) => d.field === field)?.message;
  }
}

type Json = Record<string, unknown> | unknown[];

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: Json;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Skip the refresh-and-retry step (used by the auth endpoints). */
  noRefresh?: boolean;
}

const NO_REFRESH_PATHS = ['/api/auth/login', '/api/auth/refresh', '/api/auth/logout', '/api/auth/register'];

let refreshing: Promise<boolean> | null = null;
let onSessionExpired: (() => void) | null = null;

/** Called when the session cannot be refreshed (the app returns to the login page). */
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function send(url: string, options: RequestOptions): Promise<Response> {
  return fetch(url, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
}

async function refreshSession(): Promise<boolean> {
  refreshing ??= send('/api/auth/refresh', { method: 'POST' })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

async function toError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: FieldError[] };
  } | null;
  const fallback = res.status === 429 ? 'Too many attempts, please wait and try again' : `Request failed (${res.status})`;
  return new ApiError(
    res.status,
    body?.error?.code ?? 'REQUEST_FAILED',
    body?.error?.message ?? fallback,
    Array.isArray(body?.error?.details) ? body!.error!.details! : []
  );
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, options.query);
  let res: Response;
  try {
    res = await send(url, options);
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }

  const mayRefresh = !options.noRefresh && !NO_REFRESH_PATHS.includes(path);
  if (res.status === 401 && mayRefresh) {
    if (await refreshSession()) {
      res = await send(url, options);
    } else {
      onSessionExpired?.();
    }
  }

  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as { data?: T } | null;
  return body?.data as T;
}

/** Plain-text download (CSV reports). */
export async function apiDownload(path: string, query?: RequestOptions['query']): Promise<Blob> {
  const res = await fetch(buildUrl(path, query), { credentials: 'include' });
  if (!res.ok) throw await toError(res);
  return res.blob();
}

/** Human-friendly message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
