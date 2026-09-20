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
import { getDonationHistory } from '../services/donations.service';
import { signAccessToken } from '../utils/jwt';

// DON-08: PROVIDER donation history. Provider-only identity from the session
// (`provider_id=me`); RECIPIENT/VOLUNTEER/ADMIN 403. Historical (no DON-06
// current-availability filter). Ordering createdAt DESC, id DESC. Audit-backed
// timeline from persisted AuditLog rows only (no fabricated transitions).

interface HistoryRow {
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

interface AuditRow {
  id: string;
  userId: string;
  entityType: string;
  entityId: string;
  action: string;
  timestamp: Date;
  oldValue: string | null;
  newValue: string | null;
}

function h(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function donationRow(overrides: Partial<HistoryRow> = {}): HistoryRow {
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

function auditRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id: 'audit-1',
    userId: 'prov-1',
    entityType: 'Donation',
    entityId: 'don-1',
    action: 'DONATION_CREATED',
    timestamp: new Date('2026-09-01T00:00:00.000Z'),
    oldValue: null,
    newValue: '{"status":"AVAILABLE"}',
    ...overrides,
  };
}

function callerRow(opts: { id?: string; role?: string; status?: string } = {}) {
  return { id: opts.id ?? 'user-1', role: opts.role ?? 'PROVIDER', status: opts.status ?? 'ACTIVE' };
}

function mockBackend(
  caller: ReturnType<typeof callerRow> | null,
  donations: HistoryRow[],
  audits: AuditRow[] = []
) {
  const userFind = vi.fn(async () => caller);
  const donationFindMany = vi.fn(
    async (args: { where: { providerId?: string }; skip?: number; take?: number }) => {
      const filtered = donations
        .filter((d) => args.where.providerId === undefined || d.providerId === args.where.providerId)
        .slice()
        .sort((a, b) => {
          const byCreated = b.createdAt.getTime() - a.createdAt.getTime();
          if (byCreated !== 0) return byCreated;
          return b.id < a.id ? -1 : b.id > a.id ? 1 : 0; // id DESC
        });
      const skip = args.skip ?? 0;
      const take = args.take ?? filtered.length;
      return filtered.slice(skip, skip + take);
    }
  );
  const donationCount = vi.fn(
    async (args: { where: { providerId?: string } }) =>
      donations.filter((d) => args.where.providerId === undefined || d.providerId === args.where.providerId)
        .length
  );
  const auditFindMany = vi.fn(
    async (args: { where: { entityType?: string; entityId?: { in: string[] } }; take?: number }) => {
      const ids = args.where.entityId?.in ?? [];
      return audits
        .filter((a) => a.entityType === args.where.entityType && ids.includes(a.entityId))
        .slice()
        .sort((a, b) => {
          const byTs = a.timestamp.getTime() - b.timestamp.getTime();
          if (byTs !== 0) return byTs;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
    }
  );
  const donationUpdate = vi.fn();
  const donationUpdateMany = vi.fn();
  const auditCreate = vi.fn();
  const notificationCreate = vi.fn();
  const $transaction = vi.fn(async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : undefined));
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: userFind },
    donation: {
      findMany: donationFindMany,
      count: donationCount,
      findUnique: vi.fn(),
      update: donationUpdate,
      updateMany: donationUpdateMany,
    },
    auditLog: { create: auditCreate, findMany: auditFindMany },
    notification: { create: notificationCreate },
    $transaction,
  } as unknown as PrismaClient);
  return {
    userFind,
    donationFindMany,
    donationCount,
    auditFindMany,
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

function get(qs: string, role = 'PROVIDER', id = 'prov-1') {
  const app = createApp();
  return request(app).get(`/api/donations/history${qs}`).set('Authorization', `Bearer ${token(role, id)}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DON-08 donation history', () => {
  describe('authentication / provider_id validation', () => {
    it('rejects unauthenticated requests with 401', async () => {
      mockBackend(callerRow(), [donationRow()]);
      const app = createApp();
      const res = await request(app).get('/api/donations/history?provider_id=me');
      expect(res.status).toBe(401);
    });

    it.each([
      ['missing', ''],
      ['other value', '?provider_id=prov-2'],
      ['repeated', '?provider_id=me&provider_id=me'],
      ['empty', '?provider_id='],
    ])('rejects provider_id %s with 400 and zero queries', async (_label, qs) => {
      const { donationFindMany } = mockBackend(callerRow(), [donationRow()]);
      const res = await get(qs);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(donationFindMany).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('allows a PROVIDER to retrieve their own history', async () => {
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), [donationRow({ providerId: 'prov-1' })]);
      const res = await get('?provider_id=me');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
    });

    it.each(['RECIPIENT', 'VOLUNTEER', 'ADMIN'] as const)(
      'rejects %s with 403 (provider-history only)',
      async (role) => {
        const { donationFindMany } = mockBackend(callerRow({ id: 'x-1', role }), [donationRow()]);
        const res = await get('?provider_id=me', role, 'x-1');
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
        expect(donationFindMany).not.toHaveBeenCalled();
      }
    );

    it('service-level defense rejects non-provider callers', async () => {
      mockBackend(callerRow({ id: 'rec-1', role: 'RECIPIENT' }), [donationRow()]);
      await expect(getDonationHistory('rec-1', { provider_id: 'me' })).rejects.toMatchObject({
        statusCode: 403,
      });
    });
  });

  describe('historical visibility', () => {
    it('includes future, expired, cancelled and every persisted status (no DON-06 availability filter)', async () => {
      const rows = [
        donationRow({ id: 'future', status: 'AVAILABLE', availableFrom: h(5), availableUntil: h(8), createdAt: new Date('2026-09-05T00:00:00Z') }),
        donationRow({ id: 'expired', status: 'EXPIRED', availableFrom: h(-10), availableUntil: h(-5), createdAt: new Date('2026-09-04T00:00:00Z') }),
        donationRow({ id: 'cancelled', status: 'CANCELLED', createdAt: new Date('2026-09-03T00:00:00Z') }),
        donationRow({ id: 'accepted', status: 'ACCEPTED', createdAt: new Date('2026-09-02T00:00:00Z') }),
        donationRow({ id: 'completed', status: 'COMPLETED', createdAt: new Date('2026-09-01T00:00:00Z') }),
      ];
      const { donationFindMany, donationCount } = mockBackend(
        callerRow({ id: 'prov-1', role: 'PROVIDER' }),
        rows
      );
      const res = await get('?provider_id=me');
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual([
        'future',
        'expired',
        'cancelled',
        'accepted',
        'completed',
      ]);
      const where = donationFindMany.mock.calls[0][0].where as Record<string, unknown>;
      expect(where).toEqual({ providerId: 'prov-1' });
      expect(where.availableFrom).toBeUndefined();
      expect(where.availableUntil).toBeUndefined();
      expect(donationCount.mock.calls[0][0].where).toEqual(where);
    });

    it('excludes another provider\'s donations', async () => {
      const rows = [
        donationRow({ id: 'mine', providerId: 'prov-1', createdAt: new Date('2026-09-02T00:00:00Z') }),
        donationRow({ id: 'theirs', providerId: 'prov-2', createdAt: new Date('2026-09-01T00:00:00Z') }),
      ];
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), rows);
      const res = await get('?provider_id=me');
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['mine']);
    });

    it('client identity spoofing cannot change ownership', async () => {
      const rows = [
        donationRow({ id: 'mine', providerId: 'prov-1' }),
        donationRow({ id: 'theirs', providerId: 'prov-2' }),
      ];
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), rows);
      const res = await get('?provider_id=me&providerId=prov-2&userId=prov-2&role=ADMIN');
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['mine']);
    });
  });

  describe('ordering / pagination', () => {
    it('orders by createdAt DESC with id DESC tie-break', async () => {
      const rows = [
        donationRow({ id: 'a', createdAt: new Date('2026-09-01T00:00:00Z') }),
        donationRow({ id: 'b', createdAt: new Date('2026-09-01T00:00:00Z') }),
        donationRow({ id: 'newer', createdAt: new Date('2026-09-03T00:00:00Z') }),
      ];
      const { donationFindMany } = mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), rows);
      const res = await get('?provider_id=me');
      expect(res.body.data.items.map((d: { id: string }) => d.id)).toEqual(['newer', 'b', 'a']);
      expect(donationFindMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    function manyRows(count: number): HistoryRow[] {
      return Array.from({ length: count }, (_, i) =>
        donationRow({ id: `don-${String(i + 1).padStart(3, '0')}`, createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)) })
      );
    }

    it('applies default pagination and correct metadata', async () => {
      const { donationFindMany, donationCount } = mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), manyRows(25));
      const res = await get('?provider_id=me');
      expect(res.body.data).toMatchObject({ page: 1, limit: 20, total: 25, totalPages: 2, hasNext: true, hasPrev: false });
      expect(res.body.data.items).toHaveLength(20);
      expect(donationFindMany.mock.calls[0][0].skip).toBe(0);
      expect(donationFindMany.mock.calls[0][0].take).toBe(20);
      expect(donationCount).toHaveBeenCalledTimes(1);
    });

    it('honors explicit page/limit, caps at max, and normalizes malformed values', async () => {
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), manyRows(25));
      const paged = await get('?provider_id=me&page=2&limit=10');
      expect(paged.body.data).toMatchObject({ page: 2, limit: 10, total: 25, totalPages: 3, hasNext: true, hasPrev: true });
      expect(paged.body.data.items).toHaveLength(10);
      const capped = await get('?provider_id=me&limit=500');
      expect(capped.body.data.limit).toBe(100);
      const malformed = await get('?provider_id=me&page=abc&limit=-5');
      expect(malformed.body.data).toMatchObject({ page: 1, limit: 20 });
    });

    it('returns an empty page beyond available results', async () => {
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), manyRows(3));
      const res = await get('?provider_id=me&page=9&limit=10');
      expect(res.body.data.items).toEqual([]);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.hasNext).toBe(false);
      expect(res.body.data.hasPrev).toBe(true);
    });
  });

  describe('audit-backed timeline', () => {
    it('exposes persisted DONATION_CREATED/UPDATED/CANCELLED events with public fields only', async () => {
      const rows = [donationRow({ id: 'don-1', status: 'CANCELLED' })];
      const audits = [
        auditRow({ id: 'a1', entityId: 'don-1', action: 'DONATION_CREATED', timestamp: new Date('2026-09-01T00:00:00Z'), oldValue: null, newValue: '{"status":"AVAILABLE"}' }),
        auditRow({ id: 'a2', entityId: 'don-1', action: 'DONATION_UPDATED', timestamp: new Date('2026-09-02T00:00:00Z'), oldValue: '{"foodName":"old"}', newValue: '{"foodName":"new"}' }),
        auditRow({ id: 'a3', entityId: 'don-1', action: 'DONATION_CANCELLED', timestamp: new Date('2026-09-03T00:00:00Z'), oldValue: '{"status":"AVAILABLE"}', newValue: '{"status":"CANCELLED"}' }),
      ];
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), rows, audits);
      const res = await get('?provider_id=me');
      const item = res.body.data.items[0];
      expect(item.status).toBe('CANCELLED');
      expect(item.timeline.map((e: { action: string }) => e.action)).toEqual([
        'DONATION_CREATED',
        'DONATION_UPDATED',
        'DONATION_CANCELLED',
      ]);
      expect(item.timeline[0]).toEqual({
        action: 'DONATION_CREATED',
        timestamp: '2026-09-01T00:00:00.000Z',
        oldValue: null,
        newValue: '{"status":"AVAILABLE"}',
      });
      // Only the public event fields are exposed.
      expect(Object.keys(item.timeline[0]).sort()).toEqual(['action', 'newValue', 'oldValue', 'timestamp']);
      const blob = JSON.stringify(res.body);
      expect(blob).not.toContain('audit-1');
      expect(blob).not.toContain('entityType');
      expect(blob).not.toContain('entityId');
    });

    it('does not fabricate transitions for the current status when no audit exists', async () => {
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), [donationRow({ id: 'don-1', status: 'ACCEPTED' })], []);
      const res = await get('?provider_id=me');
      const item = res.body.data.items[0];
      expect(item.status).toBe('ACCEPTED');
      expect(item.timeline).toEqual([]);
    });

    it('does not leak another donation\'s audit events into the timeline', async () => {
      const rows = [
        donationRow({ id: 'mine', createdAt: new Date('2026-09-02T00:00:00Z') }),
        donationRow({ id: 'other', createdAt: new Date('2026-09-01T00:00:00Z') }),
      ];
      const audits = [
        auditRow({ id: 'mine-1', entityId: 'mine', action: 'DONATION_CREATED' }),
      ];
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), rows, audits);
      const res = await get('?provider_id=me');
      const byId = Object.fromEntries(res.body.data.items.map((d: { id: string }) => [d.id, d.timeline]));
      expect(byId.mine).toHaveLength(1);
      expect(byId.other).toEqual([]);
    });
  });

  describe('security / read-only', () => {
    it('never exposes passwordHash/email or unrelated sensitive fields', async () => {
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), [donationRow()]);
      const res = await get('?provider_id=me');
      const blob = JSON.stringify(res.body);
      expect(blob).not.toContain('pablo@example.com');
      expect(blob).not.toContain('bcrypt-hash-placeholder');
      expect(blob).not.toContain('passwordHash');
      expect(blob).not.toContain('email');
    });

    it('performs no writes and creates no audit/notification on read', async () => {
      const { donationUpdate, donationUpdateMany, auditCreate, notificationCreate } = mockBackend(
        callerRow({ id: 'prov-1', role: 'PROVIDER' }),
        [donationRow()]
      );
      const res = await get('?provider_id=me');
      expect(res.status).toBe(200);
      expect(donationUpdate).not.toHaveBeenCalled();
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
      expect(notificationCreate).not.toHaveBeenCalled();
    });

    it('masks persistence failures with no SQL/DSN leakage', async () => {
      const app = createApp();
      vi.mocked(getPrisma).mockReturnValue({
        user: { findUnique: vi.fn(async () => callerRow({ id: 'prov-1', role: 'PROVIDER' })) },
        donation: {
          findMany: vi.fn(async () => {
            throw new Error('SELECT failed postgresql://u:p@h/db');
          }),
          count: vi.fn(),
        },
        auditLog: { findMany: vi.fn() },
        $transaction: vi.fn(async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : undefined)),
      } as unknown as PrismaClient);
      const res = await get('?provider_id=me');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('DONATION_READ_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('postgresql://');
      expect(JSON.stringify(res.body)).not.toContain('SELECT');
    });
  });

  describe('service contract', () => {
    it('rejects an empty userId with 400', async () => {
      mockBackend(callerRow(), [donationRow()]);
      await expect(getDonationHistory('', { provider_id: 'me' })).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
