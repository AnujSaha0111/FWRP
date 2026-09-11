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

// AUTH-09: caller's own organization only. The org id always resolves from
// the session user row — there is no org-id input to spoof, and joining an
// existing org by id is intentionally not offered (Phase 5 owns membership).

const ORG = {
  id: 'org-1',
  name: 'Good Food Org',
  type: 'NGO',
  address: '12 Market Street',
  latitude: 12.5,
  longitude: 77.5,
  contactInformation: '+1 555-000-0000',
  verificationStatus: 'VERIFIED',
  createdAt: new Date('2026-09-03T00:00:00.000Z'),
  updatedAt: new Date('2026-09-03T00:00:00.000Z'),
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

function mockPrisma(current: Record<string, unknown> | null) {
  const orgUpdate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...ORG, ...args.data }));
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'log-1', ...args.data }));
  const mockTx = { organization: { update: orgUpdate }, auditLog: { create: auditCreate } };
  const findUnique = vi.fn(async () => current);
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique },
    $transaction,
  } as unknown as PrismaClient);
  return { findUnique, orgUpdate, auditCreate, $transaction };
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

describe('AUTH-09 GET /api/organizations/me', () => {
  it('returns the caller organization resolved from the session', async () => {
    const { findUnique } = mockPrisma(userRow());
    const app = createApp();
    const res = await request(app).get('/api/organizations/me').set(authHeader());
    expect(res.status).toBe(200);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' }, include: { organization: true } });
    expect(res.body.data.organization).toMatchObject({ id: 'org-1', name: 'Good Food Org', type: 'NGO' });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('rejects missing org, unauthenticated, unknown, and inactive callers', async () => {
    mockPrisma(userRow({ organizationId: null, organization: null, role: 'VOLUNTEER' }));
    const app = createApp();
    const noOrg = await request(app).get('/api/organizations/me').set(authHeader());
    expect(noOrg.status).toBe(404);
    expect(noOrg.body.error.code).toBe('NOT_FOUND');

    const anon = await request(app).get('/api/organizations/me');
    expect(anon.status).toBe(401);

    mockPrisma(null);
    const missing = await request(app).get('/api/organizations/me').set(authHeader());
    expect(missing.status).toBe(404);

    mockPrisma(userRow({ status: 'SUSPENDED' }));
    const suspended = await request(app).get('/api/organizations/me').set(authHeader());
    expect(suspended.status).toBe(401);
  });

  it('masks read failures', async () => {
    vi.mocked(getPrisma).mockReturnValue({
      user: {
        findUnique: vi.fn(async () => {
          throw new Error('SELECT * FROM "organizations" failed postgres://u:p@h/db');
        }),
      },
    } as unknown as PrismaClient);
    const app = createApp();
    const res = await request(app).get('/api/organizations/me').set(authHeader());
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('ORGANIZATION_READ_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('postgres://');
  });
});

describe('AUTH-09 PUT /api/organizations/me', () => {
  it('updates member-editable fields atomically with audit on one transaction', async () => {
    const { orgUpdate, auditCreate, $transaction } = mockPrisma(userRow());
    const app = createApp();
    const res = await request(app)
      .put('/api/organizations/me')
      .set(authHeader())
      .send({ name: 'Good Food Org Updated', address: '99 New Road', contactInformation: '+1 555-111-2222' });
    expect(res.status).toBe(200);
    expect($transaction).toHaveBeenCalledTimes(1);
    // Target org comes from the session row, never from input.
    expect(orgUpdate).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { name: 'Good Food Org Updated', address: '99 New Road', contactInformation: '+1 555-111-2222' },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', action: 'ORGANIZATION_UPDATE', entityType: 'Organization', entityId: 'org-1' }),
    });
    const auditData = auditCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(JSON.parse(auditData.oldValue as string)).toMatchObject({ name: 'Good Food Org' });
    expect(JSON.parse(auditData.newValue as string)).toMatchObject({ name: 'Good Food Org Updated' });
    expect(res.body.data.organization.name).toBe('Good Food Org Updated');
  });

  it('rejects protected fields, empty bodies, and org-less callers without touching the database', async () => {
    const { orgUpdate, $transaction } = mockPrisma(userRow());
    const app = createApp();
    for (const body of [
      { type: 'HOTEL' },
      { latitude: 1.1 },
      { verificationStatus: 'VERIFIED' },
      { organizationId: 'org-9' },
      { id: 'org-9', name: 'Spoofed' },
      {},
    ]) {
      const res = await request(app).put('/api/organizations/me').set(authHeader()).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(orgUpdate).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();

    mockPrisma(userRow({ organizationId: null, organization: null }));
    const noOrg = await request(app).put('/api/organizations/me').set(authHeader()).send({ name: 'X' });
    expect(noOrg.status).toBe(404);
  });

  it('requires authentication and masks update failures', async () => {
    mockPrisma(userRow());
    const app = createApp();
    const anon = await request(app).put('/api/organizations/me').send({ name: 'X' });
    expect(anon.status).toBe(401);

    vi.mocked(getPrisma).mockReturnValue({
      user: { findUnique: vi.fn(async () => userRow()) },
      $transaction: vi.fn(async () => {
        throw new Error('UPDATE "organizations" failed');
      }),
    } as unknown as PrismaClient);
    const res = await request(app).put('/api/organizations/me').set(authHeader()).send({ name: 'X' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('ORGANIZATION_UPDATE_FAILED');
  });
});
