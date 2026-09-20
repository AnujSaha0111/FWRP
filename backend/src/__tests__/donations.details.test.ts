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
import { getDonation } from '../services/donations.service';
import { signAccessToken } from '../utils/jwt';

// DON-05: read-only donation details + the recorded visibility decision
// (TASK_CHECKLIST.md §"DON-05 Donation Detail Visibility Decision"):
//   401 unauthenticated; 404 unknown id; 403 otherwise.
//   owning provider: any status. ADMIN: any status. RECIPIENT: only VERIFIED
//   org + (AVAILABLE|MATCHED). Unrelated provider / VOLUNTEER: 403.
//   Provider projection = { id, name, organization{ id, name, verificationStatus } | null }.
//   time_remaining = BE-09 timeRemainingMs (ms, 0 at/after available_until).
//   Pure read: no update/audit/notification.

const ALL_STATUSES = [
  'DRAFT',
  'AVAILABLE',
  'MATCHED',
  'ACCEPTED',
  'PICKUP_ASSIGNED',
  'PICKED_UP',
  'IN_TRANSIT',
  'DELIVERED',
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
] as const;

const PROVIDER_VISIBLE_STATUSES = ALL_STATUSES;
const RECIPIENT_VISIBLE_STATUSES = ['AVAILABLE', 'MATCHED'] as const;
const RECIPIENT_BLOCKED_STATUSES = [
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

interface ProjectedDonation {
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
  // Extra sensitive fields deliberately present in the mock DB row to prove the
  // explicit projection strips them.
  provider: {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    passwordHash?: string;
    organization: { id: string; name: string; verificationStatus: string } | null;
  };
}

function donationRow(overrides: Partial<ProjectedDonation> = {}): ProjectedDonation {
  const now = Date.now();
  return {
    id: 'don-1',
    providerId: 'prov-1',
    foodName: 'Vegetable soup',
    category: 'Prepared meals',
    foodType: 'Vegetarian',
    quantity: 25,
    unit: 'meals',
    availableFrom: new Date(now - 60 * 60 * 1000),
    availableUntil: new Date(now + 2 * 60 * 60 * 1000),
    pickupLocation: '12 Main St, Springfield',
    pickupLatitude: null,
    pickupLongitude: null,
    storageRequirement: null,
    description: null,
    status: 'AVAILABLE',
    createdAt: new Date('2026-09-19T00:00:00.000Z'),
    updatedAt: new Date('2026-09-19T00:00:00.000Z'),
    provider: {
      id: 'prov-1',
      name: 'Pablo Provider',
      email: 'pablo@example.com',
      phone: '+1 555 000 1111',
      passwordHash: 'bcrypt-hash-placeholder',
      organization: { id: 'prov-org', name: 'Provider Kitchen', verificationStatus: 'PENDING' },
    },
    ...overrides,
  };
}

interface CallerOptions {
  id?: string;
  role?: string;
  status?: string;
  org?: { id: string; verificationStatus: string } | null;
}

function callerRow(opts: CallerOptions = {}) {
  return {
    id: opts.id ?? 'user-1',
    role: opts.role ?? 'PROVIDER',
    status: opts.status ?? 'ACTIVE',
    organization: opts.org === undefined ? { id: 'org-1', verificationStatus: 'VERIFIED' } : opts.org,
  };
}

function mockBackend(caller: ReturnType<typeof callerRow> | null, donation: ProjectedDonation | null) {
  const userFind = vi.fn(async () => caller);
  const donationFind = vi.fn(async () => donation);
  const donationUpdate = vi.fn();
  const donationUpdateMany = vi.fn();
  const auditCreate = vi.fn();
  const notificationCreate = vi.fn();
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: userFind },
    donation: {
      findUnique: donationFind,
      update: donationUpdate,
      updateMany: donationUpdateMany,
    },
    auditLog: { create: auditCreate },
    notification: { create: notificationCreate },
  } as unknown as PrismaClient);
  return { userFind, donationFind, donationUpdate, donationUpdateMany, auditCreate, notificationCreate };
}

