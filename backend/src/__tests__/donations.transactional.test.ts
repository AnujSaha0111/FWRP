import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { createDonation } from '../services/donations.service';

// DON-13: create-level transactional audit/notification checks. DON-01 requires
// creation + DONATION_CREATED audit + DONATION_CREATED notification to commit in
// the SAME transaction. update/cancel/override already have rollback tests; this
// closes the create gap: an audit or notification persistence failure must roll
// the donation insert back entirely (no partial state).

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

function mockBackend(opts: { auditFailure?: boolean; notificationFailure?: boolean } = {}) {
  const store: { donations: Array<Record<string, unknown>> } = { donations: [] };
  const userFind = vi.fn(async () => ({ id: 'user-1', role: 'PROVIDER', status: 'ACTIVE' }));
  const categoryFind = vi.fn(async () => ({ id: 'cat-1' }));
  let seq = 0;
  const donationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    seq += 1;
    const row = { id: `don-${seq}`, status: 'AVAILABLE', ...args.data };
    store.donations.push(row);
    return row;
  });
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    if (opts.auditFailure) throw new Error('AUDIT INSERT failed postgresql://u:p@h/db');
    return { id: 'audit-1', ...args.data };
  });
  const notificationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => {
    if (opts.notificationFailure) throw new Error('NOTIFICATION INSERT failed postgresql://u:p@h/db');
    return { id: 'notif-1', ...args.data };
  });

  const tx = {
    category: { findFirst: categoryFind },
    donation: { create: donationCreate },
    auditLog: { create: auditCreate },
    notification: { create: notificationCreate },
  };
  // Simulated transaction with rollback: a throw discards all staged writes.
  const $transaction = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
    const snapshot = store.donations.map((d) => ({ ...d }));
    try {
      return await fn(tx);
    } catch (err) {
      store.donations.splice(0, store.donations.length, ...snapshot);
      throw err;
    }
  });

  vi.mocked(getPrisma).mockReturnValue({
    user: { findUnique: userFind },
    $transaction,
  } as unknown as PrismaClient);

  return { store, userFind, categoryFind, donationCreate, auditCreate, notificationCreate, $transaction };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DON-13 create transactional integrity', () => {
  it('rolls back the donation and skips the notification when audit persistence fails', async () => {
    const { store, auditCreate, notificationCreate } = mockBackend({ auditFailure: true });
    await expect(createDonation('user-1', validBody())).rejects.toMatchObject({
      statusCode: 500,
      code: 'AUDIT_PERSIST_FAILED',
    });
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(notificationCreate).not.toHaveBeenCalled();
    // No partial donation persisted.
    expect(store.donations).toHaveLength(0);
  });

  it('rolls back the donation and the audit when notification persistence fails', async () => {
    const { store, donationCreate, auditCreate, notificationCreate } = mockBackend({
      notificationFailure: true,
    });
    await expect(createDonation('user-1', validBody())).rejects.toMatchObject({
      statusCode: 500,
      code: 'NOTIFICATION_ERROR',
    });
    expect(donationCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(notificationCreate).toHaveBeenCalledTimes(1);
    // Both the donation insert and the audit insert rolled back.
    expect(store.donations).toHaveLength(0);
  });

  it('masks persistence failures without leaking SQL/DSN details', async () => {
    mockBackend({ notificationFailure: true });
    try {
      await createDonation('user-1', validBody());
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as { statusCode?: number }).statusCode).toBe(500);
      expect(JSON.stringify(e)).not.toContain('postgresql://');
    }
  });
});
