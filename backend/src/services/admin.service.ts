import { z } from 'zod';
import type { Prisma, PrismaClient, UserStatus } from '@prisma/client';
import { Role } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { ACTIVE_DELIVERY_STATUSES } from '../utils/deliveryState';
import { MATCHABLE_DONATION_STATUSES } from '../utils/matchingCompatibility';
import { paginate, parsePagination, type PaginationResult } from '../utils/pagination';
import { strictDateField } from '../utils/validation';
import { persistAuditEvent } from './audit.service';
import { getSettings } from './settings.service';

// ---------------------------------------------------------------------------
// ADMIN-01: user management, ADMIN-02: operational monitoring, ADMIN-05:
// audit-log search (PRD §7.4). Every function re-checks that the caller is an
// active ADMIN (the routes also use requireRole).

type Client = PrismaClient;
type Tx = Prisma.TransactionClient;

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  return parsed.data;
}

function requireId(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [{ field, message: `${field} is required` }]);
  }
  return value.trim();
}

function mapAdminError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // Never leak SQL, constraint names, or connection details.
  return new AppError(500, 'ADMIN_REQUEST_FAILED', 'Admin request failed');
}

export async function requireActiveAdmin(client: Client | Tx, userId: string) {
  const user = await client.user.findUnique({
    where: { id: requireId(userId, 'userId') },
    select: { id: true, role: true, status: true },
  });
  if (!user || user.status !== 'ACTIVE') throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  if (user.role !== 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
  return user;
}

// ---------------------------------------------------------------------------
// ADMIN-01: users

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  organization: { select: { id: true, name: true, type: true, verificationStatus: true } },
} as const;

