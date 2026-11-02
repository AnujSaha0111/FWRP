import request from 'supertest';
import bcrypt from 'bcryptjs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { registerUser, hashPassword } from '../services/auth.service';
import { AppError } from '../middleware/error';

// AUTH-01: registration only. No tokens issued here (AUTH-02 owns login).

const providerInput = {
  name: 'Alice Provider',
  email: 'alice@example.com',
  phone: '+1 555-123-4567',
  password: 's3cure-pass',
  role: 'PROVIDER' as const,
  orgName: 'Good Food Org',
  address: '12 Market Street',
  latitude: 12.97,
  longitude: 77.59,
};

function createMockPrisma() {
  const findUnique = vi.fn(async () => null);
  const orgCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'org-1',
    verificationStatus: 'PENDING',
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    updatedAt: new Date('2026-09-03T00:00:00.000Z'),
    ...args.data,
  }));
  const userCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'user-1',
    status: 'ACTIVE',
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    updatedAt: new Date('2026-09-03T00:00:00.000Z'),
    ...args.data,
  }));
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'log-1',
    ...args.data,
  }));
  const mockTx = {
    organization: { create: orgCreate },
    user: { create: userCreate },
    auditLog: { create: auditCreate },
  };
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
  const prisma = {
    user: { findUnique, create: vi.fn() },
    organization: { create: vi.fn() },
    auditLog: { create: auditCreate },
    $transaction,
  };
  vi.mocked(getPrisma).mockReturnValue(prisma as unknown as PrismaClient);
  return { prisma, findUnique, orgCreate, userCreate, auditCreate, $transaction, mockTx };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AUTH-01 registerUser service', () => {
  it('registers a provider with organization + audit in one transaction', async () => {
    const { findUnique, orgCreate, userCreate, auditCreate, $transaction } = createMockPrisma();
    const result = await registerUser({ ...providerInput });

    expect(findUnique).toHaveBeenCalledWith({ where: { email: 'alice@example.com' } });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(orgCreate).toHaveBeenCalledTimes(1);
    expect(orgCreate).toHaveBeenCalledWith({
      data: {
        name: 'Good Food Org',
        type: 'OTHER',
        address: '12 Market Street',
        latitude: 12.97,
        longitude: 77.59,
      },
    });
    expect(userCreate).toHaveBeenCalledTimes(1);
    const userData = userCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(userData.email).toBe('alice@example.com');
    expect(userData.organizationId).toBe('org-1');
    expect(userData.role).toBe('PROVIDER');
    // Password is hashed with bcrypt, never stored raw.
    expect(userData.passwordHash).not.toBe('s3cure-pass');
    expect(await bcrypt.compare('s3cure-pass', userData.passwordHash as string)).toBe(true);

    // Audit participates in the same transaction handle.
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const auditData = auditCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(auditData.userId).toBe('user-1');
    expect(auditData.action).toBe('USER_REGISTER');
    expect(auditData.entityType).toBe('User');
    expect(auditData.entityId).toBe('user-1');
    expect(JSON.stringify(auditData)).not.toContain('s3cure-pass');

    // Sanitized result: no hash, org attached.
    expect(result.user).toMatchObject({ id: 'user-1', email: 'alice@example.com', role: 'PROVIDER', organizationId: 'org-1' });
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result.organization).toMatchObject({ id: 'org-1', name: 'Good Food Org' });
  });

  it('registers a volunteer without an organization', async () => {
    const { orgCreate, userCreate } = createMockPrisma();
    const result = await registerUser({
      name: 'Vic Volunteer',
      email: 'vic@example.com',
      phone: '5551234567',
      password: 's3cure-pass',
      role: 'VOLUNTEER',
    });
    expect(orgCreate).not.toHaveBeenCalled();
    expect((userCreate.mock.calls[0][0].data as Record<string, unknown>).organizationId).toBeNull();
    expect(result.organization).toBeNull();
    expect(result.user.organizationId).toBeNull();
  });

  it('normalizes email case and passes org type/coords through', async () => {
    const { orgCreate, userCreate } = createMockPrisma();
    await registerUser({
      ...providerInput,
      email: 'Alice@Example.COM',
      organizationType: 'NGO',
      latitude: 12.5,
      longitude: 77.5,
    } as never);
    expect((userCreate.mock.calls[0][0].data as Record<string, unknown>).email).toBe('alice@example.com');
    expect(orgCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'NGO', latitude: 12.5, longitude: 77.5 }),
    });
  });

  it('requires org fields for provider/recipient, rejects ADMIN and bad input', async () => {
    createMockPrisma();
    const cases: unknown[] = [
      { ...providerInput, orgName: undefined },
      { ...providerInput, address: '' },
      { ...providerInput, email: 'not-an-email' },
      { ...providerInput, phone: 'abc' },
      { ...providerInput, password: 'short' },
      { ...providerInput, role: 'ADMIN' },
      { ...providerInput, role: 'BOGUS' },
      { ...providerInput, name: '' },
      // Organization location is required and never defaulted (D-07).
      { ...providerInput, latitude: undefined },
      { ...providerInput, longitude: undefined },
      { ...providerInput, latitude: undefined, longitude: undefined },
      { ...providerInput, role: 'RECIPIENT', latitude: undefined, longitude: undefined },
      { ...providerInput, latitude: 0, longitude: 0 },
      { ...providerInput, latitude: 91 },
      { ...providerInput, longitude: '77.5' },
      {},
    ];
    for (const input of cases) {
      try {
        await registerUser(input as never);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).statusCode).toBe(400);
        expect((e as AppError).code).toBe('VALIDATION_ERROR');
      }
    }
  });

  it('volunteers register without coordinates (no organization)', async () => {
    const { orgCreate } = createMockPrisma();
    const { orgName: _o, address: _a, latitude: _lat, longitude: _lng, ...rest } = providerInput;
    await registerUser({ ...rest, role: 'VOLUNTEER' });
    expect(orgCreate).not.toHaveBeenCalled();
  });

  it('invalid input never reaches the database', async () => {
    const { findUnique, $transaction } = createMockPrisma();
    await expect(registerUser({ ...providerInput, email: 'bad' } as never)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(findUnique).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it('duplicate email yields 409 without creating', async () => {
    const { findUnique, $transaction, userCreate } = createMockPrisma();
    findUnique.mockResolvedValueOnce({ id: 'existing' });
    await expect(registerUser({ ...providerInput })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
    expect(userCreate).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it('maps email uniqueness race (P2002) to 409 without leaking', async () => {
    const { userCreate } = createMockPrisma();
    userCreate.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), { code: 'P2002' }));
    try {
      await registerUser({ ...providerInput });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as AppError).statusCode).toBe(409);
      expect((e as AppError).code).toBe('CONFLICT');
    }
  });

  it('masks persistence failures without leaking password, hash, or SQL', async () => {
    const { $transaction } = createMockPrisma();
    $transaction.mockRejectedValueOnce(new Error('Connection postgres://admin:s3cret@db:5432 failed: INSERT INTO "users" password_hash=hunter2'));
    try {
      await registerUser({ ...providerInput });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(500);
      const blob = (e as Error).message + JSON.stringify((e as AppError).details ?? '');
      expect(blob).not.toContain('s3cure-pass');
      expect(blob).not.toContain('hunter2');
      expect(blob).not.toContain('postgres://');
      expect(blob).not.toContain('INSERT INTO');
    }
  });

  it('hashPassword uses bcrypt (no plaintext round-trip)', async () => {
    const hash = await hashPassword('another-secret');
    expect(hash).not.toBe('another-secret');
    expect(await bcrypt.compare('another-secret', hash)).toBe(true);
  });
});

describe('AUTH-01 POST /api/auth/register route', () => {
  it('returns 201 with sanitized user and no tokens', async () => {
    createMockPrisma();
    const app = createApp();
    const res = await request(app).post('/api/auth/register').send(providerInput);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe('alice@example.com');
    expect(res.body.data.organization.id).toBe('org-1');
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain('passwordHash');
    expect(blob).not.toContain('s3cure-pass');
    expect(res.body.data.token).toBeUndefined();
    expect(res.body.data.accessToken).toBeUndefined();
  });

  it('returns 400 VALIDATION_ERROR envelope for bad input', async () => {
    createMockPrisma();
    const app = createApp();
    const res = await request(app).post('/api/auth/register').send({ ...providerInput, email: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('s3cure-pass');
  });

  it('returns 409 for duplicate email', async () => {
    const { findUnique } = createMockPrisma();
    findUnique.mockResolvedValueOnce({ id: 'existing' });
    const app = createApp();
    const res = await request(app).post('/api/auth/register').send(providerInput);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('only POST /register is mounted (GET falls through to 404)', async () => {
    createMockPrisma();
    const app = createApp();
    const res = await request(app).get('/api/auth/register');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
