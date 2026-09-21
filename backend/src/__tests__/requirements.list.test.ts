import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mock the global Prisma client — no live database.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { listRequirements } from '../services/requirements.service';
import { signAccessToken } from '../utils/jwt';

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
  // Sensitive/extra fields deliberately present on the mock row to prove the
  // explicit projection strips them.
  email?: string;
  passwordHash?: string;
}

interface WhereShape {
  OR?: Array<Record<string, unknown>>;
  AND?: Array<Record<string, unknown>>;
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
    email: 'recipient@example.com',
    passwordHash: 'bcrypt-hash-placeholder',
    ...overrides,
  };
}

function callerRow(
  opts: {
    id?: string;
    role?: string;
    status?: string;
    org?: { id: string } | null;
  } = {}
) {
  return {
    id: opts.id ?? 'user-1',
    role: opts.role ?? 'RECIPIENT',
    status: opts.status ?? 'ACTIVE',
    organization:
      opts.org === undefined ? { id: 'org-1' } : opts.org,
  };
}

function matchesCondition(row: ReqRow, cond: Record<string, unknown>): boolean {
  if ('organizationId' in cond && row.organizationId !== cond.organizationId) return false;
  if ('status' in cond && row.status !== cond.status) return false;
  if ('foodCategory' in cond && row.foodCategory !== cond.foodCategory) return false;
  if ('priority' in cond && row.priority !== cond.priority) return false;
  return true;
}

function applyWhere(rows: ReqRow[], where: WhereShape): ReqRow[] {
  return rows.filter((r) => {
    if (where.OR && !where.OR.some((c) => matchesCondition(r, c))) return false;
    if (where.AND && !where.AND.every((c) => matchesCondition(r, c))) return false;
    return true;
  });
}

interface MockOptions {
  categoryActive?: boolean;
  dbError?: boolean;
}

function mockBackend(
  caller: ReturnType<typeof callerRow> | null,
  seed: ReqRow[],
  opts: MockOptions = {}
) {
  const rows = seed.map((r) => ({ ...r }));
  const userFind = vi.fn(async () => caller);
  const categoryFindFirst = vi.fn(
    async (args: { where: { name: string; isActive: boolean } }) => {
      if (opts.categoryActive === false) return null;
      return args.where.name === 'Prepared meals' && args.where.isActive
        ? { id: 'cat-1' }
        : null;
    }
  );
  const requirementFindMany = vi.fn(
    async (args: { where: WhereShape; skip?: number; take?: number }) => {
      if (opts.dbError) throw new Error('postgresql://u:p@h/db SELECT failed');
      const filtered = applyWhere(rows, args.where)
        .slice()
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)
        );
      const skip = args.skip ?? 0;
      const take = args.take ?? filtered.length;
      return filtered.slice(skip, skip + take);
    }
  );
  const requirementCount = vi.fn(async (args: { where: WhereShape }) => {
    if (opts.dbError) throw new Error('postgresql://u:p@h/db COUNT failed');
    return applyWhere(rows, args.where).length;
  });
  const requirementCreate = vi.fn();
  const requirementUpdate = vi.fn();
  const requirementUpdateMany = vi.fn();
  const requirementDelete = vi.fn();
  const auditCreate = vi.fn();
  const notificationCreate = vi.fn();
  const $transaction = vi.fn(async (arg: unknown) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    return (arg as (c: unknown) => Promise<unknown>)({});
  });

  const client = {
    user: { findUnique: userFind },
    category: { findFirst: categoryFindFirst },
    requirement: {
      findMany: requirementFindMany,
      count: requirementCount,
      findUnique: vi.fn(),
      create: requirementCreate,
      update: requirementUpdate,
      updateMany: requirementUpdateMany,
      delete: requirementDelete,
    },
    auditLog: { create: auditCreate },
    notification: { create: notificationCreate },
    $transaction,
  };
  vi.mocked(getPrisma).mockReturnValue(client as unknown as PrismaClient);
  return {
    rows,
    userFind,
    categoryFindFirst,
    requirementFindMany,
    requirementCount,
    requirementCreate,
    requirementUpdate,
    requirementUpdateMany,
    requirementDelete,
    auditCreate,
    notificationCreate,
    $transaction,
  };
}

