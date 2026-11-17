import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../createApp';
import { listDonations } from '../services/donations.service';
import { signAccessToken } from '../utils/jwt';

// DON-07: five in-scope filters (availability-time, quantity-range, category,
// food-type, status) on GET /api/donations. Location/radius is DEFERRED and
// must be rejected with 400 (never silently ignored). Filters are ANDed with
// DON-06 role visibility + universal current availability, applied as DB
// predicates before pagination, with the same WHERE for findMany and count.

interface ListRow {
  id: string;
  providerId: string;
  foodName: string;
  category: string;
  foodType: string;
  quantity: number;
  unit: string;
  availableFrom: Date;
  availableUntil: Date;
  pickupLocation: string;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  storageRequirement: string | null;
  description: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  email?: string;
  passwordHash?: string;
}

function h(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function donationRow(overrides: Partial<ListRow> = {}): ListRow {
  return {
    id: 'don-1',
    providerId: 'prov-1',
    foodName: 'Vegetable soup',
    category: 'Prepared meals',
    foodType: 'Vegetarian',
    quantity: 25,
    unit: 'meals',
    availableFrom: h(-1),
    availableUntil: h(2),
    pickupLocation: '12 Main St, Springfield',
    pickupLatitude: null,
    pickupLongitude: null,
    storageRequirement: null,
    description: null,
    status: 'AVAILABLE',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    email: 'pablo@example.com',
    passwordHash: 'bcrypt-hash-placeholder',
    ...overrides,
  };
}

function callerRow(opts: { id?: string; role?: string; status?: string } = {}) {
  return { id: opts.id ?? 'user-1', role: opts.role ?? 'PROVIDER', status: opts.status ?? 'ACTIVE' };
}

type Cond = Record<string, unknown>;

function matchDate(value: Date, cond: unknown): boolean {
  if (!cond || typeof cond !== 'object') return true;
  const c = cond as { lte?: Date; lt?: Date; gt?: Date; gte?: Date };
  const t = value.getTime();
  if (c.lte && !(t <= c.lte.getTime())) return false;
  if (c.lt && !(t < c.lt.getTime())) return false;
  if (c.gt && !(t > c.gt.getTime())) return false;
  if (c.gte && !(t >= c.gte.getTime())) return false;
  return true;
}

function rowMatches(r: ListRow, where: Cond): boolean {
  if (where.providerId !== undefined && r.providerId !== where.providerId) return false;
  if (where.status !== undefined && r.status !== where.status) return false;
  if (!matchDate(r.availableFrom, where.availableFrom)) return false;
  if (!matchDate(r.availableUntil, where.availableUntil)) return false;
  const q = where.quantity as { gte?: number; lte?: number } | undefined;
  if (q) {
    if (q.gte !== undefined && !(r.quantity >= q.gte)) return false;
    if (q.lte !== undefined && !(r.quantity <= q.lte)) return false;
  }
  if (where.category !== undefined && r.category !== where.category) return false;
  if (where.foodType !== undefined && r.foodType !== where.foodType) return false;
  if (Array.isArray(where.AND)) {
    for (const sub of where.AND as Cond[]) if (!rowMatches(r, sub)) return false;
  }
  return true;
}

function mockBackend(
  caller: ReturnType<typeof callerRow> | null,
  rows: ListRow[],
  opts: { categoryActive?: boolean } = {}
) {
  const userFind = vi.fn(async () => caller);
  const categoryFind = vi.fn(async () => (opts.categoryActive === false ? null : { id: 'cat-1' }));
  const donationFindMany = vi.fn(async (args: { where: Cond; skip?: number; take?: number }) => {
    const filtered = rows
      .filter((r) => rowMatches(r, args.where))
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const skip = args.skip ?? 0;
    const take = args.take ?? filtered.length;
    return filtered.slice(skip, skip + take);
  });
  const donationCount = vi.fn(async (args: { where: Cond }) => rows.filter((r) => rowMatches(r, args.where)).length);
  const donationUpdate = vi.fn();
  const donationUpdateMany = vi.fn();
  const auditCreate = vi.fn();
  const notificationCreate = vi.fn();
  const $transaction = vi.fn(async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : undefined));
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: userFind },
    category: { findFirst: categoryFind },
    donation: {
      findMany: donationFindMany,
      count: donationCount,
      findUnique: vi.fn(),
      update: donationUpdate,
      updateMany: donationUpdateMany,
    },
    auditLog: { create: auditCreate },
    notification: { create: notificationCreate },
    $transaction,
  } as unknown as PrismaClient);
  return {
    userFind,
    categoryFind,
    donationFindMany,
    donationCount,
    donationUpdate,
    donationUpdateMany,
    auditCreate,
    notificationCreate,
    $transaction,
  };
}

