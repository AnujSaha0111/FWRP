import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';

function validCreateBody(overrides: Record<string, unknown> = {}) {
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

function recipientCaller() {
  return {
    id: 'user-1',
    role: 'RECIPIENT',
    status: 'ACTIVE',
    organization: { id: 'org-1', verificationStatus: 'VERIFIED' },
  };
}

function token(): string {
  return signAccessToken({ id: 'user-1', email: 'user-1@example.com', role: 'RECIPIENT', organizationId: 'org-1' });
}

function mockCreate(categoryActive = true) {
  const userFind = vi.fn(async () => recipientCaller());
  const categoryFind = vi.fn(async () => (categoryActive ? { id: 'cat-1' } : null));
  const categoryCreate = vi.fn();
  const requirementCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'req-1',
    quantityFulfilled: 0,
    status: 'OPEN',
    createdAt: new Date('2026-09-19T00:00:00.000Z'),
    updatedAt: new Date('2026-09-19T00:00:00.000Z'),
    ...args.data,
  }));
  const historyCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'rh-1',
    ...args.data,
  }));
  const client = {
    user: { findUnique: userFind },
    category: { findFirst: categoryFind, create: categoryCreate },
    requirement: { create: requirementCreate },
    requirementHistory: { create: historyCreate },
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (c: unknown) => Promise<unknown>)(client);
      }
      if (Array.isArray(arg)) return Promise.all(arg);
      throw new Error('unsupported transaction');
    }),
  };
  vi.mocked(getPrisma).mockReturnValue(client as unknown as PrismaClient);
  return { userFind, categoryFind, categoryCreate, requirementCreate, historyCreate };
}

function createReq(body: unknown) {
  const app = createApp();
  return request(app)
    .post('/api/requirements')
    .set('Authorization', `Bearer ${token()}`)
    .send(body as Record<string, unknown>);
}

describe('REQ-03 requirement validation — active category (create)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts an active category and validates against `{ name, isActive: true }`', async () => {
    const { categoryFind, categoryCreate, requirementCreate } = mockCreate(true);
    const res = await createReq(validCreateBody());
    expect(res.status).toBe(201);
    expect(categoryFind).toHaveBeenCalledWith({
      where: { name: 'Prepared meals', isActive: true },
      select: { id: true },
    });
    expect(requirementCreate).toHaveBeenCalledTimes(1);
    // Never auto-create a category.
    expect(categoryCreate).not.toHaveBeenCalled();
  });

  it('rejects an unknown/inactive category with 400 and zero writes', async () => {
    const { categoryFind, requirementCreate } = mockCreate(false);
    const res = await createReq(validCreateBody({ food_category: 'Nonexistent' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'food_category' })])
    );
    expect(categoryFind).toHaveBeenCalledWith({
      where: { name: 'Nonexistent', isActive: true },
      select: { id: true },
    });
    expect(requirementCreate).not.toHaveBeenCalled();
  });

  it('does not match case variants or partials (exact match only)', async () => {
    const { categoryFind, requirementCreate } = mockCreate(false);
    for (const value of ['prepared meals', 'Prepared', 'PREPARED MEALS']) {
      const res = await createReq(validCreateBody({ food_category: value }));
      expect(res.status).toBe(400);
      expect(categoryFind).toHaveBeenCalledWith({
        where: { name: value, isActive: true },
        select: { id: true },
      });
    }
    expect(requirementCreate).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('rejects empty/whitespace category (%j) at the schema with 400', async (food_category) => {
    const { categoryFind, requirementCreate } = mockCreate(true);
    const res = await createReq(validCreateBody({ food_category }));
    expect(res.status).toBe(400);
    expect(categoryFind).not.toHaveBeenCalled();
    expect(requirementCreate).not.toHaveBeenCalled();
  });

  it('cannot spoof the category through an unrelated field (strict schema)', async () => {
    const { requirementCreate } = mockCreate(true);
    for (const body of [
      validCreateBody({ category: 'Fruits' }),
      validCreateBody({ foodCategory: 'Fruits' }),
      validCreateBody({ category_id: 'cat-1' }),
    ]) {
      const res = await createReq(body);
      expect(res.status).toBe(400);
    }
    expect(requirementCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Edit path: active-category validation applies only when food_category is
// actually edited, and must not bypass the existing REQ-02 guards.

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
    quantityFulfilled: 10,
    requiredBy: new Date('2099-01-01T10:00:00.000Z'),
    priority: 'HIGH',
    location: 'XYZ Shelter, Springfield',
    status: 'OPEN',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function mockEdit(categoryActive = true, seed: ReqRow[] = [requirementRow()]) {
  const store = seed.map((r) => ({ ...r }));
  const auditLogs: Array<Record<string, unknown>> = [];
  const userFind = vi.fn(async () => recipientCaller());
  const categoryFind = vi.fn(async () => (categoryActive ? { id: 'cat-1' } : null));
  const requirementFindUnique = vi.fn(async (args: { where: { id: string } }) => {
    const row = store.find((r) => r.id === args.where.id);
    return row ? { ...row } : null;
  });
  const requirementUpdateMany = vi.fn(
    async (args: { where: { id: string; organizationId?: string; status?: { in: string[] } }; data: Record<string, unknown> }) => {
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
    auditLogs.push(args.data);
    return { id: 'audit-1', ...args.data };
  });

  const tx = {
    requirement: { findUnique: requirementFindUnique, updateMany: requirementUpdateMany },
    requirementHistory: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'rh-1',
        ...args.data,
      })),
    },
    category: { findFirst: categoryFind },
    auditLog: { create: auditCreate },
  };
  const $transaction = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));

  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: userFind },
    requirement: { findUnique: requirementFindUnique, updateMany: requirementUpdateMany },
    auditLog: { create: auditCreate },
    $transaction,
  } as unknown as PrismaClient);
  return { store, auditLogs, categoryFind, requirementUpdateMany, auditCreate };
}