function token(role: string, id: string): string {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId: 'org-1' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DON-05 donation details', () => {
  describe('authentication / lookup', () => {
    it('rejects unauthenticated requests with 401', async () => {
      mockBackend(callerRow(), donationRow());
      const app = createApp();
      const res = await request(app).get('/api/donations/don-1');
      expect(res.status).toBe(401);
    });

    it('returns 404 for an unknown donation', async () => {
      mockBackend(callerRow(), null);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/ghost')
        .set('Authorization', `Bearer ${token('PROVIDER', 'user-1')}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('service rejects an empty donation id with 400', async () => {
      mockBackend(callerRow(), donationRow());
      await expect(getDonation('', 'user-1')).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('owning provider', () => {
    it.each(PROVIDER_VISIBLE_STATUSES)('can view their own donation in status %s', async (status) => {
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), donationRow({ status }));
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.donation.status).toBe(status);
    });

    it('returns 200 even when the provider has no organization', async () => {
      mockBackend(
        callerRow({ id: 'prov-1', role: 'PROVIDER', org: null }),
        donationRow({ status: 'CANCELLED' })
      );
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      expect(res.status).toBe(200);
    });
  });

  describe('unrelated provider / volunteer', () => {
    it('returns 403 (not 404) for a provider who does not own the donation', async () => {
      mockBackend(callerRow({ id: 'user-2', role: 'PROVIDER' }), donationRow({ providerId: 'prov-1' }));
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'user-2')}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it.each(ALL_STATUSES)('returns 403 for a volunteer on status %s', async (status) => {
      mockBackend(callerRow({ id: 'vol-1', role: 'VOLUNTEER', org: null }), donationRow({ status }));
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('VOLUNTEER', 'vol-1')}`);
      expect(res.status).toBe(403);
    });
  });

  describe('admin', () => {
    it.each(ALL_STATUSES)('can view any donation in status %s', async (status) => {
      mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN', org: null }), donationRow({ status }));
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(res.status).toBe(200);
      expect(res.body.data.donation.status).toBe(status);
    });
  });

  describe('recipient verification-aware visibility', () => {
    it.each(RECIPIENT_VISIBLE_STATUSES)('VERIFIED recipient can view %s', async (status) => {
      mockBackend(
        callerRow({ id: 'rec-1', role: 'RECIPIENT', org: { id: 'rec-org', verificationStatus: 'VERIFIED' } }),
        donationRow({ status })
      );
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('RECIPIENT', 'rec-1')}`);
      expect(res.status).toBe(200);
      expect(res.body.data.donation.status).toBe(status);
    });

    it.each(RECIPIENT_BLOCKED_STATUSES)('VERIFIED recipient cannot view %s (403)', async (status) => {
      mockBackend(
        callerRow({ id: 'rec-1', role: 'RECIPIENT', org: { id: 'rec-org', verificationStatus: 'VERIFIED' } }),
        donationRow({ status })
      );
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('RECIPIENT', 'rec-1')}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it.each(['PENDING', 'UNDER_REVIEW', 'REJECTED'] as const)(
      'recipient with organization %s gets 403 even for AVAILABLE',
      async (verificationStatus) => {
        mockBackend(
          callerRow({ id: 'rec-1', role: 'RECIPIENT', org: { id: 'rec-org', verificationStatus } }),
          donationRow({ status: 'AVAILABLE' })
        );
        const app = createApp();
        const res = await request(app)
          .get('/api/donations/don-1')
          .set('Authorization', `Bearer ${token('RECIPIENT', 'rec-1')}`);
        expect(res.status).toBe(403);
      }
    );

    it('recipient without an organization gets 403', async () => {
      mockBackend(
        callerRow({ id: 'rec-1', role: 'RECIPIENT', org: null }),
        donationRow({ status: 'AVAILABLE' })
      );
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('RECIPIENT', 'rec-1')}`);
      expect(res.status).toBe(403);
    });
  });

  describe('response shape / projection / time_remaining', () => {
    it('returns the persisted status, donation scalars and the exact provider projection', async () => {
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), donationRow({ status: 'ACCEPTED' }));
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      expect(res.status).toBe(200);
      const d = res.body.data.donation;
      expect(d.id).toBe('don-1');
      expect(d.status).toBe('ACCEPTED');
      expect(d.foodName).toBe('Vegetable soup');
      expect(d.quantity).toBe(25);
      expect(d.provider).toEqual({
        id: 'prov-1',
        name: 'Pablo Provider',
        organization: { id: 'prov-org', name: 'Provider Kitchen', verificationStatus: 'PENDING' },
      });
    });

    it('never exposes email/phone/passwordHash or extra provider fields', async () => {
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), donationRow());
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('pablo@example.com');
      expect(serialized).not.toContain('+1 555 000 1111');
      expect(serialized).not.toContain('bcrypt-hash-placeholder');
      expect(serialized).not.toContain('passwordHash');
      expect(Object.keys(res.body.data.donation.provider).sort()).toEqual(['id', 'name', 'organization']);
    });

    it('queries with the constrained provider select (no email/phone/passwordHash)', async () => {
      const { donationFind } = mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), donationRow());
      const app = createApp();
      await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      const select = donationFind.mock.calls[0][0].select as Record<string, unknown>;
      expect(select.provider).toEqual({
        select: {
          id: true,
          name: true,
          organization: { select: { id: true, name: true, verificationStatus: true } },
        },
      });
      expect(select.email).toBeUndefined();
      expect(select.phone).toBeUndefined();
      expect(select.passwordHash).toBeUndefined();
    });

    it('returns provider organization null when the provider has no organization', async () => {
      mockBackend(
        callerRow({ id: 'prov-1', role: 'PROVIDER' }),
        donationRow({
          provider: { id: 'prov-1', name: 'Solo Provider', organization: null },
        })
      );
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      expect(res.status).toBe(200);
      expect(res.body.data.donation.provider).toEqual({
        id: 'prov-1',
        name: 'Solo Provider',
        organization: null,
      });
    });

    it('computes time_remaining in ms during availability', async () => {
      const now = Date.now();
      const availableUntil = new Date(now + 2 * 60 * 60 * 1000);
      mockBackend(
        callerRow({ id: 'prov-1', role: 'PROVIDER' }),
        donationRow({ availableFrom: new Date(now - 60 * 60 * 1000), availableUntil })
      );
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      const remaining = res.body.data.donation.time_remaining;
      expect(typeof remaining).toBe('number');
      expect(remaining).toBeGreaterThan(0);
      expect(Math.abs(remaining - 2 * 60 * 60 * 1000)).toBeLessThan(5000);
    });

    it('computes time_remaining before availability (still until available_until)', async () => {
      const now = Date.now();
      const availableUntil = new Date(now + 3 * 60 * 60 * 1000);
      mockBackend(
        callerRow({ id: 'prov-1', role: 'PROVIDER' }),
        donationRow({ availableFrom: new Date(now + 60 * 60 * 1000), availableUntil })
      );
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      const remaining = res.body.data.donation.time_remaining;
      expect(Math.abs(remaining - 3 * 60 * 60 * 1000)).toBeLessThan(5000);
    });

    it('returns time_remaining 0 at/after available_until', async () => {
      const now = Date.now();
      mockBackend(
        callerRow({ id: 'prov-1', role: 'PROVIDER' }),
        donationRow({
          availableFrom: new Date(now - 3 * 60 * 60 * 1000),
          availableUntil: new Date(now - 60 * 1000),
        })
      );
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      expect(res.body.data.donation.time_remaining).toBe(0);
    });
  });

  describe('read-only guarantee', () => {
    it('does not update the donation, write audit, or create notifications', async () => {
      const { donationUpdate, donationUpdateMany, auditCreate, notificationCreate } = mockBackend(
        callerRow({ id: 'prov-1', role: 'PROVIDER' }),
        donationRow({ status: 'AVAILABLE' })
      );
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      expect(res.status).toBe(200);
      // The GET does not mutate EXPIRED/CANCELLED and does not log/notify.
      expect(donationUpdate).not.toHaveBeenCalled();
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
      expect(notificationCreate).not.toHaveBeenCalled();
    });

    it('does not mutate or audit on a rejected view', async () => {
      const { donationUpdateMany, auditCreate, notificationCreate } = mockBackend(
        callerRow({ id: 'rec-1', role: 'RECIPIENT', org: null }),
        donationRow({ status: 'AVAILABLE' })
      );
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('RECIPIENT', 'rec-1')}`);
      expect(res.status).toBe(403);
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
      expect(notificationCreate).not.toHaveBeenCalled();
    });
  });

  describe('security', () => {
    it('masks persistence failures with no SQL/DSN leakage', async () => {
      const app = createApp();
      vi.mocked(getPrisma).mockReturnValue({
        user: { findUnique: vi.fn(async () => callerRow({ id: 'prov-1', role: 'PROVIDER' })) },
        donation: {
          findUnique: vi.fn(async () => {
            throw new Error('SELECT failed postgresql://u:p@h/db');
          }),
        },
      } as unknown as PrismaClient);
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('DONATION_READ_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('postgresql://');
      expect(JSON.stringify(res.body)).not.toContain('SELECT');
    });

    it('does not let a query/body providerId or role spoof visibility', async () => {
      // Caller is an unrelated provider, but sends query/body hints claiming
      // ownership and admin. Identity still comes from the token + DB.
      mockBackend(callerRow({ id: 'user-2', role: 'PROVIDER' }), donationRow({ providerId: 'prov-1' }));
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1?providerId=prov-1&role=ADMIN')
        .set('Authorization', `Bearer ${token('PROVIDER', 'user-2')}`)
        .send({ providerId: 'prov-1', role: 'ADMIN' });
      expect(res.status).toBe(403);
    });
  });
});
