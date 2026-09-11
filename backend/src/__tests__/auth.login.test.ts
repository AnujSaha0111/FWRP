import express from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database. bcrypt and JWT are REAL
// so password verification and token issuance are genuinely exercised.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { loginUser } from '../services/auth.service';
import { authenticate } from '../middleware/auth';
import { errorMiddleware } from '../middleware/error';
import { env } from '../config/env';
import { AppError } from '../middleware/error';

// AUTH-02: login only. No logout/refresh-rotation/reset (later AUTH tasks).

const PLAIN_PASSWORD = 'correct-password-1';

let storedHash: string;
let activeUser: Record<string, unknown>;

beforeAll(async () => {
  storedHash = await bcrypt.hash(PLAIN_PASSWORD, 4);
  activeUser = {
    id: 'user-1',
    name: 'Alice Provider',
    email: 'alice@example.com',
    phone: '+1 555-123-4567',
    passwordHash: storedHash,
    role: 'PROVIDER',
    organizationId: 'org-1',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    updatedAt: new Date('2026-09-03T00:00:00.000Z'),
  };
});

function mockPrismaWith(userRow: Record<string, unknown> | null) {
  const findUnique = vi.fn(async () => userRow);
  vi.mocked(getPrisma).mockReturnValue({ user: { findUnique } } as unknown as PrismaClient);
  return { findUnique };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AUTH-02 loginUser service', () => {
  it('accepts valid credentials and issues tokens via the BE-07 utilities', async () => {
    mockPrismaWith(activeUser);
    const result = await loginUser({ email: 'alice@example.com', password: PLAIN_PASSWORD });

    expect(result.user).toMatchObject({ id: 'user-1', email: 'alice@example.com', role: 'PROVIDER', organizationId: 'org-1' });
    expect(result.user).not.toHaveProperty('passwordHash');
    for (const token of [result.accessToken, result.refreshToken]) {
      expect(token.split('.')).toHaveLength(3);
    }
    // Access token verifies under HS256 with the access secret and carries claims.
    const decoded = jwt.verify(result.accessToken, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
    expect(decoded).toMatchObject({ id: 'user-1', email: 'alice@example.com', role: 'PROVIDER', organizationId: 'org-1' });
    // Refresh token verifies under the refresh secret only.
    const refresh = jwt.verify(result.refreshToken, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as Record<string, unknown>;
    expect(refresh.id).toBe('user-1');
    expect(() => jwt.verify(result.refreshToken, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] })).toThrow();
  });

  it('normalizes email exactly like registration (case-insensitive lookup)', async () => {
    const { findUnique } = mockPrismaWith(activeUser);
    const result = await loginUser({ email: '  Alice@Example.COM  ', password: PLAIN_PASSWORD });
    expect(findUnique).toHaveBeenCalledWith({ where: { email: 'alice@example.com' } });
    expect(result.user.id).toBe('user-1');
  });

  it('rejects wrong password, unknown user, and inactive accounts with one identical generic 401', async () => {
    mockPrismaWith(activeUser);
    const failures: unknown[] = [];
    try {
      await loginUser({ email: 'alice@example.com', password: 'wrong-password' });
    } catch (e) {
      failures.push(e);
    }
    mockPrismaWith(null);
    try {
      await loginUser({ email: 'nobody@example.com', password: PLAIN_PASSWORD });
    } catch (e) {
      failures.push(e);
    }
    mockPrismaWith({ ...activeUser, status: 'SUSPENDED' });
    try {
      await loginUser({ email: 'alice@example.com', password: PLAIN_PASSWORD });
    } catch (e) {
      failures.push(e);
    }
    mockPrismaWith({ ...activeUser, status: 'DELETED' });
    try {
      await loginUser({ email: 'alice@example.com', password: PLAIN_PASSWORD });
    } catch (e) {
      failures.push(e);
    }
    expect(failures).toHaveLength(4);
    for (const e of failures) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(401);
      expect((e as AppError).code).toBe('UNAUTHORIZED');
      expect((e as Error).message).toBe('Invalid email or password');
    }
  });

  it('rejects invalid input with 400 before touching the database', async () => {
    const { findUnique } = mockPrismaWith(activeUser);
    const bad: unknown[] = [
      {},
      { email: 'alice@example.com' },
      { password: PLAIN_PASSWORD },
      { email: 'not-an-email', password: PLAIN_PASSWORD },
      { email: 'alice@example.com', password: '' },
      { email: '', password: PLAIN_PASSWORD },
    ];
    for (const input of bad) {
      await expect(loginUser(input as never)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    }
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('masks database failures without leaking credentials or internals', async () => {
    const findUnique = vi.fn(async () => {
      throw new Error('Connection postgres://admin:s3cret@db:5432 failed: SELECT * FROM "users"');
    });
    vi.mocked(getPrisma).mockReturnValue({ user: { findUnique } } as unknown as PrismaClient);
    try {
      await loginUser({ email: 'alice@example.com', password: PLAIN_PASSWORD });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(500);
      expect((e as AppError).code).toBe('LOGIN_FAILED');
      const blob = (e as Error).message + JSON.stringify((e as AppError).details ?? '');
      expect(blob).not.toContain(PLAIN_PASSWORD);
      expect(blob).not.toContain('s3cret');
      expect(blob).not.toContain('postgres://');
      expect(blob).not.toContain('SELECT');
    }
  });
});

describe('AUTH-02 POST /api/auth/login route', () => {
  it('returns 200 with user + tokens and sets httpOnly cookies', async () => {
    mockPrismaWith(activeUser);
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: PLAIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({ id: 'user-1', email: 'alice@example.com' });
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.accessToken.split('.')).toHaveLength(3);
    expect(res.body.data.refreshToken.split('.')).toHaveLength(3);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const access = cookies.find((c) => c.startsWith('access_token='));
    const refresh = cookies.find((c) => c.startsWith('refresh_token='));
    expect(access).toBeDefined();
    expect(refresh).toBeDefined();
    for (const cookie of [access as string, refresh as string]) {
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
    }
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain('passwordHash');
    expect(blob).not.toContain(PLAIN_PASSWORD);
  });

  it('returns 400 for invalid bodies and 401 for bad credentials', async () => {
    mockPrismaWith(activeUser);
    const app = createApp();
    const bad = await request(app).post('/api/auth/login').send({ email: 'bad' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    mockPrismaWith(null);
    const denied = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: PLAIN_PASSWORD });
    expect(denied.status).toBe(401);
    expect(denied.body.success).toBe(false);
    expect(denied.body.error.code).toBe('UNAUTHORIZED');
    expect(denied.body.error.message).toBe('Invalid email or password');
  });

  it('only POST /login is mounted (GET falls through to 404)', async () => {
    mockPrismaWith(activeUser);
    const app = createApp();
    const res = await request(app).get('/api/auth/login');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('issued access token authorizes through the existing BE-07 middleware (cookie + Bearer)', async () => {
    mockPrismaWith(activeUser);
    const { accessToken } = await loginUser({ email: 'alice@example.com', password: PLAIN_PASSWORD });

    const app = express();
    app.use(express.json());
    const cookieParser = require('cookie-parser');
    app.use(cookieParser());
    app.get('/me', authenticate, (req, res) => {
      res.json({ success: true, data: { user: req.user } });
    });
    app.use(errorMiddleware);

    const viaBearer = await request(app).get('/me').set('Authorization', `Bearer ${accessToken}`);
    expect(viaBearer.status).toBe(200);
    expect(viaBearer.body.data.user).toMatchObject({ id: 'user-1', role: 'PROVIDER' });

    const viaCookie = await request(app).get('/me').set('Cookie', `access_token=${accessToken}`);
    expect(viaCookie.status).toBe(200);
    expect(viaCookie.body.data.user.id).toBe('user-1');
  });
});
