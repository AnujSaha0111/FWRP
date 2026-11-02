import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// SEC-03: refresh looks the account up — mock the global Prisma client.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { refreshUser } from '../services/auth.service';
import { signRefreshToken } from '../utils/jwt';
import { authenticate } from '../middleware/auth';
import { errorMiddleware } from '../middleware/error';
import { env } from '../config/env';

// AUTH-05: refresh rotation. SEC-03: one account lookup per refresh — the
// user must be ACTIVE and the token's session version must be current.

const CLAIMS = { id: 'user-1', email: 'alice@example.com', role: 'PROVIDER' as const, organizationId: 'org-1' };

function mockAccount(overrides: Record<string, unknown> = {}) {
  const findUnique = vi.fn(async () => ({ ...CLAIMS, status: 'ACTIVE', tokenVersion: 0, ...overrides }));
  vi.mocked(getPrisma).mockReturnValue({ user: { findUnique } } as unknown as PrismaClient);
  return findUnique;
}

beforeEach(() => {
  mockAccount();
});

function expiredRefreshToken(): string {
  return jwt.sign(
    { ...CLAIMS, exp: Math.floor(Date.now() / 1000) - 60 },
    env.JWT_REFRESH_SECRET,
    { algorithm: 'HS256' },
  );
}

// A still-valid refresh token minted 2 minutes ago: rotation must supersede
// it with a strictly newer issuance (avoids same-second iat collisions).
function agedRefreshToken(): string {
  return jwt.sign(
    { ...CLAIMS, iat: Math.floor(Date.now() / 1000) - 120 },
    env.JWT_REFRESH_SECRET,
    { algorithm: 'HS256', expiresIn: '7d' },
  );
}