function token(role: string, id: string, orgId: string | null = 'org-1'): string {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId: orgId });
}

function get(role: string, id: string, qs = '', orgId: string | null = 'org-1') {
  const app = createApp();
  return request(app).get(`/api/requirements${qs}`).set('Authorization', `Bearer ${token(role, id, orgId)}`);
}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');
function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.join(backendDir, ...parts), 'utf8');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('REQ-05 browse requirements', () => {
  describe('authentication / authorization', () => {
    it('rejects unauthenticated requests with 401 and zero queries', async () => {
      const { requirementFindMany } = mockBackend(callerRow(), [requirementRow()]);
      const app = createApp();
      const res = await request(app).get('/api/requirements');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(requirementFindMany).not.toHaveBeenCalled();
    });

    it('allows RECIPIENT (200)', async () => {
      mockBackend(callerRow(), [requirementRow()]);
      const res = await get('RECIPIENT', 'user-1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('allows ADMIN (200)', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [requirementRow()]);
      const res = await get('ADMIN', 'admin-1');
      expect(res.status).toBe(200);
    });

    it.each(['PROVIDER', 'VOLUNTEER'] as const)(
      'rejects %s with 403 and zero queries',
      async (role) => {
        const { requirementFindMany, requirementCount } = mockBackend(
          callerRow({ role }),
          [requirementRow()]
        );
        const res = await get(role, 'x-1');
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
        expect(requirementFindMany).not.toHaveBeenCalled();
        expect(requirementCount).not.toHaveBeenCalled();
      }
    );

    it('rejects an inactive/suspended caller with 401 and zero queries', async () => {
      const { requirementFindMany } = mockBackend(callerRow({ status: 'SUSPENDED' }), [
        requirementRow(),
      ]);
      const res = await get('RECIPIENT', 'user-1');
      expect(res.status).toBe(401);
      expect(requirementFindMany).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown caller with zero queries', async () => {
      const { requirementFindMany } = mockBackend(null, [requirementRow()]);
      const res = await get('RECIPIENT', 'ghost');
      expect(res.status).toBe(404);
      expect(requirementFindMany).not.toHaveBeenCalled();
    });

    it('service-level defense-in-depth rejects non-browse roles', async () => {
      mockBackend(callerRow({ role: 'PROVIDER' }), [requirementRow()]);
      await expect(listRequirements('user-1', {})).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('rejects an empty userId with 400', async () => {
      mockBackend(callerRow(), [requirementRow()]);
      await expect(listRequirements('', {})).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('recipient visibility', () => {
    const seed = [
      requirementRow({ id: 'own-open', organizationId: 'org-1', status: 'OPEN' }),
      requirementRow({ id: 'own-closed', organizationId: 'org-1', status: 'FULFILLED' }),
      requirementRow({ id: 'other-open', organizationId: 'org-2', status: 'OPEN' }),
      requirementRow({ id: 'other-closed', organizationId: 'org-2', status: 'FULFILLED' }),
    ];

    it('shows own requirements (any status) plus OPEN outside the organization', async () => {
      mockBackend(callerRow(), seed);
      const res = await get('RECIPIENT', 'user-1');
      expect(res.status).toBe(200);
      const ids = res.body.data.items.map((i: { id: string }) => i.id).sort();
      expect(ids).toEqual(['other-open', 'own-closed', 'own-open']);
      expect(ids).not.toContain('other-closed');
    });

    it('applies the own+OPEN visibility predicate to findMany AND count', async () => {
      const { requirementFindMany, requirementCount } = mockBackend(callerRow(), seed);
      await get('RECIPIENT', 'user-1');
      const findWhere = requirementFindMany.mock.calls[0][0].where;
      const countWhere = requirementCount.mock.calls[0][0].where;
      expect(findWhere).toEqual(countWhere);
      expect(findWhere.OR).toEqual([
        { organizationId: 'org-1' },
        { status: 'OPEN' },
      ]);
    });

    it('limits a recipient with no organization to OPEN requirements', async () => {
      const rows = [
        requirementRow({ id: 'own-open', organizationId: 'org-1', status: 'OPEN' }),
        requirementRow({ id: 'own-closed', organizationId: 'org-1', status: 'FULFILLED' }),
        requirementRow({ id: 'other-open', organizationId: 'org-2', status: 'OPEN' }),
      ];
      const { requirementFindMany } = mockBackend(callerRow({ org: null }), rows);
      const res = await get('RECIPIENT', 'user-1', '', null);
      expect(res.status).toBe(200);
      const ids = res.body.data.items.map((i: { id: string }) => i.id).sort();
      expect(ids).toEqual(['other-open', 'own-open']);
      expect(requirementFindMany.mock.calls[0][0].where.OR).toEqual([{ status: 'OPEN' }]);
    });

    it('does not let a status filter escape the visibility predicate', async () => {
      const { requirementFindMany } = mockBackend(callerRow(), seed);
      const res = await get('RECIPIENT', 'user-1', '?status=FULFILLED');
      expect(res.status).toBe(200);
      const ids = res.body.data.items.map((i: { id: string }) => i.id);
      expect(ids).toEqual(['own-closed']);
      expect(ids).not.toContain('other-closed');
      const where = requirementFindMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([{ organizationId: 'org-1' }, { status: 'OPEN' }]);
      expect(where.AND).toEqual([{ status: 'FULFILLED' }]);
    });

    it('ignores identity/organization/role query spoofing', async () => {
      const { requirementFindMany, userFind } = mockBackend(callerRow(), seed);
      const res = await get(
        'RECIPIENT',
        'user-1',
        '?userId=admin-1&role=ADMIN&organizationId=org-2'
      );
      expect(res.status).toBe(200);
      // Caller is loaded from the session id, not the spoofed query value.
      expect(userFind).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'user-1' } })
      );
      const ids = res.body.data.items.map((i: { id: string }) => i.id).sort();
      expect(ids).toEqual(['other-open', 'own-closed', 'own-open']);
      expect(requirementFindMany.mock.calls[0][0].where.OR).toEqual([
        { organizationId: 'org-1' },
        { status: 'OPEN' },
      ]);
    });
  });

  describe('admin visibility', () => {
    const seed = [
      requirementRow({ id: 'a', organizationId: 'org-1', status: 'OPEN' }),
      requirementRow({ id: 'b', organizationId: 'org-2', status: 'FULFILLED' }),
      requirementRow({ id: 'c', organizationId: 'org-3', status: 'CANCELLED' }),
    ];

    it('sees requirements across organizations', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), seed);
      const res = await get('ADMIN', 'admin-1');
      expect(res.status).toBe(200);
      const ids = res.body.data.items.map((i: { id: string }) => i.id).sort();
      expect(ids).toEqual(['a', 'b', 'c']);
    });

    it('applies no visibility OR predicate for ADMIN', async () => {
      const { requirementFindMany } = mockBackend(callerRow({ role: 'ADMIN' }), seed);
      await get('ADMIN', 'admin-1');
      expect(requirementFindMany.mock.calls[0][0].where.OR).toBeUndefined();
    });

    it('composes status/category/priority filters with admin visibility', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), seed);
      const res = await get('ADMIN', 'admin-1', '?status=CANCELLED&priority=HIGH');
      expect(res.status).toBe(200);
      const ids = res.body.data.items.map((i: { id: string }) => i.id);
      expect(ids).toEqual(['c']);
    });
  });

  describe('filters', () => {
    const seed = [
      requirementRow({
        id: 'meals-high-open',
        foodCategory: 'Prepared meals',
        priority: 'HIGH',
        status: 'OPEN',
      }),
      requirementRow({
        id: 'meals-low-open',
        foodCategory: 'Prepared meals',
        priority: 'LOW',
        status: 'OPEN',
      }),
      requirementRow({
        id: 'veg-critical-fulfilled',
        foodCategory: 'Vegetables',
        priority: 'CRITICAL',
        status: 'FULFILLED',
      }),
    ];

    it('filters by food_category using exact active-category validation', async () => {
      const { categoryFindFirst, requirementFindMany } = mockBackend(
        callerRow({ role: 'ADMIN' }),
        seed
      );
      const res = await get('ADMIN', 'admin-1', '?food_category=Prepared%20meals');
      expect(res.status).toBe(200);
      expect(categoryFindFirst).toHaveBeenCalledWith({
        where: { name: 'Prepared meals', isActive: true },
        select: { id: true },
      });
      expect(res.body.data.items.map((i: { id: string }) => i.id).sort()).toEqual([
        'meals-high-open',
        'meals-low-open',
      ]);
      expect(requirementFindMany.mock.calls[0][0].where.AND).toEqual([
        { foodCategory: 'Prepared meals' },
      ]);
    });

    it('rejects an unknown/inactive food_category with 400 and zero requirement queries', async () => {
      const { requirementFindMany } = mockBackend(callerRow({ role: 'ADMIN' }), seed, {
        categoryActive: false,
      });
      const res = await get('ADMIN', 'admin-1', '?food_category=Unknown');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(requirementFindMany).not.toHaveBeenCalled();
    });

    it('does not accept case-variant or partial food_category values', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), seed);
      const lower = await get('ADMIN', 'admin-1', '?food_category=prepared%20meals');
      expect(lower.status).toBe(400);
      const partial = await get('ADMIN', 'admin-1', '?food_category=Prepared');
      expect(partial.status).toBe(400);
    });

    it('filters by priority', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), seed);
      const res = await get('ADMIN', 'admin-1', '?priority=CRITICAL');
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual([
        'veg-critical-fulfilled',
      ]);
    });

    it('filters by status', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), seed);
      const res = await get('ADMIN', 'admin-1', '?status=FULFILLED');
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual([
        'veg-critical-fulfilled',
      ]);
    });

    it.each([
      ['priority', '?priority=URGENT'],
      ['status', '?status=ARCHIVED'],
    ])('rejects an invalid %s with 400 and zero queries', async (_field, qs) => {
      const { requirementFindMany } = mockBackend(callerRow({ role: 'ADMIN' }), seed);
      const res = await get('ADMIN', 'admin-1', qs);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(requirementFindMany).not.toHaveBeenCalled();
    });

    it.each([
      '?priority=HIGH&priority=LOW',
      '?status=OPEN&status=FULFILLED',
      '?food_category=Prepared%20meals&food_category=Vegetables',
      '?status=',
      '?priority=',
      '?food_category=',
    ])('rejects malformed/repeated/empty filter %s with 400', async (qs) => {
      mockBackend(callerRow({ role: 'ADMIN' }), seed);
      const res = await get('ADMIN', 'admin-1', qs);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a supplied radiusKm with 400 and zero queries (D-07 deferred)', async () => {
      const { requirementFindMany, categoryFindFirst } = mockBackend(
        callerRow({ role: 'ADMIN' }),
        seed
      );
      const res = await get('ADMIN', 'admin-1', '?radiusKm=5');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'radiusKm' })])
      );
      expect(requirementFindMany).not.toHaveBeenCalled();
      expect(categoryFindFirst).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric radiusKm too (never silently ignored)', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), seed);
      const res = await get('ADMIN', 'admin-1', '?radiusKm=abc');
      expect(res.status).toBe(400);
    });
  });

  describe('filter composition', () => {
    const seed = [
      requirementRow({
        id: 'match',
        foodCategory: 'Prepared meals',
        priority: 'HIGH',
        status: 'OPEN',
      }),
      requirementRow({
        id: 'wrong-priority',
        foodCategory: 'Prepared meals',
        priority: 'LOW',
        status: 'OPEN',
      }),
      requirementRow({
        id: 'wrong-category',
        foodCategory: 'Vegetables',
        priority: 'HIGH',
        status: 'OPEN',
      }),
      requirementRow({
        id: 'wrong-status',
        foodCategory: 'Prepared meals',
        priority: 'HIGH',
        status: 'FULFILLED',
      }),
    ];

    it('composes category + priority', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), seed);
      const res = await get(
        'ADMIN',
        'admin-1',
        '?food_category=Prepared%20meals&priority=HIGH'
      );
      expect(res.body.data.items.map((i: { id: string }) => i.id).sort()).toEqual([
        'match',
        'wrong-status',
      ]);
    });

    it('composes priority + status', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), seed);
      const res = await get('ADMIN', 'admin-1', '?priority=HIGH&status=OPEN');
      expect(res.body.data.items.map((i: { id: string }) => i.id).sort()).toEqual([
        'match',
        'wrong-category',
      ]);
    });

    it('composes category + status', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), seed);
      const res = await get(
        'ADMIN',
        'admin-1',
        '?food_category=Prepared%20meals&status=FULFILLED'
      );
      expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual(['wrong-status']);
    });

    it('composes all supported filters together', async () => {
      const { requirementFindMany } = mockBackend(callerRow({ role: 'ADMIN' }), seed);
      const res = await get(
        'ADMIN',
        'admin-1',
        '?food_category=Prepared%20meals&priority=HIGH&status=OPEN'
      );
      expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual(['match']);
      expect(requirementFindMany.mock.calls[0][0].where.AND).toEqual([
        { foodCategory: 'Prepared meals' },
        { priority: 'HIGH' },
        { status: 'OPEN' },
      ]);
    });
  });

  describe('pagination and ordering', () => {
    function pagedSeed(count: number): ReqRow[] {
      return Array.from({ length: count }, (_, i) =>
        requirementRow({
          id: `req-${String(i).padStart(2, '0')}`,
          createdAt: new Date(`2026-09-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`),
        })
      );
    }

    it('applies default page=1 limit=20', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), pagedSeed(25));
      const res = await get('ADMIN', 'admin-1');
      expect(res.status).toBe(200);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.limit).toBe(20);
      expect(res.body.data.items).toHaveLength(20);
      expect(res.body.data.total).toBe(25);
      expect(res.body.data.totalPages).toBe(2);
      expect(res.body.data.hasNext).toBe(true);
      expect(res.body.data.hasPrev).toBe(false);
    });

    it('supports explicit page/limit', async () => {
      const { requirementFindMany } = mockBackend(callerRow({ role: 'ADMIN' }), pagedSeed(25));
      const res = await get('ADMIN', 'admin-1', '?page=2&limit=10');
      expect(res.status).toBe(200);
      expect(res.body.data.page).toBe(2);
      expect(res.body.data.limit).toBe(10);
      expect(res.body.data.items).toHaveLength(10);
      expect(requirementFindMany.mock.calls[0][0].skip).toBe(10);
      expect(requirementFindMany.mock.calls[0][0].take).toBe(10);
    });

    it('caps limit at the project maximum (100)', async () => {
      const { requirementFindMany } = mockBackend(callerRow({ role: 'ADMIN' }), pagedSeed(5));
      const res = await get('ADMIN', 'admin-1', '?limit=500');
      expect(res.status).toBe(200);
      expect(res.body.data.limit).toBe(100);
      expect(requirementFindMany.mock.calls[0][0].take).toBe(100);
    });

    it('returns an empty page beyond the result set', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), pagedSeed(3));
      const res = await get('ADMIN', 'admin-1', '?page=9');
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.total).toBe(3);
    });

    it('orders deterministically by createdAt DESC then id DESC', async () => {
      const sameDay = new Date('2026-09-01T00:00:00.000Z');
      const rows = [
        requirementRow({ id: 'b', createdAt: sameDay }),
        requirementRow({ id: 'a', createdAt: sameDay }),
        requirementRow({ id: 'c', createdAt: new Date('2026-08-01T00:00:00.000Z') }),
      ];
      const { requirementFindMany } = mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get('ADMIN', 'admin-1');
      expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual(['b', 'a', 'c']);
      expect(requirementFindMany.mock.calls[0][0].orderBy).toEqual([
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
    });
  });

  describe('read-only + query correctness', () => {
    it('never mutates, audits, notifies or expires', async () => {
      const m = mockBackend(callerRow(), [
        requirementRow({ status: 'OPEN' }),
        requirementRow({ id: 'req-2', status: 'FULFILLED' }),
      ]);
      const res = await get('RECIPIENT', 'user-1');
      expect(res.status).toBe(200);
      expect(m.requirementCreate).not.toHaveBeenCalled();
      expect(m.requirementUpdate).not.toHaveBeenCalled();
      expect(m.requirementUpdateMany).not.toHaveBeenCalled();
      expect(m.requirementDelete).not.toHaveBeenCalled();
      expect(m.auditCreate).not.toHaveBeenCalled();
      expect(m.notificationCreate).not.toHaveBeenCalled();
      // Persisted statuses are untouched by the read.
      expect(m.rows.map((r) => r.status).sort()).toEqual(['FULFILLED', 'OPEN']);
    });

    it('issues exactly one findMany + one count in one transaction (no N+1)', async () => {
      const m = mockBackend(callerRow({ role: 'ADMIN' }), [
        requirementRow(),
        requirementRow({ id: 'req-2' }),
      ]);
      await get('ADMIN', 'admin-1');
      expect(m.requirementFindMany).toHaveBeenCalledTimes(1);
      expect(m.requirementCount).toHaveBeenCalledTimes(1);
      expect(m.$transaction).toHaveBeenCalledTimes(1);
    });

    it('returns an explicit safe projection without sensitive/extra fields', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [requirementRow()]);
      const res = await get('ADMIN', 'admin-1');
      const item = res.body.data.items[0];
      expect(Object.keys(item).sort()).toEqual(
        [
          'created_at',
          'food_category',
          'food_type',
          'id',
          'location',
          'organization_id',
          'priority',
          'quantity_fulfilled',
          'quantity_required',
          'required_by',
          'status',
          'updated_at',
        ].sort()
      );
      const blob = JSON.stringify(res.body);
      expect(blob).not.toMatch(/email|passwordHash|password|bcrypt/i);
      expect(item.matches).toBeUndefined();
    });

    it('masks DB failures with 500 REQUIREMENT_READ_FAILED and no SQL/DSN leak', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [requirementRow()], { dbError: true });
      const res = await get('ADMIN', 'admin-1');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('REQUIREMENT_READ_FAILED');
      expect(JSON.stringify(res.body)).not.toMatch(/postgres|SELECT|count|password|dsn/i);
    });
  });

  describe('D-06 / D-10 / D-07 boundaries', () => {
    it('keeps the browse path free of allocation/quantity-remaining mechanics', () => {
      const svc = readRepoFile('src', 'services', 'requirements.service.ts');
      for (const forbidden of [
        'Allocation',
        'DonationAllocation',
        'Fulfillment',
        'quantity_remaining',
        'quantityRemaining',
      ]) {
        expect(svc).not.toContain(forbidden);
      }
      const models = Prisma.dmmf.datamodel.models.map((m) => m.name);
      // REQ-08 / D-06 (Model A): Allocation is authoritative; no competing/remaining mechanics.
      expect(models).toContain('Allocation');
      expect(models).not.toContain('DonationAllocation');
      expect(models).not.toContain('Fulfillment');
    });

    it('introduces no expiry automation or scheduler in the browse path', () => {
      const svc = readRepoFile('src', 'services', 'requirements.service.ts');
      expect(svc).not.toMatch(/cron|setInterval|setTimeout|schedule|worker|poll/i);
      const routes = readRepoFile('src', 'routes', 'requirements.ts');
      for (const forbidden of ["'/status'", "'/expire'", "'/override'"]) {
        expect(routes).not.toContain(forbidden);
      }
    });

    it('introduces no spatial/raw-SQL implementation (radius stays a 400 rejection)', () => {
      const svc = readRepoFile('src', 'services', 'requirements.service.ts');
      // Comments may *name* the deferred architecture; actual code must not use it.
      expect(svc).not.toMatch(/\$queryRaw|\$executeRaw|ST_DWithin|haversine/i);
      expect(svc).not.toMatch(/\blatitude\b|\blongitude\b/);
      // The only radius handling is the explicit 400 rejection.
      expect(svc).toContain('radiusKm is not supported');
    });

    it('does not mutate the requirement status through the browse path', () => {
      const svc = readRepoFile('src', 'services', 'requirements.service.ts');
      // REQ-07 adds the authorized CANCELLED write behind the REQ-04 guard; the
      // browse/history read paths write no status.
      for (const status of ['PARTIALLY_FULFILLED', 'FULFILLED', 'EXPIRED']) {
        expect(svc).not.toContain(`status: '${status}'`);
      }
    });
  });
});
