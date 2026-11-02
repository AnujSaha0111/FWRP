import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the global Prisma singleton so tests prove the supplied tx handle is
// used instead of the global client — no live DB required.
vi.mock('../lib/prisma', () => ({
  getPrisma: vi.fn(),
  getPrismaIfConfigured: vi.fn(() => null),
}));

import { getPrisma } from '../lib/prisma';
import {
  notificationService,
  createNotification,
  type NotificationPersistenceClient,
} from '../services/notification.service';
import { auditService } from '../services/audit.service';
import { AppError } from '../middleware/error';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notif-1',
    userId: 'user-1',
    type: 'DONATION_CREATED',
    title: 'Donation created',
    message: 'Your donation was created',
    isRead: false,
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    ...overrides,
  };
}

function createMockTx() {
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => row({ ...args.data }));
  const findMany = vi.fn(async () => [row()]);
  const findFirst = vi.fn(async () => row());
  const count = vi.fn(async () => 1);
  const update = vi.fn(async (args: { data: Record<string, unknown> }) => row({ ...args.data }));
  const updateMany = vi.fn(async () => ({ count: 2 }));
  const $transaction = vi.fn();
  const tx = { notification: { create, findMany, findFirst, count, update, updateMany }, $transaction } as unknown as NotificationPersistenceClient & {
    $transaction: ReturnType<typeof vi.fn>;
  };
  return { tx, create, findMany, findFirst, count, update, updateMany, $transaction };
}

const validInput = {
  userId: 'user-1',
  type: 'DONATION_CREATED' as const,
  title: 'Donation created',
  message: 'Your donation was created',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BE-NOTIF-02 create', () => {
  it('creates a notification with the correct Prisma payload', async () => {
    const { tx, create } = createMockTx();
    const result = await notificationService.create({ ...validInput }, tx);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        type: 'DONATION_CREATED',
        title: 'Donation created',
        message: 'Your donation was created',
        entityType: null,
        entityId: null,
      },
    });
    expect(result.id).toBe('notif-1');
    expect(result.isRead).toBe(false);
  });

  it('omits isRead so the model default (false) applies', async () => {
    const { tx, create } = createMockTx();
    await createNotification({ ...validInput }, tx);
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty('isRead');
  });

  it('accepts { transaction } and { tx } bags', async () => {
    const m1 = createMockTx();
    await notificationService.create({ ...validInput }, { transaction: m1.tx });
    expect(m1.create).toHaveBeenCalledTimes(1);
    const m2 = createMockTx();
    await notificationService.create({ ...validInput }, { tx: m2.tx });
    expect(m2.create).toHaveBeenCalledTimes(1);
  });

  it('trims userId/title/message', async () => {
    const { tx, create } = createMockTx();
    await notificationService.create(
      { ...validInput, userId: '  user-1  ', title: '  Hi  ', message: '  Body  ' },
      tx,
    );
    expect(create).toHaveBeenCalledWith({
      data: { userId: 'user-1', type: 'DONATION_CREATED', title: 'Hi', message: 'Body', entityType: null, entityId: null },
    });
  });

  it('persists entityType/entityId for deep links and de-duplication (NOTIF-05)', async () => {
    const { tx, create } = createMockTx();
    await notificationService.create(
      { ...validInput, entityType: 'Donation', entityId: 'd1' },
      tx,
    );
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({ entityType: 'Donation', entityId: 'd1' });
  });

  it('rejects an invalid NotificationType', async () => {
    const { tx, create } = createMockTx();
    try {
      await notificationService.create({ ...validInput, type: 'BOGUS' as never }, tx);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(400);
      expect((e as AppError).code).toBe('VALIDATION_ERROR');
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects missing/empty required fields deterministically', async () => {
    const { tx, create } = createMockTx();
    const bad = [
      { ...validInput, userId: '' },
      { ...validInput, userId: '   ' },
      { ...validInput, title: '' },
      { ...validInput, message: '' },
      { ...validInput, userId: undefined as never },
    ];
    for (const input of bad) {
      try {
        await notificationService.create(input, tx);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).statusCode).toBe(400);
        expect((e as AppError).code).toBe('VALIDATION_ERROR');
      }
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('uses the supplied handle: no global client, no independent transaction', async () => {
    const { tx, create, $transaction } = createMockTx();
    await notificationService.create({ ...validInput }, tx);
    expect(create).toHaveBeenCalledTimes(1);
    expect(getPrisma).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it('falls back to the global client when no handle is supplied', async () => {
    const globalCreate = vi.fn(async (args: { data: Record<string, unknown> }) => row({ ...args.data, id: 'notif-global' }));
    vi.mocked(getPrisma).mockReturnValue({
      notification: { create: globalCreate },
    } as unknown as ReturnType<typeof getPrisma>);
    const result = await notificationService.create({ ...validInput });
    expect(getPrisma).toHaveBeenCalledTimes(1);
    expect(globalCreate).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('notif-global');
  });

  it('maps FK violation to 404 without leaking internals', async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('insert into notifications violates foreign key "notifications_user_id_fkey" DATABASE_URL=postgres://u:p@h/db'), { code: 'P2003' });
    });
    const tx = { notification: { create } } as unknown as NotificationPersistenceClient;
    try {
      await notificationService.create({ ...validInput }, tx);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(404);
      expect((e as AppError).code).toBe('NOT_FOUND');
      const blob = (e as Error).message + JSON.stringify((e as AppError).details ?? '');
      expect(blob).not.toContain('postgres://');
      expect(blob).not.toContain('insert into');
    }
  });

  it('masks generic persistence errors without leaking database internals', async () => {
    const create = vi.fn(async () => {
      throw new Error('Connection postgres://admin:secret@db:5432 failed: SELECT * FROM "notifications" password=hunter2');
    });
    const tx = { notification: { create } } as unknown as NotificationPersistenceClient;
    try {
      await notificationService.create({ ...validInput }, tx);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(500);
      const blob = (e as Error).message + JSON.stringify((e as AppError).details ?? '');
      expect(blob).not.toContain('postgres://');
      expect(blob).not.toContain('hunter2');
      expect(blob).not.toContain('SELECT');
    }
  });
});

