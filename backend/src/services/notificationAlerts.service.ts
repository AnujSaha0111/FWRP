import type { NotificationType, PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { MATCHABLE_DONATION_STATUSES, MATCHABLE_REQUIREMENT_STATUSES } from '../utils/matchingCompatibility';
import { createNotification } from './notification.service';
import { getSettings } from './settings.service';

// ---------------------------------------------------------------------------
// NOTIF-04: time-based alerts (PRD §8 "Expiry window approaching → Priority /
// Alert"). Run by the scheduled notification job. Each alert is sent at most
// once per (user, type, entity) — de-duplicated through the persisted
// notification entity (NOTIF-05), so re-runs are safe.
//
// Alerts never change any status; expiring records is the expiry job's work.

/** Defaults; administrators override them via settings (ADMIN-04). */
export const ALERT_LEAD_MS = 60 * 60 * 1000;
export const DELIVERY_DELAY_MS = 2 * 60 * 60 * 1000;

export interface AlertThresholds {
  leadMs: number;
  delayMs: number;
}

export interface AlertCandidate {
  userId: string;
  type: NotificationType;
  entityType: 'Donation' | 'Requirement' | 'Delivery';
  entityId: string;
  title: string;
  message: string;
}

export interface AlertSummary {
  candidates: number;
  sent: number;
}

function minutesLeft(until: Date, now: Date): number {
  return Math.max(0, Math.round((until.getTime() - now.getTime()) / 60000));
}

/** Gathers every alert that is due now (pure reads). */
export async function collectAlerts(
  client: PrismaClient,
  now: Date,
  thresholds: AlertThresholds = { leadMs: ALERT_LEAD_MS, delayMs: DELIVERY_DELAY_MS }
): Promise<AlertCandidate[]> {
  const soon = new Date(now.getTime() + thresholds.leadMs);
  const out: AlertCandidate[] = [];

  const admins = await client.user.findMany({ where: { role: 'ADMIN', status: 'ACTIVE' }, select: { id: true } });

  // Unclaimed donations about to expire → provider.
  const expiring = await client.donation.findMany({
    where: { status: { in: [...MATCHABLE_DONATION_STATUSES] }, availableUntil: { gt: now, lte: soon } },
    select: { id: true, providerId: true, foodName: true, availableUntil: true },
  });
  for (const d of expiring) {
    out.push({
      userId: d.providerId,
      type: 'EXPIRY_WARNING',
      entityType: 'Donation',
      entityId: d.id,
      title: 'Donation expiring soon',
      message: `"${d.foodName}" expires in ${minutesLeft(d.availableUntil, now)} min and has not been accepted yet.`,
    });
  }

  // Accepted donations still without a volunteer, about to expire → admins.
  const unassigned = await client.donation.findMany({
    where: { status: 'ACCEPTED', availableUntil: { gt: now, lte: soon } },
    select: { id: true, foodName: true, availableUntil: true },
  });
  for (const d of unassigned) {
    for (const a of admins) {
      out.push({
        userId: a.id,
        type: 'EXPIRY_WARNING',
        entityType: 'Donation',
        entityId: d.id,
        title: 'Pickup needs a volunteer',
        message: `Accepted donation "${d.foodName}" expires in ${minutesLeft(d.availableUntil, now)} min with no volunteer assigned.`,
      });
    }
  }

  // Open requirements about to pass their deadline → recipient users.
  const requirements = await client.requirement.findMany({
    where: { status: { in: [...MATCHABLE_REQUIREMENT_STATUSES] }, requiredBy: { gt: now, lte: soon } },
    select: {
      id: true,
      foodCategory: true,
      requiredBy: true,
      organization: { select: { users: { where: { role: 'RECIPIENT', status: 'ACTIVE' }, select: { id: true } } } },
    },
  });
  for (const r of requirements) {
    for (const u of r.organization.users) {
      out.push({
        userId: u.id,
        type: 'EXPIRY_WARNING',
        entityType: 'Requirement',
        entityId: r.id,
        title: 'Requirement deadline approaching',
        message: `Your ${r.foodCategory} requirement closes in ${minutesLeft(r.requiredBy, now)} min.`,
      });
    }
  }

  // Not yet picked up while the pickup window is closing → volunteer.
  const pickups = await client.delivery.findMany({
    where: {
      status: { in: ['ASSIGNED', 'ACCEPTED', 'AT_PICKUP'] },
      declinedAt: null,
      donation: { availableUntil: { gt: now, lte: soon } },
    },
    select: { id: true, volunteerId: true, pickupLocation: true, donation: { select: { foodName: true, availableUntil: true } } },
  });
  for (const p of pickups) {
    out.push({
      userId: p.volunteerId,
      type: 'PICKUP_REMINDER',
      entityType: 'Delivery',
      entityId: p.id,
      title: 'Pickup reminder',
      message: `Pick up "${p.donation.foodName}" at ${p.pickupLocation} within ${minutesLeft(p.donation.availableUntil, now)} min.`,
    });
  }

  // Missed pickups (window closed) and long-running transports → admins and recipients.
  const delayed = await client.delivery.findMany({
    where: {
      OR: [
        { status: { in: ['ASSIGNED', 'ACCEPTED', 'AT_PICKUP'] }, donation: { availableUntil: { lte: now } } },
        { status: { in: ['PICKED_UP', 'IN_TRANSIT'] }, pickupTime: { lte: new Date(now.getTime() - thresholds.delayMs) } },
      ],
    },
    select: {
      id: true,
      status: true,
      donation: {
        select: {
          foodName: true,
          allocations: {
            select: {
              requirement: {
                select: {
                  organization: { select: { users: { where: { role: 'RECIPIENT', status: 'ACTIVE' }, select: { id: true } } } },
                },
              },
            },
          },
        },
      },
    },
  });
  for (const d of delayed) {
    const missed = d.status === 'ASSIGNED' || d.status === 'ACCEPTED' || d.status === 'AT_PICKUP';
    const recipients = missed ? [] : d.donation.allocations.flatMap((a) => a.requirement.organization.users);
    for (const u of [...admins, ...recipients]) {
      out.push({
        userId: u.id,
        type: 'DELIVERY_DELAYED',
        entityType: 'Delivery',
        entityId: d.id,
        title: missed ? 'Pickup missed' : 'Delivery delayed',
        message: missed
          ? `The pickup window for "${d.donation.foodName}" closed before it was collected.`
          : `"${d.donation.foodName}" has been on the way for over ${Math.round(thresholds.delayMs / 60000)} min.`,
      });
    }
  }

  return out;
}

/** Drops candidates already notified for the same (user, type, entity). */
export async function withoutAlreadySent(client: PrismaClient, candidates: AlertCandidate[]): Promise<AlertCandidate[]> {
  if (candidates.length === 0) return [];
  const sent = await client.notification.findMany({
    where: {
      type: { in: [...new Set(candidates.map((c) => c.type))] },
      entityId: { in: [...new Set(candidates.map((c) => c.entityId))] },
    },
    select: { userId: true, type: true, entityType: true, entityId: true },
  });
  const key = (c: { userId: string; type: string; entityType: string | null; entityId: string | null }) =>
    `${c.userId}|${c.type}|${c.entityType}|${c.entityId}`;
  const seen = new Set(sent.map(key));
  const fresh: AlertCandidate[] = [];
  for (const c of candidates) {
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(c);
  }
  return fresh;
}

export async function sendDueAlerts(now: Date = new Date(), client: PrismaClient = getPrisma()): Promise<AlertSummary> {
  const settings = await getSettings(client);
  const candidates = await collectAlerts(client, now, {
    leadMs: settings['alerts.leadMinutes'] * 60 * 1000,
    delayMs: settings['alerts.deliveryDelayMinutes'] * 60 * 1000,
  });
  const fresh = await withoutAlreadySent(client, candidates);
  for (const c of fresh) {
    await createNotification(c, client);
  }
  return { candidates: candidates.length, sent: fresh.length };
}
