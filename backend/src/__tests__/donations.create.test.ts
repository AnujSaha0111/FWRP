import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database (same convention as
// donations.accept.test.ts / ORG-05).
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../app';
import { createDonation } from '../services/donations.service';
import { signAccessToken } from '../utils/jwt';

// DON-01: provider-only donation creation. Ownership comes only from the
// session + server-side user row; the strict body schema rejects spoofing;
// FR-16 window + quantity invariants; category checked against active rows;
// creation + audit + notification commit atomically.

function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'pablo@example.com',
    role: 'PROVIDER',
    status: 'ACTIVE',
    ...overrides,
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    foodName: 'Vegetable soup',
    category: 'Prepared meals',
    foodType: 'Vegetarian',
    quantity: 25,
    unit: 'meals',
    availableFrom: '2099-01-01T10:00:00.000Z',
    availableUntil: '2099-01-01T18:00:00.000Z',
    pickupLocation: '12 Main St, Springfield',
    ...overrides,
  };
}

interface Backend {
  userFind: ReturnType<typeof vi.fn>;
  categoryFind: ReturnType<typeof vi.fn>;
  donationCreate: ReturnType<typeof vi.fn>;
  auditCreate: ReturnType<typeof vi.fn>;
  notificationCreate: ReturnType<typeof vi.fn>;
}

function mockBackend(user: Record<string, unknown> | null, opts: { categoryActive?: boolean } = {}) {
  const userFind = vi.fn(async () => user);
  const categoryFind = vi.fn(async () => (opts.categoryActive === false ? null : { id: 'cat-1' }));
  let donationCounter = 0;
  const donationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    donationCounter += 1;
    return {
      id: `don-created-${donationCounter}`,
      providerId: user?.id ?? 'user-1',
      status: 'AVAILABLE',
      createdAt: new Date('2026-09-19T08:00:00.000Z'),
      updatedAt: new Date('2026-09-19T08:00:00.000Z'),
      matches: [],
      deliveries: [],
      provider: undefined,
      ...args.data,
    };
  });
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'audit-1',
    ...args.data,
  }));
  const notificationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'notif-1',
    isRead: false,
    ...args.data,
  }));
  const tx = {
    category: { findFirst: categoryFind },
    donation: { create: donationCreate },
    auditLog: { create: auditCreate },
    notification: { create: notificationCreate },
  };
  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: userFind },
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient);
  return { userFind, categoryFind, donationCreate, auditCreate, notificationCreate } as Backend;
}

