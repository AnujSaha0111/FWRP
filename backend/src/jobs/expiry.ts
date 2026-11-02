import { env } from '../config/env';
import { expireDueRecords } from '../services/expiry.service';
import { startIntervalJob, type IntervalJob } from './scheduler';

// EXP-01: marks past-window donations and past-deadline requirements EXPIRED.

export function startExpiryJob(
  intervalMinutes: number = env.EXPIRY_JOB_INTERVAL_MINUTES,
  run: () => Promise<unknown> = () => expireDueRecords()
): IntervalJob | null {
  return startIntervalJob('Expiry job', intervalMinutes, run);
}