describe('SEC-03 session revocation on refresh', () => {
  it('rejects suspended or deleted accounts', async () => {
    for (const status of ['SUSPENDED', 'DELETED']) {
      mockAccount({ status });
      await expect(refreshUser(signRefreshToken(CLAIMS))).rejects.toMatchObject({ statusCode: 401 });
    }
  });

  it('rejects tokens from a superseded session version', async () => {
    mockAccount({ tokenVersion: 2 });
    await expect(refreshUser(signRefreshToken({ ...CLAIMS, tv: 1 }))).rejects.toMatchObject({ statusCode: 401 });
    const ok = await refreshUser(signRefreshToken({ ...CLAIMS, tv: 2 }));
    expect((jwt.decode(ok.refreshToken) as { tv: number }).tv).toBe(2);
  });

  it('treats tokens issued before session versions as version 0', async () => {
    mockAccount({ tokenVersion: 0 });
    await expect(refreshUser(signRefreshToken(CLAIMS))).resolves.toBeDefined();
    mockAccount({ tokenVersion: 1 });
    await expect(refreshUser(signRefreshToken(CLAIMS))).rejects.toMatchObject({ statusCode: 401 });
  });

  it('re-issues claims from the current account (role/organization changes apply)', async () => {
    mockAccount({ role: 'ADMIN', organizationId: null });
    const result = await refreshUser(signRefreshToken(CLAIMS));
    expect(result.user).toEqual({ id: 'user-1', email: 'alice@example.com', role: 'ADMIN', organizationId: null });
  });

  it('rejects unknown accounts', async () => {
    vi.mocked(getPrisma).mockReturnValue({ user: { findUnique: vi.fn(async () => null) } } as unknown as PrismaClient);
    await expect(refreshUser(signRefreshToken(CLAIMS))).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('AUTH-05 refreshUser service', () => {
  it('rotates a valid refresh token into a fresh pair with identical claims', async () => {
    const oldRefresh = agedRefreshToken();
    const oldDecoded = jwt.decode(oldRefresh) as { iat: number };
    const result = await refreshUser(oldRefresh);

    expect(result.user).toEqual(CLAIMS);
    expect(result.accessToken.split('.')).toHaveLength(3);
    expect(result.refreshToken.split('.')).toHaveLength(3);
    // Rotation: the reissued refresh token is strictly newer than the presented one.
    const newDecoded = jwt.decode(result.refreshToken) as { iat: number };
    expect(newDecoded.iat).toBeGreaterThan(oldDecoded.iat);

    const access = jwt.verify(result.accessToken, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
    expect(access).toMatchObject(CLAIMS);
    const refresh = jwt.verify(result.refreshToken, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
    expect(refresh).toMatchObject(CLAIMS);
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('rejects missing, malformed, and foreign tokens with generic 401s', async () => {
    const cases: Array<{ input: unknown; message: string }> = [
      { input: undefined, message: 'Refresh token required' },
      { input: '', message: 'Refresh token required' },
      { input: '   ', message: 'Refresh token required' },
      { input: 123, message: 'Refresh token required' },
      { input: 'two.parts', message: 'Invalid token' },
      // Access token presented as refresh (wrong secret).
      { input: jwt.sign(CLAIMS, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: '15m' }), message: 'Invalid token' },
      // Wrong algorithm rejected by HS256-only verification.
      { input: jwt.sign(CLAIMS, env.JWT_REFRESH_SECRET, { algorithm: 'HS384', expiresIn: '7d' }), message: 'Invalid token' },
      // Valid signature but invalid claims.
      { input: jwt.sign({ ...CLAIMS, role: 'BOGUS' }, env.JWT_REFRESH_SECRET, { algorithm: 'HS256', expiresIn: '7d' }), message: 'Invalid token payload' },
      { input: jwt.sign({ email: 'a@test.com', role: 'PROVIDER' }, env.JWT_REFRESH_SECRET, { algorithm: 'HS256', expiresIn: '7d' }), message: 'Invalid token payload' },
    ];
    for (const { input, message } of cases) {
      try {
        await refreshUser(input);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect((e as { statusCode?: number }).statusCode).toBe(401);
        expect((e as { code?: string }).code).toBe('UNAUTHORIZED');
        expect((e as Error).message).toBe(message);
        const blob = (e as Error).message + JSON.stringify((e as { details?: unknown }).details ?? '');
        expect(blob).not.toContain(env.JWT_REFRESH_SECRET);
      }
    }
  });

  it('rejects expired refresh tokens distinctly without leaking', async () => {
    try {
      await refreshUser(expiredRefreshToken());
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as { statusCode?: number }).statusCode).toBe(401);
      expect((e as Error).message).toBe('Token expired');
    }
  });
});

describe('AUTH-05 POST /api/auth/refresh route', () => {
  it('rotates via cookie and resets both cookies', async () => {
    const app = createApp();
    const oldRefresh = agedRefreshToken();
    const res = await request(app).post('/api/auth/refresh').set('Cookie', `refresh_token=${oldRefresh}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toEqual(CLAIMS);
    expect(res.body.data.accessToken.split('.')).toHaveLength(3);
    const newDecoded = jwt.decode(res.body.data.refreshToken) as { iat: number };
    const oldDecoded = jwt.decode(oldRefresh) as { iat: number };
    expect(newDecoded.iat).toBeGreaterThan(oldDecoded.iat);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    for (const name of ['access_token', 'refresh_token']) {
      const cookie = cookies.find((c) => c.startsWith(`${name}=`));
      expect(cookie).toBeDefined();
      expect(cookie as string).toContain('HttpOnly');
      expect(cookie as string).toContain('SameSite=Lax');
    }
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('accepts the token from the JSON body for non-browser clients', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: signRefreshToken(CLAIMS) });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe('user-1');
  });

  it('returns 401 without a token and 404 for GET', async () => {
    const app = createApp();
    const missing = await request(app).post('/api/auth/refresh');
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('UNAUTHORIZED');

    const garbage = await request(app).post('/api/auth/refresh').send({ refreshToken: 'garbage' });
    expect(garbage.status).toBe(401);

    const get = await request(app).get('/api/auth/refresh');
    expect(get.status).toBe(404);
    expect(get.body.error.code).toBe('NOT_FOUND');
  });

  it('rotated access token authorizes through the existing BE-07 middleware', async () => {
    const app = createApp();
    const rotated = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: signRefreshToken(CLAIMS) });
    expect(rotated.status).toBe(200);

    const protectedApp = express();
    protectedApp.use(express.json());
    const cookieParser = require('cookie-parser');
    protectedApp.use(cookieParser());
    protectedApp.get('/me', authenticate, (req, res) => {
      res.json({ success: true, data: { user: req.user } });
    });
    protectedApp.use(errorMiddleware);

    const res = await request(protectedApp)
      .get('/me')
      .set('Authorization', `Bearer ${rotated.body.data.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ id: 'user-1', role: 'PROVIDER' });
  });
});
