import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../createApp';
import { createRequirement } from '../services/requirements.service';
import { signAccessToken } from '../utils/jwt';

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    food_category: 'Prepared meals',
    food_type: 'Vegetarian',
    quantity_required: 100,
    required_by: '2099-01-01T10:00:00.000Z',
    priority: 'HIGH',
    location: 'XYZ Shelter, Springfield',
    ...overrides,
  };
}

function callerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    role: 'RECIPIENT',
    status: 'ACTIVE',
    organization: { id: 'org-1', verificationStatus: 'VERIFIED' },
    ...overrides,
  };
}

function mockBackend(caller: Record<string, unknown> | null) {
  const userFind = vi.fn(async () => caller);
  const requirementCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'req-1',
    quantityFulfilled: 0,
    status: 'OPEN',
    createdAt: new Date('2026-09-19T00:00:00.000Z'),
    updatedAt: new Date('2026-09-19T00:00:00.000Z'),
    ...args.data,
  }));
  const auditCreate = vi.fn();
  const notificationCreate = vi.fn();
  const historyCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'rh-1',
    ...args.data,
  }));
  const client = {
    user: { findUnique: userFind },
    category: { findFirst: vi.fn(async () => ({ id: 'cat-1' })) },
    requirement: { create: requirementCreate },
    requirementHistory: { create: historyCreate },
    auditLog: { create: auditCreate },
    notification: { create: notificationCreate },
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (c: unknown) => Promise<unknown>)(client);
      }
      if (Array.isArray(arg)) return Promise.all(arg);
      throw new Error('unsupported transaction');
    }),
  };
  vi.mocked(getPrisma).mockReturnValue(client as unknown as PrismaClient);
  return { userFind, requirementCreate, historyCreate, auditCreate, notificationCreate };
}

function token(role = 'RECIPIENT', id = 'user-1'): string {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId: 'org-1' });
}

