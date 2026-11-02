import { z } from 'zod';
import type { Notification, PrismaClient } from '@prisma/client';
import { NotificationType } from '@prisma/client';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { getPrisma } from '../lib/prisma';
import { parsePagination, paginate, type PaginationResult } from '../utils/pagination';

// BE-NOTIF-02: central notification service/interface foundation.
// Uses the DB-08 Prisma Notification model only. No email/SMTP here: the email
// outbox lives in notificationDispatch.service.ts (NOTIF-06) and routes in
// routes/notifications.ts (NOTIF-01).

export type NotificationPersistenceClient = Pick<PrismaClient, 'notification'>;

export interface NotificationTxOptions {
  tx?: NotificationPersistenceClient;
  transaction?: NotificationPersistenceClient;
}

export type NotificationTx =
  | NotificationPersistenceClient
  | NotificationTxOptions
  | null
  | undefined;

function resolveNotificationClient(txOrOptions: NotificationTx): NotificationPersistenceClient | null {
  if (!txOrOptions) return null;
  if (typeof (txOrOptions as NotificationPersistenceClient).notification !== 'undefined') {
    return txOrOptions as NotificationPersistenceClient;
  }
  const opts = txOrOptions as NotificationTxOptions;
  return opts.tx ?? opts.transaction ?? null;
}

const MAX_TITLE_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 10000;

const createNotificationSchema = z.object({
  userId: z.string().trim().min(1, 'userId is required').max(255),
  type: z.nativeEnum(NotificationType),
  title: z.string().trim().min(1, 'title is required').max(MAX_TITLE_LENGTH),
  message: z.string().trim().min(1, 'message is required').max(MAX_MESSAGE_LENGTH),
  // NOTIF-05: related record, persisted for deep links and reminder de-duplication.
  entityType: z.string().trim().min(1).max(100).optional(),
  entityId: z.string().trim().min(1).max(255).optional(),
});

export type CreateNotificationInput = z.input<typeof createNotificationSchema>;

export interface ListNotificationsOptions {
  page?: string | number;
  limit?: string | number;
  /** NOTIF-01: only unread rows. */
  unreadOnly?: boolean;
}

export interface MarkAllAsReadResult {
  count: number;
}

function requireUserId(userId: unknown): string {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'userId is required' },
    ]);
  }
  return userId.trim();
}

function requireNotificationId(id: unknown): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'id', message: 'Notification id is required' },
    ]);
  }
  return id.trim();
}

function isPrismaKnownError(err: unknown): err is { code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  );
}

function mapNotificationError(err: unknown, operation: 'create' | 'read' | 'update'): AppError {
  if (err instanceof AppError) return err;
  if (isPrismaKnownError(err)) {
    // P2003: FK violation (create for unknown user). P2025: record not found (update).
    if (err.code === 'P2003') {
      return new AppError(404, 'NOT_FOUND', 'User not found');
    }
    if (err.code === 'P2025') {
      return new AppError(404, 'NOT_FOUND', 'Notification not found');
    }
  }
  // Never leak Prisma/database internals (SQL, constraints, connection info).
  const message =
    operation === 'create'
      ? 'Failed to create notification'
      : operation === 'read'
        ? 'Failed to read notifications'
        : 'Failed to update notification';
  return new AppError(500, 'NOTIFICATION_ERROR', message);
}

// Transaction-safe creation. When the caller supplies its Prisma transaction
// handle, the insert participates in that SAME transaction; this function
// never opens an independent transaction. Without a handle it falls back to
// the global Prisma singleton (BE-NOTIF-04 covers rollback verification).
// isRead is intentionally omitted so the model default (false) applies.
export async function createNotification(
  input: CreateNotificationInput,
  txOrOptions?: NotificationTx,
): Promise<Notification> {
  const parsed = createNotificationSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const client: NotificationPersistenceClient =
    resolveNotificationClient(txOrOptions) ?? getPrisma();
  const { userId, type, title, message, entityType, entityId } = parsed.data;
  try {
    return await client.notification.create({
      data: { userId, type, title, message, entityType: entityType ?? null, entityId: entityId ?? null },
    });
  } catch (err) {
    throw mapNotificationError(err, 'create');
  }
}

