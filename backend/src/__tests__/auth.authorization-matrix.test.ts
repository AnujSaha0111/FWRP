import request from 'supertest';
import bcrypt from 'bcryptjs';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database. JWTs are REAL
// (BE-07 signers) so the genuine middleware chain is exercised per role.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { signAccessToken, signRefreshToken } from '../utils/jwt';

// AUTH-07: role-based authorization matrix — all 4 D-04 roles against every
// live endpoint, through the real authenticate/requireRole middleware.
// Guards themselves come from BE-08; this suite proves per-endpoint wiring.
// Later phases extend the matrix as business endpoints land (AUTH-12).

const ROLES = ['PROVIDER', 'RECIPIENT', 'VOLUNTEER', 'ADMIN'] as const;
type Role = (typeof ROLES)[number];

function tokenFor(role: Role): string {
  return signAccessToken({
    id: `${role.toLowerCase()}-1`,
    email: `${role.toLowerCase()}@example.com`,
    role,
    organizationId: role === 'VOLUNTEER' || role === 'ADMIN' ? null : 'org-1',
  });
}

let storedHash: string;

beforeAll(async () => {
  storedHash = await bcrypt.hash('correct-password-1', 4);
});

function mockDbForAuthFlows() {
  const userRow = {
    id: 'matrix-user-1',
    name: 'Matrix User',
    email: 'matrix@example.com',
    phone: '+1 555-000-0000',
    passwordHash: storedHash,
    role: 'PROVIDER',
    organizationId: 'org-1',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    updatedAt: new Date('2026-09-03T00:00:00.000Z'),
  };
  const findUnique = vi.fn(async (args: { where: Record<string, string> }) => {
    // Unknown emails look free (registration path); known lookups echo the id.
    if (args.where.email && args.where.email !== 'matrix@example.com') return null;
    return { ...userRow, id: args.where.id ?? userRow.id, email: args.where.email ?? userRow.email };
  });
  const userUpdate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...userRow, ...args.data }));
  const userCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...userRow, ...args.data }));
  const orgCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'org-1', ...args.data }));
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'log-1', ...args.data }));
  const mockTx = {
    user: { create: userCreate, update: userUpdate },
    organization: { create: orgCreate },
    auditLog: { create: auditCreate },
  };
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique, create: userCreate, update: userUpdate },
    organization: { create: orgCreate },
    auditLog: { create: auditCreate },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
  } as unknown as PrismaClient);
  return { findUnique, userUpdate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AUTH-07 role matrix: public auth endpoints stay public', () => {
  it('register, login, logout, and refresh need no token', async () => {
    mockDbForAuthFlows();
    const app = createApp();
    const reg = await request(app).post('/api/auth/register').send({
      name: 'Matrix User',
      email: 'fresh-matrix@example.com',
      phone: '+1 555-000-0000',
      password: 'correct-password-1',
      role: 'VOLUNTEER',
    });
    expect(reg.status).toBe(201);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'matrix@example.com', password: 'correct-password-1' });
    expect(login.status).toBe(200);

    const logout = await request(app).post('/api/auth/logout');
    expect(logout.status).toBe(200);

    const refresh = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.data.refreshToken });
    expect(refresh.status).toBe(200);
  });
});

describe('AUTH-07 role matrix: self change-password allows every role, rejects anonymous', () => {
  it('anonymous callers get 401', async () => {
    mockDbForAuthFlows();
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: 'correct-password-1', newPassword: 'brand-new-pass-2' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it.each(ROLES)('%s can change its own password', async (role) => {
    mockDbForAuthFlows();
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${tokenFor(role)}`)
      .send({ currentPassword: 'correct-password-1', newPassword: 'brand-new-pass-2' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { changed: true } });
  });
});

describe('AUTH-07 role matrix: admin reset is ADMIN-only', () => {
  it('anonymous callers get 401', async () => {
    mockDbForAuthFlows();
    const app = createApp();
    const res = await request(app).put('/api/admin/users/user-9/password').send({ newPassword: 'brand-new-pass-2' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it.each(['PROVIDER', 'RECIPIENT', 'VOLUNTEER'] as const)('%s gets 403 without touching the target', async (role) => {
    const { userUpdate } = mockDbForAuthFlows();
    const app = createApp();
    const res = await request(app)
      .put('/api/admin/users/user-9/password')
      .set('Authorization', `Bearer ${tokenFor(role)}`)
      .send({ newPassword: 'brand-new-pass-2' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('ADMIN succeeds and the response carries no hash', async () => {
    mockDbForAuthFlows();
    const app = createApp();
    const res = await request(app)
      .put('/api/admin/users/user-9/password')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ newPassword: 'brand-new-pass-2' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { changed: true, userId: 'user-9' } });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });
});

describe('AUTH-07 role matrix: refresh rotation is role-agnostic', () => {
  it.each(ROLES)('%s refresh token rotates successfully', async (role) => {
    const app = createApp();
    const refreshToken = signRefreshToken({
      id: `${role.toLowerCase()}-1`,
      email: `${role.toLowerCase()}@example.com`,
      role,
      organizationId: null,
    });
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe(role);
  });
});

describe('AUTH-07 role matrix: future-domain placeholders stay ungated 501s for every role', () => {
  it.each(['/api/requirements', '/api/notifications'])('%s answers 501 with or without any role', async (prefix) => {
    const app = createApp();
    const anon = await request(app).get(prefix);
    expect(anon.status).toBe(501);
    for (const role of ROLES) {
      const res = await request(app).get(prefix).set('Authorization', `Bearer ${tokenFor(role)}`);
      expect(res.status).toBe(501);
      expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
    }
  });
});