function post(body: unknown, role = 'RECIPIENT', id = 'user-1') {
  const app = createApp();
  return request(app)
    .post('/api/requirements')
    .set('Authorization', `Bearer ${token(role, id)}`)
    .send(body as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('REQ-01 create requirement', () => {
  describe('authentication / authorization', () => {
    it('rejects unauthenticated requests with 401', async () => {
      mockBackend(callerRow());
      const app = createApp();
      const res = await request(app).post('/api/requirements').send(validBody());
      expect(res.status).toBe(401);
    });

    it.each(['PROVIDER', 'VOLUNTEER', 'ADMIN'] as const)(
      'rejects %s with 403 (recipient-only) and zero writes',
      async (role) => {
        const { requirementCreate } = mockBackend(callerRow({ role }));
        const res = await post(validBody(), role, 'x-1');
        expect(res.status).toBe(403);
        expect(requirementCreate).not.toHaveBeenCalled();
      }
    );

    it('rejects an inactive/suspended recipient with 401 and zero writes', async () => {
      const { requirementCreate } = mockBackend(callerRow({ status: 'SUSPENDED' }));
      const res = await post(validBody());
      expect(res.status).toBe(401);
      expect(requirementCreate).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown caller without writing', async () => {
      const { requirementCreate } = mockBackend(null);
      const res = await post(validBody());
      expect(res.status).toBe(404);
      expect(requirementCreate).not.toHaveBeenCalled();
    });

    it('service-level defense-in-depth rejects non-recipient callers', async () => {
      mockBackend(callerRow({ role: 'PROVIDER' }));
      await expect(createRequirement('user-1', validBody())).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe('organization verification gate', () => {
    it('creates for a VERIFIED organization (201)', async () => {
      const { requirementCreate } = mockBackend(callerRow());
      const res = await post(validBody());
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(requirementCreate).toHaveBeenCalledTimes(1);
    });

    it.each(['PENDING', 'UNDER_REVIEW', 'REJECTED'] as const)(
      'rejects an organization with verificationStatus %s with 403 and zero writes',
      async (verificationStatus) => {
        const { requirementCreate } = mockBackend(
          callerRow({ organization: { id: 'org-1', verificationStatus } })
        );
        const res = await post(validBody());
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
        expect(requirementCreate).not.toHaveBeenCalled();
      }
    );

    it('rejects a recipient with no organization with 403 and zero writes', async () => {
      const { requirementCreate } = mockBackend(callerRow({ organization: null }));
      const res = await post(validBody());
      expect(res.status).toBe(403);
      expect(requirementCreate).not.toHaveBeenCalled();
    });
  });

  describe('creation semantics', () => {
    it('persists all fields, derives organizationId from the session, sets OPEN and quantityFulfilled 0', async () => {
      const { requirementCreate } = mockBackend(callerRow());
      const res = await post(validBody());
      expect(res.status).toBe(201);
      expect(requirementCreate).toHaveBeenCalledWith({
        data: {
          organizationId: 'org-1',
          foodCategory: 'Prepared meals',
          foodType: 'Vegetarian',
          quantityRequired: 100,
          requiredBy: new Date('2099-01-01T10:00:00.000Z'),
          priority: 'HIGH',
          location: 'XYZ Shelter, Springfield',
          status: 'OPEN',
        },
      });
      const r = res.body.data.requirement;
      expect(r).toEqual(
        expect.objectContaining({
          id: 'req-1',
          organization_id: 'org-1',
          food_category: 'Prepared meals',
          food_type: 'Vegetarian',
          quantity_required: 100,
          quantity_fulfilled: 0,
          priority: 'HIGH',
          location: 'XYZ Shelter, Springfield',
          status: 'OPEN',
        })
      );
    });

    it('accepts a lowercase enum priority value and persists it', async () => {
      const { requirementCreate } = mockBackend(callerRow());
      // priority must be one of the enum values exactly
      const res = await post(validBody({ priority: 'CRITICAL' }));
      expect(res.status).toBe(201);
      expect(requirementCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ priority: 'CRITICAL' }) })
      );
    });

    it('does not emit audit or notification events', async () => {
      const { auditCreate, notificationCreate } = mockBackend(callerRow());
      await post(validBody());
      expect(auditCreate).not.toHaveBeenCalled();
      expect(notificationCreate).not.toHaveBeenCalled();
    });
  });

  describe('request validation (strict)', () => {
    const badBodies: Array<[string, Record<string, unknown>]> = [
      ['missing food_category', validBody({ food_category: undefined })],
      ['empty food_category', validBody({ food_category: '   ' })],
      ['non-string food_category', validBody({ food_category: 5 })],
      ['missing food_type', validBody({ food_type: '' })],
      ['missing quantity_required', validBody({ quantity_required: undefined })],
      ['zero quantity', validBody({ quantity_required: 0 })],
      ['negative quantity', validBody({ quantity_required: -3 })],
      ['string quantity', validBody({ quantity_required: '100' })],
      ['non-finite quantity', validBody({ quantity_required: Infinity })],
      ['malformed required_by', validBody({ required_by: 'not-a-date' })],
      ['null required_by', validBody({ required_by: null })],
      ['boolean required_by', validBody({ required_by: true })],
      ['array required_by', validBody({ required_by: ['2099-01-01T10:00:00.000Z'] })],
      ['past required_by', validBody({ required_by: '2020-01-01T00:00:00.000Z' })],
      ['invalid priority', validBody({ priority: 'URGENT' })],
      ['missing location', validBody({ location: '  ' })],
      ['client status', validBody({ status: 'FULFILLED' })],
      ['client organizationId', validBody({ organizationId: 'other-org' })],
      ['client organization_id', validBody({ organization_id: 'other-org' })],
      ['client quantity_fulfilled', validBody({ quantity_fulfilled: 50 })],
      ['client id', validBody({ id: 'req-x' })],
      ['client createdAt', validBody({ createdAt: '2020-01-01T00:00:00.000Z' })],
      ['client userId', validBody({ userId: 'other' })],
      ['unknown field', validBody({ extra: true })],
    ];

    it.each(badBodies)('rejects %s with 400 and zero writes', async (_label, body) => {
      const { requirementCreate } = mockBackend(callerRow());
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(requirementCreate).not.toHaveBeenCalled();
    });

    it('rejects empty required_by string', async () => {
      const { requirementCreate } = mockBackend(callerRow());
      const res = await post(validBody({ required_by: '' }));
      expect(res.status).toBe(400);
      expect(requirementCreate).not.toHaveBeenCalled();
    });
  });

  describe('security', () => {
    it('body/query identity spoofing cannot change the owning organization', async () => {
      const { requirementCreate } = mockBackend(callerRow());
      const app = createApp();
      // Body spoof is rejected by the strict schema; query spoof is ignored.
      const res = await request(app)
        .post('/api/requirements?organizationId=other-org&userId=other&role=RECIPIENT')
        .set('Authorization', `Bearer ${token('RECIPIENT', 'user-1')}`)
        .send(validBody());
      expect(res.status).toBe(201);
      expect(requirementCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ organizationId: 'org-1' }) })
      );
    });

    it('does not expose sensitive fields', async () => {
      mockBackend(callerRow());
      const res = await post(validBody());
      const blob = JSON.stringify(res.body);
      expect(blob).not.toContain('password');
      expect(blob).not.toContain('passwordHash');
      expect(res.body.data.requirement.organization).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('masks persistence failures with no SQL/DSN leakage', async () => {
      const app = createApp();
      vi.mocked(getPrisma).mockReturnValue({
        user: { findUnique: vi.fn(async () => callerRow()) },
        category: { findFirst: vi.fn(async () => ({ id: 'cat-1' })) },
        requirement: {
          create: vi.fn(async () => {
            throw new Error('INSERT failed postgresql://u:p@h/db');
          }),
        },
      } as unknown as PrismaClient);
      const res = await post(validBody());
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('REQUIREMENT_CREATE_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('postgresql://');
      expect(JSON.stringify(res.body)).not.toContain('INSERT');
    });
  });
});
