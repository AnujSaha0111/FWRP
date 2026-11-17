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
import { createApp } from '../createApp';
import {
  createRequirement,
  getRequirementHistory,
  updateRequirement,
} from '../services/requirements.service';
import { signAccessToken } from '../utils/jwt';

interface HistRow {
  id: string;
  requirementId: string;
  organizationId: string;
  actorId: string | null;
  action: string;
  timestamp: Date;
  foodCategory: string;
  foodType: string;
  quantityRequired: number;
  quantityFulfilled: number;
  requiredBy: Date;
  priority: string;
  location: string;
  status: string;
  // Deliberately present to prove the projection strips sensitive fields.
  email?: string;
  passwordHash?: string;
}

function histRow(overrides: Partial<HistRow> = {}): HistRow {
  return {
    id: 'rh-1',
    requirementId: 'req-1',
    organizationId: 'org-1',
    actorId: 'user-1',
    action: 'CREATE',
    timestamp: new Date('2026-09-20T00:00:00.000Z'),
    foodCategory: 'Prepared meals',
    foodType: 'Vegetarian',
    quantityRequired: 100,
    quantityFulfilled: 0,
    requiredBy: new Date('2099-01-01T10:00:00.000Z'),
    priority: 'HIGH',
    location: 'XYZ Shelter, Springfield',
    status: 'OPEN',
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
    org?: { id: string; verificationStatus?: string } | null;
  } = {}
) {
  return {
    id: opts.id ?? 'user-1',
    role: opts.role ?? 'RECIPIENT',
    status: opts.status ?? 'ACTIVE',
    organization:
      opts.org === undefined ? { id: 'org-1', verificationStatus: 'VERIFIED' } : opts.org,
  };
}

function applyWhere(rows: HistRow[], where: Record<string, unknown>): HistRow[] {
  const org = where.organizationId;
  return rows.filter((r) => (org === undefined ? true : r.organizationId === org));
}

// --- read endpoint mock -----------------------------------------------------
function mockRead(caller: ReturnType<typeof callerRow> | null, seed: HistRow[]) {
  const rows = seed.map((r) => ({ ...r }));
  const userFind = vi.fn(async () => caller);
  const historyFindMany = vi.fn(async (args: { where: Record<string, unknown>; skip?: number; take?: number }) => {
    const filtered = applyWhere(rows, args.where)
      .slice()
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime() || b.id.localeCompare(a.id));
    const skip = args.skip ?? 0;
    const take = args.take ?? filtered.length;
    return filtered.slice(skip, skip + take);
  });
  const historyCount = vi.fn(async (args: { where: Record<string, unknown> }) => applyWhere(rows, args.where).length);
  const requirementCreate = vi.fn();
  const requirementUpdate = vi.fn();
  const requirementUpdateMany = vi.fn();
  const requirementDelete = vi.fn();
  const historyCreate = vi.fn();
  const auditCreate = vi.fn();
  const notificationCreate = vi.fn();
  const matchFindMany = vi.fn(() => {
    throw new Error('Match must not be queried by REQ-06');
  });
  const $transaction = vi.fn(async (arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (c: unknown) => Promise<unknown>)({})
  );
  const client = {
    user: { findUnique: userFind },
    requirement: {
      create: requirementCreate,
      update: requirementUpdate,
      updateMany: requirementUpdateMany,
      delete: requirementDelete,
    },
    requirementHistory: { findMany: historyFindMany, count: historyCount, create: historyCreate },
    auditLog: { create: auditCreate },
    notification: { create: notificationCreate },
    match: { findMany: matchFindMany },
    $transaction,
  };
  vi.mocked(getPrisma).mockReturnValue(client as unknown as PrismaClient);
  return {
    rows,
    userFind,
    historyFindMany,
    historyCount,
    requirementCreate,
    requirementUpdate,
    requirementUpdateMany,
    requirementDelete,
    historyCreate,
    auditCreate,
    notificationCreate,
    matchFindMany,
    $transaction,
  };
}

