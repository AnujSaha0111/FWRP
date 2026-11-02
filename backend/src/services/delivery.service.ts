import { z } from 'zod';
import type { DeliveryStatus, DonationStatus, Prisma, PrismaClient, RequirementStatus, Role } from '@prisma/client';
import { NotificationType } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { canTransition } from '../utils/donationState';
import {
  ACTIVE_DELIVERY_STATUSES,
  canDeliveryTransition,
  DONATION_STATUS_FOR_DELIVERY,
  REASSIGNABLE_DELIVERY_STATUSES,
  VOLUNTEER_PROGRESS_STATUSES,
  windowsOverlap,
  type VolunteerProgressStatus,
} from '../utils/deliveryState';
import { deriveRequirementStatus } from '../utils/fulfillment';
import { paginate, parsePagination, type PaginationResult } from '../utils/pagination';
import { canRequirementTransition } from '../utils/requirementState';
import { persistAuditEvent } from './audit.service';
import { refreshMatchesSafely } from './matching.service';
import { createNotification } from './notification.service';
import { pickupWindow } from './volunteers.service';

// ---------------------------------------------------------------------------
// LOG-03..LOG-07, DELCONF-01..DELCONF-03: pickup assignment, volunteer
// workflow, provider handover and recipient confirmation (PRD §7.1-7.4, §8,
// FR-12..FR-15; state machine in utils/deliveryState.ts, docs/database.md §11.3).
//
// Every transition is one transaction: a conditional write on the expected
// current status (concurrent transitions lose with 409), the mirrored Donation
// status change (FR-14 sync), audit, and notifications. Delivery confirmation
// is the only place that marks a Donation COMPLETED and raises
// Requirement.quantityFulfilled.

type Client = PrismaClient;
type Tx = Prisma.TransactionClient;

interface Caller {
  id: string;
  role: Role;
  organizationId: string | null;
}

// ---------------------------------------------------------------------------
// Projections

