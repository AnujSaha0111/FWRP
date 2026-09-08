/**
 * Donation time-window utilities — BE-09
 * Pure functions, no DB required. Used by DON-01, ACCEPT-05, EXP-02.
 */

export interface TimeWindow {
  availableFrom: Date;
  availableUntil: Date;
}

export function validateAvailabilityWindow(
  availableFrom: Date,
  availableUntil: Date,
  now: Date = new Date()
): { valid: boolean; error?: string } {
  if (!(availableFrom instanceof Date) || isNaN(availableFrom.getTime())) {
    return { valid: false, error: 'available_from must be a valid date' };
  }
  if (!(availableUntil instanceof Date) || isNaN(availableUntil.getTime())) {
    return { valid: false, error: 'available_until must be a valid date' };
  }
  if (availableUntil.getTime() <= availableFrom.getTime()) {
    return { valid: false, error: 'available_until must be after available_from' };
  }
  if (availableUntil.getTime() <= now.getTime()) {
    return { valid: false, error: 'available_until must be in the future' };
  }
  return { valid: true };
}

export function isWithinAvailabilityWindow(window: TimeWindow, now: Date = new Date()): boolean {
  const from = window.availableFrom.getTime();
  const until = window.availableUntil.getTime();
  const t = now.getTime();
  return t >= from && t < until;
}

export function isExpired(window: TimeWindow, now: Date = new Date()): boolean {
  return now.getTime() >= window.availableUntil.getTime();
}

export function isNotYetAvailable(window: TimeWindow, now: Date = new Date()): boolean {
  return now.getTime() < window.availableFrom.getTime();
}

export function timeRemainingMs(window: TimeWindow, now: Date = new Date()): number {
  const diff = window.availableUntil.getTime() - now.getTime();
  return diff > 0 ? diff : 0;
}

export function timeRemainingHuman(window: TimeWindow, now: Date = new Date()): string {
  const ms = timeRemainingMs(window, now);
  if (ms <= 0) return 'expired';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m remaining`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `${hours}h ${remMins}m remaining`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h remaining`;
}

export function isApproachingExpiry(
  window: TimeWindow,
  thresholdMs: number = 60 * 60 * 1000,
  now: Date = new Date()
): boolean {
  const remaining = timeRemainingMs(window, now);
  return remaining > 0 && remaining <= thresholdMs;
}