// --- create atomicity mock --------------------------------------------------
function mockCreate(
  caller: ReturnType<typeof callerRow> | null,
  opts: { historyFailure?: boolean } = {}
) {
  const requirements: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
  const requirementCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    const row = {
      id: 'req-1',
      quantityFulfilled: 0,
      status: 'OPEN',
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
      ...args.data,
    };
    requirements.push(row);
    return row;
  });
  const historyCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    if (opts.historyFailure) throw new Error('history insert failed postgresql://u:p@h/db');
    history.push(args.data);
    return { id: 'rh-1', ...args.data };
  });
  const client: Record<string, unknown> = {
    user: { findUnique: vi.fn(async () => caller) },
    category: { findFirst: vi.fn(async () => ({ id: 'cat-1' })) },
    requirement: { create: requirementCreate },
    requirementHistory: { create: historyCreate },
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg !== 'function') throw new Error('expected callback transaction');
      const reqSnap = requirements.slice();
      const histSnap = history.slice();
      try {
        return await (arg as (c: unknown) => Promise<unknown>)(client);
      } catch (err) {
        requirements.splice(0, requirements.length, ...reqSnap);
        history.splice(0, history.length, ...histSnap);
        throw err;
      }
    }),
  };
  vi.mocked(getPrisma).mockReturnValue(client as unknown as PrismaClient);
  return { requirements, history, requirementCreate, historyCreate };
}

// --- update atomicity mock --------------------------------------------------
function mockUpdate(
  caller: ReturnType<typeof callerRow> | null,
  seedReq: Record<string, unknown>,
  opts: { historyFailure?: boolean } = {}
) {
  const store = [{ ...seedReq }];
  const history: Record<string, unknown>[] = [];
  const audit: Record<string, unknown>[] = [];
  const userFind = vi.fn(async () => caller);
  const requirementFindUnique = vi.fn(async (args: { where: { id: string } }) => {
    const r = store.find((x) => x.id === args.where.id);
    return r ? { ...r } : null;
  });
  const requirementUpdateMany = vi.fn(
    async (args: {
      where: { id: string; organizationId?: string; status?: { in: string[] } };
      data: Record<string, unknown>;
    }) => {
      let count = 0;
      for (const r of store) {
        if (r.id !== args.where.id) continue;
        if (args.where.organizationId !== undefined && r.organizationId !== args.where.organizationId) continue;
        if (args.where.status?.in && !args.where.status.in.includes(r.status as string)) continue;
        Object.assign(r, args.data, { updatedAt: new Date(Date.now() + 1000) });
        count += 1;
      }
      return { count };
    }
  );
  const historyCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    if (opts.historyFailure) throw new Error('history insert failed');
    history.push(args.data);
    return { id: `rh-${history.length}`, ...args.data };
  });
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    audit.push(args.data);
    return { id: `audit-${audit.length}`, ...args.data };
  });
  const tx = {
    requirement: { findUnique: requirementFindUnique, updateMany: requirementUpdateMany },
    requirementHistory: { create: historyCreate },
    category: { findFirst: vi.fn(async () => ({ id: 'cat-1' })) },
    auditLog: { create: auditCreate },
  };
  const client: Record<string, unknown> = {
    user: { findUnique: userFind },
    $transaction: vi.fn(async (arg: unknown) => {
      const reqSnap = store.map((r) => ({ ...r }));
      const histSnap = history.slice();
      const auditSnap = audit.slice();
      try {
        return await (arg as (c: unknown) => Promise<unknown>)(tx);
      } catch (err) {
        store.splice(0, store.length, ...reqSnap);
        history.splice(0, history.length, ...histSnap);
        audit.splice(0, audit.length, ...auditSnap);
        throw err;
      }
    }),
  };
  vi.mocked(getPrisma).mockReturnValue(client as unknown as PrismaClient);
  return { store, history, audit, requirementUpdateMany, historyCreate, auditCreate };
}

function requirementSeed(overrides: Record<string, unknown> = {}) {
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
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
    updatedAt: new Date('2026-09-20T00:00:00.000Z'),
    ...overrides,
  };
}

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

function token(role = 'RECIPIENT', id = 'user-1'): string {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId: 'org-1' });
}

