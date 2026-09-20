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
import { listDonations } from '../services/donations.service';
import { signAccessToken } from '../utils/jwt';

// DON-06: read-only donation listing. Visibility + the read-time availability
// window are DATABASE predicates (an in-memory stand-in applies them here so
// role/availability behavior is genuinely exercised), pagination reuses
// parsePagination, ordering is createdAt desc, and time_remaining is computed
// per item (ms, never persisted). A pure read — no update/audit/notification.

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
  // Sensitive fields deliberately present on the mock DB row to prove the
  // explicit projection strips them.
  email?: string;
  passwordHash?: string;
}

interface WhereShape {
  providerId?: string;
  status?: string;
  availableFrom?: { lte: Date };
  availableUntil?: { gt: Date };
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
  return {
    id: opts.id ?? 'user-1',
    role: opts.role ?? 'PROVIDER',
    status: opts.status ?? 'ACTIVE',
  };
}

function applyWhere(rows: ListRow[], where: WhereShape): ListRow[] {
  const now = Date.now();
  return rows.filter((r) => {
    if (where.providerId !== undefined && r.providerId !== where.providerId) return false;
    if (where.status !== undefined && r.status !== where.status) return false;
    if (r.availableFrom.getTime() > now) return false;
    if (r.availableUntil.getTime() <= now) return false;
    return true;
  });
}

function mockBackend(caller: ReturnType<typeof callerRow> | null, rows: ListRow[]) {
  const userFind = vi.fn(async () => caller);
  const donationFindMany = vi.fn(async (args: { where: WhereShape; skip?: number; take?: number }) => {
    const filtered = applyWhere(rows, args.where)
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const skip = args.skip ?? 0;
    const take = args.take ?? filtered.length;
    return filtered.slice(skip, skip + take);
  });
  const donationCount = vi.fn(async (args: { where: WhereShape }) => applyWhere(rows, args.where).length);
  const donationUpdate = vi.fn();
  const donationUpdateMany = vi.fn();
  const auditCreate = vi.fn();
  const notificationCreate = vi.fn();
  const $transaction = vi.fn(async (arg: unknown) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    return (arg as (c: unknown) => Promise<unknown>)({});
  });

  const client = {
    user: { findUnique: userFind },
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
  };
  vi.mocked(getPrisma).mockReturnValue(client as unknown as PrismaClient);
  return {
    userFind,
    donationFindMany,
    donationCount,
    donationUpdate,
    donationUpdateMany,
    auditCreate,
    notificationCreate,
    $transaction,
    rows,
  };
}

