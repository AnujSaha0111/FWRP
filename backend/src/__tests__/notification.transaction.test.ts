import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(() => {
    throw new Error('global Prisma client must not be used inside the transaction helper');
  }),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import { getPrisma } from '../lib/prisma';
import { notificationService } from '../services/notification.service';
import { AppError } from '../middleware/error';
import { runSimulatedTransaction } from './helpers/simulated-transaction';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');

const validInput = {
  userId: 'user-1',
  type: 'DONATION_ACCEPTED' as const,
  title: 'Donation accepted',
  message: 'Your donation was accepted',
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  expect(getPrisma).not.toHaveBeenCalled();
});

describe('BE-NOTIF-04 transactional create + rollback (simulated)', () => {
  it('commits business change and notification atomically on success', async () => {
    const outcome = await runSimulatedTransaction(async (tx) => {
      await tx.business.apply({ donationId: 'd1', status: 'ACCEPTED' });
      const created = await notificationService.create({ ...validInput }, tx.asPersistenceClient());
      return created;
    });

    expect(outcome.error).toBeUndefined();
    expect(outcome.rolledBack).toEqual([]);
    expect(outcome.committed).toHaveLength(2);
    expect(outcome.committed[0]).toEqual({
      store: 'business',
      data: { donationId: 'd1', status: 'ACCEPTED' },
    });
    const staged = outcome.committed[1];
    expect(staged.store).toBe('notification');
    const data = staged.data;
    expect(data.userId).toBe('user-1');
    expect(data.type).toBe('DONATION_ACCEPTED');
    expect(data.title).toBe('Donation accepted');
    expect(data).toHaveProperty('entityType');
    expect(outcome.result).toMatchObject({ userId: 'user-1', isRead: false });
  });

  it('discards the staged notification when the business transaction fails (no orphans)', async () => {
    const outcome = await runSimulatedTransaction(async (tx) => {
      await tx.business.apply({ donationId: 'd1', status: 'ACCEPTED' });
      await notificationService.create({ ...validInput }, tx.asPersistenceClient());
      throw new AppError(409, 'ALREADY_CLAIMED', 'Donation was already claimed');
    });

    expect(outcome.error).toBeInstanceOf(AppError);
    expect((outcome.error as AppError).code).toBe('ALREADY_CLAIMED');
    // Nothing committed: neither the business change nor the notification survives.
    expect(outcome.committed).toEqual([]);
    expect(outcome.result).toBeUndefined();
    expect(outcome.rolledBack).toHaveLength(2);
    expect(outcome.rolledBack.map((w) => w.store).sort()).toEqual(['business', 'notification']);
  });

  it('discards earlier staged writes when failure happens before the notification write', async () => {
    const outcome = await runSimulatedTransaction(async (tx) => {
      await tx.business.apply({ donationId: 'd1', status: 'ACCEPTED' });
      throw new Error('invariant check failed');
    });

    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.committed).toEqual([]);
    expect(outcome.rolledBack).toHaveLength(1);
    expect(outcome.rolledBack[0].store).toBe('business');
  });

  it('rolls back staged business writes when notification validation fails inside the transaction', async () => {
    const outcome = await runSimulatedTransaction(async (tx) => {
      await tx.business.apply({ donationId: 'd1', status: 'ACCEPTED' });
      await notificationService.create({ ...validInput, title: '' }, tx.asPersistenceClient());
    });

    expect(outcome.error).toBeInstanceOf(AppError);
    expect((outcome.error as AppError).code).toBe('VALIDATION_ERROR');
    expect(outcome.committed).toEqual([]);
    expect(outcome.rolledBack).toHaveLength(1);
    expect(outcome.rolledBack[0].store).toBe('business');
  });

  it('notification migration ordering: table+enum established in init, untouched by CHECKs migration', () => {
    const dir = path.join(backendDir, 'prisma', 'migrations');
    const entries = fs.readdirSync(dir).sort();
    expect(entries).toEqual([
      '20260831000001_init',
      '20260831000002_add_check_constraints',
      '20260903000003_org_notification_types',
      // REQ-06 (authoritative): additive requirement-history migration.
      '20260920000004_requirement_history',
      // REQ-07 (authoritative): additive RequirementHistoryAction CANCEL value.
      '20260920000005_requirement_history_cancel',
      // REQ-08 (authoritative): additive Allocation representation.
      '20260920000006_allocation',
      // LOG-01/DELCONF (authoritative): additive volunteer availability + delivery fields.
      '20261103000007_logistics',
      // NOTIF-05/06 (authoritative): additive notification entity + email outbox columns.
      '20261103000008_notification_entity_outbox',
      // SEC/ADMIN (authoritative): additive reset tokens, session version, incidents, settings.
      '20261103000009_admin_security',
    ]);
    const init = fs.readFileSync(path.join(dir, entries[0], 'migration.sql'), 'utf8');
    const checks = fs.readFileSync(path.join(dir, entries[1], 'migration.sql'), 'utf8');
    // Forward order: notification schema lands in the first migration.
    expect(init).toContain('CREATE TYPE "NotificationType"');
    expect(init).toContain('CREATE TABLE "notifications"');
    expect(init).toContain('notifications_user_id_is_read_created_at_idx');
    // The second (CHECK constraints) migration does not alter notification state.
    expect(checks).not.toContain('notifications');
    expect(checks).not.toContain('NotificationType');
  });
});
