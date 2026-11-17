import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma client — no live database (same convention as
// donations.create.test.ts / ORG-05).
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createApp } from '../createApp';
import { createDonation } from '../services/donations.service';
import { signAccessToken } from '../utils/jwt';

// DON-02: donation validation. DON-01 already proved the happy path, ownership,
// status, auth/role gating, the time-window invariant, coordinate pairing, the
// audit/notification transaction and unknown-field rejection. This suite adds
// the DON-02-specific validation matrix that DON-01 did not pin down, plus the
// D-12 image boundary (image upload remains UNIMPLEMENTED while D-12 is
// unresolved — image payloads are rejected by the strict schema; donation
// creation without any image STILL works).

function providerRow() {
  return { id: 'user-1', email: 'pablo@example.com', role: 'PROVIDER', status: 'ACTIVE' };
}

function inHours(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    foodName: 'Vegetable soup',
    category: 'Prepared meals',
    foodType: 'Vegetarian',
    quantity: 25,
    unit: 'meals',
    availableFrom: inHours(1),
    availableUntil: inHours(6),
    pickupLocation: '12 Main St, Springfield',
    ...overrides,
  };
}

function mockBackend() {
  const userFind = vi.fn(async () => providerRow());
  const categoryFind = vi.fn(async () => ({ id: 'cat-1' }));
  let counter = 0;
  const donationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    counter += 1;
    return {
      id: `don-created-${counter}`,
      providerId: 'user-1',
      status: 'AVAILABLE',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...args.data,
    };
  });
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'audit-1', ...args.data }));
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
  return { donationCreate, auditCreate, notificationCreate };
}

