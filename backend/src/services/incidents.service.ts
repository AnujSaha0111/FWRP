import { z } from 'zod';
import type { IncidentStatus, Prisma, PrismaClient } from '@prisma/client';
import { NotificationType } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { paginate, parsePagination, type PaginationResult } from '../utils/pagination';
import { changeUserStatusInTx, requireActiveAdmin } from './admin.service';
import { persistAuditEvent } from './audit.service';
import { createNotification } from './notification.service';

// ---------------------------------------------------------------------------
// ADMIN-03: reported accounts and disputes (PRD §7.4 "Manage reported
// accounts", "Resolve disputes").
//
// - ACCOUNT_REPORT: any active user reports another account (not themselves).
// - DISPUTE: about a donation (optionally one of its deliveries); only a party
//   to it may file — its provider, a user of the receiving organization, or a
//   volunteer who delivered it.
// - One open (OPEN/UNDER_REVIEW) incident per reporter and target.
// - Admin workflow: OPEN → UNDER_REVIEW → RESOLVED | DISMISSED (OPEN may close
//   directly). Closing needs a resolution note; resolving an account report can
//   suspend the reported account in the same transaction. The reporter is
//   notified of every admin update.

type Client = PrismaClient;

export const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
  OPEN: ['UNDER_REVIEW', 'RESOLVED', 'DISMISSED'],
  UNDER_REVIEW: ['RESOLVED', 'DISMISSED'],
  RESOLVED: [],
  DISMISSED: [],
};

const INCIDENT_SELECT = {
  id: true,
  type: true,
  status: true,
  reason: true,
  description: true,
  donationId: true,
  deliveryId: true,
  resolution: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  reporter: { select: { id: true, name: true, role: true } },
  subjectUser: { select: { id: true, name: true, role: true, status: true } },
  resolvedBy: { select: { id: true, name: true } },
} as const;

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

function mapIncidentError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError(500, 'INCIDENT_FAILED', 'Incident request failed');
}

async function loadCaller(client: Client, userId: string) {
  const user = await client.user.findUnique({
    where: { id: requireId(userId, 'userId') },
    select: { id: true, role: true, status: true, organizationId: true },
  });
  if (!user || user.status !== 'ACTIVE') throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return user;
}

// ---------------------------------------------------------------------------
// File (any role)

export const createIncidentSchema = z
  .object({
    type: z.enum(['ACCOUNT_REPORT', 'DISPUTE']),
    subjectUserId: z.string().trim().min(1).max(255).optional(),
    donationId: z.string().trim().min(1).max(255).optional(),
    deliveryId: z.string().trim().min(1).max(255).optional(),
    reason: z.string().trim().min(3, 'A reason is required').max(200),
    description: z.string().trim().min(10, 'Please describe what happened (at least 10 characters)').max(5000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.type === 'ACCOUNT_REPORT' && !v.subjectUserId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subjectUserId'], message: 'subjectUserId is required for account reports' });
    }
    if (v.type === 'DISPUTE' && !v.donationId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['donationId'], message: 'donationId is required for disputes' });
    }
    if (v.type === 'ACCOUNT_REPORT' && (v.donationId || v.deliveryId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['donationId'], message: 'Account reports do not reference a donation' });
    }
  });

