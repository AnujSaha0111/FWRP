import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database (same convention as
// donations.create.test.ts / donations.accept.test.ts / ORG-05).
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../createApp';
import { updateDonation } from '../services/donations.service';
import { signAccessToken } from '../utils/jwt';

// DON-03: provider-owned donation editing.
// - provider identity only from the session (never the body)
// - persisted ownership enforced in the service (defense-in-depth)
// - editable only when status is DRAFT or AVAILABLE, else 409
// - all editable FR-04 fields re-validated with the DON-01/DON-02 contract
// - atomic conditional update (id + providerId + editable status)
// - exactly one DONATION_UPDATED audit event in the SAME transaction
// - no dedicated `version` column exists in schema/PRD/ADR, so none is
//   invented: the server-managed `updatedAt` is the version marker.

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

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function baseDonation(overrides: Partial<DonationRow> = {}): DonationRow {
  return {
    id: 'don-1',
    providerId: 'user-1',
    foodName: 'Vegetable soup',
    category: 'Prepared meals',
    foodType: 'Vegetarian',
    quantity: 25,
    unit: 'meals',
    availableFrom: hoursFromNow(1),
    availableUntil: hoursFromNow(6),
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
  categoryActive?: boolean;
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
  const categoryFind = vi.fn(async () => (opts.categoryActive === false ? null : { id: 'cat-1' }));
  const donationFind = vi.fn(async () => store.donation);
  const donationUpdateMany = vi.fn(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      if (!store.donation) return { count: 0 };
      if (opts.statusChangedBeforeWrite) {
        store.donation = { ...store.donation, status: opts.statusChangedBeforeWrite };
      }
      if (store.donation.id !== args.where.id) return { count: 0 };
      const editable = ['DRAFT', 'AVAILABLE'];
      if (!editable.includes(store.donation.status)) return { count: 0 };
      // Simulate Prisma @updatedAt bumping exactly once on the successful write.
      store.donation = { ...store.donation, ...args.data, updatedAt: new Date(Date.now() + 1000) };
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
    category: { findFirst: categoryFind },
    donation: { findUnique: donationFind, updateMany: donationUpdateMany },
    auditLog: { create: auditCreate },
    notification: { create: notificationCreate },
  };
  // Simulated transaction: a throw discards all staged writes (models Prisma
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

  return { userFind, categoryFind, donationFind, donationUpdateMany, auditCreate, notificationCreate, store };
}

function token(role = 'PROVIDER', id = 'user-1'): string {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId: 'org-1' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DON-03 donation editing', () => {
  describe('authorization / ownership', () => {
    it('lets the owning provider edit and returns the safe profile envelope', async () => {
      mockBackend();
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({ foodName: 'Tomato soup' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.donation.id).toBe('don-1');
      expect(res.body.data.donation.providerId).toBe('user-1');
      expect(res.body.data.donation.foodName).toBe('Tomato soup');
      expect(res.body.data.donation.status).toBe('AVAILABLE');
      expect(res.body.data.donation.matches).toBeUndefined();
      expect(res.body.data.donation.provider).toBeUndefined();
    });

    it('rejects unauthenticated requests with 401 and no mutation', async () => {
      const { donationUpdateMany } = mockBackend();
      const app = createApp();
      const res = await request(app).put('/api/donations/don-1').send({ foodName: 'x' });
      expect(res.status).toBe(401);
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });

    it.each(['RECIPIENT', 'VOLUNTEER', 'ADMIN'] as const)(
      'rejects %s with 403 and no mutation (provider-only route)',
      async (role) => {
        const { donationUpdateMany } = mockBackend();
        const app = createApp();
        const res = await request(app)
          .put('/api/donations/don-1')
          .set('Authorization', `Bearer ${token(role)}`)
          .send({ foodName: 'x' });
        expect(res.status).toBe(403);
        expect(donationUpdateMany).not.toHaveBeenCalled();
      }
    );

    it('rejects a provider editing another provider\'s donation with 403 and zero mutation', async () => {
      const { donationUpdateMany, auditCreate } = mockBackend({
        user: providerRow({ id: 'user-2' }),
        donation: baseDonation({ providerId: 'user-1' }),
      });
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'user-2')}`)
        .send({ foodName: 'Stolen' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it('client-supplied providerId/ownerId cannot bypass ownership', async () => {
      const { donationUpdateMany } = mockBackend({
        user: providerRow({ id: 'user-2' }),
        donation: baseDonation({ providerId: 'user-1' }),
      });
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'user-2')}`)
        .send({ foodName: 'Stolen', providerId: 'user-1', ownerId: 'user-1' });
      // Strict schema rejects the unknown server-controlled keys before any lookup.
      expect(res.status).toBe(400);
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown donation with zero mutation', async () => {
      const { donationUpdateMany, auditCreate } = mockBackend({ donation: null });
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/ghost')
        .set('Authorization', `Bearer ${token()}`)
        .send({ foodName: 'x' });
      expect(res.status).toBe(404);
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it('service-level defense-in-depth rejects non-provider callers', async () => {
      const { donationUpdateMany } = mockBackend({ user: providerRow({ role: 'RECIPIENT' }) });
      await expect(updateDonation('don-1', 'user-1', { foodName: 'x' })).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('status gate', () => {
    it.each(['DRAFT', 'AVAILABLE'] as const)('allows editing status %s', async (status) => {
      mockBackend({ donation: baseDonation({ status }) });
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({ foodName: 'Updated' });
      expect(res.status).toBe(200);
    });

    it.each([
      'MATCHED',
      'ACCEPTED',
      'PICKUP_ASSIGNED',
      'PICKED_UP',
      'IN_TRANSIT',
      'DELIVERED',
      'COMPLETED',
      'EXPIRED',
      'CANCELLED',
    ] as const)('rejects status %s with 409 and zero mutation', async (status) => {
      const { donationUpdateMany, auditCreate, notificationCreate } = mockBackend({
        donation: baseDonation({ status }),
      });
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({ foodName: 'Updated' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
      expect(notificationCreate).not.toHaveBeenCalled();
    });

    it('blocks the write when a concurrent transition leaves the row non-editable (conditional update)', async () => {
      const { donationUpdateMany, auditCreate } = mockBackend({
        donation: baseDonation({ status: 'AVAILABLE' }),
        statusChangedBeforeWrite: 'ACCEPTED',
      });
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({ foodName: 'Updated' });
      expect(res.status).toBe(409);
      expect(donationUpdateMany).toHaveBeenCalledTimes(1);
      expect(auditCreate).not.toHaveBeenCalled();
    });
  });

  describe('validation (reuses DON-01/DON-02 contract)', () => {
    const invalidBodies: Array<[string, Record<string, unknown>]> = [
      ['whitespace food name', { foodName: '   ' }],
      ['non-string food name', { foodName: 12 }],
      ['empty category', { category: '' }],
      ['non-string food type', { foodType: 5 }],
      ['zero quantity', { quantity: 0 }],
      ['negative quantity', { quantity: -2 }],
      ['string quantity', { quantity: '5' }],
      ['empty unit', { unit: '  ' }],
      ['malformed availableFrom', { availableFrom: 'not-a-date' }],
      ['null availableFrom', { availableFrom: null }],
      ['boolean availableFrom', { availableFrom: true }],
      ['array availableFrom', { availableFrom: ['2026-09-19T10:00:00.000Z'] }],
      ['malformed availableUntil', { availableUntil: 'tomorrow-ish' }],
      ['null availableUntil', { availableUntil: null }],
      ['boolean availableUntil', { availableUntil: false }],
      ['empty pickup location', { pickupLocation: '' }],
      ['longitude without latitude', { pickupLongitude: 10 }],
      ['lat without lng', { pickupLatitude: 40 }],
      ['out-of-range latitude', { pickupLatitude: 91, pickupLongitude: 0 }],
      ['out-of-range longitude', { pickupLatitude: 0, pickupLongitude: -181 }],
      ['non-finite latitude', { pickupLatitude: Infinity, pickupLongitude: 0 }],
      ['non-string storage requirement', { storageRequirement: 7 }],
      ['non-string description', { description: { x: 1 } }],
    ];

    it.each(invalidBodies)('rejects %s with 400 and zero writes', async (_label, body) => {
      const { donationUpdateMany, auditCreate, notificationCreate } = mockBackend();
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
      expect(notificationCreate).not.toHaveBeenCalled();
    });

    it('rejects until <= from using the effective window (partial edit)', async () => {
      const existing = baseDonation({ availableFrom: hoursFromNow(1), availableUntil: hoursFromNow(6) });
      mockBackend({ donation: existing });
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({ availableUntil: new Date(existing.availableFrom.getTime() - 60_000).toISOString() });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects availableUntil <= now', async () => {
      mockBackend();
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({ availableFrom: '2020-01-01T00:00:00.000Z', availableUntil: '2020-01-02T00:00:00.000Z' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects unknown/inactive category with 400 and no auto-create', async () => {
      const { categoryFind, donationUpdateMany, auditCreate } = mockBackend({ categoryActive: false });
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({ category: 'Nonexistent' });
      expect(res.status).toBe(400);
      expect(categoryFind).toHaveBeenCalledWith({ where: { name: 'Nonexistent', isActive: true }, select: { id: true } });
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it('does not re-check the category when the edit does not touch it', async () => {
      const { categoryFind, donationUpdateMany } = mockBackend();
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({ quantity: 40 });
      expect(res.status).toBe(200);
      expect(categoryFind).not.toHaveBeenCalled();
      expect(donationUpdateMany).toHaveBeenCalledWith({
        where: { id: 'don-1', providerId: 'user-1', status: { in: ['DRAFT', 'AVAILABLE'] } },
        data: { quantity: 40 },
      });
    });

    it('rejects server-controlled and D-12 image fields (strict schema)', async () => {
      const { donationUpdateMany } = mockBackend();
      const app = createApp();
      for (const body of [
        { status: 'COMPLETED' },
        { providerId: 'other' },
        { organizationId: 'other-org' },
        { id: 'other-id' },
        { createdAt: '2020-01-01T00:00:00.000Z' },
        { updatedAt: '2020-01-01T00:00:00.000Z' },
        { image: 'data:image/png;base64,AAAA' },
        { imageUrl: 'https://example.com/x.png' },
        { proofOfDelivery: 'uploads/proof.png' },
      ]) {
        const res = await request(app)
          .put('/api/donations/don-1')
          .set('Authorization', `Bearer ${token()}`)
          .send(body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects an empty body (no editable fields)', async () => {
      const { donationUpdateMany } = mockBackend();
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({});
      expect(res.status).toBe(400);
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });

    it('service-layer strict validation still applies when the route middleware is bypassed', async () => {
      const { donationUpdateMany } = mockBackend();
      await expect(updateDonation('don-1', 'user-1', {})).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        updateDonation('don-1', 'user-1', { availableFrom: true, foodName: 'x' })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(updateDonation('', 'user-1', { foodName: 'x' })).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('update semantics / version bump', () => {
    it('updates multiple fields together and preserves untouched fields', async () => {
      const { donationUpdateMany } = mockBackend();
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({
          foodName: 'Lentil soup',
          quantity: 50,
          unit: 'portions',
          storageRequirement: 'Refrigerated',
          pickupLatitude: 40.7128,
          pickupLongitude: -74.006,
        });
      expect(res.status).toBe(200);
      expect(donationUpdateMany).toHaveBeenCalledWith({
        where: { id: 'don-1', providerId: 'user-1', status: { in: ['DRAFT', 'AVAILABLE'] } },
        data: {
          foodName: 'Lentil soup',
          quantity: 50,
          unit: 'portions',
          storageRequirement: 'Refrigerated',
          pickupLatitude: 40.7128,
          pickupLongitude: -74.006,
        },
      });
      // Untouched fields keep their persisted values.
      expect(res.body.data.donation.category).toBe('Prepared meals');
      expect(res.body.data.donation.foodType).toBe('Vegetarian');
      expect(res.body.data.donation.pickupLocation).toBe('12 Main St, Springfield');
    });

    it('bumps the server-managed version marker (updatedAt) exactly once and returns it', async () => {
      const before = baseDonation({ updatedAt: new Date('2026-09-19T00:00:00.000Z') });
      mockBackend({ donation: before });
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({ description: 'Now with herbs' });
      expect(res.status).toBe(200);
      expect(new Date(res.body.data.donation.updatedAt).getTime()).toBeGreaterThan(before.updatedAt.getTime());
    });

    it('never lets a client-provided version/updatedAt control the write', async () => {
      const { donationUpdateMany } = mockBackend();
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({ foodName: 'x', version: 999, updatedAt: '2099-01-01T00:00:00.000Z' });
      expect(res.status).toBe(400);
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });

    it('emits exactly one audit event with actor/entity/old/new and does NOT notify', async () => {
      const { auditCreate, notificationCreate } = mockBackend();
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({ foodName: 'Audited soup' });
      expect(res.status).toBe(200);
      expect(auditCreate).toHaveBeenCalledTimes(1);
      const audit = auditCreate.mock.calls[0][0].data;
      expect(audit).toEqual(
        expect.objectContaining({
          userId: 'user-1',
          action: 'DONATION_UPDATED',
          entityType: 'Donation',
          entityId: 'don-1',
        })
      );
      const oldValue = JSON.parse(audit.oldValue as string);
      const newValue = JSON.parse(audit.newValue as string);
      expect(oldValue.foodName).toBe('Vegetable soup');
      expect(newValue.foodName).toBe('Audited soup');
      expect(newValue.updatedAt).not.toBe(oldValue.updatedAt);
      expect(notificationCreate).not.toHaveBeenCalled();
    });

    it('rolls the edit back when audit persistence fails, masking DB details', async () => {
      const { donationUpdateMany, store } = mockBackend({
        auditFailure: true,
        donation: baseDonation({ foodName: 'Original soup' }),
      });
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({ foodName: 'x' });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('AUDIT_PERSIST_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('postgres://');
      expect(donationUpdateMany).toHaveBeenCalledTimes(1);
      // The simulated transaction rolled the donation back — no partial edit.
      expect(store.donation?.foodName).toBe('Original soup');
    });

    it('performs no audit/write on validation or authorization failure', async () => {
      const { auditCreate, donationUpdateMany } = mockBackend({
        donation: baseDonation({ status: 'ACCEPTED' }),
      });
      const app = createApp();
      await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token()}`)
        .send({ foodName: 'x' });
      expect(auditCreate).not.toHaveBeenCalled();
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });
  });
});
