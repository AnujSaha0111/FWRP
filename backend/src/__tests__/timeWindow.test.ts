import { describe, it, expect } from 'vitest';
import {
  validateAvailabilityWindow,
  isWithinAvailabilityWindow,
  isExpired,
  isNotYetAvailable,
  timeRemainingMs,
  timeRemainingHuman,
  isApproachingExpiry,
} from '../utils/timeWindow';

describe('timeWindow utils — BE-09', () => {
  const now = new Date('2026-09-02T10:00:00Z');
  const from = new Date('2026-09-02T09:00:00Z');
  const until = new Date('2026-09-02T12:00:00Z');

  describe('validateAvailabilityWindow', () => {
    it('accepts valid window', () => {
      expect(validateAvailabilityWindow(from, until, now).valid).toBe(true);
    });
    it('rejects when available_until <= available_from', () => {
      expect(validateAvailabilityWindow(until, from, now).valid).toBe(false);
      expect(validateAvailabilityWindow(from, from, now).valid).toBe(false);
    });
    it('rejects when available_until is not in future', () => {
      const pastUntil = new Date('2026-09-02T09:30:00Z');
      expect(validateAvailabilityWindow(from, pastUntil, now).valid).toBe(false);
    });
    it('rejects invalid dates', () => {
      expect(validateAvailabilityWindow(new Date('invalid'), until, now).valid).toBe(false);
    });
  });

  describe('isWithinAvailabilityWindow', () => {
    it('true when now between from and until', () => {
      expect(isWithinAvailabilityWindow({ availableFrom: from, availableUntil: until }, now)).toBe(true);
    });
    it('false before from', () => {
      const early = new Date('2026-09-02T08:00:00Z');
      expect(isWithinAvailabilityWindow({ availableFrom: from, availableUntil: until }, early)).toBe(false);
    });
    it('false at exactly until (exclusive)', () => {
      expect(isWithinAvailabilityWindow({ availableFrom: from, availableUntil: until }, until)).toBe(false);
    });
    it('true at exactly from (inclusive)', () => {
      expect(isWithinAvailabilityWindow({ availableFrom: from, availableUntil: until }, from)).toBe(true);
    });
  });

  describe('isExpired / isNotYetAvailable', () => {
    it('isExpired true when now >= until', () => {
      expect(isExpired({ availableFrom: from, availableUntil: until }, until)).toBe(true);
      expect(isExpired({ availableFrom: from, availableUntil: until }, new Date('2026-09-02T13:00:00Z'))).toBe(true);
    });
    it('isNotYetAvailable true when now < from', () => {
      expect(isNotYetAvailable({ availableFrom: from, availableUntil: until }, new Date('2026-09-02T08:00:00Z'))).toBe(true);
    });
  });

  describe('timeRemainingMs', () => {
    it('returns positive ms when not expired', () => {
      expect(timeRemainingMs({ availableFrom: from, availableUntil: until }, now)).toBe(2 * 60 * 60 * 1000);
    });
    it('returns 0 when expired', () => {
      expect(timeRemainingMs({ availableFrom: from, availableUntil: until }, new Date('2026-09-02T13:00:00Z'))).toBe(0);
    });
  });

  describe('timeRemainingHuman', () => {
    it('formats minutes', () => {
      const w = { availableFrom: from, availableUntil: new Date('2026-09-02T10:30:00Z') };
      expect(timeRemainingHuman(w, now)).toBe('30m remaining');
    });
    it('returns expired', () => {
      const w = { availableFrom: from, availableUntil: new Date('2026-09-02T09:30:00Z') };
      expect(timeRemainingHuman(w, now)).toBe('expired');
    });
  });

  describe('isApproachingExpiry', () => {
    it('true within threshold', () => {
      const w = { availableFrom: from, availableUntil: new Date('2026-09-02T10:30:00Z') };
      expect(isApproachingExpiry(w, 60 * 60 * 1000, now)).toBe(true);
    });
    it('false outside threshold', () => {
      expect(isApproachingExpiry({ availableFrom: from, availableUntil: until }, 60 * 60 * 1000, now)).toBe(false);
    });
  });
});