export const listUsersQuerySchema = z
  .object({
    role: z.nativeEnum(Role).optional(),
    status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export async function listUsers(adminId: string, query: unknown) {
  const q = parse(listUsersQuerySchema, query);
  const client = getPrisma();
  await requireActiveAdmin(client, adminId);
  const where: Prisma.UserWhereInput = {
    ...(q.role ? { role: q.role } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.q
      ? {
          OR: [
            { name: { contains: q.q, mode: 'insensitive' } },
            { email: { contains: q.q, mode: 'insensitive' } },
            { organization: { name: { contains: q.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const params = parsePagination({ page: q.page, limit: q.limit });
  try {
    const [rows, total] = await client.$transaction([
      client.user.findMany({ where, select: USER_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: params.offset, take: params.limit }),
      client.user.count({ where }),
    ]);
    return paginate(rows, total, params);
  } catch (err) {
    throw mapAdminError(err);
  }
}

export async function getUser(adminId: string, userId: string) {
  const id = requireId(userId);
  const client = getPrisma();
  await requireActiveAdmin(client, adminId);
  try {
    const user = await client.user.findUnique({
      where: { id },
      select: {
        ...USER_SELECT,
        _count: { select: { donations: true, volunteerDeliveries: true, incidentsReported: true, incidentsAbout: true } },
      },
    });
    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
    const { _count, ...rest } = user;
    return {
      user: rest,
      activity: {
        donations: _count.donations,
        deliveries: _count.volunteerDeliveries,
        incidentsReported: _count.incidentsReported,
        incidentsAbout: _count.incidentsAbout,
      },
    };
  } catch (err) {
    throw mapAdminError(err);
  }
}

export const updateUserStatusSchema = z
  .object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']),
    reason: z.string().trim().min(3, 'A reason is required').max(1000),
  })
  .strict();

/**
 * Status change inside the caller's transaction (also used by incident
 * resolution). Suspending/deleting revokes every session (SEC-03). A volunteer
 * on an active delivery must be reassigned first.
 */
export async function changeUserStatusInTx(
  tx: Tx,
  adminId: string,
  targetId: string,
  status: UserStatus,
  reason: string
) {
  if (targetId === adminId) throw new AppError(409, 'CONFLICT', 'Administrators cannot change their own status');
  const target = await tx.user.findUnique({ where: { id: targetId }, select: { id: true, status: true, role: true } });
  if (!target) throw new AppError(404, 'NOT_FOUND', 'User not found');
  if (target.status === status) throw new AppError(409, 'CONFLICT', `User is already ${status}`);
  if (status !== 'ACTIVE' && target.role === 'VOLUNTEER') {
    const active = await tx.delivery.count({
      where: { volunteerId: targetId, declinedAt: null, status: { in: [...ACTIVE_DELIVERY_STATUSES] } },
    });
    if (active > 0) {
      throw new AppError(409, 'ACTIVE_DELIVERY', 'Reassign the volunteer’s active delivery before suspending them');
    }
  }
  const updated = await tx.user.update({
    where: { id: targetId },
    data: { status, ...(status !== 'ACTIVE' ? { tokenVersion: { increment: 1 } } : {}) },
    select: USER_SELECT,
  });
  await persistAuditEvent(
    {
      actorId: adminId,
      action: 'USER_STATUS_CHANGED',
      entityType: 'User',
      entityId: targetId,
      oldValue: { status: target.status },
      newValue: { status, reason },
    },
    tx
  );
  return updated;
}

export async function updateUserStatus(adminId: string, userId: string, input: unknown) {
  const id = requireId(userId);
  const data = parse(updateUserStatusSchema, input);
  const client = getPrisma();
  const admin = await requireActiveAdmin(client, adminId);
  try {
    const user = await client.$transaction((tx) => changeUserStatusInTx(tx, admin.id, id, data.status, data.reason));
    return { user };
  } catch (err) {
    throw mapAdminError(err);
  }
}

// ---------------------------------------------------------------------------
// ADMIN-02: monitoring (PRD §7.4 "Monitor donations / active deliveries")

export async function getMonitoring(adminId: string, now: Date = new Date()) {
  const client = getPrisma();
  await requireActiveAdmin(client, adminId);
  const settings = await getSettings(client);
  const soon = new Date(now.getTime() + settings['alerts.leadMinutes'] * 60 * 1000);
  const delayedSince = new Date(now.getTime() - settings['alerts.deliveryDelayMinutes'] * 60 * 1000);
  const deliverySelect = {
    id: true,
    status: true,
    assignedAt: true,
    pickupTime: true,
    declinedAt: true,
    volunteer: { select: { id: true, name: true, phone: true } },
    donation: { select: { id: true, foodName: true, availableUntil: true, pickupLocation: true } },
  } as const;
  try {
    const [expiringUnclaimed, awaitingVolunteer, activeDeliveries, delayedDeliveries, openIncidents, pendingVerifications] =
      await Promise.all([
        client.donation.findMany({
          where: { status: { in: [...MATCHABLE_DONATION_STATUSES] }, availableUntil: { gt: now, lte: soon } },
          select: { id: true, foodName: true, quantity: true, unit: true, availableUntil: true, providerId: true },
          orderBy: { availableUntil: 'asc' },
          take: 50,
        }),
        client.donation.findMany({
          where: { status: 'ACCEPTED', availableUntil: { gt: now } },
          select: { id: true, foodName: true, quantity: true, unit: true, availableUntil: true },
          orderBy: { availableUntil: 'asc' },
          take: 50,
        }),
        client.delivery.findMany({
          where: { declinedAt: null, status: { in: [...ACTIVE_DELIVERY_STATUSES] } },
          select: deliverySelect,
          orderBy: { donation: { availableUntil: 'asc' } },
          take: 100,
        }),
        client.delivery.findMany({
          where: {
            OR: [
              { status: { in: ['ASSIGNED', 'ACCEPTED', 'AT_PICKUP'] }, donation: { availableUntil: { lte: now } } },
              { status: { in: ['PICKED_UP', 'IN_TRANSIT'] }, pickupTime: { lte: delayedSince } },
            ],
          },
          select: deliverySelect,
          take: 100,
        }),
        client.incident.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } }),
        client.organization.count({ where: { verificationStatus: { in: ['PENDING', 'UNDER_REVIEW'] } } }),
      ]);
    return {
      generatedAt: now,
      expiringUnclaimed,
      awaitingVolunteer,
      activeDeliveries,
      delayedDeliveries,
      openIncidents,
      pendingVerifications,
    };
  } catch (err) {
    throw mapAdminError(err);
  }
}

// ---------------------------------------------------------------------------
// ADMIN-05: audit-log search

export const auditLogQuerySchema = z
  .object({
    entityType: z.string().trim().min(1).max(100).optional(),
    entityId: z.string().trim().min(1).max(255).optional(),
    actorId: z.string().trim().min(1).max(255).optional(),
    action: z.string().trim().min(1).max(100).optional(),
    from: strictDateField('from').optional(),
    to: strictDateField('to').optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export async function searchAuditLogs(adminId: string, query: unknown): Promise<PaginationResult<unknown>> {
  const q = parse(auditLogQuerySchema, query);
  if (q.from && q.to && q.to.getTime() <= q.from.getTime()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [{ field: 'to', message: 'to must be after from' }]);
  }
  const client = getPrisma();
  await requireActiveAdmin(client, adminId);
  const where: Prisma.AuditLogWhereInput = {
    ...(q.entityType ? { entityType: q.entityType } : {}),
    ...(q.entityId ? { entityId: q.entityId } : {}),
    ...(q.actorId ? { userId: q.actorId } : {}),
    ...(q.action ? { action: q.action } : {}),
    ...(q.from || q.to ? { timestamp: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } } : {}),
  };
  const params = parsePagination({ page: q.page, limit: q.limit });
  try {
    const [rows, total] = await client.$transaction([
      client.auditLog.findMany({
        where,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          oldValue: true,
          newValue: true,
          timestamp: true,
          user: { select: { id: true, name: true, role: true } },
        },
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        skip: params.offset,
        take: params.limit,
      }),
      client.auditLog.count({ where }),
    ]);
    return paginate(rows, total, params);
  } catch (err) {
    throw mapAdminError(err);
  }
}
