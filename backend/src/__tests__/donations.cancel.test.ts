import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database (same convention as the
// DON-01/DON-02/DON-03 and ORG-05 donation suites).
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../createApp';
import { cancelDonation } from '../services/donations.service';
import { signAccessToken } from '../utils/jwt';

// DON-04: provider-owned donation cancellation.
// Authoritative transition set (PRD §33 / docs/database.md §11.2):
//   AVAILABLE → CANCELLED and MATCHED → CANCELLED ("Provider before ACCEPTED").
// DRAFT→CANCELLED is NOT an enumerated transition, so DRAFT is rejected 409.
// Post-ACCEPTED admin override is DON-12 (not implemented here).
// Provider identity comes only from the session; no request body is consumed.

interface DonationRow {
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

const CANCELLABLE = ['AVAILABLE', 'MATCHED'] as const;
const NON_CANCELLABLE = [
  'DRAFT',
  'ACCEPTED',
  'PICKUP_ASSIGNED',
  'PICKED_UP',
  'IN_TRANSIT',
  'DELIVERED',
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
] as const;

function baseDonation(overrides: Partial<DonationRow> = {}): DonationRow {
  return {
    id: 'don-1',
    providerId: 'user-1',
    foodName: 'Vegetable soup',
    category: 'Prepared meals',
    foodType: 'Vegetarian',
    quantity: 25,
    unit: 'meals',
    availableFrom: new Date(Date.now() + 60 * 60 * 1000),
    availableUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
    pickupLocation: '12 Main St, Springfield',
    pickupLatitude: null,
    pickupLongitude: null,
    storageRequirement: null,
    description: null,
    status: 'AVAILABLE',
    createdAt: new Date('2026-09-19T00:00:00.000Z'),
    updatedAt: new Date('2026-09-19T00:00:00.000Z'),
    ...overrides,
  };
}

function providerRow(overrides: Record<string, unknown> = {}) {
  return { id: 'user-1', email: 'pablo@example.com', role: 'PROVIDER', status: 'ACTIVE', ...overrides };
}

interface MockOptions {
  user?: Record<string, unknown> | null;
  donation?: DonationRow | null;
  /** Simulates a concurrent transition between the read and the conditional write. */
  statusChangedBeforeWrite?: string;
  auditFailure?: boolean;
}

function mockBackend(opts: MockOptions = {}) {
  const user = opts.user === undefined ? providerRow() : opts.user;
  const store: { donation: DonationRow | null } = {
    donation: opts.donation === undefined ? baseDonation() : opts.donation,
  };
  const userFind = vi.fn(async () => user);
  const donationFind = vi.fn(async () => store.donation);
  const donationUpdateMany = vi.fn(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      if (!store.donation) return { count: 0 };
      if (opts.statusChangedBeforeWrite) {
        store.donation = { ...store.donation, status: opts.statusChangedBeforeWrite };
      }
      if (store.donation.id !== args.where.id) return { count: 0 };
      if (!(CANCELLABLE as readonly string[]).includes(store.donation.status)) return { count: 0 };
      store.donation = {
        ...store.donation,
        ...args.data,
        updatedAt: new Date(Date.now() + 1000),
      };
      return { count: 1 };
    }
  );
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    if (opts.auditFailure) throw new Error('AUDIT INSERT failed postgres://u:p@h/db');
    return { id: 'audit-1', ...args.data };
  });
  const notificationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'notif-1',
    isRead: false,
    ...args.data,
  }));

  const tx = {
    user: { findUnique: userFind },
    donation: { findUnique: donationFind, updateMany: donationUpdateMany },
    auditLog: { create: auditCreate },
    notification: { create: notificationCreate },
  };
  // Simulated transaction: a throw discards staged writes (models Prisma
  // interactive $transaction rollback at unit level — no live PostgreSQL).
  const $transaction = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
    const snapshot = store.donation ? { ...store.donation } : null;
    try {
      return await fn(tx);
    } catch (err) {
      store.donation = snapshot;
      throw err;
    }
  });
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: userFind },
    $transaction,
  } as unknown as PrismaClient);

  return { userFind, donationFind, donationUpdateMany, auditCreate, notificationCreate, store };
}

