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
import { canTransition, canAdminOverride } from '../utils/donationState';

// DON-12: ADMIN-only overrides — ACCEPTED → CANCELLED and COMPLETED → AVAILABLE.
// The ordinary DON-09 lifecycle is NOT broadened; only the separate
// canAdminOverride matrix authorizes these, via POST /:id/override.

interface DonRow {
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
}

function donationRow(overrides: Partial<DonRow> = {}): DonRow {
  return {
    id: 'don-1',
    providerId: 'prov-1',
    foodName: 'Vegetable soup',
    category: 'Prepared meals',
    foodType: 'Vegetarian',
    quantity: 25,
    unit: 'meals',
    availableFrom: new Date('2099-01-01T10:00:00.000Z'),
    availableUntil: new Date('2099-01-01T18:00:00.000Z'),
    pickupLocation: '12 Main St, Springfield',
    pickupLatitude: null,
    pickupLongitude: null,
    storageRequirement: null,
    description: null,
    status: 'ACCEPTED',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function callerRow(opts: { id?: string; role?: string; status?: string } = {}) {
  return { id: opts.id ?? 'admin-1', role: opts.role ?? 'ADMIN', status: opts.status ?? 'ACTIVE' };
}

interface MockOptions {
  statusChangedBeforeWrite?: string;
  auditFailure?: boolean;
}

function mockBackend(caller: ReturnType<typeof callerRow> | null, seed: DonRow[], opts: MockOptions = {}) {
  const donations = seed.map((d) => ({ ...d }));
  const auditLogs: Array<Record<string, unknown>> = [];
  const userFind = vi.fn(async () => caller);
  const donationFindUnique = vi.fn(async (args: { where: { id: string } }) => {
    const row = donations.find((d) => d.id === args.where.id);
    return row ? { ...row } : null;
  });
  const donationUpdateMany = vi.fn(
    async (args: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
      if (opts.statusChangedBeforeWrite) {
        const d = donations.find((x) => x.id === args.where.id);
        if (d) d.status = opts.statusChangedBeforeWrite;
      }
      let count = 0;
      for (const d of donations) {
        if (d.id !== args.where.id) continue;
        if (args.where.status !== undefined && d.status !== args.where.status) continue;
        Object.assign(d, args.data);
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
  const notificationCreate = vi.fn();

  const tx = {
    donation: { findUnique: donationFindUnique, updateMany: donationUpdateMany },
    auditLog: { create: auditCreate },
    notification: { create: notificationCreate },
  };
  // Simulated transaction with rollback semantics (no live DB).
  const $transaction = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
    const snapshot = donations.map((d) => ({ ...d }));
    try {
      return await fn(tx);
    } catch (err) {
      donations.splice(0, donations.length, ...snapshot);
      throw err;
    }
  });

  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: userFind },
    donation: { findUnique: donationFindUnique, updateMany: donationUpdateMany, update: vi.fn() },
    auditLog: { create: auditCreate },
    notification: { create: notificationCreate },
    $transaction,
  } as unknown as PrismaClient);

  return {
    donations,
    auditLogs,
    userFind,
    donationFindUnique,
    donationUpdateMany,
    auditCreate,
    notificationCreate,
    $transaction,
  };
}

function token(role: string, id: string): string {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId: 'org-1' });
}

