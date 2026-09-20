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

// DON-11: provider permissions — a consolidated authorization matrix proving
// the behavior already implemented by DON-01..DON-10 (no production change):
// provider mutation is ownership-based; roles are gated; identity comes from
// the session; DON-05 remains authoritative for detail visibility (no
// field-level private-field model is introduced).

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
  provider: { id: string; name: string; organization: { id: string; name: string; verificationStatus: string } | null };
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
    status: 'AVAILABLE',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    provider: { id: 'prov-1', name: 'Pablo Provider', organization: { id: 'prov-org', name: 'Kitchen', verificationStatus: 'PENDING' } },
    ...overrides,
  };
}

interface CallerRow {
  id: string;
  role: string;
  status: string;
  organization: { id: string; verificationStatus: string } | null;
}

function callerRow(opts: { id?: string; role?: string; status?: string; org?: { id: string; verificationStatus: string } | null } = {}): CallerRow {
  return {
    id: opts.id ?? 'prov-1',
    role: opts.role ?? 'PROVIDER',
    status: opts.status ?? 'ACTIVE',
    organization: opts.org === undefined ? { id: 'org-1', verificationStatus: 'VERIFIED' } : opts.org,
  };
}

function mockBackend(caller: CallerRow | null, seed: DonRow[]) {
  const donations = seed.map((d) => ({ ...d }));
  const auditLogs: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];
  let seq = 100;

  const userFind = vi.fn(async () => caller);
  const categoryFind = vi.fn(async () => ({ id: 'cat-1' }));
  const donationFindUnique = vi.fn(async (args: { where: { id: string } }) => {
    const row = donations.find((d) => d.id === args.where.id);
    return row ?? null;
  });
  const donationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    seq += 1;
    const row = {
      id: `don-${seq}`,
      status: 'AVAILABLE',
      createdAt: new Date(),
      updatedAt: new Date(),
      provider: { id: args.data.providerId, name: 'Pablo Provider', organization: null },
      ...args.data,
    } as unknown as DonRow;
    donations.push(row);
    return row;
  });
  const donationUpdateMany = vi.fn(async (args: { where: { id: string; providerId?: string; status?: { in: string[] } }; data: Record<string, unknown> }) => {
    let count = 0;
    for (const d of donations) {
      if (d.id !== args.where.id) continue;
      if (args.where.providerId !== undefined && d.providerId !== args.where.providerId) continue;
      if (args.where.status?.in && !args.where.status.in.includes(d.status)) continue;
      Object.assign(d, args.data);
      count += 1;
    }
    return { count };
  });
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    auditLogs.push(args.data);
    return { id: `audit-${auditLogs.length}`, ...args.data };
  });
  const notificationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    notifications.push(args.data);
    return { id: `notif-${notifications.length}`, ...args.data };
  });

  const tx = {
    category: { findFirst: categoryFind },
    donation: { findUnique: donationFindUnique, create: donationCreate, updateMany: donationUpdateMany },
    auditLog: { create: auditCreate },
    notification: { create: notificationCreate },
  };
  const $transaction = vi.fn(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (t: unknown) => Promise<unknown>)(tx) : Promise.all(arg as Promise<unknown>[])
  );

  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: userFind },
    category: { findFirst: categoryFind },
    donation: { findUnique: donationFindUnique, create: donationCreate, updateMany: donationUpdateMany, count: vi.fn(), findMany: vi.fn() },
    auditLog: { create: auditCreate, findMany: vi.fn(async () => []) },
    notification: { create: notificationCreate },
    $transaction,
  } as unknown as PrismaClient);

  return { donations, auditLogs, notifications, userFind, donationFindUnique, donationCreate, donationUpdateMany, auditCreate, notificationCreate };
}

function token(role: string, id: string): string {
  return signAccessToken({ id, email: `${id}@example.com`, role, organizationId: 'org-1' });
}

