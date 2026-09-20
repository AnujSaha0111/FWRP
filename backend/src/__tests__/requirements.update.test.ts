import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { updateRequirement } from '../services/requirements.service';
import { signAccessToken } from '../utils/jwt';

// REQ-02: owner-organization requirement editing — PUT /api/requirements/:id.
// OPEN/PARTIALLY_FULFILLED only; session-derived ownership; strict partial body;
// effective `quantity_fulfilled <= quantity_required` invariant; one
// REQUIREMENT_UPDATED audit in the same transaction.

interface ReqRow {
  id: string;
  organizationId: string;
  foodCategory: string;
  foodType: string;
  quantityRequired: number;
  quantityFulfilled: number;
  requiredBy: Date;
  priority: string;
  location: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

function requirementRow(overrides: Partial<ReqRow> = {}): ReqRow {
  return {
    id: 'req-1',
    organizationId: 'org-1',
    foodCategory: 'Prepared meals',
    foodType: 'Vegetarian',
    quantityRequired: 100,
    quantityFulfilled: 0,
    requiredBy: new Date('2099-01-01T10:00:00.000Z'),
    priority: 'HIGH',
    location: 'XYZ Shelter, Springfield',
    status: 'OPEN',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function callerRow(opts: { id?: string; role?: string; status?: string; org?: { id: string; verificationStatus: string } | null } = {}) {
  return {
    id: opts.id ?? 'user-1',
    role: opts.role ?? 'RECIPIENT',
    status: opts.status ?? 'ACTIVE',
    organization: opts.org === undefined ? { id: 'org-1', verificationStatus: 'VERIFIED' } : opts.org,
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { location: 'New Shelter Address', ...overrides };
}

interface MockOptions {
  statusChangedBeforeWrite?: string;
  auditFailure?: boolean;
}

function mockBackend(caller: ReturnType<typeof callerRow> | null, seed: ReqRow[], opts: MockOptions = {}) {
  const store = seed.map((r) => ({ ...r }));
  const auditLogs: Array<Record<string, unknown>> = [];
  const userFind = vi.fn(async () => caller);
  const requirementFindUnique = vi.fn(async (args: { where: { id: string } }) => {
    const row = store.find((r) => r.id === args.where.id);
    return row ? { ...row } : null;
  });
  const requirementUpdateMany = vi.fn(
    async (args: { where: { id: string; organizationId?: string; status?: { in: string[] } }; data: Record<string, unknown> }) => {
      if (opts.statusChangedBeforeWrite) {
        const r = store.find((x) => x.id === args.where.id);
        if (r) r.status = opts.statusChangedBeforeWrite;
      }
      let count = 0;
      for (const r of store) {
        if (r.id !== args.where.id) continue;
        if (args.where.organizationId !== undefined && r.organizationId !== args.where.organizationId) continue;
        if (args.where.status?.in && !args.where.status.in.includes(r.status)) continue;
        Object.assign(r, args.data, { updatedAt: new Date(Date.now() + 1000) });
        count += 1;
      }
      return { count };
    }
  );
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    if (opts.auditFailure) throw new Error('AUDIT INSERT failed postgresql://u:p@h/db');
    auditLogs.push(args.data);
    return { id: `audit-${auditLogs.length}`, ...args.data };
  });

  const tx = {
    requirement: { findUnique: requirementFindUnique, updateMany: requirementUpdateMany },
    auditLog: { create: auditCreate },
  };
  const $transaction = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
    const snapshot = store.map((r) => ({ ...r }));
    try {
      return await fn(tx);
    } catch (err) {
      store.splice(0, store.length, ...snapshot);
      throw err;
    }
  });

  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: userFind },
    requirement: { findUnique: requirementFindUnique, updateMany: requirementUpdateMany },
    auditLog: { create: auditCreate },
    $transaction,
  } as unknown as PrismaClient);

  return { store, auditLogs, userFind, requirementFindUnique, requirementUpdateMany, auditCreate, $transaction };
}

function token(role = 'RECIPIENT', id = 'user-1'): string {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId: 'org-1' });
}