function post(body: unknown, role = 'ADMIN', id = 'admin-1') {
  const app = createApp();
  return request(app)
    .post('/api/donations/don-1/override')
    .set('Authorization', `Bearer ${token(role, id)}`)
    .send(body as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DON-12 admin override', () => {
  describe('authentication / authorization', () => {
    it('rejects unauthenticated requests with 401', async () => {
      mockBackend(callerRow(), [donationRow()]);
      const app = createApp();
      const res = await request(app).post('/api/donations/don-1/override').send({ to: 'CANCELLED' });
      expect(res.status).toBe(401);
    });

    it.each(['PROVIDER', 'RECIPIENT', 'VOLUNTEER'] as const)(
      'rejects %s with 403 and zero mutation',
      async (role) => {
        const { donationUpdateMany, auditLogs } = mockBackend(callerRow({ id: 'x-1', role }), [
          donationRow({ status: 'ACCEPTED' }),
        ]);
        const res = await post({ to: 'CANCELLED' }, role, 'x-1');
        expect(res.status).toBe(403);
        expect(donationUpdateMany).not.toHaveBeenCalled();
        expect(auditLogs).toHaveLength(0);
      }
    );

    it('lets an ADMIN perform an authorized override', async () => {
      mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN' }), [donationRow({ status: 'ACCEPTED' })]);
      const res = await post({ to: 'CANCELLED' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.donation.status).toBe('CANCELLED');
    });
  });

  describe('valid overrides', () => {
    it('ADMIN ACCEPTED → CANCELLED → 200', async () => {
      const { donations, donationUpdateMany } = mockBackend(callerRow(), [donationRow({ status: 'ACCEPTED' })]);
      const res = await post({ to: 'CANCELLED' });
      expect(res.status).toBe(200);
      expect(res.body.data.donation).toEqual(
        expect.objectContaining({ id: 'don-1', status: 'CANCELLED' })
      );
      expect(donations[0].status).toBe('CANCELLED');
      expect(donationUpdateMany).toHaveBeenCalledWith({
        where: { id: 'don-1', status: 'ACCEPTED' },
        data: { status: 'CANCELLED' },
      });
    });

    it('ADMIN COMPLETED → AVAILABLE → 200', async () => {
      const { donations } = mockBackend(callerRow(), [donationRow({ status: 'COMPLETED' })]);
      const res = await post({ to: 'AVAILABLE' });
      expect(res.status).toBe(200);
      expect(res.body.data.donation.status).toBe('AVAILABLE');
      expect(donations[0].status).toBe('AVAILABLE');
    });
  });

  describe('invalid source/target combinations → 409 zero mutation/audit', () => {
    const cases: Array<[string, string]> = [
      ['ACCEPTED', 'AVAILABLE'],
      ['COMPLETED', 'CANCELLED'],
      ['AVAILABLE', 'CANCELLED'],
      ['AVAILABLE', 'AVAILABLE'],
      ['MATCHED', 'CANCELLED'],
      ['PICKUP_ASSIGNED', 'CANCELLED'],
      ['PICKED_UP', 'CANCELLED'],
      ['IN_TRANSIT', 'CANCELLED'],
      ['DELIVERED', 'CANCELLED'],
      ['EXPIRED', 'AVAILABLE'],
      ['EXPIRED', 'CANCELLED'],
      ['CANCELLED', 'AVAILABLE'],
      ['DRAFT', 'CANCELLED'],
    ];

    it.each(cases)('rejects %s → %s with 409 and zero mutation/audit', async (status, to) => {
      const { donationUpdateMany, auditLogs, donations } = mockBackend(callerRow(), [
        donationRow({ status }),
      ]);
      const res = await post({ to });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
      expect(donations[0].status).toBe(status);
    });
  });

  describe('request body / security', () => {
    it.each([
      ['missing to', {}],
      ['null to', { to: null }],
      ['array to', { to: ['CANCELLED'] }],
      ['object to', { to: { x: 1 } }],
      ['invalid enum', { to: 'DELIVERED' }],
      ['empty to', { to: '' }],
      ['client from field', { to: 'CANCELLED', from: 'ACCEPTED' }],
      ['identity spoof', { to: 'CANCELLED', providerId: 'prov-1', userId: 'prov-1', organizationId: 'o', role: 'ADMIN', status: 'ACCEPTED' }],
    ])('rejects %s with 400 and zero mutation', async (_label, body) => {
      const { donationUpdateMany, auditLogs } = mockBackend(callerRow(), [donationRow({ status: 'ACCEPTED' })]);
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
    });

    it('returns 404 for an unknown donation with zero mutation', async () => {
      const { donationUpdateMany, auditLogs } = mockBackend(callerRow(), []);
      const res = await post({ to: 'CANCELLED' });
      expect(res.status).toBe(404);
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('concurrency', () => {
    it('returns 409 with no audit when a concurrent change makes the conditional update affect zero rows', async () => {
      const { donationUpdateMany, auditLogs } = mockBackend(callerRow(), [donationRow({ status: 'ACCEPTED' })], {
        statusChangedBeforeWrite: 'DELIVERED',
      });
      const res = await post({ to: 'CANCELLED' });
      expect(res.status).toBe(409);
      expect(donationUpdateMany).toHaveBeenCalledTimes(1);
      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('audit', () => {
    it('writes exactly one DONATION_ADMIN_OVERRIDE event with actor/entity/old/new', async () => {
      const { auditCreate, auditLogs, notificationCreate } = mockBackend(callerRow({ id: 'admin-1' }), [
        donationRow({ status: 'ACCEPTED' }),
      ]);
      const res = await post({ to: 'CANCELLED' });
      expect(res.status).toBe(200);
      expect(auditCreate).toHaveBeenCalledTimes(1);
      expect(auditLogs).toHaveLength(1);
      const data = auditLogs[0];
      expect(data).toEqual(
        expect.objectContaining({
          userId: 'admin-1',
          action: 'DONATION_ADMIN_OVERRIDE',
          entityType: 'Donation',
          entityId: 'don-1',
        })
      );
      expect(JSON.parse(data.oldValue as string).status).toBe('ACCEPTED');
      expect(JSON.parse(data.newValue as string).status).toBe('CANCELLED');
      expect(notificationCreate).not.toHaveBeenCalled();
    });

    it('writes no audit for a rejected override', async () => {
      const { auditCreate } = mockBackend(callerRow(), [donationRow({ status: 'AVAILABLE' })]);
      const res = await post({ to: 'CANCELLED' });
      expect(res.status).toBe(409);
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it('rolls back the status mutation and masks errors when audit persistence fails', async () => {
      const { donations, donationUpdateMany } = mockBackend(callerRow(), [donationRow({ status: 'ACCEPTED' })], {
        auditFailure: true,
      });
      const res = await post({ to: 'CANCELLED' });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('AUDIT_PERSIST_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('postgresql://');
      expect(donationUpdateMany).toHaveBeenCalledTimes(1);
      expect(donations[0].status).toBe('ACCEPTED');
    });
  });

  describe('ordinary lifecycle is not broadened', () => {
    it('keeps COMPLETED terminal and ACCEPTED non-cancellable via canTransition', () => {
      expect(canTransition('COMPLETED', 'AVAILABLE')).toBe(false);
      expect(canTransition('ACCEPTED', 'CANCELLED')).toBe(false);
      expect(canTransition('AVAILABLE', 'CANCELLED')).toBe(true);
      expect(canTransition('MATCHED', 'CANCELLED')).toBe(true);
    });

    it('authorizes exactly the two admin override pairs', () => {
      expect(canAdminOverride('ACCEPTED', 'CANCELLED')).toBe(true);
      expect(canAdminOverride('COMPLETED', 'AVAILABLE')).toBe(true);
      for (const [from, to] of [
        ['AVAILABLE', 'CANCELLED'],
        ['MATCHED', 'CANCELLED'],
        ['COMPLETED', 'CANCELLED'],
        ['ACCEPTED', 'AVAILABLE'],
        ['PICKUP_ASSIGNED', 'CANCELLED'],
        ['DELIVERED', 'CANCELLED'],
        ['EXPIRED', 'AVAILABLE'],
        ['CANCELLED', 'AVAILABLE'],
        ['AVAILABLE', 'AVAILABLE'],
      ] as const) {
        expect(canAdminOverride(from, to), `${from}->${to}`).toBe(false);
      }
    });

    it('masks persistence failures with no SQL/DSN leakage', async () => {
      const app = createApp();
      vi.mocked(getPrisma).mockReturnValue({
        user: { findUnique: vi.fn(async () => callerRow()) },
        donation: {
          findUnique: vi.fn(async () => {
            throw new Error('SELECT failed postgresql://u:p@h/db');
          }),
        },
        auditLog: { create: vi.fn() },
        $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) =>
          fn({ donation: { findUnique: vi.fn(async () => { throw new Error('SELECT failed postgresql://u:p@h/db'); }) }, auditLog: { create: vi.fn() } })
        ),
      } as unknown as PrismaClient);
      const res = await post({ to: 'CANCELLED' });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('DONATION_OVERRIDE_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('postgresql://');
      expect(JSON.stringify(res.body)).not.toContain('SELECT');
    });
  });
});
