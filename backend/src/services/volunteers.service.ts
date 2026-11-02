import { z } from 'zod';
import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { ACTIVE_DELIVERY_STATUSES, windowsOverlap } from '../utils/deliveryState';
import { strictDateField } from '../utils/validation';
import { persistAuditEvent } from './audit.service';

// ---------------------------------------------------------------------------
// LOG-01: volunteer availability (PRD §7.3 "Maintain availability") and the
// admin "who can take this pickup" lookup used by assignment (FR-12).
//
// A volunteer is free for a window when they have an availability window
// overlapping it AND no active (non-declined) delivery (BR-05).

type Client = PrismaClient | Prisma.TransactionClient;

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_WINDOWS = 50;

export interface AvailabilityWindow {
  id: string;
  availableFrom: Date;
  availableUntil: Date;
}

export interface AvailableVolunteer {
  id: string;
  name: string;
  phone: string;
  windows: AvailabilityWindow[];
}

const WINDOW_SELECT = { id: true, availableFrom: true, availableUntil: true } as const;

export const createAvailabilitySchema = z
  .object({
    availableFrom: strictDateField('availableFrom'),
    availableUntil: strictDateField('availableUntil'),
  })
  .strict();

export const availableVolunteersQuerySchema = z
  .object({
    donationId: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field, message: `${field} is required` },
    ]);
  }
  return value.trim();
}

function mapVolunteerError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // Never leak SQL, constraint names, or connection details.
  return new AppError(500, 'VOLUNTEER_ERROR', 'Volunteer availability request failed');
}

async function loadVolunteer(client: Client, userId: string) {
  const id = requireId(userId, 'userId');
  const user = await client.user.findUnique({ where: { id }, select: { id: true, role: true, status: true } });
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  if (user.status !== 'ACTIVE') throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  if (user.role !== 'VOLUNTEER') throw new AppError(403, 'FORBIDDEN', 'Only volunteers manage availability');
  return user;
}

export async function listMyAvailability(userId: string, now: Date = new Date()): Promise<AvailabilityWindow[]> {
  const client = getPrisma();
  const volunteer = await loadVolunteer(client, userId);
  try {
    return await client.volunteerAvailability.findMany({
      where: { volunteerId: volunteer.id, availableUntil: { gt: now } },
      select: WINDOW_SELECT,
      orderBy: [{ availableFrom: 'asc' }, { id: 'asc' }],
    });
  } catch (err) {
    throw mapVolunteerError(err);
  }
}

export async function addAvailability(
  userId: string,
  input: unknown,
  now: Date = new Date()
): Promise<{ window: AvailabilityWindow }> {
  const parsed = createAvailabilitySchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const { availableFrom, availableUntil } = parsed.data;
  const fieldError = (field: string, message: string) =>
    new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [{ field, message }]);
  if (availableUntil.getTime() <= availableFrom.getTime()) {
    throw fieldError('availableUntil', 'availableUntil must be after availableFrom');
  }
  if (availableUntil.getTime() <= now.getTime()) {
    throw fieldError('availableUntil', 'availableUntil must be in the future');
  }
  if (availableUntil.getTime() - availableFrom.getTime() > MAX_WINDOW_MS) {
    throw fieldError('availableUntil', 'An availability window may span at most 7 days');
  }

  const client = getPrisma();
  const volunteer = await loadVolunteer(client, userId);
  try {
    const window = await client.$transaction(async (tx) => {
      // Serialize window edits per volunteer so overlap checks cannot race.
      await tx.$queryRaw`SELECT "user_id" FROM "users" WHERE "user_id" = ${volunteer.id} FOR UPDATE`;
      const existing = await tx.volunteerAvailability.findMany({
        where: { volunteerId: volunteer.id, availableUntil: { gt: now } },
        select: WINDOW_SELECT,
      });
      if (existing.length >= MAX_FUTURE_WINDOWS) {
        throw new AppError(409, 'CONFLICT', `At most ${MAX_FUTURE_WINDOWS} upcoming windows are allowed`);
      }
      if (existing.some((w) => windowsOverlap(w, availableFrom, availableUntil))) {
        throw new AppError(409, 'CONFLICT', 'Window overlaps an existing availability window');
      }
      const created = await tx.volunteerAvailability.create({
        data: { volunteerId: volunteer.id, availableFrom, availableUntil },
        select: WINDOW_SELECT,
      });
      await persistAuditEvent(
        {
          actorId: volunteer.id,
          action: 'VOLUNTEER_AVAILABILITY_ADDED',
          entityType: 'VolunteerAvailability',
          entityId: created.id,
          oldValue: null,
          newValue: created,
        },
        tx
      );
      return created;
    });
    return { window };
  } catch (err) {
    throw mapVolunteerError(err);
  }
}

