import { logger } from '../utils/logger';

// Shared in-process interval scheduler for background jobs (MATCH-11,
// NOTIF-04/06). Started only by the server entrypoint, never by createApp, so
// tests stay timer-free. Runs are serialized: a slow run is never overlapped
// by the next tick, and the timer never keeps the process alive on its own.

export interface IntervalJob {
  stop(): void;
  /** Runs once now (skipped if a run is already in progress). */
  runOnce(): Promise<void>;
}

export function startIntervalJob<T>(
  name: string,
  intervalMinutes: number,
  run: () => Promise<T>
): IntervalJob | null {
  if (!(intervalMinutes > 0)) {
    logger.info(`${name} job disabled`);
    return null;
  }

  let running = false;
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      const summary: unknown = await run();
      logger.info({ summary }, `${name} completed`);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, `${name} failed`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void runOnce(), intervalMinutes * 60 * 1000);
  timer.unref();
  logger.info({ intervalMinutes }, `${name} job started`);
  return { stop: () => clearInterval(timer), runOnce };
}
