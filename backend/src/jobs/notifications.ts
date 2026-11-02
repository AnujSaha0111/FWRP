import { env } from '../config/env';
import { dispatchPendingEmails } from '../services/notificationDispatch.service';
import { sendDueAlerts } from '../services/notificationAlerts.service';
import { startIntervalJob, type IntervalJob } from './scheduler';

// NOTIF-04 + NOTIF-06: time-based alerts first (so new alerts are emailed in
// the same run), then the email outbox.

export async function runNotificationJob(now: Date = new Date()) {
  const alerts = await sendDueAlerts(now);
  const emails = await dispatchPendingEmails(now);
  return { alerts, emails };
}

export function startNotificationJob(
  intervalMinutes: number = env.NOTIFICATION_JOB_INTERVAL_MINUTES,
  run: () => Promise<unknown> = () => runNotificationJob()
): IntervalJob | null {
  return startIntervalJob('Notification job', intervalMinutes, run);
}