function token(role = 'PROVIDER', id = 'user-1'): string {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId: 'org-1' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DON-04 donation cancellation', () => {
  describe('authorization / ownership', () => {
    it('lets the owning provider cancel an AVAILABLE donation and returns status CANCELLED', async () => {
      const { donationUpdateMany } = mockBackend();
      const app = createApp();
      const res = await request(app)
        .post('/api/donations/don-1/cancel')
        .set('Authorization', `Bearer ${token()}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.donation.id).toBe('don-1');
      expect(res.body.data.donation.providerId).toBe('user-1');
      expect(res.body.data.donation.status).toBe('CANCELLED');
      // Unrelated fields survive the transition unchanged.
      expect(res.body.data.donation.foodName).toBe('Vegetable soup');
      expect(res.body.data.donation.quantity).toBe(25);
      expect(res.body.data.donation.availableUntil).toBeDefined();
      expect(res.body.data.donation.matches).toBeUndefined();
      expect(res.body.data.donation.provider).toBeUndefined();
      expect(donationUpdateMany).toHaveBeenCalledWith({
        where: { id: 'don-1', providerId: 'user-1', status: { in: ['AVAILABLE', 'MATCHED'] } },
        data: { status: 'CANCELLED' },
      });
    });

    it('rejects unauthenticated requests with 401 and zero mutation', async () => {
      const { donationUpdateMany } = mockBackend();
      const app = createApp();
      const res = await request(app).post('/api/donations/don-1/cancel');
      expect(res.status).toBe(401);
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });

    it.each(['RECIPIENT', 'VOLUNTEER', 'ADMIN'] as const)(
      'rejects %s with 403 and zero mutation (provider-only route)',
      async (role) => {
        const { donationUpdateMany, auditCreate } = mockBackend();
        const app = createApp();
        const res = await request(app)
          .post('/api/donations/don-1/cancel')
          .set('Authorization', `Bearer ${token(role)}`);
        expect(res.status).toBe(403);
        expect(donationUpdateMany).not.toHaveBeenCalled();
        expect(auditCreate).not.toHaveBeenCalled();
      }
    );

    it('rejects one provider cancelling another provider\'s donation with 403 and zero mutation', async () => {
      const { donationUpdateMany, auditCreate } = mockBackend({
        user: providerRow({ id: 'user-2' }),
        donation: baseDonation({ providerId: 'user-1' }),
      });
      const app = createApp();
      const res = await request(app)
        .post('/api/donations/don-1/cancel')
        .set('Authorization', `Bearer ${token('PROVIDER', 'user-2')}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown donation with zero mutation', async () => {
      const { donationUpdateMany, auditCreate } = mockBackend({ donation: null });
      const app = createApp();
      const res = await request(app)
        .post('/api/donations/ghost/cancel')
        .set('Authorization', `Bearer ${token()}`);
      expect(res.status).toBe(404);
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it('service-level defense-in-depth rejects non-provider callers', async () => {
      const { donationUpdateMany } = mockBackend({ user: providerRow({ role: 'RECIPIENT' }) });
      await expect(cancelDonation('don-1', 'user-1')).rejects.toMatchObject({ statusCode: 403 });
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });

    it('service rejects an inactive/suspended caller with 401 and zero mutation', async () => {
      const { donationUpdateMany } = mockBackend({ user: providerRow({ status: 'SUSPENDED' }) });
      await expect(cancelDonation('don-1', 'user-1')).rejects.toMatchObject({ statusCode: 401 });
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });

    it('does not consume a request body, so client status/providerId cannot steer the transition', async () => {
      const { donationUpdateMany } = mockBackend();
      const app = createApp();
      const res = await request(app)
        .post('/api/donations/don-1/cancel')
        .set('Authorization', `Bearer ${token()}`)
        .send({ status: 'COMPLETED', providerId: 'attacker', canceledBy: 'attacker' });
      // Body is ignored (no schema); ownership/status still come from session + DB.
      expect(res.status).toBe(200);
      expect(res.body.data.donation.status).toBe('CANCELLED');
      expect(donationUpdateMany).toHaveBeenCalledWith({
        where: { id: 'don-1', providerId: 'user-1', status: { in: ['AVAILABLE', 'MATCHED'] } },
        data: { status: 'CANCELLED' },
      });
    });
  });

  describe('state machine eligibility', () => {
    it.each(CANCELLABLE)('cancels an eligible %s donation', async (status) => {
      const { donationUpdateMany } = mockBackend({ donation: baseDonation({ status }) });
      const app = createApp();
      const res = await request(app)
        .post('/api/donations/don-1/cancel')
        .set('Authorization', `Bearer ${token()}`);
      expect(res.status).toBe(200);
      expect(res.body.data.donation.status).toBe('CANCELLED');
      expect(donationUpdateMany).toHaveBeenCalledTimes(1);
    });

    it.each(NON_CANCELLABLE)(
      'rejects a %s donation with 409 and zero side effects',
      async (status) => {
        const { donationUpdateMany, auditCreate, notificationCreate } = mockBackend({
          donation: baseDonation({ status }),
        });
        const app = createApp();
        const res = await request(app)
          .post('/api/donations/don-1/cancel')
          .set('Authorization', `Bearer ${token()}`);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CONFLICT');
        expect(donationUpdateMany).not.toHaveBeenCalled();
        expect(auditCreate).not.toHaveBeenCalled();
        expect(notificationCreate).not.toHaveBeenCalled();
      }
    );

    it('blocks the write when a concurrent transition leaves the row non-cancellable', async () => {
      const { donationUpdateMany, auditCreate, store } = mockBackend({
        donation: baseDonation({ status: 'AVAILABLE' }),
        statusChangedBeforeWrite: 'ACCEPTED',
      });
      const app = createApp();
      const res = await request(app)
        .post('/api/donations/don-1/cancel')
        .set('Authorization', `Bearer ${token()}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(donationUpdateMany).toHaveBeenCalledTimes(1);
      expect(auditCreate).not.toHaveBeenCalled();
      // The conditional write did not produce a cancellation.
      expect(store.donation?.status).not.toBe('CANCELLED');
    });
  });

  describe('audit / notifications', () => {
    it('writes exactly one DONATION_CANCELLED audit event with actor, entity, id and old/new status', async () => {
      const { auditCreate, notificationCreate } = mockBackend({
        donation: baseDonation({ status: 'MATCHED' }),
      });
      const app = createApp();
      const res = await request(app)
        .post('/api/donations/don-1/cancel')
        .set('Authorization', `Bearer ${token()}`);
      expect(res.status).toBe(200);
      expect(auditCreate).toHaveBeenCalledTimes(1);
      const audit = auditCreate.mock.calls[0][0].data;
      expect(audit).toEqual(
        expect.objectContaining({
          userId: 'user-1',
          action: 'DONATION_CANCELLED',
          entityType: 'Donation',
          entityId: 'don-1',
        })
      );
      const oldValue = JSON.parse(audit.oldValue as string);
      const newValue = JSON.parse(audit.newValue as string);
      expect(oldValue.status).toBe('MATCHED');
      expect(newValue.status).toBe('CANCELLED');
      // DON-04 requires an audit change only — no notification type exists for
      // donation cancellation, so none may be emitted.
      expect(notificationCreate).not.toHaveBeenCalled();
    });

    it('emits no notification on a rejected cancellation', async () => {
      const { notificationCreate, auditCreate } = mockBackend({
        donation: baseDonation({ status: 'COMPLETED' }),
      });
      const app = createApp();
      const res = await request(app)
        .post('/api/donations/don-1/cancel')
        .set('Authorization', `Bearer ${token()}`);
      expect(res.status).toBe(409);
      expect(notificationCreate).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it('rolls the cancellation back when audit persistence fails, masking DB details', async () => {
      const { donationUpdateMany, store } = mockBackend({
        auditFailure: true,
        donation: baseDonation({ status: 'AVAILABLE' }),
      });
      const app = createApp();
      const res = await request(app)
        .post('/api/donations/don-1/cancel')
        .set('Authorization', `Bearer ${token()}`);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('AUDIT_PERSIST_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('postgres://');
      expect(JSON.stringify(res.body)).not.toContain('SELECT');
      expect(donationUpdateMany).toHaveBeenCalledTimes(1);
      // Transaction rollback: no partial cancellation.
      expect(store.donation?.status).toBe('AVAILABLE');
    });

    it('does not emit an audit event for an ownership rejection', async () => {
      const { auditCreate } = mockBackend({
        user: providerRow({ id: 'user-2' }),
        donation: baseDonation({ providerId: 'user-1' }),
      });
      const app = createApp();
      await request(app)
        .post('/api/donations/don-1/cancel')
        .set('Authorization', `Bearer ${token('PROVIDER', 'user-2')}`);
      expect(auditCreate).not.toHaveBeenCalled();
    });
  });

  describe('security', () => {
    it('masks persistence failures with no SQL/DSN/Prisma leakage', async () => {
      const app = createApp();
      vi.mocked(getPrisma).mockReturnValue({
        user: { findUnique: vi.fn(async () => providerRow()) },
        $transaction: vi.fn(async () => {
          throw new Error('UPDATE "donations" failed postgresql://u:p@h/db');
        }),
      } as unknown as PrismaClient);
      const res = await request(app)
        .post('/api/donations/don-1/cancel')
        .set('Authorization', `Bearer ${token()}`);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('DONATION_CANCEL_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('postgresql://');
      expect(JSON.stringify(res.body)).not.toContain('donations');
    });

    it('service rejects an empty donation id with 400', async () => {
      mockBackend();
      await expect(cancelDonation('', 'user-1')).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