function put(body: unknown, role = 'RECIPIENT', id = 'user-1', qs = '') {
  const app = createApp();
  return request(app)
    .put(`/api/requirements/req-1${qs}`)
    .set('Authorization', `Bearer ${token(role, id)}`)
    .send(body as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('REQ-02 edit requirement', () => {
  describe('authentication / authorization', () => {
    it('rejects unauthenticated requests with 401', async () => {
      mockBackend(callerRow(), [requirementRow()]);
      const app = createApp();
      const res = await request(app).put('/api/requirements/req-1').send(validBody());
      expect(res.status).toBe(401);
    });

    it.each(['PROVIDER', 'VOLUNTEER', 'ADMIN'] as const)(
      'rejects %s with 403 and zero writes',
      async (role) => {
        const { requirementUpdateMany } = mockBackend(callerRow({ role }), [requirementRow()]);
        const res = await put(validBody(), role, 'x-1');
        expect(res.status).toBe(403);
        expect(requirementUpdateMany).not.toHaveBeenCalled();
      }
    );

    it('rejects an inactive/suspended recipient with 401 and zero writes', async () => {
      const { requirementUpdateMany } = mockBackend(callerRow({ status: 'SUSPENDED' }), [requirementRow()]);
      const res = await put(validBody());
      expect(res.status).toBe(401);
      expect(requirementUpdateMany).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown caller without writing', async () => {
      const { requirementUpdateMany } = mockBackend(null, [requirementRow()]);
      const res = await put(validBody());
      expect(res.status).toBe(404);
      expect(requirementUpdateMany).not.toHaveBeenCalled();
    });

    it('service-level defense-in-depth rejects non-recipient callers', async () => {
      mockBackend(callerRow({ role: 'PROVIDER' }), [requirementRow()]);
      await expect(updateRequirement('req-1', 'user-1', validBody())).rejects.toMatchObject({
        statusCode: 403,
      });
    });
  });

  describe('ownership', () => {
    it('lets the owning recipient organization edit', async () => {
      const { store } = mockBackend(callerRow(), [requirementRow()]);
      const res = await put(validBody());
      expect(res.status).toBe(200);
      expect(res.body.data.requirement.location).toBe('New Shelter Address');
      expect(store[0].location).toBe('New Shelter Address');
    });

    it('rejects a different recipient organization with 403 and zero writes', async () => {
      const { requirementUpdateMany, auditLogs, store } = mockBackend(
        callerRow({ org: { id: 'org-2', verificationStatus: 'VERIFIED' } }),
        [requirementRow({ organizationId: 'org-1' })]
      );
      const res = await put(validBody());
      expect(res.status).toBe(403);
      expect(requirementUpdateMany).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
      expect(store[0].location).toBe('XYZ Shelter, Springfield');
    });

    it('returns 404 for an unknown requirement with zero writes', async () => {
      const { requirementUpdateMany } = mockBackend(callerRow(), []);
      const res = await put(validBody());
      expect(res.status).toBe(404);
      expect(requirementUpdateMany).not.toHaveBeenCalled();
    });

    it('body organization spoofing is rejected by the strict schema', async () => {
      const { requirementUpdateMany } = mockBackend(callerRow({ org: { id: 'org-2', verificationStatus: 'VERIFIED' } }), [
        requirementRow({ organizationId: 'org-1' }),
      ]);
      const res = await put(validBody({ organization_id: 'org-1' }));
      expect(res.status).toBe(400);
      expect(requirementUpdateMany).not.toHaveBeenCalled();
    });

    it('query identity spoofing cannot change ownership', async () => {
      const { requirementUpdateMany } = mockBackend(
        callerRow({ org: { id: 'org-2', verificationStatus: 'VERIFIED' } }),
        [requirementRow({ organizationId: 'org-1' })]
      );
      const res = await put(validBody(), 'RECIPIENT', 'user-1', '?organizationId=org-1&userId=user-9');
      expect(res.status).toBe(403);
      expect(requirementUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('editable status', () => {
    it.each(['OPEN', 'PARTIALLY_FULFILLED'] as const)('allows editing status %s', async (status) => {
      mockBackend(callerRow(), [requirementRow({ status })]);
      const res = await put(validBody());
      expect(res.status).toBe(200);
    });

    it.each(['FULFILLED', 'EXPIRED', 'CANCELLED'] as const)(
      'rejects status %s with 409 and zero mutation/audit',
      async (status) => {
        const { requirementUpdateMany, auditLogs, store } = mockBackend(callerRow(), [requirementRow({ status })]);
        const res = await put(validBody());
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONFLICT');
        expect(requirementUpdateMany).not.toHaveBeenCalled();
        expect(auditLogs).toHaveLength(0);
        expect(store[0].status).toBe(status);
      }
    );

    it('does not change status on a successful edit', async () => {
      const { store } = mockBackend(callerRow(), [requirementRow({ status: 'PARTIALLY_FULFILLED' })]);
      const res = await put(validBody());
      expect(res.status).toBe(200);
      expect(res.body.data.requirement.status).toBe('PARTIALLY_FULFILLED');
      expect(store[0].status).toBe('PARTIALLY_FULFILLED');
    });
  });

  describe('validation (strict partial body)', () => {
    const badBodies: Array<[string, Record<string, unknown>, number]> = [
      ['empty body', {}, 400],
      ['empty food_category', { food_category: '  ' }, 400],
      ['zero quantity', { quantity_required: 0 }, 400],
      ['negative quantity', { quantity_required: -1 }, 400],
      ['non-finite quantity', { quantity_required: Infinity }, 400],
      ['string quantity', { quantity_required: '100' }, 400],
      ['malformed required_by', { required_by: 'nope' }, 400],
      ['null required_by', { required_by: null }, 400],
      ['boolean required_by', { required_by: true }, 400],
      ['array required_by', { required_by: ['2099-01-01T10:00:00.000Z'] }, 400],
      ['past required_by', { required_by: '2020-01-01T00:00:00.000Z' }, 400],
      ['invalid priority', { priority: 'URGENT' }, 400],
      ['empty location', { location: '   ' }, 400],
      ['client status', { status: 'FULFILLED' }, 400],
      ['client quantity_fulfilled', { quantity_fulfilled: 5 }, 400],
      ['client organizationId', { organizationId: 'org-1' }, 400],
      ['client id', { id: 'req-x' }, 400],
      ['client created_at', { created_at: '2020-01-01T00:00:00.000Z' }, 400],
      ['client updated_at', { updated_at: '2020-01-01T00:00:00.000Z' }, 400],
      ['unknown field', { extra: true }, 400],
    ];

    it.each(badBodies)('rejects %s with %i and zero writes', async (_label, body, expected) => {
      const { requirementUpdateMany } = mockBackend(callerRow(), [requirementRow()]);
      const res = await put(body);
      expect(res.status).toBe(expected);
      expect(requirementUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('fulfillment invariant', () => {
    it('allows quantity_required >= existing quantity_fulfilled', async () => {
      mockBackend(callerRow(), [requirementRow({ quantityRequired: 100, quantityFulfilled: 40 })]);
      const res = await put({ quantity_required: 40 });
      expect(res.status).toBe(200);
      expect(res.body.data.requirement.quantity_required).toBe(40);
    });

    it('rejects quantity_required < existing quantity_fulfilled with zero writes', async () => {
      const { requirementUpdateMany, auditLogs } = mockBackend(callerRow(), [
        requirementRow({ quantityRequired: 100, quantityFulfilled: 40 }),
      ]);
      const res = await put({ quantity_required: 39 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(requirementUpdateMany).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
    });

    it('cannot modify quantity_fulfilled directly (strict schema)', async () => {
      const { requirementUpdateMany } = mockBackend(callerRow(), [
        requirementRow({ quantityFulfilled: 10 }),
      ]);
      const res = await put({ quantity_required: 200, quantity_fulfilled: 0 });
      expect(res.status).toBe(400);
      expect(requirementUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('update semantics', () => {
    it('persists edited fields, leaves untouched fields unchanged, and preserves server-controlled fields/status', async () => {
      const { requirementUpdateMany, store } = mockBackend(callerRow(), [
        requirementRow({ quantityFulfilled: 5, status: 'PARTIALLY_FULFILLED' }),
      ]);
      const res = await put({
        food_category: 'Fruits',
        food_type: 'Vegan',
        quantity_required: 200,
        priority: 'CRITICAL',
      });
      expect(res.status).toBe(200);
      expect(requirementUpdateMany).toHaveBeenCalledWith({
        where: { id: 'req-1', organizationId: 'org-1', status: { in: ['OPEN', 'PARTIALLY_FULFILLED'] } },
        data: {
          foodCategory: 'Fruits',
          foodType: 'Vegan',
          quantityRequired: 200,
          priority: 'CRITICAL',
        },
      });
      const r = res.body.data.requirement;
      expect(r.food_category).toBe('Fruits');
      expect(r.quantity_required).toBe(200);
      // untouched
      expect(r.location).toBe('XYZ Shelter, Springfield');
      expect(r.required_by).toBe('2099-01-01T10:00:00.000Z');
      // server-controlled
      expect(r.quantity_fulfilled).toBe(5);
      expect(r.status).toBe('PARTIALLY_FULFILLED');
      expect(r.organization_id).toBe('org-1');
      expect(store[0].quantityFulfilled).toBe(5);
    });

    it('bumps updated_at on a successful edit', async () => {
      const before = new Date('2026-09-01T00:00:00.000Z');
      mockBackend(callerRow(), [requirementRow({ updatedAt: before })]);
      const res = await put(validBody());
      expect(new Date(res.body.data.requirement.updated_at).getTime()).toBeGreaterThan(before.getTime());
    });
  });

  describe('audit', () => {
    it('writes exactly one REQUIREMENT_UPDATED event with actor/entity/old/new', async () => {
      const { auditCreate, auditLogs } = mockBackend(callerRow(), [requirementRow()]);
      const res = await put(validBody({ priority: 'LOW' }));
      expect(res.status).toBe(200);
      expect(auditCreate).toHaveBeenCalledTimes(1);
      expect(auditLogs).toHaveLength(1);
      const data = auditLogs[0];
      expect(data).toEqual(
        expect.objectContaining({
          userId: 'user-1',
          action: 'REQUIREMENT_UPDATED',
          entityType: 'Requirement',
          entityId: 'req-1',
        })
      );
      expect(JSON.parse(data.oldValue as string).priority).toBe('HIGH');
      expect(JSON.parse(data.newValue as string).priority).toBe('LOW');
    });

    it('writes no audit for rejected requests', async () => {
      const { auditCreate } = mockBackend(callerRow(), [requirementRow({ status: 'FULFILLED' })]);
      const res = await put(validBody());
      expect(res.status).toBe(409);
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it('rolls back the requirement update and masks errors when audit persistence fails', async () => {
      const { store, requirementUpdateMany } = mockBackend(callerRow(), [requirementRow()], {
        auditFailure: true,
      });
      const res = await put(validBody());
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('AUDIT_PERSIST_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('postgresql://');
      expect(requirementUpdateMany).toHaveBeenCalledTimes(1);
      expect(store[0].location).toBe('XYZ Shelter, Springfield');
    });
  });

  describe('concurrency', () => {
    it('returns 409 with no audit when a concurrent status change makes the conditional update affect zero rows', async () => {
      const { requirementUpdateMany, auditLogs } = mockBackend(callerRow(), [requirementRow({ status: 'OPEN' })], {
        statusChangedBeforeWrite: 'CANCELLED',
      });
      const res = await put(validBody());
      expect(res.status).toBe(409);
      expect(requirementUpdateMany).toHaveBeenCalledTimes(1);
      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('masks persistence failures with no SQL/DSN leakage', async () => {
      const app = createApp();
      vi.mocked(getPrisma).mockReturnValue({
        user: { findUnique: vi.fn(async () => callerRow()) },
        requirement: {
          findUnique: vi.fn(async () => requirementRow()),
          updateMany: vi.fn(async () => {
            throw new Error('UPDATE failed postgresql://u:p@h/db');
          }),
        },
        auditLog: { create: vi.fn() },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({
            requirement: {
              findUnique: vi.fn(async () => requirementRow()),
              updateMany: vi.fn(async () => {
                throw new Error('UPDATE failed postgresql://u:p@h/db');
              }),
            },
            auditLog: { create: vi.fn() },
          })
        ),
      } as unknown as PrismaClient);
      const res = await put(validBody());
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('REQUIREMENT_UPDATE_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('postgresql://');
      expect(JSON.stringify(res.body)).not.toContain('UPDATE failed');
    });
  });
});