describe('BE-NOTIF-02 list/get/unreadCount', () => {
  it('lists notifications scoped to userId, newest first, with pagination envelope', async () => {
    const { tx, findMany, count } = createMockTx();
    const page = await notificationService.list('user-1', { page: 2, limit: 5 }, tx);
    expect(count).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
      skip: 5,
      take: 5,
    });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.page).toBe(2);
    expect(page.limit).toBe(5);
    expect(typeof page.totalPages).toBe('number');
    expect(typeof page.hasNext).toBe('boolean');
    expect(typeof page.hasPrev).toBe('boolean');
    expect(getPrisma).not.toHaveBeenCalled();
  });

  it('caps page size at the shared MAX_LIMIT (100)', async () => {
    const { tx, findMany } = createMockTx();
    await notificationService.list('user-1', { limit: 5000 }, tx);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it('rejects invalid userId for reads without touching the database', async () => {
    const { tx, findMany, findFirst, count } = createMockTx();
    for (const bad of ['', '   ', undefined as never, 123 as never]) {
      await expect(notificationService.list(bad as never, {}, tx)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      await expect(notificationService.get('n1', bad as never, tx)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      await expect(notificationService.unreadCount(bad as never, tx)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    }
    expect(findMany).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('gets a single notification scoped to its owner', async () => {
    const { tx, findFirst } = createMockTx();
    const result = await notificationService.get('notif-1', 'user-1', tx);
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'notif-1', userId: 'user-1' } });
    expect(result.id).toBe('notif-1');
  });

  it('missing or other-user notification yields 404 (no cross-user reads)', async () => {
    const findFirst = vi.fn(async () => null);
    const tx = { notification: { findFirst } } as unknown as NotificationPersistenceClient;
    await expect(notificationService.get('notif-9', 'user-1', tx)).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    await expect(notificationService.get('notif-1', 'user-2', tx)).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('counts unread notifications scoped to userId', async () => {
    const { tx, count } = createMockTx();
    count.mockResolvedValueOnce(3);
    const n = await notificationService.unreadCount('user-1', tx);
    expect(count).toHaveBeenCalledWith({ where: { userId: 'user-1', isRead: false } });
    expect(n).toBe(3);
    expect(getPrisma).not.toHaveBeenCalled();
  });

  it('masks read errors without leaking internals', async () => {
    const findMany = vi.fn(async () => {
      throw new Error('FATAL: password authentication failed for user "dbuser"');
    });
    const tx = { notification: { findMany, count: vi.fn(async () => 0) } } as unknown as NotificationPersistenceClient;
    try {
      await notificationService.list('user-1', {}, tx);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as AppError).statusCode).toBe(500);
      const blob = (e as Error).message + JSON.stringify((e as AppError).details ?? '');
      expect(blob).not.toContain('dbuser');
      expect(blob).not.toContain('password authentication');
    }
  });
});

describe('BE-NOTIF-02 markAsRead/markAllAsRead', () => {
  it('marks a single notification read for its owner', async () => {
    const { tx, findFirst, update } = createMockTx();
    const result = await notificationService.markAsRead('notif-1', 'user-1', tx);
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'notif-1', userId: 'user-1' } });
    expect(update).toHaveBeenCalledWith({ where: { id: 'notif-1' }, data: { isRead: true } });
    expect(result.isRead).toBe(true);
    expect(getPrisma).not.toHaveBeenCalled();
  });

  it('mark-as-read is idempotent for already-read rows', async () => {
    const findFirst = vi.fn(async () => row({ isRead: true }));
    const update = vi.fn(async () => row({ isRead: true }));
    const tx = { notification: { findFirst, update } } as unknown as NotificationPersistenceClient;
    const result = await notificationService.markAsRead('notif-1', 'user-1', tx);
    expect(result.isRead).toBe(true);
  });

  it('mark-as-read on missing or other-user notification yields 404 without updating', async () => {
    const findFirst = vi.fn(async () => null);
    const update = vi.fn();
    const tx = { notification: { findFirst, update } } as unknown as NotificationPersistenceClient;
    await expect(notificationService.markAsRead('notif-9', 'user-1', tx)).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects invalid id/userId for mark-as-read without touching the database', async () => {
    const { tx, findFirst, update } = createMockTx();
    await expect(notificationService.markAsRead('', 'user-1', tx)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    await expect(notificationService.markAsRead('notif-1', '', tx)).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(findFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('marks all unread rows of one user as read (scoped updateMany)', async () => {
    const { tx, updateMany } = createMockTx();
    const result = await notificationService.markAllAsRead('user-1', tx);
    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', isRead: false },
      data: { isRead: true },
    });
    expect(result).toEqual({ count: 2 });
    expect(getPrisma).not.toHaveBeenCalled();
  });
});

describe('BE-NOTIF-02 boundaries', () => {
  it('exposes only the foundation surface (no email/outbox/route helpers)', () => {
    expect(Object.keys(notificationService).sort()).toEqual(
      ['create', 'get', 'list', 'markAllAsRead', 'markAsRead', 'unreadCount'].sort(),
    );
    const svc = notificationService as unknown as Record<string, unknown>;
    for (const banned of ['send', 'sendEmail', 'email', 'outbox', 'enqueue', 'publish', 'remove', 'delete']) {
      expect(svc[banned]).toBeUndefined();
    }
  });

  it('existing audit service behavior remains intact', () => {
    const event = auditService.log({
      actorId: 'user-1',
      action: 'VERIFY',
      entityType: 'Organization',
      entityId: 'org-1',
    });
    expect(event.actor).toBe('user-1');
    expect(typeof auditService.persist).toBe('function');
    expect(auditService.serializeValue(null)).toBeNull();
  });
});