function providerToken(role = 'PROVIDER', organizationId: string | null = 'org-1'): string {
  return signAccessToken({ id: 'user-1', email: 'pablo@example.com', role, organizationId });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DON-01 donation creation', () => {
  it('creates a donation for a provider, assigns session ownership, initial status AVAILABLE', async () => {
    const { donationCreate } = mockBackend(providerRow());
    const app = createApp();
    const res = await request(app)
      .post('/api/donations')
      .set('Authorization', `Bearer ${providerToken()}`)
      .send(validBody());
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const donation = res.body.data.donation;
    expect(donation.providerId).toBe('user-1');
    expect(donation.status).toBe('AVAILABLE');
    expect(donation.foodName).toBe('Vegetable soup');
    expect(donation.category).toBe('Prepared meals');
    expect(donation.quantity).toBe(25);
    expect(donation.unit).toBe('meals');
    expect(donation.availableFrom).toBe('2099-01-01T10:00:00.000Z');
    expect(donation.availableUntil).toBe('2099-01-01T18:00:00.000Z');
    expect(donation.pickupLocation).toBe('12 Main St, Springfield');
    // Relations are never leaked
    expect(donation.matches).toBeUndefined();
    expect(donation.provider).toBeUndefined();
  });

  it('derives providerId in the service from the DB-loaded caller, not the body', async () => {
    const { donationCreate } = mockBackend(providerRow());
    const app = createApp();
    const res = await request(app)
      .post('/api/donations')
      .set('Authorization', `Bearer ${providerToken()}`)
      .send(validBody());
    expect(res.status).toBe(201);
    expect(donationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ providerId: 'user-1', status: 'AVAILABLE' }),
    });
  });

  it('persists optional fields when provided', async () => {
    const { donationCreate } = mockBackend(providerRow());
    const app = createApp();
    await request(app)
      .post('/api/donations')
      .set('Authorization', `Bearer ${providerToken()}`)
      .send(
        validBody({
          pickupLatitude: 40.7128,
          pickupLongitude: -74.006,
          storageRequirement: 'Refrigerated',
          description: 'Fresh from today',
        })
      );
    expect(donationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pickupLatitude: 40.7128,
        pickupLongitude: -74.006,
        storageRequirement: 'Refrigerated',
        description: 'Fresh from today',
      }),
    });
  });

  it('commits audit log and DONATION_CREATED notification in the same transaction', async () => {
    const { donationCreate, auditCreate, notificationCreate } = mockBackend(providerRow());
    const result = await createDonation('user-1', validBody());
    expect(result.donation.id).toBe('don-created-1');
    expect(donationCreate).toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'DONATION_CREATED',
        entityType: 'Donation',
        entityId: 'don-created-1',
        userId: 'user-1',
      }),
    });
    expect(notificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        type: 'DONATION_CREATED',
      }),
    });
  });

  it.each([
    ['quantity', validBody({ quantity: 0 })],
    ['negative quantity', validBody({ quantity: -3 })],
    ['missing food name', validBody({ foodName: '' })],
    ['missing unit', validBody({ unit: '   ' })],
    ['missing category', validBody({ category: '' })],
    ['pickup until <= from', validBody({ availableFrom: '2026-09-19T18:00:00.000Z', availableUntil: '2026-09-19T10:00:00.000Z' })],
    ['available_until in the past', validBody({ availableFrom: '2020-01-01T10:00:00.000Z', availableUntil: '2020-01-02T18:00:00.000Z' })],
    ['latitude without longitude', validBody({ pickupLatitude: 40 })],
    ['out-of-range latitude', validBody({ pickupLatitude: 91, pickupLongitude: 0 })],
    ['non-numeric quantity', validBody({ quantity: 'lots' })],
  ])('rejects invalid payload: %s with 400 and no writes', async (_label, body) => {
    const { donationCreate, auditCreate, notificationCreate } = mockBackend(providerRow());
    const app = createApp();
    const res = await request(app)
      .post('/api/donations')
      .set('Authorization', `Bearer ${providerToken()}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(donationCreate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it('rejects malformed/unknown timestamps with 400', async () => {
    const { donationCreate } = mockBackend(providerRow());
    const app = createApp();
    const res = await request(app)
      .post('/api/donations')
      .set('Authorization', `Bearer ${providerToken()}`)
      .send(validBody({ availableUntil: 'not-a-date' }));
    expect(res.status).toBe(400);
    expect(donationCreate).not.toHaveBeenCalled();
  });

  it('rejects an unknown or inactive category with 400 and zero writes', async () => {
    const { categoryFind, donationCreate, auditCreate, notificationCreate } = mockBackend(
      providerRow(),
      { categoryActive: false }
    );
    const app = createApp();
    const res = await request(app)
      .post('/api/donations')
      .set('Authorization', `Bearer ${providerToken()}`)
      .send(validBody({ category: 'Nonexistent category' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(categoryFind).toHaveBeenCalledWith({
      where: { name: 'Nonexistent category', isActive: true },
      select: { id: true },
    });
    expect(donationCreate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it('rejects non-provider roles with 403 and zero writes', async () => {
    const { donationCreate } = mockBackend(providerRow());
    const app = createApp();
    for (const role of ['RECIPIENT', 'VOLUNTEER', 'ADMIN'] as const) {
      const res = await request(app)
        .post('/api/donations')
        .set('Authorization', `Bearer ${providerToken(role)}`)
        .send(validBody());
      expect(res.status).toBe(403);
    }
    expect(donationCreate).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests with 401', async () => {
    mockBackend(providerRow());
    const app = createApp();
    const res = await request(app).post('/api/donations').send(validBody());
    expect(res.status).toBe(401);
  });

  it('service-level defense-in-depth rejects non-provider callers', async () => {
    const { donationCreate } = mockBackend({ ...providerRow(), role: 'RECIPIENT' });
    await expect(createDonation('user-1', validBody())).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(donationCreate).not.toHaveBeenCalled();
  });

  it('service enforces the window and quantity rules even behind the route', async () => {
    mockBackend(providerRow());
    await expect(createDonation('user-1', validBody({ quantity: 0 }))).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      createDonation('user-1', validBody({ availableFrom: '2026-09-19T18:00:00.000Z', availableUntil: '2026-09-19T10:00:00.000Z' }))
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('client-supplied providerId/organizationId/status are stripped/rejected — ownership and status cannot be spoofed', async () => {
    const { donationCreate } = mockBackend(providerRow());
    const app = createApp();
    const res = await request(app)
      .post('/api/donations')
      .set('Authorization', `Bearer ${providerToken()}`)
      .send(
        validBody({
          providerId: 'attacker-org',
          organizationId: 'attacker-org',
          status: 'COMPLETED',
          provider: { id: 'attacker' },
        })
      );
    expect(res.status).toBe(400);
    expect(donationCreate).not.toHaveBeenCalled();
  });

  it('suspended provider callers are rejected with 401 and zero writes', async () => {
    const { donationCreate } = mockBackend(providerRow({ status: 'SUSPENDED' }));
    const app = createApp();
    const res = await request(app)
      .post('/api/donations')
      .set('Authorization', `Bearer ${providerToken()}`)
      .send(validBody());
    expect(res.status).toBe(401);
    expect(donationCreate).not.toHaveBeenCalled();
  });
});