function validEditBody(overrides: Record<string, unknown> = {}) {
  return { foodName: 'Updated soup', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DON-11 provider permissions (authorization matrix)', () => {
  describe('A. provider mutation is ownership-based', () => {
    it('lets an authenticated PROVIDER create a donation', async () => {
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), []);
      const app = createApp();
      const res = await request(app)
        .post('/api/donations')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`)
        .send({
          foodName: 'Soup',
          category: 'Prepared meals',
          foodType: 'Vegetarian',
          quantity: 5,
          unit: 'meals',
          availableFrom: '2099-01-01T10:00:00.000Z',
          availableUntil: '2099-01-01T18:00:00.000Z',
          pickupLocation: '12 Main St',
        });
      expect(res.status).toBe(201);
    });

    it('lets a PROVIDER edit their own donation when the state permits', async () => {
      const { donationUpdateMany, donations } = mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), [
        donationRow({ id: 'don-1', providerId: 'prov-1', status: 'AVAILABLE' }),
      ]);
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`)
        .send(validEditBody());
      expect(res.status).toBe(200);
      expect(donationUpdateMany).toHaveBeenCalledWith({
        where: { id: 'don-1', providerId: 'prov-1', status: { in: ['DRAFT', 'AVAILABLE'] } },
        data: { foodName: 'Updated soup' },
      });
      expect(donations.find((d) => d.id === 'don-1')?.foodName).toBe('Updated soup');
    });

    it('forbids editing another provider\'s donation with 403 and zero mutation', async () => {
      const { donationUpdateMany, auditLogs, donations } = mockBackend(
        callerRow({ id: 'prov-2', role: 'PROVIDER' }),
        [donationRow({ id: 'don-1', providerId: 'prov-1', status: 'AVAILABLE' })]
      );
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-2')}`)
        .send(validEditBody());
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(donations[0].foodName).toBe('Vegetable soup');
      expect(auditLogs).toHaveLength(0);
    });

    it('lets a PROVIDER cancel their own cancellable donation', async () => {
      const { donationUpdateMany, donations } = mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), [
        donationRow({ id: 'don-1', providerId: 'prov-1', status: 'AVAILABLE' }),
      ]);
      const app = createApp();
      const res = await request(app)
        .post('/api/donations/don-1/cancel')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      expect(res.status).toBe(200);
      expect(res.body.data.donation.status).toBe('CANCELLED');
      expect(donationUpdateMany).toHaveBeenCalledTimes(1);
      expect(donations[0].status).toBe('CANCELLED');
    });

    it('forbids cancelling another provider\'s donation with 403 and zero mutation', async () => {
      const { donationUpdateMany, auditLogs, donations } = mockBackend(
        callerRow({ id: 'prov-2', role: 'PROVIDER' }),
        [donationRow({ id: 'don-1', providerId: 'prov-1', status: 'AVAILABLE' })]
      );
      const app = createApp();
      const res = await request(app)
        .post('/api/donations/don-1/cancel')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-2')}`);
      expect(res.status).toBe(403);
      expect(donationUpdateMany).not.toHaveBeenCalled();
      expect(donations[0].status).toBe('AVAILABLE');
      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('B. role restrictions', () => {
    it('rejects unauthenticated provider-mutation attempts with 401', async () => {
      mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), [donationRow({ providerId: 'prov-1' })]);
      const app = createApp();
      expect((await request(app).put('/api/donations/don-1').send(validEditBody())).status).toBe(401);
      expect((await request(app).post('/api/donations/don-1/cancel')).status).toBe(401);
      expect((await request(app).post('/api/donations').send(validEditBody())).status).toBe(401);
    });

    it.each(['RECIPIENT', 'VOLUNTEER', 'ADMIN'] as const)(
      'forbids %s from provider edit/cancel routes with 403',
      async (role) => {
        const { donationUpdateMany } = mockBackend(callerRow({ id: 'x-1', role }), [
          donationRow({ id: 'don-1', providerId: 'prov-1' }),
        ]);
        const app = createApp();
        const edit = await request(app)
          .put('/api/donations/don-1')
          .set('Authorization', `Bearer ${token(role, 'x-1')}`)
          .send(validEditBody());
        expect(edit.status).toBe(403);
        const cancel = await request(app)
          .post('/api/donations/don-1/cancel')
          .set('Authorization', `Bearer ${token(role, 'x-1')}`);
        expect(cancel.status).toBe(403);
        expect(donationUpdateMany).not.toHaveBeenCalled();
      }
    );

    it('allows ADMIN to view per DON-05 but not to edit/cancel', async () => {
      mockBackend(callerRow({ id: 'admin-1', role: 'ADMIN', org: null }), [
        donationRow({ id: 'don-1', providerId: 'prov-1', status: 'ACCEPTED' }),
      ]);
      const app = createApp();
      const view = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(view.status).toBe(200);
      const edit = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`)
        .send(validEditBody());
      expect(edit.status).toBe(403);
      const cancel = await request(app)
        .post('/api/donations/don-1/cancel')
        .set('Authorization', `Bearer ${token('ADMIN', 'admin-1')}`);
      expect(cancel.status).toBe(403);
    });

    it.each(['AVAILABLE', 'MATCHED'] as const)(
      'allows a VERIFIED RECIPIENT to view %s per DON-05',
      async (status) => {
        mockBackend(
          callerRow({ id: 'rec-1', role: 'RECIPIENT', org: { id: 'rec-org', verificationStatus: 'VERIFIED' } }),
          [donationRow({ id: 'don-1', providerId: 'prov-1', status })]
        );
        const app = createApp();
        const res = await request(app)
          .get('/api/donations/don-1')
          .set('Authorization', `Bearer ${token('RECIPIENT', 'rec-1')}`);
        expect(res.status).toBe(200);
      }
    );

    it('forbids an unrelated PROVIDER from viewing another provider\'s donation (403, DON-05)', async () => {
      mockBackend(callerRow({ id: 'prov-2', role: 'PROVIDER' }), [
        donationRow({ id: 'don-1', providerId: 'prov-1' }),
      ]);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-2')}`);
      expect(res.status).toBe(403);
    });
  });

  describe('C. identity integrity', () => {
    it('rejects client-supplied identity fields on the edit body (strict schema, zero mutation)', async () => {
      const { donationUpdateMany } = mockBackend(callerRow({ id: 'prov-2', role: 'PROVIDER' }), [
        donationRow({ id: 'don-1', providerId: 'prov-1' }),
      ]);
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-2')}`)
        .send(validEditBody({ providerId: 'prov-1', organizationId: 'prov-org', userId: 'prov-1', status: 'COMPLETED' }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });

    it('derives ownership from the session, not from query parameters', async () => {
      const { donationUpdateMany } = mockBackend(callerRow({ id: 'prov-2', role: 'PROVIDER' }), [
        donationRow({ id: 'don-1', providerId: 'prov-1' }),
      ]);
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1?providerId=prov-1&userId=prov-1&role=PROVIDER')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-2')}`)
        .send(validEditBody());
      expect(res.status).toBe(403);
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });

    it('does not let a spoofed query identity change DON-05 view authorization', async () => {
      mockBackend(callerRow({ id: 'prov-2', role: 'PROVIDER' }), [
        donationRow({ id: 'don-1', providerId: 'prov-1' }),
      ]);
      const app = createApp();
      const res = await request(app)
        .get('/api/donations/don-1?providerId=prov-1&role=ADMIN&userId=prov-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-2')}`);
      expect(res.status).toBe(403);
    });
  });

  describe('D. state interaction (authorization precedes the existing guards)', () => {
    it('authorizes the owner, then rejects a non-editable state with 409 and zero mutation', async () => {
      const { donationUpdateMany } = mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), [
        donationRow({ id: 'don-1', providerId: 'prov-1', status: 'ACCEPTED' }),
      ]);
      const app = createApp();
      const res = await request(app)
        .put('/api/donations/don-1')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`)
        .send(validEditBody());
      expect(res.status).toBe(409);
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects cancelling a non-cancellable (DON-09) status with 409 and zero mutation', async () => {
      const { donationUpdateMany } = mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), [
        donationRow({ id: 'don-1', providerId: 'prov-1', status: 'ACCEPTED' }),
      ]);
      const app = createApp();
      const res = await request(app)
        .post('/api/donations/don-1/cancel')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      expect(res.status).toBe(409);
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown donation without any mutation (edit and cancel)', async () => {
      const { donationUpdateMany } = mockBackend(callerRow({ id: 'prov-1', role: 'PROVIDER' }), []);
      const app = createApp();
      const edit = await request(app)
        .put('/api/donations/ghost')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`)
        .send(validEditBody());
      expect(edit.status).toBe(404);
      const cancel = await request(app)
        .post('/api/donations/ghost/cancel')
        .set('Authorization', `Bearer ${token('PROVIDER', 'prov-1')}`);
      expect(cancel.status).toBe(404);
      expect(donationUpdateMany).not.toHaveBeenCalled();
    });
  });
});