function token(role: string, id: string): string {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId: 'org-1' });
}

function get(qs: string, role = 'ADMIN', id = 'admin-1') {
  const app = createApp();
  return request(app).get(`/api/donations${qs}`).set('Authorization', `Bearer ${token(role, id)}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DON-07 donation filtering', () => {
  describe('radius is deferred / rejected', () => {
    it.each(['radiusKm=5', 'radiusKm=0', 'radiusKm=abc', 'radiusKm=-3', 'radiusKm=Infinity'])(
      'rejects unsupported %s with 400 VALIDATION_ERROR and zero queries',
      async (qs) => {
        const { donationFindMany } = mockBackend(callerRow({ role: 'ADMIN' }), [donationRow()]);
        const res = await get(`?${qs}`);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(donationFindMany).not.toHaveBeenCalled();
      }
    );

    it('service rejects radiusKm directly too', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [donationRow()]);
      await expect(listDonations('user-1', { radiusKm: '5' })).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('availability-time filter', () => {
    it('includes a donation whose window overlaps the requested interval', async () => {
      const rows = [donationRow({ id: 'open', availableFrom: h(-1), availableUntil: h(3) })];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const from = h(0).toISOString();
      const until = h(1).toISOString();
      const res = await get(`?availableFrom=${from}&availableUntil=${until}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['open']);
    });

    it('excludes a donation that does not overlap the requested interval', async () => {
      const rows = [donationRow({ id: 'later', availableFrom: h(5), availableUntil: h(8) })];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get(`?availableFrom=${h(0).toISOString()}&availableUntil=${h(2).toISOString()}`);
      expect(res.body.data.items).toEqual([]);
    });

    it('includes when the donation fully contains the requested interval', async () => {
      const rows = [donationRow({ id: 'contains', availableFrom: h(-2), availableUntil: h(6) })];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get(`?availableFrom=${h(0).toISOString()}&availableUntil=${h(1).toISOString()}`);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['contains']);
    });

    it('includes when the requested interval fully contains the donation', async () => {
      const rows = [donationRow({ id: 'contained', availableFrom: h(-1), availableUntil: h(2) })];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get(`?availableFrom=${h(-3).toISOString()}&availableUntil=${h(4).toISOString()}`);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['contained']);
    });

    it('excludes on exact half-open boundaries (donation.availableFrom === until; availableUntil === from)', async () => {
      const until = h(2);
      const from = h(1);
      const rows = [
        donationRow({ id: 'startEqUntil', availableFrom: until, availableUntil: h(4) }),
        donationRow({ id: 'endEqFrom', availableFrom: h(-1), availableUntil: from }),
      ];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get(`?availableFrom=${from.toISOString()}&availableUntil=${until.toISOString()}`);
      expect(res.body.data.items).toEqual([]);
    });

    it('rejects only one side supplied', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [donationRow()]);
      expect((await get(`?availableFrom=${h(0).toISOString()}`)).status).toBe(400);
      expect((await get(`?availableUntil=${h(1).toISOString()}`)).status).toBe(400);
    });

    it('rejects malformed dates', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [donationRow()]);
      const res = await get('?availableFrom=nope&availableUntil=also-nope');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects reversed and equal ranges', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [donationRow()]);
      const reversed = await get(`?availableFrom=${h(3).toISOString()}&availableUntil=${h(1).toISOString()}`);
      expect(reversed.status).toBe(400);
      const same = h(2).toISOString();
      const equal = await get(`?availableFrom=${same}&availableUntil=${same}`);
      expect(equal.status).toBe(400);
    });

    it('still applies DON-06 current availability (expired rows excluded even if the requested interval is in the past)', async () => {
      const rows = [
        donationRow({ id: 'expired', availableFrom: h(-10), availableUntil: h(-5) }),
      ];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get(`?availableFrom=${h(-8).toISOString()}&availableUntil=${h(-6).toISOString()}`);
      expect(res.body.data.items).toEqual([]);
    });
  });

  describe('quantity-range filter', () => {
    it('applies min only (inclusive)', async () => {
      const rows = [donationRow({ id: 'lo', quantity: 10 }), donationRow({ id: 'hi', quantity: 30 })];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get('?minQuantity=10');
      expect(res.body.data.items.map((d: { id: string }) => d.id).sort()).toEqual(['hi', 'lo']);
    });

    it('applies max only (inclusive)', async () => {
      const rows = [donationRow({ id: 'lo', quantity: 10 }), donationRow({ id: 'hi', quantity: 30 })];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get('?maxQuantity=10');
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['lo']);
    });

    it('applies min + max and exact inclusive boundaries', async () => {
      const rows = [
        donationRow({ id: 'a', quantity: 5 }),
        donationRow({ id: 'b', quantity: 10.5 }),
        donationRow({ id: 'c', quantity: 20 }),
      ];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get('?minQuantity=5&maxQuantity=20');
      expect(res.body.data.items.map((d: { id: string }) => d.id).sort()).toEqual(['a', 'b', 'c']);
      const exact = await get('?minQuantity=5&maxQuantity=5');
      expect(exact.body.data.items.map((d: { id: string }) => d.id)).toEqual(['a']);
    });

    it('allows decimal quantities', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [donationRow({ id: 'x', quantity: 2.5 })]);
      const res = await get('?minQuantity=2.5&maxQuantity=2.5');
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['x']);
    });

    it('rejects non-numeric / non-finite / empty / repeated quantity values', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [donationRow()]);
      for (const qs of ['minQuantity=abc', 'minQuantity=Infinity', 'minQuantity=', 'minQuantity=1&minQuantity=2']) {
        const res = await get(`?${qs}`);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('rejects minQuantity > maxQuantity', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [donationRow()]);
      const res = await get('?minQuantity=10&maxQuantity=5');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('category filter', () => {
    it('matches an active category exactly', async () => {
      const rows = [
        donationRow({ id: 'prep', category: 'Prepared meals' }),
        donationRow({ id: 'bakery', category: 'Bakery products' }),
      ];
      const { categoryFind } = mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get('?category=Prepared%20meals');
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['prep']);
      expect(categoryFind).toHaveBeenCalledWith({
        where: { name: 'Prepared meals', isActive: true },
        select: { id: true },
      });
    });

    it('returns empty for a different active category with no matches', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [donationRow({ category: 'Prepared meals' })]);
      const res = await get('?category=Fruits');
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
    });

    it('rejects an inactive/unknown category with 400 and no listing query', async () => {
      const { donationFindMany } = mockBackend(callerRow({ role: 'ADMIN' }), [donationRow()], {
        categoryActive: false,
      });
      const res = await get('?category=Nonexistent');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(donationFindMany).not.toHaveBeenCalled();
    });

    it('does not silently match case variants or partials (rejected as inactive)', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [donationRow()], { categoryActive: false });
      expect((await get('?category=prepared%20meals')).status).toBe(400);
      expect((await get('?category=Prepared')).status).toBe(400);
    });
  });

  describe('food-type filter', () => {
    it('matches exactly', async () => {
      const rows = [
        donationRow({ id: 'veg', foodType: 'Vegetarian' }),
        donationRow({ id: 'nonveg', foodType: 'Non-vegetarian' }),
      ];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get('?foodType=Vegetarian');
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['veg']);
    });

    it('does not match partial or case variants', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [donationRow({ foodType: 'Vegetarian' })]);
      expect((await get('?foodType=Veget')).body.data.items).toEqual([]);
      expect((await get('?foodType=vegetarian')).body.data.items).toEqual([]);
    });
  });

  describe('status filter', () => {
    it('matches a valid enum value (ADMIN)', async () => {
      const rows = [
        donationRow({ id: 'avail', status: 'AVAILABLE' }),
        donationRow({ id: 'done', status: 'COMPLETED' }),
      ];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get('?status=COMPLETED');
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['done']);
    });

    it('rejects invalid enum and repeated status values', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [donationRow()]);
      expect((await get('?status=NOPE')).status).toBe(400);
      expect((await get('?status=AVAILABLE&status=COMPLETED')).status).toBe(400);
    });

    it('cannot let a RECIPIENT escape AVAILABLE-only visibility', async () => {
      const rows = [
        donationRow({ id: 'avail', status: 'AVAILABLE' }),
        donationRow({ id: 'done', status: 'COMPLETED' }),
      ];
      const { donationFindMany } = mockBackend(callerRow({ id: 'rec-1', role: 'RECIPIENT' }), rows);
      const res = await get('?status=COMPLETED', 'RECIPIENT', 'rec-1');
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      const where = donationFindMany.mock.calls[0][0].where as { status?: string; AND?: unknown[] };
      expect(where.status).toBe('AVAILABLE');
      expect(where.AND).toEqual([{ status: 'COMPLETED' }]);
    });

    it('a PROVIDER status filter still only sees own donations', async () => {
      const rows = [
        donationRow({ id: 'mine', providerId: 'prov-1', status: 'COMPLETED' }),
        donationRow({ id: 'theirs', providerId: 'prov-2', status: 'COMPLETED' }),
      ];
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), rows);
      const res = await get('?status=COMPLETED', 'PROVIDER', 'prov-1');
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['mine']);
    });

    it('ADMIN filtering still respects universal current availability (expired excluded)', async () => {
      const rows = [
        donationRow({ id: 'live', status: 'COMPLETED', availableFrom: h(-2), availableUntil: h(2) }),
        donationRow({ id: 'expired', status: 'COMPLETED', availableFrom: h(-5), availableUntil: h(-1) }),
      ];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get('?status=COMPLETED');
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['live']);
    });
  });

  describe('composition', () => {
    it('ANDs category + foodType', async () => {
      const rows = [
        donationRow({ id: 'match', category: 'Prepared meals', foodType: 'Vegetarian' }),
        donationRow({ id: 'wrongType', category: 'Prepared meals', foodType: 'Non-vegetarian' }),
        donationRow({ id: 'wrongCat', category: 'Fruits', foodType: 'Vegetarian' }),
      ];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get('?category=Prepared%20meals&foodType=Vegetarian');
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['match']);
    });

    it('ANDs status + category', async () => {
      const rows = [
        donationRow({ id: 'm', status: 'COMPLETED', category: 'Prepared meals' }),
        donationRow({ id: 'n', status: 'AVAILABLE', category: 'Prepared meals' }),
      ];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get('?status=COMPLETED&category=Prepared%20meals');
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['m']);
    });

    it('ANDs availability-time + quantity (availability filter, not just DON-06 window)', async () => {
      const rows = [
        // matches: overlaps [h1,h2] and within quantity range
        donationRow({ id: 'match', availableFrom: h(-1), availableUntil: h(3), quantity: 50 }),
        // currently available (until > now) but does NOT overlap [h1,h2]
        donationRow({ id: 'noOverlap', availableFrom: h(-1), availableUntil: h(0.5), quantity: 50 }),
        // overlaps but quantity out of range
        donationRow({ id: 'wrongQty', availableFrom: h(-1), availableUntil: h(3), quantity: 5 }),
      ];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get(
        `?availableFrom=${h(1).toISOString()}&availableUntil=${h(2).toISOString()}&minQuantity=40&maxQuantity=60`
      );
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['match']);
    });

    it('ANDs status + quantity', async () => {
      const rows = [
        donationRow({ id: 'match', status: 'COMPLETED', quantity: 50 }),
        donationRow({ id: 'wrongQty', status: 'COMPLETED', quantity: 5 }),
        donationRow({ id: 'wrongStatus', status: 'AVAILABLE', quantity: 50 }),
      ];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get('?status=COMPLETED&minQuantity=40&maxQuantity=60');
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['match']);
    });

    it('applies ALL supported filters simultaneously', async () => {
      const rows = [
        donationRow({
          id: 'match',
          availableFrom: h(-1),
          availableUntil: h(3),
          quantity: 50,
          category: 'Prepared meals',
          foodType: 'Vegetarian',
          status: 'AVAILABLE',
        }),
        donationRow({ id: 'wrongStatus', status: 'MATCHED', category: 'Prepared meals', foodType: 'Vegetarian', quantity: 50, availableFrom: h(-1), availableUntil: h(3) }),
        donationRow({ id: 'wrongCategory', category: 'Fruits', foodType: 'Vegetarian', quantity: 50, availableFrom: h(-1), availableUntil: h(3) }),
        donationRow({ id: 'wrongType', category: 'Prepared meals', foodType: 'Non-vegetarian', quantity: 50, availableFrom: h(-1), availableUntil: h(3) }),
        donationRow({ id: 'wrongQty', category: 'Prepared meals', foodType: 'Vegetarian', quantity: 5, availableFrom: h(-1), availableUntil: h(3) }),
        donationRow({ id: 'noOverlap', category: 'Prepared meals', foodType: 'Vegetarian', quantity: 50, availableFrom: h(-1), availableUntil: h(0.5) }),
      ];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get(
        `?availableFrom=${h(1).toISOString()}&availableUntil=${h(2).toISOString()}` +
          '&minQuantity=40&maxQuantity=60&category=Prepared%20meals&foodType=Vegetarian&status=AVAILABLE'
      );
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['match']);
    });

    it('ANDs multiple filters and lets ordinary contradictions return an empty result (200)', async () => {
      const rows = [donationRow({ id: 'x', quantity: 50, category: 'Prepared meals' })];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const match = await get(
        '?category=Prepared%20meals&foodType=Vegetarian&status=AVAILABLE&minQuantity=1&maxQuantity=100'
      );
      expect(match.status).toBe(200);
      expect(match.body.data.items.map((d: { id: string }) => d.id)).toEqual(['x']);
      const empty = await get('?status=ACCEPTED&category=Prepared%20meals');
      expect(empty.status).toBe(200);
      expect(empty.body.data.items).toEqual([]);
    });

    it('omitted filters remain unconstrained (DON-06 behavior)', async () => {
      const rows = [
        donationRow({ id: 'a', category: 'Fruits', foodType: 'Vegetarian', quantity: 1 }),
        donationRow({ id: 'b', category: 'Prepared meals', foodType: 'Non-vegetarian', quantity: 99 }),
      ];
      mockBackend(callerRow({ role: 'ADMIN' }), rows);
      const res = await get('');
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((d: { id: string }) => d.id).sort()).toEqual(['a', 'b']);
    });
  });

  describe('authorization / security', () => {
    it('client-supplied identity/role fields never change visibility', async () => {
      const rows = [
        donationRow({ id: 'mine', providerId: 'prov-1' }),
        donationRow({ id: 'theirs', providerId: 'prov-2' }),
      ];
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), rows);
      const res = await get('?providerId=prov-2&userId=prov-2&role=ADMIN', 'PROVIDER', 'prov-1');
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['mine']);
    });

    it('VOLUNTEER remains 403 regardless of filters', async () => {
      const { donationFindMany } = mockBackend(callerRow({ id: 'vol-1', role: 'VOLUNTEER' }), []);
      const res = await get('?status=AVAILABLE&minQuantity=1', 'VOLUNTEER', 'vol-1');
      expect(res.status).toBe(403);
      expect(donationFindMany).not.toHaveBeenCalled();
    });

    it('filtered responses expose no sensitive fields', async () => {
      mockBackend(callerRow({ role: 'ADMIN' }), [donationRow()]);
      const res = await get('?status=AVAILABLE');
      const blob = JSON.stringify(res.body);
      expect(blob).not.toContain('pablo@example.com');
      expect(blob).not.toContain('passwordHash');
      expect(blob).not.toContain('bcrypt-hash-placeholder');
    });
  });

  describe('query correctness / read-only', () => {
    it('applies the same effective WHERE to findMany and count, before pagination', async () => {
      const { donationFindMany, donationCount } = mockBackend(callerRow({ role: 'ADMIN' }), [
        donationRow(),
      ]);
      await get('?status=AVAILABLE&minQuantity=1&maxQuantity=100&category=Prepared%20meals');
      const findArgs = donationFindMany.mock.calls[0][0];
      const countArgs = donationCount.mock.calls[0][0];
      expect(countArgs.where).toEqual(findArgs.where);
      expect(Array.isArray((findArgs.where as { AND?: unknown[] }).AND)).toBe(true);
      expect(findArgs.skip).toBe(0);
      expect(findArgs.take).toBe(20);
    });

    it('issues a single findMany + count in one transaction (no N+1)', async () => {
      const { donationFindMany, donationCount, $transaction } = mockBackend(callerRow({ role: 'ADMIN' }), [
        donationRow(),
      ]);
      await get('?foodType=Vegetarian');
      expect(donationFindMany).toHaveBeenCalledTimes(1);
      expect(donationCount).toHaveBeenCalledTimes(1);
      expect($transaction).toHaveBeenCalledTimes(1);
    });

    it('remains read-only with filters (no update/audit/notification)', async () => {
      const rows = [
        donationRow({ id: 'live', status: 'COMPLETED' }),
        donationRow({ id: 'expired', status: 'COMPLETED', availableFrom: h(-5), availableUntil: h(-1) }),
      ];
      const { donationUpdate, donationUpdateMany, auditCreate, notificationCreate } = mockBackend(
        callerRow({ role: 'ADMIN' }),
        rows
      );
      const res = await get('?status=COMPLETED&minQuantity=0');
      expect(res.status).toBe(200);
      expect(donationUpdate).not.toHaveBeenCalled();
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
      expect(notificationCreate).not.toHaveBeenCalled();
      expect(rows.find((r) => r.id === 'expired')?.status).toBe('COMPLETED');
    });
  });
});
