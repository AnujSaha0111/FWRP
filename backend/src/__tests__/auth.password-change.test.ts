import request from 'supertest';
import bcrypt from 'bcryptjs';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database. bcrypt is REAL so hashing
// behavior is genuinely exercised.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { adminResetPassword, changePassword } from '../services/auth.service';
import { signAccessToken } from '../utils/jwt';

// AUTH-06: D-13 fallback (authenticated self-change + admin reset). The email
// token flow (D-13 option A) is NOT implemented; D-13 stays unresolved.

const OLD_PASSWORD = 'old-password-1';
const NEW_PASSWORD = 'new-password-2';

let selfUser: Record<string, unknown>;
let targetUser: Record<string, unknown>;

beforeAll(async () => {
  const base = {
    name: 'Alice Provider',
    email: 'alice@example.com',
    phone: '+1 555-123-4567',
    role: 'PROVIDER',
    organizationId: 'org-1',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    updatedAt: new Date('2026-09-03T00:00:00.000Z'),
  };
  selfUser = { ...base, id: 'user-1', passwordHash: await bcrypt.hash(OLD_PASSWORD, 4) };
  targetUser = { ...base, id: 'user-2', email: 'bob@example.com', passwordHash: await bcrypt.hash(OLD_PASSWORD, 4) };
});

function mockTx() {
  const userUpdate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'x', ...args.data }));
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'log-1', ...args.data }));
  return { userUpdate, auditCreate, tx: { user: { update: userUpdate }, auditLog: { create: auditCreate } } };
}

function mockSelf() {
  const { userUpdate, auditCreate, tx } = mockTx();
  const findUnique = vi.fn(async () => selfUser);
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient);
  return { findUnique, userUpdate, auditCreate };
}

function mockAdminTarget() {
  const { userUpdate, auditCreate, tx } = mockTx();
  const findUnique = vi.fn(async () => targetUser);
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique },
    $transaction,
  } as unknown as PrismaClient);
  return { findUnique, userUpdate, auditCreate, $transaction };
}

function userToken(): string {
  return signAccessToken({ id: 'user-1', email: 'alice@example.com', role: 'PROVIDER', organizationId: 'org-1' });
}

function adminToken(): string {
  return signAccessToken({ id: 'admin-1', email: 'admin@example.com', role: 'ADMIN', organizationId: null });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AUTH-06 self change-password service', () => {
  it('changes the password and audits atomically on one transaction', async () => {
    const { findUnique, userUpdate, auditCreate } = mockSelf();
    const result = await changePassword('user-1', { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });

    expect(result).toEqual({ changed: true });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(userUpdate).toHaveBeenCalledTimes(1);
    const stored = userUpdate.mock.calls[0][0].data.passwordHash as string;
    expect(stored).not.toBe(NEW_PASSWORD);
    expect(await bcrypt.compare(NEW_PASSWORD, stored)).toBe(true);
    expect(await bcrypt.compare(OLD_PASSWORD, stored)).toBe(false);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', action: 'PASSWORD_CHANGE', entityType: 'User', entityId: 'user-1' }),
    });
  });

  it('rejects wrong current password and unknown/inactive users with one generic 401', async () => {
    mockSelf();
    const failures: unknown[] = [];
    try {
      await changePassword('user-1', { currentPassword: 'wrong-pass', newPassword: NEW_PASSWORD });
    } catch (e) {
      failures.push(e);
    }
    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(),
    } as unknown as PrismaClient);
    try {
      await changePassword('ghost', { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    } catch (e) {
      failures.push(e);
    }
    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique: vi.fn(async () => ({ ...selfUser, status: 'SUSPENDED' })) },
      $transaction: vi.fn(),
    } as unknown as PrismaClient);
    try {
      await changePassword('user-1', { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    } catch (e) {
      failures.push(e);
    }
    expect(failures).toHaveLength(3);
    for (const e of failures) {
      expect((e as { statusCode?: number }).statusCode).toBe(401);
      expect((e as Error).message).toBe('Current password is incorrect');
    }
  });

  it('rejects weak/identical input with 400 before touching the database', async () => {
    const { findUnique } = mockSelf();
    const bad: unknown[] = [
      {},
      { currentPassword: OLD_PASSWORD },
      { newPassword: NEW_PASSWORD },
      { currentPassword: OLD_PASSWORD, newPassword: 'short' },
      { currentPassword: OLD_PASSWORD, newPassword: OLD_PASSWORD },
      { currentPassword: '', newPassword: NEW_PASSWORD },
    ];
    for (const input of bad) {
      await expect(changePassword('user-1', input as never)).rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('masks persistence failures without leaking passwords or internals', async () => {
    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique: vi.fn(async () => selfUser) },
      $transaction: vi.fn(async () => {
        throw new Error('INSERT INTO "audit_logs" failed password=hunter2 postgres://u:p@h/db');
      }),
    } as unknown as PrismaClient);
    try {
      await changePassword('user-1', { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as { statusCode?: number }).statusCode).toBe(500);
      expect((e as { code?: string }).code).toBe('PASSWORD_UPDATE_FAILED');
      const blob = (e as Error).message + JSON.stringify((e as { details?: unknown }).details ?? '');
      expect(blob).not.toContain(OLD_PASSWORD);
      expect(blob).not.toContain(NEW_PASSWORD);
      expect(blob).not.toContain('hunter2');
      expect(blob).not.toContain('postgres://');
    }
  });
});