function providerToken(): string {
  return signAccessToken({ id: 'user-1', email: 'pablo@example.com', role: 'PROVIDER', organizationId: 'org-1' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DON-02 donation validation', () => {
  const invalidPayloads: Array<[string, Record<string, unknown>]> = [
    // food name
    ['whitespace-only food name', validBody({ foodName: '   ' })],
    ['over-long food name', validBody({ foodName: 'a'.repeat(501) })],
    ['non-string food name', validBody({ foodName: 123 })],
    // category
    ['whitespace-only category', validBody({ category: '  ' })],
    ['over-long category', validBody({ category: 'a'.repeat(201) })],
    // food type
    ['missing food type', validBody({ foodType: '' })],
    ['non-string food type', validBody({ foodType: ['Vegetarian'] })],
    // quantity
    ['boolean quantity', validBody({ quantity: true })],
    ['null quantity', validBody({ quantity: null })],
    ['array quantity', validBody({ quantity: [5] })],
    // unit
    ['non-string unit', validBody({ unit: 12 })],
    ['over-long unit', validBody({ unit: 'a'.repeat(101) })],
    // available_from / available_until (strict DON-02 date parsing)
    ['null available_from', validBody({ availableFrom: null })],
    ['boolean available_from', validBody({ availableFrom: true })],
    ['empty-string available_from', validBody({ availableFrom: '' })],
    ['array available_from', validBody({ availableFrom: ['2026-09-19T10:00:00.000Z'] })],
    ['malformed available_from', validBody({ availableFrom: '19/09/2026' })],
    ['null available_until', validBody({ availableUntil: null })],
    ['boolean available_until', validBody({ availableUntil: false })],
    ['array available_until', validBody({ availableUntil: ['2026-09-19T18:00:00.000Z'] })],
    ['malformed available_until', validBody({ availableUntil: 'tomorrow-ish' })],
    // pickup location / coordinates
    ['missing pickup location', validBody({ pickupLocation: '   ' })],
    ['non-string pickup location', validBody({ pickupLocation: 42 })],
    ['longitude without latitude', validBody({ pickupLongitude: 10 })],
    ['null longitude', validBody({ pickupLatitude: 40, pickupLongitude: null })],
    ['out-of-range longitude', validBody({ pickupLatitude: 40, pickupLongitude: -181 })],
    // storage requirement / description
    ['non-string storage requirement', validBody({ storageRequirement: 4 })],
    ['over-long storage requirement', validBody({ storageRequirement: 'a'.repeat(501) })],
    ['non-string description', validBody({ description: { text: 'x' } })],
    ['over-long description', validBody({ description: 'a'.repeat(10001) })],
  ];

  it.each(invalidPayloads)('rejects invalid payload: %s with 400 and zero writes', async (_label, body) => {
    const { donationCreate, auditCreate, notificationCreate } = mockBackend();
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

  it('rejects server-controlled/unknown fields, including image payloads, while D-12 is unresolved', async () => {
    const { donationCreate } = mockBackend();
    const app = createApp();
    for (const body of [
      validBody({ providerId: 'someone-else' }),
      validBody({ organizationId: 'other-org' }),
      validBody({ status: 'COMPLETED' }),
      validBody({ image: 'data:image/png;base64,AAAA' }),
      validBody({ imageUrl: 'https://example.com/food.png' }),
      validBody({ proofOfDelivery: 'uploads/proof.png' }),
    ]) {
      const res = await request(app)
        .post('/api/donations')
        .set('Authorization', `Bearer ${providerToken()}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(donationCreate).not.toHaveBeenCalled();
  });

  it('accepts boundary-length valid fields and still creates the donation successfully without any image', async () => {
    const { donationCreate, auditCreate, notificationCreate } = mockBackend();
    const app = createApp();
    const res = await request(app)
      .post('/api/donations')
      .set('Authorization', `Bearer ${providerToken()}`)
      .send(
        validBody({
          foodName: 'a'.repeat(500),
          category: 'Prepared meals',
          foodType: 'b'.repeat(200),
          quantity: 0.5,
          unit: 'c'.repeat(100),
          pickupLocation: 'd'.repeat(500),
          storageRequirement: 'e'.repeat(500),
          description: 'f'.repeat(10000),
        })
      );
    expect(res.status).toBe(201);
    expect(res.body.data.donation.status).toBe('AVAILABLE');
    expect(donationCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(notificationCreate).toHaveBeenCalledTimes(1);
  });

  it('accepts valid epoch-number dates and converts them (no boolean/null/array coercion)', async () => {
    const { donationCreate } = mockBackend();
    const app = createApp();
    const from = Date.now() + 60 * 60 * 1000;
    const until = Date.now() + 5 * 60 * 60 * 1000;
    const res = await request(app)
      .post('/api/donations')
      .set('Authorization', `Bearer ${providerToken()}`)
      .send(validBody({ availableFrom: from, availableUntil: until }));
    expect(res.status).toBe(201);
    const data = donationCreate.mock.calls[0][0].data;
    expect((data.availableFrom as Date).getTime()).toBe(from);
    expect((data.availableUntil as Date).getTime()).toBe(until);
  });

  it('validates strictly in the service layer too (bypassing the route middleware) with zero writes', async () => {
    const { donationCreate, auditCreate } = mockBackend();
    await expect(createDonation('user-1', validBody({ availableFrom: null }))).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(createDonation('user-1', validBody({ availableUntil: true }))).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(createDonation('user-1', validBody({ foodType: '   ' }))).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      createDonation('user-1', validBody({ pickupLatitude: Infinity, pickupLongitude: 0 }))
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(donationCreate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('service accepts real Date objects for the availability window', async () => {
    const { donationCreate } = mockBackend();
    const result = await createDonation(
      'user-1',
      validBody({
        availableFrom: new Date(Date.now() + 60 * 60 * 1000),
        availableUntil: new Date(Date.now() + 5 * 60 * 60 * 1000),
      })
    );
    expect(result.donation.status).toBe('AVAILABLE');
    expect(donationCreate).toHaveBeenCalledTimes(1);
  });
});
