import type { PrismaClient } from '@prisma/client';
import { NotificationType } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { persistAuditEvent } from './audit.service';
import { createNotification } from './notification.service';

// ---------------------------------------------------------------------------
// EXP-01: automatic expiry (PRD §8 alternative flow, FR-16). Run by the
// scheduled expiry job.
//
// Follows the authoritative state machines exactly:
//   Donation    AVAILABLE | MATCHED → EXPIRED   once availableUntil has passed
//   Requirement OPEN → EXPIRED                  once requiredBy has passed
// Accepted-but-not-collected donations are not expired (no such transition);
// the alert job flags them as missed pickups and an admin can cancel them.
// Partially fulfilled requirements keep their status (REQ-04 has no
// PARTIALLY_FULFILLED → EXPIRED) and simply stop matching after the deadline.
//
// Each record expires in its own transaction with a conditional write, so a
// concurrent acceptance or edit wins cleanly and one bad row never blocks the rest.

const EXPIRABLE_DONATION = ['AVAILABLE', 'MATCHED'] as const;
const BATCH_SIZE = 200;

export interface ExpirySummary {
  donationsExpired: number;
  requirementsExpired: number;
  failed: number;
}

async function expireDonations(client: PrismaClient, now: Date, summary: ExpirySummary): Promise<void> {
  const due = await client.donation.findMany({
    where: { status: { in: [...EXPIRABLE_DONATION] }, availableUntil: { lte: now } },
    select: { id: true, providerId: true, foodName: true, status: true },
    orderBy: [{ availableUntil: 'asc' }, { id: 'asc' }],
    take: BATCH_SIZE,
  });
  for (const d of due) {
    try {
      const expired = await client.$transaction(async (tx) => {
        const moved = await tx.donation.updateMany({
          where: { id: d.id, status: { in: [...EXPIRABLE_DONATION] }, availableUntil: { lte: now } },
          data: { status: 'EXPIRED' },
        });
        if (moved.count !== 1) return false;
        await tx.match.updateMany({ where: { donationId: d.id, status: 'RECOMMENDED' }, data: { status: 'EXPIRED' } });
        await persistAuditEvent(
          {
            actorId: null,
            action: 'DONATION_EXPIRED',
            entityType: 'Donation',
            entityId: d.id,
            oldValue: { status: d.status },
            newValue: { status: 'EXPIRED' },
          },
          tx
        );
        await createNotification(
          {
            userId: d.providerId,
            type: NotificationType.DONATION_EXPIRED,
            title: 'Donation expired',
            message: `"${d.foodName}" reached the end of its availability window without being accepted.`,
            entityType: 'Donation',
            entityId: d.id,
          },
          tx
        );
        return true;
      });
      if (expired) summary.donationsExpired += 1;
    } catch (err) {
      summary.failed += 1;
      logger.warn({ donationId: d.id, err: err instanceof Error ? err.message : String(err) }, 'Donation expiry failed');
    }
  }
}

async function expireRequirements(client: PrismaClient, now: Date, summary: ExpirySummary): Promise<void> {
  const due = await client.requirement.findMany({
    where: { status: 'OPEN', requiredBy: { lte: now } },
    orderBy: [{ requiredBy: 'asc' }, { id: 'asc' }],
    take: BATCH_SIZE,
  });
  for (const r of due) {
    try {
      const expired = await client.$transaction(async (tx) => {
        const moved = await tx.requirement.updateMany({
          where: { id: r.id, status: 'OPEN', requiredBy: { lte: now } },
          data: { status: 'EXPIRED' },
        });
        if (moved.count !== 1) return false;
        await tx.match.updateMany({ where: { requirementId: r.id, status: 'RECOMMENDED' }, data: { status: 'EXPIRED' } });
        // REQ-06: the history stays the authoritative timeline (system actor).
        await tx.requirementHistory.create({
          data: {
            requirementId: r.id,
            organizationId: r.organizationId,
            actorId: null,
            action: 'UPDATE',
            foodCategory: r.foodCategory,
            foodType: r.foodType,
            quantityRequired: r.quantityRequired,
            quantityFulfilled: r.quantityFulfilled,
            requiredBy: r.requiredBy,
            priority: r.priority,
            location: r.location,
            status: 'EXPIRED',
          },
        });
        await persistAuditEvent(
          {
            actorId: null,
            action: 'REQUIREMENT_EXPIRED',
            entityType: 'Requirement',
            entityId: r.id,
            oldValue: { status: 'OPEN' },
            newValue: { status: 'EXPIRED' },
          },
          tx
        );
        return true;
      });
      if (expired) summary.requirementsExpired += 1;
    } catch (err) {
      summary.failed += 1;
      logger.warn({ requirementId: r.id, err: err instanceof Error ? err.message : String(err) }, 'Requirement expiry failed');
    }
  }
}

export async function expireDueRecords(now: Date = new Date(), client: PrismaClient = getPrisma()): Promise<ExpirySummary> {
  const summary: ExpirySummary = { donationsExpired: 0, requirementsExpired: 0, failed: 0 };
  await expireDonations(client, now, summary);
  await expireRequirements(client, now, summary);
  return summary;
}