export async function createIncident(userId: string, input: unknown) {
  const data = parse(createIncidentSchema, input);
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  try {
    if (data.type === 'ACCOUNT_REPORT') {
      if (data.subjectUserId === caller.id) throw new AppError(409, 'CONFLICT', 'You cannot report your own account');
      const subject = await client.user.findUnique({ where: { id: data.subjectUserId! }, select: { id: true } });
      if (!subject) throw new AppError(404, 'NOT_FOUND', 'User not found');
    } else {
      const donation = await client.donation.findUnique({
        where: { id: data.donationId! },
        select: {
          providerId: true,
          allocations: { select: { requirement: { select: { organizationId: true } } } },
          deliveries: { select: { id: true, volunteerId: true } },
        },
      });
      // Same 404 for missing donations and ones the caller is not party to.
      const party =
        donation &&
        (caller.role === 'ADMIN' ||
          donation.providerId === caller.id ||
          donation.deliveries.some((d) => d.volunteerId === caller.id) ||
          (caller.organizationId !== null &&
            donation.allocations.some((a) => a.requirement.organizationId === caller.organizationId)));
      if (!donation || !party) throw new AppError(404, 'NOT_FOUND', 'Donation not found');
      if (data.deliveryId && !donation.deliveries.some((d) => d.id === data.deliveryId)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
          { field: 'deliveryId', message: 'Delivery does not belong to this donation' },
        ]);
      }
      if (data.subjectUserId) {
        const subject = await client.user.findUnique({ where: { id: data.subjectUserId }, select: { id: true } });
        if (!subject) throw new AppError(404, 'NOT_FOUND', 'User not found');
      }
    }

    const duplicate = await client.incident.findFirst({
      where: {
        reporterId: caller.id,
        type: data.type,
        status: { in: ['OPEN', 'UNDER_REVIEW'] },
        ...(data.type === 'ACCOUNT_REPORT' ? { subjectUserId: data.subjectUserId } : { donationId: data.donationId }),
      },
      select: { id: true },
    });
    if (duplicate) throw new AppError(409, 'DUPLICATE_INCIDENT', 'You already have an open report for this');

    const incident = await client.$transaction(async (tx) => {
      const created = await tx.incident.create({
        data: {
          type: data.type,
          reporterId: caller.id,
          subjectUserId: data.subjectUserId ?? null,
          donationId: data.donationId ?? null,
          deliveryId: data.deliveryId ?? null,
          reason: data.reason,
          description: data.description,
        },
        select: INCIDENT_SELECT,
      });
      await persistAuditEvent(
        {
          actorId: caller.id,
          action: 'INCIDENT_CREATED',
          entityType: 'Incident',
          entityId: created.id,
          newValue: { type: created.type, reason: created.reason, subjectUserId: data.subjectUserId ?? null, donationId: data.donationId ?? null },
        },
        tx
      );
      const admins = await tx.user.findMany({ where: { role: 'ADMIN', status: 'ACTIVE' }, select: { id: true } });
      for (const a of admins) {
        await createNotification(
          {
            userId: a.id,
            type: NotificationType.INCIDENT_UPDATED,
            title: data.type === 'DISPUTE' ? 'New dispute' : 'New account report',
            message: `${data.reason} — filed by a ${caller.role.toLowerCase()}.`,
            entityType: 'Incident',
            entityId: created.id,
          },
          tx
        );
      }
      return created;
    });
    return { incident };
  } catch (err) {
    throw mapIncidentError(err);
  }
}

