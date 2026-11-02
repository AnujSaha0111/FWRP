# Security (SEC-01..03)

Builds on the existing auth design: bcrypt password hashes, HS256 JWTs in
httpOnly cookies (ADR 002), helmet, CORS, role checks, and services that
re-check account status.

## SEC-01 Rate limiting

In-memory fixed-window limits on the auth endpoints (`middleware/rateLimit.ts`);
`429 RATE_LIMITED` with `Retry-After` and `RateLimit-*` headers.

| Endpoint | Limit |
|---|---|
| `POST /api/auth/login` | 10 / 15 min per IP + email; 50 / 15 min per IP |
| `POST /api/auth/register` | 20 / hour per IP |
| `POST /api/auth/refresh` | 120 / 15 min per IP |
| `POST /api/auth/forgot-password` | 10 / 15 min per IP; 3 / hour per email |
| `POST /api/auth/reset-password` | 20 / 15 min per IP |

- `RATE_LIMIT_ENABLED` (default on; off under `NODE_ENV=test`).
- Behind a proxy or load balancer set `TRUST_PROXY_HOPS` so limits key on the
  real client IP.
- Counters are per server instance; several instances need a shared store
  (e.g. Redis).

## SEC-02 Password reset by email

1. `POST /api/auth/forgot-password { email }` → always `202` with the same
   message, so it never reveals whether an account exists. For an active
   account it invalidates earlier links, stores a new single-use token (SHA-256
   hash only) and emails `APP_BASE_URL/reset-password?token=…`, valid for
   `PASSWORD_RESET_TTL_MINUTES` (30).
2. `POST /api/auth/reset-password { token, newPassword }` → sets the password
   (same policy as registration), consumes the token and ends every session.
   Invalid, used or expired links answer `400 INVALID_RESET_TOKEN`.

The admin reset (`PUT /api/admin/users/:id/password`) remains for support.

## SEC-03 Session revocation

Each user has a `tokenVersion`; issued tokens carry it (`tv`). Every refresh
looks the account up and requires it to be `ACTIVE` with a matching version,
then re-issues claims from the current row (role and organization changes
apply). Bumping the version revokes all refresh tokens:

| Event | Effect |
|---|---|
| Self password change | Other sessions end; the current device gets fresh cookies |
| Password reset (email or admin) | All sessions end |
| Account suspended / deleted | All sessions end |

Access tokens are short-lived (`JWT_ACCESS_EXPIRES_IN`, 15 min) and are not
looked up per request; services already reject inactive accounts.

## Not included

- Address geocoding (PRD §13 assumption 5): coordinates are entered with the
  organization or donation; no external mapping service is called.
- Multi-factor authentication, account lockout beyond rate limits, and CSRF
  tokens (cookies are `SameSite=Lax`; state-changing routes are JSON-only).
