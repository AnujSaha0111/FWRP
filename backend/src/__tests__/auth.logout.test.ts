import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// No database: logout is stateless cookie clearing. Prisma is mocked only so
// the login-then-logout flow can mint a real token without live Supabase.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { authenticate } from '../middleware/auth';
import { errorMiddleware } from '../middleware/error';

// AUTH-03: logout only (cookie clear per stateless JWT). No blocklist table,
// no session store, no AUTH-04+ features.

const PLAIN_PASSWORD = 'correct-password-1';

let activeUser: Record<string, unknown>;

beforeAll(async () => {
  activeUser = {
    id: 'user-1',
    name: 'Alice Provider',
    email: 'alice@example.com',
    phone: '+1 555-123-4567',
    passwordHash: await bcrypt.hash(PLAIN_PASSWORD, 4),
    role: 'PROVIDER',
    organizationId: 'org-1',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    updatedAt: new Date('2026-09-03T00:00:00.000Z'),
  };
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: vi.fn(async () => activeUser) },
  } as unknown as PrismaClient);
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: vi.fn(async () => activeUser) },
  } as unknown as PrismaClient);
});

function cookiesOf(res: request.Response, name: string): string | undefined {
  const cookies = res.headers['set-cookie'] as unknown as string[];
  return cookies?.find((c) => c.startsWith(`${name}=`));
}

describe('AUTH-03 POST /api/auth/logout', () => {
  it('clears both auth cookies after a real login', async () => {
    const app = createApp();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: PLAIN_PASSWORD });
    expect(login.status).toBe(200);
    expect(cookiesOf(login, 'access_token')).toBeDefined();

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `access_token=${login.body.data.accessToken}; refresh_token=${login.body.data.refreshToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { loggedOut: true } });

    for (const name of ['access_token', 'refresh_token']) {
      const cleared = cookiesOf(res, name);
      expect(cleared).toBeDefined();
      // Empty value expiring in the past, with the same protective flags.
      expect(cleared as string).toMatch(new RegExp(`^${name}=;`));
      expect(cleared as string).toContain('Expires=Thu, 01 Jan 1970');
      expect(cleared as string).toContain('HttpOnly');
      expect(cleared as string).toContain('SameSite=Lax');
      expect(cleared as string).toContain('Path=/');
    }
    expect(JSON.stringify(res.body)).not.toContain(login.body.data.accessToken);
  });

  it('is idempotent: succeeds with no cookies at all', async () => {
    const app = createApp();
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { loggedOut: true } });
    expect(cookiesOf(res, 'access_token')).toBeDefined();
    expect(cookiesOf(res, 'refresh_token')).toBeDefined();
  });

  it('succeeds with expired or malformed tokens (never 401)', async () => {
    const app = createApp();
    for (const cookie of [
      'access_token=garbage',
      'access_token=eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IngifQ.invalid',
      'access_token=; refresh_token=',
    ]) {
      const res = await request(app).post('/api/auth/logout').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.data.loggedOut).toBe(true);
    }
  });

  it('logout is effective: the cleared cookie no longer authenticates', async () => {
    const app = createApp();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: PLAIN_PASSWORD });
    const token = login.body.data.accessToken as string;

    const protectedApp = express();
    protectedApp.use(express.json());
    const cookieParser = require('cookie-parser');
    protectedApp.use(cookieParser());
    protectedApp.get('/me', authenticate, (req, res) => {
      res.json({ success: true, data: { user: req.user } });
    });
    protectedApp.use(errorMiddleware);

    // Pre-logout token works...
    const before = await request(protectedApp).get('/me').set('Cookie', `access_token=${token}`);
    expect(before.status).toBe(200);

    // ...logout clears it...
    const logout = await request(app).post('/api/auth/logout').set('Cookie', `access_token=${token}`);
    expect(logout.status).toBe(200);
    const clearedValue = (cookiesOf(logout, 'access_token') as string).split(';')[0].split('=')[1] ?? '';

    // ...and the cleared (empty) cookie is rejected.
    const after = await request(protectedApp).get('/me').set('Cookie', `access_token=${clearedValue}`);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('UNAUTHORIZED');
  });

  it('ignores any request body and only mounts POST', async () => {
    const app = createApp();
    const res = await request(app).post('/api/auth/logout').send({ email: 'x@y.z', password: 'whatever' });
    expect(res.status).toBe(200);
    expect(res.body.data.loggedOut).toBe(true);

    const get = await request(app).get('/api/auth/logout');
    expect(get.status).toBe(404);
    expect(get.body.error.code).toBe('NOT_FOUND');
  });
});