export async function deleteAvailability(userId: string, windowId: string): Promise<{ deleted: true }> {
  const id = requireId(windowId, 'id');
  const client = getPrisma();
  const volunteer = await loadVolunteer(client, userId);
  try {
    await client.$transaction(async (tx) => {
      const res = await tx.volunteerAvailability.deleteMany({ where: { id, volunteerId: volunteer.id } });
      // Same 404 for missing and foreign windows.
      if (res.count !== 1) throw new AppError(404, 'NOT_FOUND', 'Availability window not found');
      await persistAuditEvent(
        {
          actorId: volunteer.id,
          action: 'VOLUNTEER_AVAILABILITY_REMOVED',
          entityType: 'VolunteerAvailability',
          entityId: id,
          oldValue: { id },
          newValue: null,
        },
        tx
      );
    });
    return { deleted: true };
  } catch (err) {
    throw mapVolunteerError(err);
  }
}

/** Ids of volunteers currently occupied by an active, non-declined delivery. */
export async function busyVolunteerIds(client: Client, volunteerIds?: string[]): Promise<Set<string>> {
  const rows = await client.delivery.findMany({
    where: {
      status: { in: [...ACTIVE_DELIVERY_STATUSES] },
      declinedAt: null,
      ...(volunteerIds ? { volunteerId: { in: volunteerIds } } : {}),
    },
    select: { volunteerId: true },
  });
  return new Set(rows.map((r) => r.volunteerId));
}

/**
 * Free volunteers with a window overlapping [from, until): ACTIVE, role
 * VOLUNTEER, not busy. Shared by assignment checks, the admin lookup and the
 * matching transport component.
 */
export async function findFreeVolunteers(
  client: Client,
  from: Date,
  until: Date
): Promise<AvailableVolunteer[]> {
  if (until.getTime() <= from.getTime()) return [];
  const windows = await client.volunteerAvailability.findMany({
    where: {
      availableFrom: { lt: until },
      availableUntil: { gt: from },
      volunteer: { role: 'VOLUNTEER', status: 'ACTIVE' },
    },
    select: { ...WINDOW_SELECT, volunteer: { select: { id: true, name: true, phone: true } } },
    orderBy: [{ availableFrom: 'asc' }, { id: 'asc' }],
  });
  const busy = await busyVolunteerIds(client, [...new Set(windows.map((w) => w.volunteer.id))]);
  const byVolunteer = new Map<string, AvailableVolunteer>();
  for (const w of windows) {
    if (busy.has(w.volunteer.id)) continue;
    const entry = byVolunteer.get(w.volunteer.id) ?? { ...w.volunteer, windows: [] };
    entry.windows.push({ id: w.id, availableFrom: w.availableFrom, availableUntil: w.availableUntil });
    byVolunteer.set(w.volunteer.id, entry);
  }
  return [...byVolunteer.values()];
}

/** The window a donation pickup can happen in: [max(now, availableFrom), availableUntil). */
export function pickupWindow(
  donation: { availableFrom: Date; availableUntil: Date },
  now: Date
): { from: Date; until: Date } {
  return {
    from: new Date(Math.max(now.getTime(), donation.availableFrom.getTime())),
    until: donation.availableUntil,
  };
}

/** ADMIN: free volunteers for a donation's pickup window (or for "now" without one). */
export async function listAvailableVolunteers(
  adminId: string,
  query: unknown,
  now: Date = new Date()
): Promise<{ from: Date; until: Date; volunteers: AvailableVolunteer[] }> {
  const parsed = availableVolunteersQuerySchema.safeParse(query ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const client = getPrisma();
  const admin = await client.user.findUnique({
    where: { id: requireId(adminId, 'userId') },
    select: { role: true, status: true },
  });
  if (!admin || admin.status !== 'ACTIVE') throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  if (admin.role !== 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Insufficient permissions');

  try {
    let from = now;
    let until = new Date(now.getTime() + 60 * 1000);
    if (parsed.data.donationId) {
      const donation = await client.donation.findUnique({
        where: { id: parsed.data.donationId },
        select: { availableFrom: true, availableUntil: true },
      });
      if (!donation) throw new AppError(404, 'NOT_FOUND', 'Donation not found');
      ({ from, until } = pickupWindow(donation, now));
    }
    return { from, until, volunteers: await findFreeVolunteers(client, from, until) };
  } catch (err) {
    throw mapVolunteerError(err);
  }
}