export const DELIVERY_DETAIL_SELECT = {
  id: true,
  donationId: true,
  volunteerId: true,
  status: true,
  pickupLocation: true,
  deliveryLocation: true,
  assignedAt: true,
  pickupTime: true,
  deliveryTime: true,
  proofOfDelivery: true,
  notes: true,
  declinedAt: true,
  declineReason: true,
  handoverConfirmedAt: true,
  confirmedAt: true,
  quantityReceived: true,
  receiverName: true,
  createdAt: true,
  updatedAt: true,
  volunteer: { select: { id: true, name: true, phone: true } },
  donation: {
    select: {
      id: true,
      providerId: true,
      foodName: true,
      category: true,
      foodType: true,
      quantity: true,
      unit: true,
      availableFrom: true,
      availableUntil: true,
      storageRequirement: true,
      pickupLatitude: true,
      pickupLongitude: true,
      status: true,
      provider: {
        select: {
          id: true,
          name: true,
          phone: true,
          organization: {
            select: { id: true, name: true, latitude: true, longitude: true, contactInformation: true },
          },
        },
      },
      allocations: {
        select: {
          id: true,
          committedQuantity: true,
          requirement: {
            select: {
              id: true,
              location: true,
              organization: {
                select: {
                  id: true,
                  name: true,
                  address: true,
                  latitude: true,
                  longitude: true,
                  contactInformation: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  },
} as const;

type DeliveryRow = Prisma.DeliveryGetPayload<{ select: typeof DELIVERY_DETAIL_SELECT }>;

export interface DeliveryView {
  id: string;
  status: DeliveryStatus;
  needsReassignment: boolean;
  assignedAt: Date;
  pickupTime: Date | null;
  deliveryTime: Date | null;
  declinedAt: Date | null;
  declineReason: string | null;
  handoverConfirmedAt: Date | null;
  confirmedAt: Date | null;
  quantityReceived: number | null;
  receiverName: string | null;
  proofOfDelivery: string | null;
  notes: string | null;
  volunteer: { id: string; name: string; phone: string };
  donation: {
    id: string;
    foodName: string;
    category: string;
    foodType: string;
    quantity: number;
    unit: string;
    availableUntil: Date;
    storageRequirement: string | null;
    status: DonationStatus;
    committedQuantity: number;
  };
  pickup: {
    location: string;
    latitude: number | null;
    longitude: number | null;
    provider: { name: string; phone: string; organization: string | null; contact: string | null };
  };
  dropoff: {
    location: string;
    latitude: number | null;
    longitude: number | null;
    requirementId: string | null;
    organization: { id: string; name: string; contact: string | null } | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

function toDeliveryView(row: DeliveryRow): DeliveryView {
  const d = row.donation;
  const providerOrg = d.provider.organization;
  const allocation = d.allocations[0] ?? null;
  const recipientOrg = allocation?.requirement.organization ?? null;
  return {
    id: row.id,
    status: row.status,
    needsReassignment: row.status === 'ASSIGNED' && row.declinedAt !== null,
    assignedAt: row.assignedAt,
    pickupTime: row.pickupTime,
    deliveryTime: row.deliveryTime,
    declinedAt: row.declinedAt,
    declineReason: row.declineReason,
    handoverConfirmedAt: row.handoverConfirmedAt,
    confirmedAt: row.confirmedAt,
    quantityReceived: row.quantityReceived,
    receiverName: row.receiverName,
    proofOfDelivery: row.proofOfDelivery,
    notes: row.notes,
    volunteer: row.volunteer,
    donation: {
      id: d.id,
      foodName: d.foodName,
      category: d.category,
      foodType: d.foodType,
      quantity: d.quantity,
      unit: d.unit,
      availableUntil: d.availableUntil,
      storageRequirement: d.storageRequirement,
      status: d.status,
      committedQuantity: d.allocations.reduce((sum, a) => sum + a.committedQuantity, 0),
    },
    pickup: {
      location: row.pickupLocation,
      // Donation coordinates, else the provider organization's (never fabricated).
      latitude: d.pickupLatitude ?? providerOrg?.latitude ?? null,
      longitude: d.pickupLongitude ?? providerOrg?.longitude ?? null,
      provider: {
        name: d.provider.name,
        phone: d.provider.phone,
        organization: providerOrg?.name ?? null,
        contact: providerOrg?.contactInformation ?? null,
      },
    },
    dropoff: {
      location: row.deliveryLocation,
      latitude: recipientOrg?.latitude ?? null,
      longitude: recipientOrg?.longitude ?? null,
      requirementId: allocation?.requirement.id ?? null,
      organization: recipientOrg
        ? { id: recipientOrg.id, name: recipientOrg.name, contact: recipientOrg.contactInformation }
        : null,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field, message: `${field} is required` },
    ]);
  }
  return value.trim();
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  return parsed.data;
}

function mapDeliveryError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // Never leak SQL, constraint names, or connection details.
  return new AppError(500, 'DELIVERY_FAILED', 'Delivery request failed');
}

async function loadCaller(client: Client, userId: string): Promise<Caller> {
  const user = await client.user.findUnique({
    where: { id: requireId(userId, 'userId') },
    select: { id: true, role: true, status: true, organizationId: true },
  });
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  if (user.status !== 'ACTIVE') throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  return user;
}

function requireRole(caller: Caller, ...roles: Role[]): void {
  if (!roles.includes(caller.role)) throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
}

/** Role scope for reads: ADMIN all, VOLUNTEER own, PROVIDER own donations, RECIPIENT own organization. */
function scopeWhere(caller: Caller): Prisma.DeliveryWhereInput {
  switch (caller.role) {
    case 'ADMIN':
      return {};
    case 'VOLUNTEER':
      return { volunteerId: caller.id };
    case 'PROVIDER':
      return { donation: { providerId: caller.id } };
    case 'RECIPIENT':
      if (!caller.organizationId) throw new AppError(403, 'FORBIDDEN', 'Organization required');
      return { donation: { allocations: { some: { requirement: { organizationId: caller.organizationId } } } } };
    default:
      throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');
  }
}

function canView(caller: Caller, row: DeliveryRow): boolean {
  switch (caller.role) {
    case 'ADMIN':
      return true;
    case 'VOLUNTEER':
      return row.volunteerId === caller.id;
    case 'PROVIDER':
      return row.donation.providerId === caller.id;
    case 'RECIPIENT':
      return (
        caller.organizationId !== null &&
        row.donation.allocations.some((a) => a.requirement.organization.id === caller.organizationId)
      );
    default:
      return false;
  }
}

async function loadDelivery(client: Client | Tx, id: string): Promise<DeliveryRow> {
  const row = await client.delivery.findUnique({ where: { id }, select: DELIVERY_DETAIL_SELECT });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Delivery not found');
  return row;
}

/** Loads the delivery and hides out-of-scope rows behind the same 404. */
async function loadVisibleDelivery(client: Client | Tx, caller: Caller, id: string): Promise<DeliveryRow> {
  const row = await loadDelivery(client, id);
  if (!canView(caller, row)) throw new AppError(404, 'NOT_FOUND', 'Delivery not found');
  return row;
}

async function lockRow(tx: Tx, table: 'donations' | 'users' | 'deliveries', id: string): Promise<void> {
  // Table/column names are fixed literals per branch; ids are parameterized.
  if (table === 'donations') await tx.$queryRaw`SELECT 1 FROM "donations" WHERE "donation_id" = ${id} FOR UPDATE`;
  else if (table === 'users') await tx.$queryRaw`SELECT 1 FROM "users" WHERE "user_id" = ${id} FOR UPDATE`;
  else await tx.$queryRaw`SELECT 1 FROM "deliveries" WHERE "delivery_id" = ${id} FOR UPDATE`;
}

/** Conditional delivery write on the expected status; 409 when it moved concurrently. */
async function moveDelivery(
  tx: Tx,
  id: string,
  from: DeliveryStatus,
  data: Prisma.DeliveryUncheckedUpdateManyInput,
  extraWhere: Prisma.DeliveryWhereInput = {}
): Promise<void> {
  const res = await tx.delivery.updateMany({ where: { id, status: from, ...extraWhere }, data });
  if (res.count !== 1) throw new AppError(409, 'CONFLICT', 'Delivery status changed; reload and retry');
}

/** Mirrors the delivery status onto the donation (FR-14) through the central donation guard. */
async function syncDonation(tx: Tx, donationId: string, from: DonationStatus, to: DonationStatus): Promise<void> {
  if (from === to) return;
  if (!canTransition(from, to)) throw new AppError(409, 'CONFLICT', `Donation cannot move from ${from} to ${to}`);
  const res = await tx.donation.updateMany({ where: { id: donationId, status: from }, data: { status: to } });
  if (res.count !== 1) throw new AppError(409, 'CONFLICT', 'Donation status changed; reload and retry');
}

async function recipientUserIds(tx: Tx, organizationId: string | undefined): Promise<string[]> {
  if (!organizationId) return [];
  const users = await tx.user.findMany({
    where: { organizationId, role: 'RECIPIENT', status: 'ACTIVE' },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

async function notifyAll(
  tx: Tx,
  userIds: string[],
  type: NotificationType,
  title: string,
  message: string,
  entityId: string
): Promise<void> {
  for (const userId of [...new Set(userIds)]) {
    await createNotification({ userId, type, title, message, entityType: 'Delivery', entityId }, tx);
  }
}

async function audit(
  tx: Tx,
  actorId: string,
  action: string,
  entityId: string,
  oldValue: unknown,
  newValue: unknown
): Promise<void> {
  await persistAuditEvent({ actorId, action, entityType: 'Delivery', entityId, oldValue, newValue }, tx);
}

/** BR-05 + availability: the volunteer must be free and have a window covering the pickup window. */
async function assertVolunteerAssignable(
  tx: Tx,
  volunteerId: string,
  donation: { availableFrom: Date; availableUntil: Date },
  now: Date,
  ignoreDeliveryId?: string
): Promise<{ id: string; name: string }> {
  // Serializes concurrent assignments of the same volunteer (docs/database.md §13.3).
  await lockRow(tx, 'users', volunteerId);
  const volunteer = await tx.user.findUnique({
    where: { id: volunteerId },
    select: { id: true, name: true, role: true, status: true },
  });
  if (!volunteer || volunteer.role !== 'VOLUNTEER') throw new AppError(404, 'NOT_FOUND', 'Volunteer not found');
  if (volunteer.status !== 'ACTIVE') throw new AppError(409, 'CONFLICT', 'Volunteer is not active');

  const overlapping = await tx.delivery.count({
    where: {
      volunteerId,
      status: { in: [...ACTIVE_DELIVERY_STATUSES] },
      declinedAt: null,
      ...(ignoreDeliveryId ? { id: { not: ignoreDeliveryId } } : {}),
    },
  });
  if (overlapping > 0) {
    throw new AppError(409, 'OVERLAPPING_ASSIGNMENT', 'Volunteer already has an active delivery');
  }

  const { from, until } = pickupWindow(donation, now);
  const windows = await tx.volunteerAvailability.findMany({
    where: { volunteerId, availableUntil: { gt: from }, availableFrom: { lt: until } },
    select: { availableFrom: true, availableUntil: true },
  });
  if (!windows.some((w) => windowsOverlap(w, from, until))) {
    throw new AppError(409, 'VOLUNTEER_UNAVAILABLE', 'Volunteer has no availability during the pickup window');
  }
  return { id: volunteer.id, name: volunteer.name };
}

// ---------------------------------------------------------------------------
// Reads

export const listDeliveriesQuerySchema = z
  .object({
    status: z.enum(['ASSIGNED', 'ACCEPTED', 'AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CONFIRMED']).optional(),
    active: z.enum(['true', 'false']).optional(),
    needsReassignment: z.enum(['true', 'false']).optional(),
    donationId: z.string().trim().min(1).max(255).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export async function listDeliveries(userId: string, query: unknown): Promise<PaginationResult<DeliveryView>> {
  const q = parse(listDeliveriesQuerySchema, query);
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  const and: Prisma.DeliveryWhereInput[] = [scopeWhere(caller)];
  // A volunteer no longer sees assignments they declined.
  if (caller.role === 'VOLUNTEER') and.push({ declinedAt: null });
  if (q.status) and.push({ status: q.status });
  if (q.active === 'true') and.push({ status: { in: [...ACTIVE_DELIVERY_STATUSES] } });
  if (q.active === 'false') and.push({ status: { in: ['DELIVERED', 'CONFIRMED'] } });
  if (q.needsReassignment === 'true') and.push({ status: 'ASSIGNED', declinedAt: { not: null } });
  if (q.donationId) and.push({ donationId: q.donationId });
  const where: Prisma.DeliveryWhereInput = { AND: and };
  const params = parsePagination({ page: q.page, limit: q.limit });
  try {
    const [rows, total] = await client.$transaction([
      client.delivery.findMany({
        where,
        select: DELIVERY_DETAIL_SELECT,
        // Soonest-expiring pickups first, then newest assignments.
        orderBy: [{ donation: { availableUntil: 'asc' } }, { assignedAt: 'desc' }, { id: 'asc' }],
        skip: params.offset,
        take: params.limit,
      }),
      client.delivery.count({ where }),
    ]);
    return paginate(rows.map(toDeliveryView), total, params);
  } catch (err) {
    throw mapDeliveryError(err);
  }
}

export async function getDelivery(userId: string, deliveryId: string): Promise<{ delivery: DeliveryView }> {
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  try {
    return { delivery: toDeliveryView(await loadVisibleDelivery(client, caller, requireId(deliveryId, 'id'))) };
  } catch (err) {
    throw mapDeliveryError(err);
  }
}

export interface PendingAssignments {
  /** Accepted donations waiting for a volunteer. */
  awaitingVolunteer: Array<{
    donationId: string;
    foodName: string;
    quantity: number;
    unit: string;
    pickupLocation: string;
    availableUntil: Date;
    recipientOrganization: string | null;
  }>;
  /** Assignments declined by their volunteer, waiting for reassignment. */
  declined: DeliveryView[];
}

/** ADMIN work queue for FR-12. */
export async function listPendingAssignments(userId: string, now: Date = new Date()): Promise<PendingAssignments> {
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  requireRole(caller, 'ADMIN');
  try {
    const [donations, declined] = await client.$transaction([
      client.donation.findMany({
        where: { status: 'ACCEPTED', availableUntil: { gt: now } },
        select: {
          id: true,
          foodName: true,
          quantity: true,
          unit: true,
          pickupLocation: true,
          availableUntil: true,
          allocations: {
            select: { requirement: { select: { organization: { select: { name: true } } } } },
            take: 1,
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: [{ availableUntil: 'asc' }, { id: 'asc' }],
        take: 100,
      }),
      client.delivery.findMany({
        where: { status: 'ASSIGNED', declinedAt: { not: null } },
        select: DELIVERY_DETAIL_SELECT,
        orderBy: [{ donation: { availableUntil: 'asc' } }, { id: 'asc' }],
        take: 100,
      }),
    ]);
    return {
      awaitingVolunteer: donations.map((d) => ({
        donationId: d.id,
        foodName: d.foodName,
        quantity: d.quantity,
        unit: d.unit,
        pickupLocation: d.pickupLocation,
        availableUntil: d.availableUntil,
        recipientOrganization: d.allocations[0]?.requirement.organization.name ?? null,
      })),
      declined: declined.map(toDeliveryView),
    };
  } catch (err) {
    throw mapDeliveryError(err);
  }
}

// ---------------------------------------------------------------------------
// LOG-03: assignment (ADMIN, FR-12)

export const assignDeliverySchema = z
  .object({
    donationId: z.string().trim().min(1).max(255),
    volunteerId: z.string().trim().min(1).max(255),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

export async function assignDelivery(
  userId: string,
  input: unknown,
  now: Date = new Date()
): Promise<{ delivery: DeliveryView }> {
  const data = parse(assignDeliverySchema, input);
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  requireRole(caller, 'ADMIN');
  try {
    const id = await client.$transaction(async (tx) => {
      await lockRow(tx, 'donations', data.donationId);
      const donation = await tx.donation.findUnique({
        where: { id: data.donationId },
        select: {
          id: true,
          status: true,
          providerId: true,
          foodName: true,
          pickupLocation: true,
          availableFrom: true,
          availableUntil: true,
          allocations: {
            select: {
              requirement: {
                select: { location: true, organization: { select: { id: true, address: true } } },
              },
            },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
      });
      if (!donation) throw new AppError(404, 'NOT_FOUND', 'Donation not found');
      if (!canTransition(donation.status, 'PICKUP_ASSIGNED')) {
        throw new AppError(409, 'CONFLICT', 'Only accepted donations can be assigned for pickup');
      }
      if (donation.availableUntil.getTime() <= now.getTime()) {
        throw new AppError(409, 'CONFLICT', 'The donation pickup window has ended');
      }
      const allocation = donation.allocations[0];
      if (!allocation) {
        // Legacy acceptance without a requirement has no destination (ACCEPT-01).
        throw new AppError(
          409,
          'NO_RECIPIENT_ALLOCATION',
          'Donation has no recipient allocation; accept it for a requirement first'
        );
      }
      const volunteer = await assertVolunteerAssignable(tx, data.volunteerId, donation, now);

      const created = await tx.delivery.create({
        data: {
          donationId: donation.id,
          volunteerId: volunteer.id,
          pickupLocation: donation.pickupLocation,
          deliveryLocation: allocation.requirement.location || allocation.requirement.organization.address,
          status: 'ASSIGNED',
          assignedAt: now,
          notes: data.notes ?? null,
        },
        select: { id: true },
      });
      await syncDonation(tx, donation.id, donation.status, 'PICKUP_ASSIGNED');
      await audit(tx, caller.id, 'DELIVERY_ASSIGNED', created.id, null, {
        donationId: donation.id,
        volunteerId: volunteer.id,
        status: 'ASSIGNED',
      });

      await notifyAll(
        tx,
        [volunteer.id],
        NotificationType.PICKUP_ASSIGNED,
        'New pickup assignment',
        `You have been assigned to pick up "${donation.foodName}" at ${donation.pickupLocation}.`,
        created.id
      );
      const recipients = await recipientUserIds(tx, allocation.requirement.organization.id);
      await notifyAll(
        tx,
        [donation.providerId, ...recipients],
        NotificationType.PICKUP_ASSIGNED,
        'Pickup scheduled',
        `A volunteer (${volunteer.name}) has been assigned to "${donation.foodName}".`,
        created.id
      );
      return created.id;
    });
    return { delivery: toDeliveryView(await loadDelivery(client, id)) };
  } catch (err) {
    throw mapDeliveryError(err);
  }
}

export const reassignDeliverySchema = z
  .object({
    volunteerId: z.string().trim().min(1).max(255),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

/** ADMIN: move an assignment (declined or not yet picked up) to another volunteer. Stays ASSIGNED. */
export async function reassignDelivery(
  userId: string,
  deliveryId: string,
  input: unknown,
  now: Date = new Date()
): Promise<{ delivery: DeliveryView }> {
  const id = requireId(deliveryId, 'id');
  const data = parse(reassignDeliverySchema, input);
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  requireRole(caller, 'ADMIN');
  try {
    await client.$transaction(async (tx) => {
      await lockRow(tx, 'deliveries', id);
      const row = await loadDelivery(tx, id);
      if (!REASSIGNABLE_DELIVERY_STATUSES.includes(row.status)) {
        throw new AppError(409, 'CONFLICT', 'Only deliveries that have not been picked up can be reassigned');
      }
      if (row.volunteerId === data.volunteerId && row.declinedAt === null) {
        throw new AppError(409, 'CONFLICT', 'Delivery is already assigned to this volunteer');
      }
      const volunteer = await assertVolunteerAssignable(tx, data.volunteerId, row.donation, now, id);
      await moveDelivery(tx, id, row.status, {
        volunteerId: volunteer.id,
        status: 'ASSIGNED',
        assignedAt: now,
        declinedAt: null,
        declineReason: null,
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      });
      await audit(
        tx,
        caller.id,
        'DELIVERY_REASSIGNED',
        id,
        { volunteerId: row.volunteerId, status: row.status, declinedAt: row.declinedAt },
        { volunteerId: volunteer.id, status: 'ASSIGNED' }
      );
      await notifyAll(
        tx,
        [volunteer.id],
        NotificationType.PICKUP_ASSIGNED,
        'New pickup assignment',
        `You have been assigned to pick up "${row.donation.foodName}" at ${row.pickupLocation}.`,
        id
      );
      if (row.declinedAt === null && row.volunteerId !== volunteer.id) {
        await notifyAll(
          tx,
          [row.volunteerId],
          NotificationType.PICKUP_ASSIGNED,
          'Pickup reassigned',
          `Your pickup of "${row.donation.foodName}" was reassigned to another volunteer.`,
          id
        );
      }
    });
    return { delivery: toDeliveryView(await loadDelivery(client, id)) };
  } catch (err) {
    throw mapDeliveryError(err);
  }
}

// ---------------------------------------------------------------------------
// LOG-04: volunteer accepts or declines the assignment

export const respondToAssignmentSchema = z
  .object({
    action: z.enum(['ACCEPT', 'DECLINE']),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();

export async function respondToAssignment(
  userId: string,
  deliveryId: string,
  input: unknown,
  now: Date = new Date()
): Promise<{ delivery: DeliveryView }> {
  const id = requireId(deliveryId, 'id');
  const data = parse(respondToAssignmentSchema, input);
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  requireRole(caller, 'VOLUNTEER');
  try {
    await client.$transaction(async (tx) => {
      const row = await loadVisibleDelivery(tx, caller, id);
      if (row.status !== 'ASSIGNED' || row.declinedAt !== null) {
        throw new AppError(409, 'CONFLICT', 'This assignment is no longer awaiting your response');
      }
      const guard = { volunteerId: caller.id, declinedAt: null };
      if (data.action === 'ACCEPT') {
        await moveDelivery(tx, id, 'ASSIGNED', { status: 'ACCEPTED' }, guard);
        await audit(tx, caller.id, 'DELIVERY_ACCEPTED', id, { status: 'ASSIGNED' }, { status: 'ACCEPTED' });
      } else {
        // ASSIGNED → ASSIGNED: waits for an admin reassignment (docs/database.md §11.3).
        await moveDelivery(
          tx,
          id,
          'ASSIGNED',
          { declinedAt: now, declineReason: data.reason ?? null },
          guard
        );
        await audit(tx, caller.id, 'DELIVERY_DECLINED', id, { status: 'ASSIGNED' }, {
          status: 'ASSIGNED',
          declined: true,
          reason: data.reason ?? null,
        });
      }
    });
    return { delivery: toDeliveryView(await loadDelivery(client, id)) };
  } catch (err) {
    throw mapDeliveryError(err);
  }
}

// ---------------------------------------------------------------------------
// LOG-05: volunteer progress (AT_PICKUP → PICKED_UP → IN_TRANSIT → DELIVERED)

export const updateDeliveryStatusSchema = z
  .object({
    status: z.enum(VOLUNTEER_PROGRESS_STATUSES),
    // Reference to proof (photo URL/path, code); no file upload in the MVP.
    proofOfDelivery: z.string().trim().min(1).max(2000).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((v) => v.proofOfDelivery === undefined || v.status === 'DELIVERED', {
    message: 'proofOfDelivery is only accepted with status DELIVERED',
    path: ['proofOfDelivery'],
  });

const PREVIOUS: Record<VolunteerProgressStatus, DeliveryStatus> = {
  AT_PICKUP: 'ACCEPTED',
  PICKED_UP: 'AT_PICKUP',
  IN_TRANSIT: 'PICKED_UP',
  DELIVERED: 'IN_TRANSIT',
};

export async function updateDeliveryStatus(
  userId: string,
  deliveryId: string,
  input: unknown,
  now: Date = new Date()
): Promise<{ delivery: DeliveryView }> {
  const id = requireId(deliveryId, 'id');
  const data = parse(updateDeliveryStatusSchema, input);
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  requireRole(caller, 'VOLUNTEER');
  try {
    await client.$transaction(async (tx) => {
      const row = await loadVisibleDelivery(tx, caller, id);
      const from = PREVIOUS[data.status];
      if (row.status !== from || !canDeliveryTransition(row.status, data.status)) {
        throw new AppError(409, 'CONFLICT', `Cannot move a delivery from ${row.status} to ${data.status}`);
      }
      const update: Prisma.DeliveryUncheckedUpdateManyInput = { status: data.status };
      if (data.status === 'PICKED_UP') update.pickupTime = now;
      if (data.status === 'DELIVERED') {
        update.deliveryTime = now;
        if (data.proofOfDelivery !== undefined) update.proofOfDelivery = data.proofOfDelivery;
      }
      if (data.notes !== undefined) update.notes = data.notes;
      await moveDelivery(tx, id, from, update, { volunteerId: caller.id });

      const donationTarget = DONATION_STATUS_FOR_DELIVERY[data.status];
      if (donationTarget) await syncDonation(tx, row.donationId, row.donation.status, donationTarget);
      await audit(tx, caller.id, `DELIVERY_${data.status}`, id, { status: from }, {
        status: data.status,
        ...(data.proofOfDelivery ? { proofOfDelivery: data.proofOfDelivery } : {}),
      });

      if (data.status === 'DELIVERED') {
        const orgId = row.donation.allocations[0]?.requirement.organization.id;
        await notifyAll(
          tx,
          await recipientUserIds(tx, orgId),
          NotificationType.CONFIRMATION_PENDING,
          'Please confirm receipt',
          `"${row.donation.foodName}" has been delivered. Please confirm what you received.`,
          id
        );
      }
    });
    return { delivery: toDeliveryView(await loadDelivery(client, id)) };
  } catch (err) {
    throw mapDeliveryError(err);
  }
}

// ---------------------------------------------------------------------------
// DELCONF-01: provider confirms the handover (PRD §7.1)

export async function confirmHandover(
  userId: string,
  deliveryId: string,
  now: Date = new Date()
): Promise<{ delivery: DeliveryView }> {
  const id = requireId(deliveryId, 'id');
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  requireRole(caller, 'PROVIDER');
  try {
    await client.$transaction(async (tx) => {
      const row = await loadVisibleDelivery(tx, caller, id);
      if (row.handoverConfirmedAt !== null) throw new AppError(409, 'CONFLICT', 'Handover already confirmed');
      if (!['AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED'].includes(row.status)) {
        throw new AppError(409, 'CONFLICT', 'The volunteer has not reached the pickup yet');
      }
      if (row.status === 'AT_PICKUP') {
        // Provider handing the food over is the pickup itself.
        await moveDelivery(tx, id, 'AT_PICKUP', { status: 'PICKED_UP', pickupTime: now, handoverConfirmedAt: now });
        await syncDonation(tx, row.donationId, row.donation.status, 'PICKED_UP');
      } else {
        await moveDelivery(tx, id, row.status, { handoverConfirmedAt: now }, { handoverConfirmedAt: null });
      }
      await audit(tx, caller.id, 'DELIVERY_HANDOVER_CONFIRMED', id, { status: row.status }, {
        status: row.status === 'AT_PICKUP' ? 'PICKED_UP' : row.status,
        handoverConfirmedAt: now,
      });
    });
    return { delivery: toDeliveryView(await loadDelivery(client, id)) };
  } catch (err) {
    throw mapDeliveryError(err);
  }
}

// ---------------------------------------------------------------------------
// DELCONF-02/03: recipient confirms receipt (FR-15, AC-08). DELIVERED →
// CONFIRMED, Donation DELIVERED → COMPLETED, Requirement fulfilment — one transaction.

export const confirmReceiptSchema = z
  .object({
    quantityReceived: z.number({ invalid_type_error: 'quantityReceived must be a number' }).positive().finite().optional(),
    receiverName: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

/** REQ-04 allows OPEN → PARTIALLY_FULFILLED → FULFILLED; a full delivery from OPEN takes both steps. */
function canReachRequirementStatus(from: RequirementStatus, to: RequirementStatus): boolean {
  if (from === to || canRequirementTransition(from, to)) return true;
  return canRequirementTransition(from, 'PARTIALLY_FULFILLED') && canRequirementTransition('PARTIALLY_FULFILLED', to);
}

export async function confirmReceipt(
  userId: string,
  deliveryId: string,
  input: unknown,
  now: Date = new Date()
): Promise<{ delivery: DeliveryView; requirement: { id: string; quantityFulfilled: number; status: RequirementStatus } | null }> {
  const id = requireId(deliveryId, 'id');
  const data = parse(confirmReceiptSchema, input);
  const client = getPrisma();
  const caller = await loadCaller(client, userId);
  requireRole(caller, 'RECIPIENT');
  try {
    const requirementResult = await client.$transaction(async (tx) => {
      await lockRow(tx, 'deliveries', id);
      const row = await loadVisibleDelivery(tx, caller, id);
      if (row.status !== 'DELIVERED') {
        throw new AppError(409, 'CONFLICT', 'Only delivered donations can be confirmed');
      }
      const allocation = row.donation.allocations.find(
        (a) => a.requirement.organization.id === caller.organizationId
      );
      if (!allocation) throw new AppError(404, 'NOT_FOUND', 'Delivery not found');
      const received = data.quantityReceived ?? allocation.committedQuantity;
      if (received > row.donation.quantity) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
          { field: 'quantityReceived', message: 'quantityReceived cannot exceed the donated quantity' },
        ]);
      }

      await moveDelivery(tx, id, 'DELIVERED', {
        status: 'CONFIRMED',
        confirmedAt: now,
        quantityReceived: received,
        receiverName: data.receiverName ?? null,
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      });
      await syncDonation(tx, row.donationId, row.donation.status, 'COMPLETED');

      // Requirement fulfilment: only while the requirement is still open.
      const requirement = await tx.requirement.findUnique({ where: { id: allocation.requirement.id } });
      let requirementResult: { id: string; quantityFulfilled: number; status: RequirementStatus } | null = null;
      if (requirement && (requirement.status === 'OPEN' || requirement.status === 'PARTIALLY_FULFILLED')) {
        const fulfilled = requirement.quantityFulfilled + received;
        const status = deriveRequirementStatus(requirement.quantityRequired, fulfilled);
        if (!canReachRequirementStatus(requirement.status, status)) {
          throw new AppError(409, 'CONFLICT', 'Requirement cannot accept this fulfilment');
        }
        const res = await tx.requirement.updateMany({
          where: { id: requirement.id, status: requirement.status, quantityFulfilled: requirement.quantityFulfilled },
          data: { quantityFulfilled: fulfilled, status },
        });
        if (res.count !== 1) throw new AppError(409, 'CONFLICT', 'Requirement changed; reload and retry');
        await tx.requirementHistory.create({
          data: {
            requirementId: requirement.id,
            organizationId: requirement.organizationId,
            actorId: caller.id,
            action: 'UPDATE',
            foodCategory: requirement.foodCategory,
            foodType: requirement.foodType,
            quantityRequired: requirement.quantityRequired,
            quantityFulfilled: fulfilled,
            requiredBy: requirement.requiredBy,
            priority: requirement.priority,
            location: requirement.location,
            status,
          },
        });
        requirementResult = { id: requirement.id, quantityFulfilled: fulfilled, status };
      }

      await audit(tx, caller.id, 'DELIVERY_CONFIRMED', id, { status: 'DELIVERED' }, {
        status: 'CONFIRMED',
        quantityReceived: received,
        receiverName: data.receiverName ?? null,
      });
      await persistAuditEvent(
        {
          actorId: caller.id,
          action: 'DONATION_COMPLETED',
          entityType: 'Donation',
          entityId: row.donationId,
          oldValue: { status: row.donation.status },
          newValue: { status: 'COMPLETED', quantityReceived: received, requirement: requirementResult },
        },
        tx
      );
      await notifyAll(
        tx,
        [row.donation.providerId, row.volunteerId],
        NotificationType.DELIVERY_COMPLETED,
        'Delivery completed',
        `"${row.donation.foodName}" was received (${received} ${row.donation.unit}). Thank you!`,
        id
      );
      return requirementResult;
    });
    // Fulfilled demand drops out of the requirement's recommendations.
    if (requirementResult) await refreshMatchesSafely('requirement', requirementResult.id);
    return { delivery: toDeliveryView(await loadDelivery(client, id)), requirement: requirementResult };
  } catch (err) {
    throw mapDeliveryError(err);
  }
}