// Paginated list scoped to one user, newest first (createdAt desc).
// Served by the (userId, isRead, createdAt) index.
export async function listNotifications(
  userId: string,
  options?: ListNotificationsOptions,
  txOrOptions?: NotificationTx,
): Promise<PaginationResult<Notification>> {
  const ownerId = requireUserId(userId);
  const params = parsePagination({
    page: options?.page,
    limit: options?.limit,
  });
  const client: NotificationPersistenceClient =
    resolveNotificationClient(txOrOptions) ?? getPrisma();
  const where = options?.unreadOnly ? { userId: ownerId, isRead: false } : { userId: ownerId };
  try {
    const [total, items] = await Promise.all([
      client.notification.count({ where }),
      client.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: params.offset,
        take: params.limit,
      }),
    ]);
    return paginate(items, total, params);
  } catch (err) {
    throw mapNotificationError(err, 'read');
  }
}

// Single notification scoped to its owner. Missing and other-user rows both
// yield 404 so IDs cannot be enumerated across users.
export async function getNotification(
  id: string,
  userId: string,
  txOrOptions?: NotificationTx,
): Promise<Notification> {
  const notificationId = requireNotificationId(id);
  const ownerId = requireUserId(userId);
  const client: NotificationPersistenceClient =
    resolveNotificationClient(txOrOptions) ?? getPrisma();
  try {
    const row = await client.notification.findFirst({
      where: { id: notificationId, userId: ownerId },
    });
    if (!row) {
      throw new AppError(404, 'NOT_FOUND', 'Notification not found');
    }
    return row;
  } catch (err) {
    throw mapNotificationError(err, 'read');
  }
}

// Count of unread rows scoped to one user (uses the composite index).
export async function unreadCount(
  userId: string,
  txOrOptions?: NotificationTx,
): Promise<number> {
  const ownerId = requireUserId(userId);
  const client: NotificationPersistenceClient =
    resolveNotificationClient(txOrOptions) ?? getPrisma();
  try {
    return await client.notification.count({ where: { userId: ownerId, isRead: false } });
  } catch (err) {
    throw mapNotificationError(err, 'read');
  }
}

// Idempotent: already-read rows return successfully. Scoped to the owner.
export async function markAsRead(
  id: string,
  userId: string,
  txOrOptions?: NotificationTx,
): Promise<Notification> {
  const notificationId = requireNotificationId(id);
  const ownerId = requireUserId(userId);
  const client: NotificationPersistenceClient =
    resolveNotificationClient(txOrOptions) ?? getPrisma();
  try {
    const existing = await client.notification.findFirst({
      where: { id: notificationId, userId: ownerId },
    });
    if (!existing) {
      throw new AppError(404, 'NOT_FOUND', 'Notification not found');
    }
    return await client.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });
  } catch (err) {
    throw mapNotificationError(err, 'update');
  }
}

// Marks all unread rows of one user as read. Other users are unaffected.
export async function markAllAsRead(
  userId: string,
  txOrOptions?: NotificationTx,
): Promise<MarkAllAsReadResult> {
  const ownerId = requireUserId(userId);
  const client: NotificationPersistenceClient =
    resolveNotificationClient(txOrOptions) ?? getPrisma();
  try {
    const result = await client.notification.updateMany({
      where: { userId: ownerId, isRead: false },
      data: { isRead: true },
    });
    return { count: result.count };
  } catch (err) {
    throw mapNotificationError(err, 'update');
  }
}

export interface NotificationService {
  create(input: CreateNotificationInput, txOrOptions?: NotificationTx): Promise<Notification>;
  list(
    userId: string,
    options?: ListNotificationsOptions,
    txOrOptions?: NotificationTx,
  ): Promise<PaginationResult<Notification>>;
  get(id: string, userId: string, txOrOptions?: NotificationTx): Promise<Notification>;
  unreadCount(userId: string, txOrOptions?: NotificationTx): Promise<number>;
  markAsRead(id: string, userId: string, txOrOptions?: NotificationTx): Promise<Notification>;
  markAllAsRead(userId: string, txOrOptions?: NotificationTx): Promise<MarkAllAsReadResult>;
}

export const notificationService: NotificationService = {
  create: (input, txOrOptions) => createNotification(input, txOrOptions),
  list: (userId, options, txOrOptions) => listNotifications(userId, options, txOrOptions),
  get: (id, userId, txOrOptions) => getNotification(id, userId, txOrOptions),
  unreadCount: (userId, txOrOptions) => unreadCount(userId, txOrOptions),
  markAsRead: (id, userId, txOrOptions) => markAsRead(id, userId, txOrOptions),
  markAllAsRead: (userId, txOrOptions) => markAllAsRead(userId, txOrOptions),
};
