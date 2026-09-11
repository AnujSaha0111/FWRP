import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';

// AUTH-08: self user profile only. No email change, no privilege escalation,
// no other-user access (owner always comes from the session).

const ORG = {
  id: 'org-1',
  name: 'Good Food Org',
  type: 'NGO',
  address: '12 Market Street',
  verificationStatus: 'VERIFIED',
};

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    name: 'Alice Provider',
    email: 'alice@example.com',
    phone: '+1 555-123-4567',
    passwordHash: 'bcrypt-hash-placeholder',
    role: 'PROVIDER',
    organizationId: 'org-1',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    updatedAt: new Date('2026-09-03T00:00:00.000Z'),
    organization: { ...ORG },
    ...overrides,
  };
}

function mockTx() {
  const userUpdate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...userRow(), ...args.data }));
  const orgUpdate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...ORG, ...args.data }));
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'log-1', ...args.data }));
  return { userUpdate, orgUpdate, auditCreate, tx: { user: { update: userUpdate }, organization: { update: orgUpdate }, auditLog: { create: auditCreate } } };
}

function mockPrisma(current: Record<string, unknown> | null) {
  const { userUpdate, orgUpdate, auditCreate, tx } = mockTx();
  const findUnique = vi.fn(async () => current);
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique },
    $transaction,
  } as unknown as PrismaClient);
  return { findUnique, userUpdate, orgUpdate, auditCreate, $transaction };
}

function token(): string {
  return signAccessToken({ id: 'user-1', email: 'alice@example.com', role: 'PROVIDER', organizationId: 'org-1' });
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${token()}` };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AUTH-08 GET /api/users/me', () => {
  it('returns the sanitized profile with organization', async () => {
    const { findUnique } = mockPrisma(userRow());
    const app = createApp();
    const res = await request(app).get('/api/users/me').set(authHeader());
    expect(res.status).toBe(200);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' }, include: { organization: true } });
    expect(res.body.data.user).toMatchObject({ id: 'user-1', email: 'alice@example.com', role: 'PROVIDER' });
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.organization).toMatchObject({ id: 'org-1', address: '12 Market Street' });
  });

  it('returns null organization for users without one', async () => {
    mockPrisma(userRow({ organizationId: null, organization: null, role: 'VOLUNTEER' }));
    const app = createApp();
    const res = await request(app).get('/api/users/me').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.data.organization).toBeNull();
  });

  it('rejects unauthenticated, invalid, unknown, and inactive callers', async () => {
    mockPrisma(userRow());
    const app = createApp();
    const anon = await request(app).get('/api/users/me');
    expect(anon.status).toBe(401);
    const bad = await request(app).get('/api/users/me').set('Authorization', 'Bearer garbage');
    expect(bad.status).toBe(401);

    mockPrisma(null);
    const missing = await request(app).get('/api/users/me').set(authHeader());
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');

    mockPrisma(userRow({ status: 'SUSPENDED' }));
    const suspended = await request(app).get('/api/users/me').set(authHeader());
    expect(suspended.status).toBe(401);
  });

  it('masks read failures', async () => {
    vi.mocked(getPrisma).mockReturnValue({
      user: {
        findUnique: vi.fn(async () => {
          throw new Error('SELECT * FROM "users" failed postgres://u:p@h/db');
        }),
      },
    } as unknown as PrismaClient);
    const app = createApp();
    const res = await request(app).get('/api/users/me').set(authHeader());
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('PROFILE_READ_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('postgres://');
  });
});

describe('AUTH-08 PUT /api/users/me', () => {
  it('updates name and phone atomically with audit on one transaction', async () => {
    const { userUpdate, orgUpdate, auditCreate, $transaction } = mockPrisma(userRow());
    const app = createApp();
    const res = await request(app)
      .put('/api/users/me')
      .set(authHeader())
      .send({ name: 'Alice Updated', phone: '+1 555-999-0000' });
    expect(res.status).toBe(200);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { name: 'Alice Updated', phone: '+1 555-999-0000' },
    });
    expect(orgUpdate).not.toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', action: 'PROFILE_UPDATE', entityType: 'User', entityId: 'user-1' }),
    });
    const auditData = auditCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(JSON.parse(auditData.newValue as string)).toMatchObject({ name: 'Alice Updated' });
    expect(JSON.parse(auditData.oldValue as string)).toMatchObject({ name: 'Alice Provider' });
    expect(JSON.stringify(auditData)).not.toContain('bcrypt-hash-placeholder');
    expect(res.body.data.user.name).toBe('Alice Updated');
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  it('updates address on the caller organization without touching the user row', async () => {
    const { userUpdate, orgUpdate } = mockPrisma(userRow());
    const app = createApp();
    const res = await request(app).put('/api/users/me').set(authHeader()).send({ address: '99 New Road' });
    expect(res.status).toBe(200);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(orgUpdate).toHaveBeenCalledWith({ where: { id: 'org-1' }, data: { address: '99 New Road' } });
    expect(res.body.data.organization.address).toBe('99 New Road');
  });

  it('rejects address without an organization and empty bodies', async () => {
    const { $transaction } = mockPrisma(userRow({ organizationId: null, organization: null }));
    const app = createApp();
    const noOrg = await request(app).put('/api/users/me').set(authHeader()).send({ address: '99 New Road' });
    expect(noOrg.status).toBe(400);
    const empty = await request(app).put('/api/users/me').set(authHeader()).send({});
    expect(empty.status).toBe(400);
    expect($transaction).not.toHaveBeenCalled();
  });

  it('blocks privilege escalation and email change via strict schema', async () => {
    const { userUpdate, $transaction } = mockPrisma(userRow());
    const app = createApp();
    for (const body of [
      { email: 'new@example.com' },
      { role: 'ADMIN' },
      { status: 'SUSPENDED' },
      { organizationId: 'org-9' },
      { userId: 'user-2', name: 'Spoofed' },
      { name: '  ' },
      { phone: 'not-a-phone' },
    ]) {
      const res = await request(app).put('/api/users/me').set(authHeader()).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(userUpdate).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it('requires authentication and masks update failures', async () => {
    mockPrisma(userRow());
    const app = createApp();
    const anon = await request(app).put('/api/users/me').send({ name: 'X' });
    expect(anon.status).toBe(401);

    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique: vi.fn(async () => userRow()) },
      $transaction: vi.fn(async () => {
        throw new Error('UPDATE "users" failed password=hunter2');
      }),
    } as unknown as PrismaClient);
    const res = await request(app).put('/api/users/me').set(authHeader()).send({ name: 'X' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('PROFILE_UPDATE_FAILED');
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain('hunter2');
    expect(blob).not.toContain('passwordHash');
  });
});