export const listIncidentsQuerySchema = z
  .object({
    type: z.enum(['ACCOUNT_REPORT', 'DISPUTE']).optional(),
    status: z.enum(['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED']).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

async function listWhere(client: Client, where: Prisma.IncidentWhereInput, page?: number, limit?: number) {
  const params = parsePagination({ page, limit });
  const [rows, total] = await client.$transaction([
    client.incident.findMany({ where, select: INCIDENT_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: params.offset, take: params.limit }),
    client.incident.count({ where }),
  ]);
  return paginate(rows, total, params);
}

/** Reporter's own incidents. */
export async function listMyIncidents(userId: string, query: unknown): Promise<PaginationResult<unknown>> {
  const q = parse(listIncidentsQuerySchema, query);
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  try {
    return await listWhere(client, { reporterId: caller.id, ...(q.type ? { type: q.type } : {}), ...(q.status ? { status: q.status } : {}) }, q.page, q.limit);
  } catch (err) {
    throw mapIncidentError(err);
  }
}

/** Reporter or admin; others get 404. */
export async function getIncident(userId: string, incidentId: string) {
  const id = requireId(incidentId);
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  try {
    const incident = await client.incident.findUnique({ where: { id }, select: INCIDENT_SELECT });
    if (!incident || (caller.role !== 'ADMIN' && incident.reporter.id !== caller.id)) {
      throw new AppError(404, 'NOT_FOUND', 'Incident not found');
    }
    return { incident };
  } catch (err) {
    throw mapIncidentError(err);
  }
}

// ---------------------------------------------------------------------------
// Admin

export async function adminListIncidents(adminId: string, query: unknown): Promise<PaginationResult<unknown>> {
  const q = parse(listIncidentsQuerySchema, query);
  const client = getPrisma();
  await requireActiveAdmin(client, adminId);
  try {
    return await listWhere(client, { ...(q.type ? { type: q.type } : {}), ...(q.status ? { status: q.status } : {}) }, q.page, q.limit);
  } catch (err) {
    throw mapIncidentError(err);
  }
}

export const updateIncidentSchema = z
  .object({
    status: z.enum(['UNDER_REVIEW', 'RESOLVED', 'DISMISSED']),
    resolution: z.string().trim().min(3).max(5000).optional(),
    suspendSubject: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.status !== 'UNDER_REVIEW' && !v.resolution) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resolution'], message: 'A resolution note is required to close an incident' });
    }
    if (v.suspendSubject && v.status !== 'RESOLVED') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['suspendSubject'], message: 'Only a resolved incident can suspend the reported account' });
    }
  });

export async function adminUpdateIncident(adminId: string, incidentId: string, input: unknown, now: Date = new Date()) {
  const id = requireId(incidentId);
  const data = parse(updateIncidentSchema, input);
  const client = getPrisma();
  const admin = await requireActiveAdmin(client, adminId);
  try {
    const incident = await client.$transaction(async (tx) => {
      const current = await tx.incident.findUnique({ where: { id }, select: INCIDENT_SELECT });
      if (!current) throw new AppError(404, 'NOT_FOUND', 'Incident not found');
      if (!INCIDENT_TRANSITIONS[current.status].includes(data.status)) {
        throw new AppError(409, 'CONFLICT', `Cannot move an incident from ${current.status} to ${data.status}`);
      }
      if (data.suspendSubject && !current.subjectUser) {
        throw new AppError(409, 'CONFLICT', 'This incident has no reported account to suspend');
      }
      const closing = data.status !== 'UNDER_REVIEW';
      // Conditional on the status we read: a concurrent update loses with 409.
      const moved = await tx.incident.updateMany({
        where: { id, status: current.status },
        data: {
          status: data.status,
          ...(data.resolution !== undefined ? { resolution: data.resolution } : {}),
          ...(closing ? { resolvedById: admin.id, resolvedAt: now } : {}),
        },
      });
      if (moved.count !== 1) throw new AppError(409, 'CONFLICT', 'Incident changed; reload and retry');

      if (data.suspendSubject && current.subjectUser && current.subjectUser.status !== 'SUSPENDED') {
        await changeUserStatusInTx(tx, admin.id, current.subjectUser.id, 'SUSPENDED', `Incident ${id}: ${data.resolution}`);
      }
      await persistAuditEvent(
        {
          actorId: admin.id,
          action: 'INCIDENT_UPDATED',
          entityType: 'Incident',
          entityId: id,
          oldValue: { status: current.status },
          newValue: { status: data.status, resolution: data.resolution ?? null, suspendSubject: Boolean(data.suspendSubject) },
        },
        tx
      );
      await createNotification(
        {
          userId: current.reporter.id,
          type: NotificationType.INCIDENT_UPDATED,
          title: closing ? `Your report was ${data.status.toLowerCase()}` : 'Your report is under review',
          message: closing ? (data.resolution as string) : `An administrator is reviewing "${current.reason}".`,
          entityType: 'Incident',
          entityId: id,
        },
        tx
      );
      return tx.incident.findUnique({ where: { id }, select: INCIDENT_SELECT });
    });
    return { incident };
  } catch (err) {
    throw mapIncidentError(err);
  }
}