function token(role: string, id: string): string {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId: 'org-1' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DON-06 donation listing', () => {
  describe('authentication / role', () => {
    it('rejects unauthenticated requests with 401', async () => {
      mockBackend(callerRow(), [donationRow()]);
      const app = createApp();
      const res = await request(app).get('/api/donations');
      expect(res.status).toBe(401);
    });

    it('returns 403 for VOLUNTEER (no browse capability) with zero queries', async () => {
      const { donationFindMany } = mockBackend(callerRow({ role: 'VOLUNTEER' }), [donationRow()]);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('VOLUNTEER', 'vol-1')}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(donationFindMany).not.toHaveBeenCalled();
    });
  });

  describe('PROVIDER visibility', () => {
    it('returns only the authenticated provider\'s own donations', async () => {
      const rows = [
        donationRow({ id: 'mine-1', providerId: 'prov-1', createdAt: new Date('2026-09-03T00:00:00Z') }),
        donationRow({ id: 'mine-2', providerId: 'prov-1', createdAt: new Date('2026-09-02T00:00:00Z') }),
        donationRow({ id: 'theirs', providerId: 'prov-2', createdAt: new Date('2026-09-01T00:00:00Z') }),
      ];
      const { donationFindMany } = mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), rows);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['mine-1', 'mine-2']);
      expect(donationFindMany.mock.calls[0][0].where.providerId).toBe('prov-1');
    });

    it('cannot see another provider\'s donations even when spoofing providerId in query/body', async () => {
      const rows = [
        donationRow({ id: 'mine', providerId: 'prov-1' }),
        donationRow({ id: 'theirs', providerId: 'prov-2' }),
      ];
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), rows);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations?providerId=prov-2&userId=prov-2&role=ADMIN')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`)
        .send({ providerId: 'prov-2', role: 'ADMIN' });
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['mine']);
    });
  });

  describe('RECIPIENT visibility', () => {
    it('returns only AVAILABLE donations', async () => {
      const rows = [
        donationRow({ id: 'avail', status: 'AVAILABLE' }),
        donationRow({ id: 'matched', status: 'MATCHED' }),
        donationRow({ id: 'accepted', status: 'ACCEPTED' }),
      ];
      const { donationFindMany } = mockBackend(
        callerRow({ id: 'rec-1', role: 'RECIPIENT' }),
        rows
      );
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('RECIPIENT', 'rec-1')}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['avail']);
      expect(donationFindMany.mock.calls[0][0].where.status).toBe('AVAILABLE');
    });

    it.each([
      'DRAFT',
      'MATCHED',
      'ACCEPTED',
      'PICKUP_ASSIGNED',
      'PICKED_UP',
      'IN_TRANSIT',
      'DELIVERED',
      'COMPLETED',
      'EXPIRED',
      'CANCELLED',
    ] as const)('does not return %s donations', async (status) => {
      const rows = [donationRow({ id: 'x', status })];
      mockBackend(callerRow({ id: 'rec-1', role: 'RECIPIENT' }), rows);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('RECIPIENT', 'rec-1')}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.total).toBe(0);
    });
  });

  describe('ADMIN visibility', () => {
    it('returns donations across providers and statuses (subject to the availability window)', async () => {
      const rows = [
        donationRow({ id: 'a', providerId: 'prov-1', status: 'AVAILABLE' }),
        donationRow({ id: 'b', providerId: 'prov-2', status: 'ACCEPTED' }),
        donationRow({ id: 'c', providerId: 'prov-3', status: 'COMPLETED' }),
        donationRow({ id: 'd', providerId: 'prov-4', status: 'DRAFT' }),
      ];
      const { donationFindMany } = mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN' }), rows);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((d: { id: string }) => d.id).sort()).toEqual([
        'a',
        'b',
        'c',
        'd',
      ]);
      const where = donationFindMany.mock.calls[0][0].where;
      expect(where.providerId).toBeUndefined();
      expect(where.status).toBeUndefined();
    });
  });

  describe('read-time availability window', () => {
    it('excludes a not-yet-available donation (availableFrom in the future)', async () => {
      const rows = [donationRow({ id: 'future', availableFrom: h(1), availableUntil: h(3) })];
      mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN' }), rows);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(res.body.data.items).toEqual([]);
    });

    it('includes a donation availableFrom exactly now', async () => {
      const rows = [
        donationRow({ id: 'now', availableFrom: new Date(), availableUntil: h(2) }),
      ];
      mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN' }), rows);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['now']);
    });

    it('includes a donation with availableUntil in the future', async () => {
      const rows = [donationRow({ id: 'open', availableFrom: h(-1), availableUntil: h(0.5) })];
      mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN' }), rows);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['open']);
    });

    it('excludes a donation exactly at availableUntil', async () => {
      const rows = [donationRow({ id: 'edge', availableFrom: h(-2), availableUntil: new Date() })];
      mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN' }), rows);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(res.body.data.items).toEqual([]);
    });

    it('excludes an already-expired donation', async () => {
      const rows = [donationRow({ id: 'old', availableFrom: h(-5), availableUntil: h(-1) })];
      mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN' }), rows);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(res.body.data.items).toEqual([]);
    });
  });

  describe('time_remaining', () => {
    it('is present in milliseconds and positive for in-window donations', async () => {
      const rows = [donationRow({ id: 'open', availableFrom: h(-1), availableUntil: h(2) })];
      mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN' }), rows);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      const item = res.body.data.items[0];
      expect(typeof item.time_remaining).toBe('number');
      expect(item.time_remaining).toBeGreaterThan(0);
      expect(Math.abs(item.time_remaining - 2 * 60 * 60 * 1000)).toBeLessThan(5000);
    });

    it('is not persisted onto the stored donation rows', async () => {
      const rows = [donationRow({ id: 'open' })];
      mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN' }), rows);
      const app = createApp();
      await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect('time_remaining' in rows[0]).toBe(false);
    });
  });

  describe('pagination', () => {
    function manyRows(count: number): ListRow[] {
      return Array.from({ length: count }, (_, i) =>
        donationRow({
          id: `don-${String(i + 1).padStart(3, '0')}`,
          providerId: 'prov-1',
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)),
        })
      );
    }

    it('applies default page=1 / limit=20 and correct metadata', async () => {
      const { donationFindMany, donationCount } = mockBackend(
        callerRow({ id: 'admin-1', role: 'ADMIN' }),
        manyRows(25)
      );
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(res.status).toBe(200);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.limit).toBe(20);
      expect(res.body.data.total).toBe(25);
      expect(res.body.data.totalPages).toBe(2);
      expect(res.body.data.hasNext).toBe(true);
      expect(res.body.data.hasPrev).toBe(false);
      expect(res.body.data.items).toHaveLength(20);
      expect(donationFindMany.mock.calls[0][0].skip).toBe(0);
      expect(donationFindMany.mock.calls[0][0].take).toBe(20);
      expect(donationCount).toHaveBeenCalledTimes(1);
    });

    it('honors explicit page/limit and reports metadata', async () => {
      mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN' }), manyRows(25));
      const app = createApp();
      const res = await request(app)
        .get('/api/donations?page=2&limit=10')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(res.body.data.page).toBe(2);
      expect(res.body.data.limit).toBe(10);
      expect(res.body.data.total).toBe(25);
      expect(res.body.data.totalPages).toBe(3);
      expect(res.body.data.hasNext).toBe(true);
      expect(res.body.data.hasPrev).toBe(true);
      expect(res.body.data.items).toHaveLength(10);
    });

    it('caps limit at the utility maximum (100)', async () => {
      const { donationFindMany } = mockBackend(
        callerRow({ id: 'admin-1', role: 'ADMIN' }),
        manyRows(3)
      );
      const app = createApp();
      const res = await request(app)
        .get('/api/donations?limit=500')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(res.body.data.limit).toBe(100);
      expect(donationFindMany.mock.calls[0][0].take).toBe(100);
    });

    it('normalizes malformed/negative pagination to defaults', async () => {
      const { donationFindMany } = mockBackend(
        callerRow({ id: 'admin-1', role: 'ADMIN' }),
        manyRows(3)
      );
      const app = createApp();
      for (const qs of ['page=0&limit=-5', 'page=abc&limit=abc', 'limit=0']) {
        const res = await request(app)
          .get(`/api/donations?${qs}`)
          .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
        expect(res.status).toBe(200);
        expect(res.body.data.page).toBe(1);
        expect(res.body.data.limit).toBe(20);
      }
      expect(donationFindMany.mock.calls[0][0].take).toBe(20);
    });

    it('returns an empty page beyond the available results', async () => {
      mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN' }), manyRows(5));
      const app = createApp();
      const res = await request(app)
        .get('/api/donations?page=9&limit=10')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.total).toBe(5);
      expect(res.body.data.hasNext).toBe(false);
      expect(res.body.data.hasPrev).toBe(true);
    });

    it('orders by createdAt descending', async () => {
      const rows = [
        donationRow({ id: 'old', createdAt: new Date('2026-09-01T00:00:00Z') }),
        donationRow({ id: 'new', createdAt: new Date('2026-09-03T00:00:00Z') }),
        donationRow({ id: 'mid', createdAt: new Date('2026-09-02T00:00:00Z') }),
      ];
      const { donationFindMany } = mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN' }), rows);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['new', 'mid', 'old']);
      expect(donationFindMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
    });
  });

  describe('projection / security', () => {
    it('returns safe donation fields and no sensitive/extra fields', async () => {
      mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN' }), [donationRow()]);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      const item = res.body.data.items[0];
      expect(Object.keys(item).sort()).toEqual(
        [
          'availableFrom',
          'availableUntil',
          'category',
          'createdAt',
          'description',
          'foodName',
          'foodType',
          'id',
          'pickupLatitude',
          'pickupLocation',
          'pickupLongitude',
          'providerId',
          'quantity',
          'status',
          'storageRequirement',
          'time_remaining',
          'unit',
          'updatedAt',
        ].sort()
      );
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('pablo@example.com');
      expect(serialized).not.toContain('bcrypt-hash-placeholder');
      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('email');
    });

    it('applies role + availability predicates in the query, not in JS', async () => {
      const { donationFindMany, donationCount } = mockBackend(
        callerRow({ id: 'prov-1', role: 'PROVIDER' }),
        [donationRow({ providerId: 'prov-1' })]
      );
      const app = createApp();
      await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      const where = donationFindMany.mock.calls[0][0].where;
      expect(where.providerId).toBe('prov-1');
      expect(where.availableFrom.lte).toBeInstanceOf(Date);
      expect(where.availableUntil.gt).toBeInstanceOf(Date);
      expect(donationCount.mock.calls[0][0].where).toEqual(where);
    });

    it('issues a single paged query + count in one transaction (no N+1)', async () => {
      const { donationFindMany, donationCount, $transaction } = mockBackend(
        callerRow({ id: 'admin-1', role: 'ADMIN' }),
        [donationRow({ id: 'a' }), donationRow({ id: 'b' })]
      );
      const app = createApp();
      await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(donationFindMany).toHaveBeenCalledTimes(1);
      expect(donationCount).toHaveBeenCalledTimes(1);
      expect($transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('read-only guarantee', () => {
    it('performs no update/audit/notification on a successful list', async () => {
      const rows = [
        donationRow({ id: 'open' }),
        donationRow({ id: 'expired', availableFrom: h(-5), availableUntil: h(-1) }),
      ];
      const { donationUpdate, donationUpdateMany, auditCreate, notificationCreate } = mockBackend(
        callerRow({ id: 'admin-1', role: 'ADMIN' }),
        rows
      );
      const app = createApp();
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(res.status).toBe(200);
      expect(donationUpdate).not.toHaveBeenCalled();
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
      expect(notificationCreate).not.toHaveBeenCalled();
      // Expired rows are filtered at read time, not mutated.
      expect(rows.find((r) => r.id === 'expired')?.status).toBe('AVAILABLE');
    });

    it('masks persistence failures with no SQL/DSN leakage', async () => {
      const app = createApp();
      vi.mocked(getPrisma).mockReturnValue({
        user: { findUnique: vi.fn(async () => callerRow({ id: 'admin-1', role: 'ADMIN' })) },
        donation: {
          findMany: vi.fn(async () => {
            throw new Error('SELECT failed postgresql://u:p@h/db');
          }),
          count: vi.fn(),
        },
        $transaction: vi.fn(async (arg: unknown) => {
          if (Array.isArray(arg)) return Promise.all(arg);
          return undefined;
        }),
      } as unknown as PrismaClient);
      const res = await request(app)
        .get('/api/donations')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('DONATION_READ_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('postgresql://');
      expect(JSON.stringify(res.body)).not.toContain('SELECT');
    });
  });

  describe('service contract', () => {
    it('rejects an empty userId with 400', async () => {
      mockBackend(callerRow(), [donationRow()]);
      await expect(listDonations('', {})).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