describe('AUTH-06 admin reset service', () => {
  it('lets an admin reset any user password with admin-attributed audit', async () => {
    const { userUpdate, auditCreate } = mockAdminTarget();
    const result = await adminResetPassword('admin-1', 'user-2', { newPassword: NEW_PASSWORD });

    expect(result).toEqual({ changed: true, userId: 'user-2' });
    const stored = userUpdate.mock.calls[0][0].data.passwordHash as string;
    expect(await bcrypt.compare(NEW_PASSWORD, stored)).toBe(true);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'admin-1', action: 'PASSWORD_RESET', entityType: 'User', entityId: 'user-2' }),
    });
  });

  it('rejects unknown targets (404) and invalid input (400)', async () => {
    mockAdminTarget();
    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(),
    } as unknown as PrismaClient);
    await expect(adminResetPassword('admin-1', 'ghost', { newPassword: NEW_PASSWORD })).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
    await expect(adminResetPassword('admin-1', '', { newPassword: NEW_PASSWORD })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(adminResetPassword('admin-1', 'user-2', { newPassword: 'short' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('AUTH-06 routes', () => {
  it('self change is owner-scoped to the session (body userId ignored)', async () => {
    const { findUnique } = mockSelf();
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ userId: 'user-2', currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { changed: true } });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(JSON.stringify(res.body)).not.toContain(NEW_PASSWORD);
  });

  it('self change requires authentication', async () => {
    mockSelf();
    const app = createApp();
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('admin reset requires ADMIN (403 for providers, 401 anonymous, 200 admin)', async () => {
    mockAdminTarget();
    const app = createApp();
    const anon = await request(app).put('/api/admin/users/user-2/password').send({ newPassword: NEW_PASSWORD });
    expect(anon.status).toBe(401);

    const provider = await request(app)
      .put('/api/admin/users/user-2/password')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ newPassword: NEW_PASSWORD });
    expect(provider.status).toBe(403);
    expect(provider.body.error.code).toBe('FORBIDDEN');

    const admin = await request(app)
      .put('/api/admin/users/user-2/password')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ newPassword: NEW_PASSWORD });
    expect(admin.status).toBe(200);
    expect(admin.body).toEqual({ success: true, data: { changed: true, userId: 'user-2' } });
    expect(JSON.stringify(admin.body)).not.toContain(NEW_PASSWORD);
  });

  it('admin reset validates input and reports unknown users', async () => {
    mockAdminTarget();
    const app = createApp();
    const weak = await request(app)
      .put('/api/admin/users/user-2/password')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ newPassword: 'x' });
    expect(weak.status).toBe(400);

    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(),
    } as unknown as PrismaClient);
    const missing = await request(app)
      .put('/api/admin/users/ghost/password')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ newPassword: NEW_PASSWORD });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });
});