function putReq(body: unknown) {
  const app = createApp();
  return request(app)
    .put('/api/requirements/req-1')
    .set('Authorization', `Bearer ${token()}`)
    .send(body as Record<string, unknown>);
}

describe('REQ-03 requirement validation — active category (edit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates an edited food_category against the active set and persists it', async () => {
    const { categoryFind, requirementUpdateMany, store } = mockEdit(true);
    const res = await putReq({ food_category: 'Fruits' });
    expect(res.status).toBe(200);
    expect(categoryFind).toHaveBeenCalledWith({
      where: { name: 'Fruits', isActive: true },
      select: { id: true },
    });
    expect(requirementUpdateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', organizationId: 'org-1', status: { in: ['OPEN', 'PARTIALLY_FULFILLED'] } },
      data: { foodCategory: 'Fruits' },
    });
    expect(store[0].foodCategory).toBe('Fruits');
  });

  it.each(['Nonexistent', 'prepared meals'])(
    'rejects an unknown/inactive edited category %s with 400 zero mutation/audit',
    async (food_category) => {
      const { requirementUpdateMany, auditCreate, store } = mockEdit(false);
      const res = await putReq({ food_category });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(requirementUpdateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
      expect(store[0].foodCategory).toBe('Prepared meals');
    }
  );

  it('does not perform a category lookup when food_category is not edited', async () => {
    const { categoryFind } = mockEdit(true);
    const res = await putReq({ location: 'New Address' });
    expect(res.status).toBe(200);
    expect(categoryFind).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Consolidation: REQ-03 boundary checks not already pinned by REQ-01/REQ-02.

describe('REQ-03 requirement validation — boundary consolidation (create)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])('accepts priority %s', async (priority) => {
    const { requirementCreate } = mockCreate(true);
    const res = await createReq(validCreateBody({ priority }));
    expect(res.status).toBe(201);
    expect(requirementCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ priority }) })
    );
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-finite', Infinity],
    ['non-numeric', '100'],
  ])('rejects invalid quantity_required (%s) with 400 zero writes', async (_label, quantity_required) => {
    const { requirementCreate } = mockCreate(true);
    const res = await createReq(validCreateBody({ quantity_required }));
    expect(res.status).toBe(400);
    expect(requirementCreate).not.toHaveBeenCalled();
  });

  it('accepts a valid positive decimal quantity_required', async () => {
    const { requirementCreate } = mockCreate(true);
    const res = await createReq(validCreateBody({ quantity_required: 12.5 }));
    expect(res.status).toBe(201);
    expect(requirementCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ quantityRequired: 12.5 }) })
    );
  });

  it('rejects a required_by at/before now (boundary) with 400 zero writes', async () => {
    const { requirementCreate } = mockCreate(true);
    const res = await createReq(validCreateBody({ required_by: new Date().toISOString() }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(requirementCreate).not.toHaveBeenCalled();
  });

  it('rejects non-string location with 400 zero writes', async () => {
    const { requirementCreate } = mockCreate(true);
    const res = await createReq(validCreateBody({ location: 123 }));
    expect(res.status).toBe(400);
    expect(requirementCreate).not.toHaveBeenCalled();
  });
});
