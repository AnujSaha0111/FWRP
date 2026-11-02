import type { NotificationType, PrismaClient } from '@prisma/client';
import { getPrisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { emailService as defaultEmailService, type EmailService } from './email.service';

// ---------------------------------------------------------------------------
// NOTIF-06: email outbox. Notifications are created inside business
// transactions; emailing there could send mail for a rolled-back change. This
// dispatcher runs after commit (scheduled job) and emails committed rows of the
// key event types, at most MAX_EMAIL_ATTEMPTS times each.
//
// Each row is claimed with a conditional update (attempt counter) before
// sending, so two instances never email the same notification twice.

export const EMAIL_NOTIFICATION_TYPES: readonly NotificationType[] = [
  'DONATION_ACCEPTED',
  'PICKUP_ASSIGNED',
  'PICKUP_REMINDER',
  'DELIVERY_DELAYED',
  'EXPIRY_WARNING',
  'DONATION_EXPIRED',
  'CONFIRMATION_PENDING',
  'DELIVERY_COMPLETED',
  'ORGANIZATION_VERIFIED',
  'ORGANIZATION_REJECTED',
  'INCIDENT_UPDATED',
];

export const MAX_EMAIL_ATTEMPTS = 3;
/** Rows older than this are never emailed (stale news, and pre-feature rows). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 50;

export interface DispatchSummary {
  scanned: number;
  sent: number;
  failed: number;
  skipped: number;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderNotificationEmail(name: string, title: string, message: string) {
  const text = `Hi ${name},\n\n${message}\n\n— Food Waste Redistribution Platform`;
  const html =
    `<p>Hi ${escapeHtml(name)},</p><p>${escapeHtml(message)}</p>` +
    `<p style="color:#666">— Food Waste Redistribution Platform</p>`;
  return { subject: `FWRP: ${title}`.replace(/[\r\n]+/g, ' ').slice(0, 500), text, html };
}

export async function dispatchPendingEmails(
  now: Date = new Date(),
  email: EmailService = defaultEmailService,
  client: PrismaClient = getPrisma()
): Promise<DispatchSummary> {
  const rows = await client.notification.findMany({
    where: {
      emailedAt: null,
      emailAttempts: { lt: MAX_EMAIL_ATTEMPTS },
      type: { in: [...EMAIL_NOTIFICATION_TYPES] },
      createdAt: { gte: new Date(now.getTime() - MAX_AGE_MS) },
    },
    select: {
      id: true,
      type: true,
      title: true,
      message: true,
      emailAttempts: true,
      user: { select: { email: true, name: true, status: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: BATCH_SIZE,
  });

  const summary: DispatchSummary = { scanned: rows.length, sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    // Claim: only one dispatcher wins this attempt.
    const claimed = await client.notification.updateMany({
      where: { id: row.id, emailedAt: null, emailAttempts: row.emailAttempts },
      data: { emailAttempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;

    if (row.user.status !== 'ACTIVE') {
      // Never email suspended/deleted accounts; retire the row.
      await client.notification.update({ where: { id: row.id }, data: { emailAttempts: MAX_EMAIL_ATTEMPTS } });
      summary.skipped += 1;
      continue;
    }

    try {
      const body = renderNotificationEmail(row.user.name, row.title, row.message);
      await email.send({ to: row.user.email, type: row.type, ...body });
      await client.notification.update({ where: { id: row.id }, data: { emailedAt: now } });
      summary.sent += 1;
    } catch (err) {
      summary.failed += 1;
      // Metadata only: never the address or body.
      logger.warn(
        { notificationId: row.id, attempt: row.emailAttempts + 1, code: (err as { code?: string }).code },
        'Notification email failed'
      );
    }
  }
  return summary;
}