function getHistory(role = 'RECIPIENT', id = 'user-1', qs = '') {
  const app = createApp();
  return request(app).get(`/api/requirements/history${qs}`).set('Authorization', `Bearer ${token(role, id)}`);
}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');
function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.join(backendDir, ...parts), 'utf8');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('REQ-06 requirement history endpoint', () => {
  describe('authentication / authorization', () => {
    it('rejects unauthenticated requests with 401 and zero queries', async () => {
      const { historyFindMany } = mockRead(callerRow(), [histRow()]);
      const app = createApp();
      const res = await request(app).get('/api/requirements/history');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(historyFindMany).not.toHaveBeenCalled();
    });

    it('allows RECIPIENT (200)', async () => {
      mockRead(callerRow(), [histRow()]);
      const res = await getHistory('RECIPIENT', 'user-1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('allows ADMIN (200)', async () => {
      mockRead(callerRow({ role: 'ADMIN' }), [histRow()]);
      const res = await getHistory('ADMIN', 'admin-1');
      expect(res.status).toBe(200);
    });

    it.each(['PROVIDER', 'VOLUNTEER'] as const)(
      'rejects %s with 403 and zero queries',
      async (role) => {
        const { historyFindMany, historyCount } = mockRead(callerRow({ role }), [histRow()]);
        const res = await getHistory(role, 'x-1');
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
        expect(historyFindMany).not.toHaveBeenCalled();
        expect(historyCount).not.toHaveBeenCalled();
      }
    );

    it('rejects an inactive/suspended caller with 401 and zero queries', async () => {
      const { historyFindMany } = mockRead(callerRow({ status: 'SUSPENDED' }), [histRow()]);
      const res = await getHistory('RECIPIENT', 'user-1');
      expect(res.status).toBe(401);
      expect(historyFindMany).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown caller with zero queries', async () => {
      const { historyFindMany } = mockRead(null, [histRow()]);
      const res = await getHistory('RECIPIENT', 'ghost');
      expect(res.status).toBe(404);
      expect(historyFindMany).not.toHaveBeenCalled();
    });

    it('service-level defense-in-depth rejects non-history roles', async () => {
      mockRead(callerRow({ role: 'VOLUNTEER' }), [histRow()]);
      await expect(getRequirementHistory('user-1', {})).rejects.toMatchObject({ statusCode: 403 });
    });

    it('rejects an empty userId with 400', async () => {
      mockRead(callerRow(), [histRow()]);
      await expect(getRequirementHistory('', {})).rejects.toMatchObject({ statusCode: 400 });
    });

    it('returns an empty page for a recipient with no organization', async () => {
      const { historyFindMany, historyCount } = mockRead(callerRow({ org: null }), [histRow()]);
      const res = await getHistory('RECIPIENT', 'user-1');
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.total).toBe(0);
      expect(historyFindMany).not.toHaveBeenCalled();
      expect(historyCount).not.toHaveBeenCalled();
    });
  });

  describe('visibility / scope', () => {
    const seed = [
      histRow({ id: 'own-1', organizationId: 'org-1' }),
      histRow({ id: 'own-2', organizationId: 'org-1' }),
      histRow({ id: 'other-1', organizationId: 'org-2' }),
    ];

    it('recipient sees only their persisted organization history', async () => {
      mockRead(callerRow(), seed);
      const res = await getHistory('RECIPIENT', 'user-1');
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((i: { id: string }) => i.id).sort()).toEqual(['own-1', 'own-2']);
      expect(res.body.data.total).toBe(2);
    });

    it('applies the organization predicate to findMany AND count', async () => {
      const { historyFindMany, historyCount } = mockRead(callerRow(), seed);
      await getHistory('RECIPIENT', 'user-1');
      const findWhere = historyFindMany.mock.calls[0][0].where;
      const countWhere = historyCount.mock.calls[0][0].where;
      expect(findWhere).toEqual({ organizationId: 'org-1' });
      expect(countWhere).toEqual({ organizationId: 'org-1' });
    });

    it('admin sees history across organizations with no org predicate', async () => {
      const { historyFindMany } = mockRead(callerRow({ role: 'ADMIN' }), seed);
      const res = await getHistory('ADMIN', 'admin-1');
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((i: { id: string }) => i.id).sort()).toEqual([
        'other-1',
        'own-1',
        'own-2',
      ]);
      expect(historyFindMany.mock.calls[0][0].where).toEqual({});
    });

    it('ignores identity/organization/role query spoofing', async () => {
      const { historyFindMany, userFind } = mockRead(callerRow(), seed);
      const res = await getHistory(
        'RECIPIENT',
        'user-1',
        '?organizationId=org-2&userId=admin-1&recipient_id=org-2&role=ADMIN'
      );
      expect(res.status).toBe(200);
      expect(userFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'user-1' } }));
      expect(historyFindMany.mock.calls[0][0].where).toEqual({ organizationId: 'org-1' });
      expect(res.body.data.items.map((i: { id: string }) => i.id).sort()).toEqual(['own-1', 'own-2']);
    });
  });

  describe('ordering / pagination', () => {
    it('orders deterministically by timestamp DESC then id DESC', async () => {
      const same = new Date('2026-09-20T00:00:00.000Z');
      const rows = [
        histRow({ id: 'b', timestamp: same }),
        histRow({ id: 'a', timestamp: same }),
        histRow({ id: 'c', timestamp: new Date('2026-09-19T00:00:00.000Z') }),
      ];
      const { historyFindMany } = mockRead(callerRow(), rows);
      const res = await getHistory('RECIPIENT', 'user-1');
      expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual(['b', 'a', 'c']);
      expect(historyFindMany.mock.calls[0][0].orderBy).toEqual([
        { timestamp: 'desc' },
        { id: 'desc' },
      ]);
    });

    function pagedSeed(count: number): HistRow[] {
      return Array.from({ length: count }, (_, i) =>
        histRow({
          id: `rh-${String(i).padStart(2, '0')}`,
          timestamp: new Date(`2026-09-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`),
        })
      );
    }

    it('applies default page=1 limit=20', async () => {
      mockRead(callerRow(), pagedSeed(25));
      const res = await getHistory('RECIPIENT', 'user-1');
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.limit).toBe(20);
      expect(res.body.data.items).toHaveLength(20);
      expect(res.body.data.total).toBe(25);
      expect(res.body.data.hasNext).toBe(true);
    });

    it('supports explicit page/limit', async () => {
      const { historyFindMany } = mockRead(callerRow(), pagedSeed(25));
      const res = await getHistory('RECIPIENT', 'user-1', '?page=2&limit=10');
      expect(res.body.data.page).toBe(2);
      expect(res.body.data.items).toHaveLength(10);
      expect(historyFindMany.mock.calls[0][0].skip).toBe(10);
      expect(historyFindMany.mock.calls[0][0].take).toBe(10);
    });

    it('caps limit at the project maximum (100) and normalizes malformed input', async () => {
      const { historyFindMany } = mockRead(callerRow(), pagedSeed(5));
      const capped = await getHistory('RECIPIENT', 'user-1', '?limit=500');
      expect(capped.body.data.limit).toBe(100);
      expect(historyFindMany.mock.calls[0][0].take).toBe(100);
      const malformed = await getHistory('RECIPIENT', 'user-1', '?page=abc&limit=-3');
      expect(malformed.status).toBe(200);
      expect(malformed.body.data.page).toBe(1);
      expect(malformed.body.data.limit).toBe(20);
    });

    it('returns an empty page beyond the result set', async () => {
      mockRead(callerRow(), pagedSeed(3));
      const res = await getHistory('RECIPIENT', 'user-1', '?page=9');
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.total).toBe(3);
    });

    it('issues exactly one findMany + one count in one transaction (no N+1)', async () => {
      const m = mockRead(callerRow(), [histRow(), histRow({ id: 'rh-2' })]);
      await getHistory('RECIPIENT', 'user-1');
      expect(m.historyFindMany).toHaveBeenCalledTimes(1);
      expect(m.historyCount).toHaveBeenCalledTimes(1);
      expect(m.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('fulfillment progress + response safety', () => {
    it('exposes quantity_required and quantity_fulfilled (0 / partial / full) unmodified', async () => {
      const rows = [
        histRow({ id: 'zero', quantityRequired: 100, quantityFulfilled: 0 }),
        histRow({ id: 'partial', quantityRequired: 100, quantityFulfilled: 40 }),
        histRow({ id: 'full', quantityRequired: 100, quantityFulfilled: 100 }),
      ];
      mockRead(callerRow(), rows);
      const res = await getHistory('RECIPIENT', 'user-1');
      const byId = new Map(
        (res.body.data.items as Array<{ id: string; quantity_required: number; quantity_fulfilled: number }>).map(
          (i) => [i.id, i]
        )
      );
      expect(byId.get('zero')!.quantity_fulfilled).toBe(0);
      expect(byId.get('partial')!.quantity_fulfilled).toBe(40);
      expect(byId.get('full')!.quantity_fulfilled).toBe(100);
      for (const item of byId.values()) {
        expect(item.quantity_required).toBe(100);
      }
    });

    it('does not expose derived/remaining/allocation or matched-donation fields', async () => {
      mockRead(callerRow(), [histRow()]);
      const res = await getHistory('RECIPIENT', 'user-1');
      const blob = JSON.stringify(res.body);
      expect(blob).not.toMatch(/quantity_remaining|quantityRemaining|percentage|ratio|allocat|matches|matched_donation/i);
    });

    it('returns an explicit safe projection without sensitive fields', async () => {
      mockRead(callerRow(), [histRow()]);
      const res = await getHistory('RECIPIENT', 'user-1');
      const item = res.body.data.items[0];
      expect(Object.keys(item).sort()).toEqual(
        [
          'action',
          'actor_id',
          'food_category',
          'food_type',
          'id',
          'location',
          'organization_id',
          'priority',
          'quantity_fulfilled',
          'quantity_required',
          'required_by',
          'requirement_id',
          'status',
          'timestamp',
        ].sort()
      );
      const blob = JSON.stringify(res.body);
      expect(blob).not.toMatch(/email|passwordHash|password|bcrypt/i);
    });

    it('masks DB failures with 500 REQUIREMENT_READ_FAILED and no SQL/DSN leak', async () => {
      const m = mockRead(callerRow(), [histRow()]);
      m.historyFindMany.mockImplementationOnce(async () => {
        throw new Error('postgresql://u:p@h/db SELECT failed');
      });
      const res = await getHistory('RECIPIENT', 'user-1');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('REQUIREMENT_READ_FAILED');
      expect(JSON.stringify(res.body)).not.toMatch(/postgres|SELECT|password|dsn/i);
    });
  });

  describe('read-only + matching boundary', () => {
    it('performs no writes and never queries Match', async () => {
      const m = mockRead(callerRow(), [histRow(), histRow({ id: 'rh-2' })]);
      const res = await getHistory('RECIPIENT', 'user-1');
      expect(res.status).toBe(200);
      expect(m.requirementCreate).not.toHaveBeenCalled();
      expect(m.requirementUpdate).not.toHaveBeenCalled();
      expect(m.requirementUpdateMany).not.toHaveBeenCalled();
      expect(m.requirementDelete).not.toHaveBeenCalled();
      expect(m.historyCreate).not.toHaveBeenCalled();
      expect(m.auditCreate).not.toHaveBeenCalled();
      expect(m.notificationCreate).not.toHaveBeenCalled();
      expect(m.matchFindMany).not.toHaveBeenCalled();
      // Persisted rows are untouched (no status/quantity mutation).
      expect(m.rows.map((r) => r.status)).toEqual(['OPEN', 'OPEN']);
    });

    it('keeps RequirementHistory free of allocation/quantity-remaining fields', () => {
      const models = Prisma.dmmf.datamodel.models.map((x) => x.name);
      expect(models).toContain('RequirementHistory');
      // REQ-08 / D-06 (Model A): Allocation is authoritative; no competing/remaining mechanics.
      expect(models).toContain('Allocation');
      expect(models).not.toContain('DonationAllocation');
      expect(models).not.toContain('Fulfillment');
      for (const model of Prisma.dmmf.datamodel.models) {
        for (const field of model.fields) {
          expect(field.name, `${model.name}.${field.name}`).not.toMatch(
            /quantityRemaining|quantity_remaining|percentage|ratio/i
          );
        }
      }
      const schema = readRepoFile('prisma', 'schema.prisma');
      expect(schema).not.toMatch(/quantity_remaining|quantityRemaining/);
      // RequirementHistory carries no allocation relation/fields.
      const rh = Prisma.dmmf.datamodel.models.find((m) => m.name === 'RequirementHistory')!;
      for (const field of rh.fields) {
        expect(field.name).not.toMatch(/allocation|committed/i);
      }
    });

    it('history action enum supports only the authorized lifecycle events', () => {
      const actionEnum = Prisma.dmmf.datamodel.enums.find((e) => e.name === 'RequirementHistoryAction');
      expect(actionEnum).toBeDefined();
      // REQ-06 CREATE/UPDATE + REQ-07 CANCEL; no fabricated lifecycle events.
      expect(actionEnum!.values.map((v) => v.name)).toEqual(['CREATE', 'UPDATE', 'CANCEL']);
    });

    it('history service performs no Match lookup', () => {
      const svc = readRepoFile('src', 'services', 'requirements.service.ts');
      expect(svc).not.toMatch(/client\.match|tx\.match|\.match\.findMany|\.match\.create/);
    });
  });
});

describe('REQ-06 CREATE/UPDATE history atomicity', () => {
  it('persists a CREATE history record atomically with requirement creation', async () => {
    const { requirements, history, historyCreate } = mockCreate(callerRow());
    const result = await createRequirement('user-1', validBody());
    expect(result.requirement.id).toBe('req-1');
    expect(requirements).toHaveLength(1);
    expect(history).toHaveLength(1);
    expect(historyCreate).toHaveBeenCalledTimes(1);
    expect(history[0]).toMatchObject({
      requirementId: 'req-1',
      organizationId: 'org-1',
      actorId: 'user-1',
      action: 'CREATE',
      foodCategory: 'Prepared meals',
      foodType: 'Vegetarian',
      quantityRequired: 100,
      quantityFulfilled: 0,
      priority: 'HIGH',
      location: 'XYZ Shelter, Springfield',
      status: 'OPEN',
    });
  });

  it('rolls back requirement creation when history persistence fails (masked 500)', async () => {
    const { requirements, history } = mockCreate(callerRow(), { historyFailure: true });
    await expect(createRequirement('user-1', validBody())).rejects.toMatchObject({
      statusCode: 500,
      code: 'REQUIREMENT_CREATE_FAILED',
    });
    expect(requirements).toHaveLength(0);
    expect(history).toHaveLength(0);
  });

  it('persists an UPDATE history record for the post-update state atomically', async () => {
    const { store, history, audit, historyCreate } = mockUpdate(callerRow(), requirementSeed());
    const result = await updateRequirement('req-1', 'user-1', { location: 'New Shelter Address' });
    expect(result.requirement.location).toBe('New Shelter Address');
    expect(store[0].location).toBe('New Shelter Address');
    expect(history).toHaveLength(1);
    expect(historyCreate).toHaveBeenCalledTimes(1);
    expect(history[0]).toMatchObject({
      requirementId: 'req-1',
      organizationId: 'org-1',
      actorId: 'user-1',
      action: 'UPDATE',
      location: 'New Shelter Address',
      status: 'OPEN',
      quantityRequired: 100,
      quantityFulfilled: 0,
    });
    // Existing REQUIREMENT_UPDATED audit remains intact alongside history.
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('REQUIREMENT_UPDATED');
  });

  it('rolls back the requirement update AND the existing audit when history fails', async () => {
    const { store, history, audit } = mockUpdate(callerRow(), requirementSeed(), {
      historyFailure: true,
    });
    await expect(
      updateRequirement('req-1', 'user-1', { location: 'Should Not Persist' })
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(store[0].location).toBe('XYZ Shelter, Springfield');
    expect(history).toHaveLength(0);
    // The REQUIREMENT_UPDATED audit committed before history must also roll back.
    expect(audit).toHaveLength(0);
  });

  it('produces one immutable history record per update (multiple updates)', async () => {
    const { history } = mockUpdate(callerRow(), requirementSeed());
    await updateRequirement('req-1', 'user-1', { location: 'First' });
    await updateRequirement('req-1', 'user-1', { location: 'Second' });
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.action)).toEqual(['UPDATE', 'UPDATE']);
    expect(history[0].location).toBe('First');
    expect(history[1].location).toBe('Second');
  });

  it('does not fabricate history for pre-existing requirements (no rows on read)', async () => {
    // A requirement exists in the DB but has no persisted history rows: the
    // endpoint returns nothing and creates nothing.
    const m = mockRead(callerRow(), []);
    const res = await getHistory('RECIPIENT', 'user-1');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.total).toBe(0);
    expect(m.historyCreate).not.toHaveBeenCalled();
  });
});
