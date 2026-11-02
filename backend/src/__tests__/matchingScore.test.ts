import { describe, it, expect } from 'vitest';
import { DEFAULT_MATCHING_WEIGHTS, type MatchingConfig } from '../config/matching';
import type { MatchingDonationInput, MatchingRequirementInput } from '../utils/matchingInput';
import {
  calculateTransportScore,
  calculateDistanceScore,
  calculateFoodScore,
  calculatePriorityScore,
  calculateUrgencyScore,
  scoreMatch,
} from '../utils/matchingScore';

// MATCH-06: weighted scorer. Pure, deterministic, no DB.

const NOW = new Date('2026-09-20T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const CONFIG: MatchingConfig = {
  weights: { ...DEFAULT_MATCHING_WEIGHTS },
  maxDistanceKm: 50,
  urgencyHorizonMs: 24 * HOUR,
  candidateLimit: 500,
};

function donation(overrides: Partial<MatchingDonationInput> = {}): MatchingDonationInput {
  return {
    id: 'don-1',
    pickupLocation: 'Main St',
    pickupLatitude: 52.52,
    pickupLongitude: 13.405,
    category: 'Prepared meals',
    foodType: 'Vegetarian',
    quantity: 100,
    committedQuantity: 0,
    remainingQuantity: 100,
    availableFrom: new Date(NOW.getTime() - HOUR),
    availableUntil: new Date(NOW.getTime() + 48 * HOUR),
    status: 'AVAILABLE',
    createdAt: NOW,
    ...overrides,
  };
}

function requirement(overrides: Partial<MatchingRequirementInput> = {}): MatchingRequirementInput {
  return {
    id: 'req-1',
    organizationId: 'org-1',
    foodCategory: 'Prepared meals',
    foodType: 'Vegetarian',
    quantityRequired: 100,
    quantityFulfilled: 0,
    remainingQuantity: 100,
    requiredBy: new Date(NOW.getTime() + 48 * HOUR),
    priority: 'MEDIUM',
    location: 'Shelter',
    organizationLatitude: 52.52,
    organizationLongitude: 13.405,
    status: 'OPEN',
    createdAt: NOW,
    ...overrides,
  };
}

describe('MATCH-06 component scores', () => {
  it('food score follows MATCH-D03 (exact 1, category-only 0.5, mismatch 0), case-insensitive', () => {
    expect(calculateFoodScore({ category: 'Bakery', foodType: 'Bread' }, { foodCategory: 'bakery ', foodType: 'BREAD' })).toBe(1);
    expect(calculateFoodScore({ category: 'Bakery', foodType: 'Bread' }, { foodCategory: 'Bakery', foodType: 'Cake' })).toBe(0.5);
    expect(calculateFoodScore({ category: 'Bakery', foodType: 'Bread' }, { foodCategory: 'Dairy', foodType: 'Bread' })).toBe(0);
  });

  it('distance score decays linearly to 0 at the radius', () => {
    expect(calculateDistanceScore(0, 50)).toBe(1);
    expect(calculateDistanceScore(25, 50)).toBe(0.5);
    expect(calculateDistanceScore(50, 50)).toBe(0);
    expect(calculateDistanceScore(80, 50)).toBe(0);
    expect(calculateDistanceScore(Number.NaN, 50)).toBe(0);
    expect(calculateDistanceScore(-1, 50)).toBe(0);
  });

  it('priority score follows MATCH-D05 ordering', () => {
    expect(calculatePriorityScore('LOW')).toBeLessThan(calculatePriorityScore('MEDIUM'));
    expect(calculatePriorityScore('MEDIUM')).toBeLessThan(calculatePriorityScore('HIGH'));
    expect(calculatePriorityScore('HIGH')).toBeLessThan(calculatePriorityScore('CRITICAL'));
    expect(calculatePriorityScore('CRITICAL')).toBe(1);
  });

  it('urgency uses the earlier deadline and saturates at the horizon', () => {
    const far = new Date(NOW.getTime() + 72 * HOUR);
    expect(calculateUrgencyScore(far, far, 24 * HOUR, NOW)).toBe(0);
    expect(calculateUrgencyScore(new Date(NOW.getTime() + 12 * HOUR), far, 24 * HOUR, NOW)).toBe(0.5);
    expect(calculateUrgencyScore(far, new Date(NOW.getTime() + 6 * HOUR), 24 * HOUR, NOW)).toBe(0.75);
    expect(calculateUrgencyScore(NOW, far, 24 * HOUR, NOW)).toBe(1);
  });
});

describe('LOG-08 transport component', () => {
  const from = new Date(NOW.getTime() - HOUR);
  const until = new Date(NOW.getTime() + 6 * HOUR);
  const requiredBy = new Date(NOW.getTime() + 4 * HOUR);

  it('is 1 only when a free volunteer window overlaps [max(now, from), min(until, requiredBy))', () => {
    const inside = { availableFrom: new Date(NOW.getTime() + HOUR), availableUntil: new Date(NOW.getTime() + 2 * HOUR) };
    const afterDeadline = { availableFrom: new Date(NOW.getTime() + 5 * HOUR), availableUntil: until };
    const past = { availableFrom: new Date(NOW.getTime() - 3 * HOUR), availableUntil: new Date(NOW.getTime() - HOUR) };
    expect(calculateTransportScore(from, until, requiredBy, [inside], NOW)).toBe(1);
    expect(calculateTransportScore(from, until, requiredBy, [afterDeadline, past], NOW)).toBe(0);
  });

  it('is 0 without volunteer data or when the delivery window is empty', () => {
    expect(calculateTransportScore(from, until, requiredBy, undefined, NOW)).toBe(0);
    expect(calculateTransportScore(from, until, requiredBy, [], NOW)).toBe(0);
    const w = { availableFrom: from, availableUntil: until };
    expect(calculateTransportScore(from, until, new Date(NOW.getTime() - 1), [w], NOW)).toBe(0);
  });
});

describe('MATCH-06 scoreMatch', () => {
  it('a perfect, co-located, critical, imminent, transportable pair scores 1', () => {
    const outcome = scoreMatch(
      donation({ availableUntil: new Date(NOW.getTime() + 1) }),
      requirement({ priority: 'CRITICAL' }),
      CONFIG,
      NOW,
      { volunteerWindows: [{ availableFrom: NOW, availableUntil: new Date(NOW.getTime() + HOUR) }] }
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.score).toBe(1);
      expect(outcome.result.distanceKm).toBe(0);
    }
  });

  it('combines components with the configured weights', () => {
    // food 0.5, quantity 0.5, priority 0.5 (MEDIUM), urgency 0, distance 1, transport 0.
    const outcome = scoreMatch(
      donation({ remainingQuantity: 50 }),
      requirement({ foodType: 'Vegan' }),
      CONFIG,
      NOW
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const expected = 0.25 * 1 + 0.25 * 0.5 + 0.15 * 0.5 + 0.15 * 0.5 + 0.1 * 0 + 0.1 * 0;
      expect(outcome.result.score).toBeCloseTo(expected, 4);
      expect(outcome.result.components).toEqual({
        distance: 1,
        food: 0.5,
        quantity: 0.5,
        priority: 0.5,
        urgency: 0,
        transport: 0,
      });
    }
  });

  it('ranks closer, better-fitting pairs higher', () => {
    const near = scoreMatch(donation(), requirement(), CONFIG, NOW);
    // ~11 km north
    const far = scoreMatch(donation(), requirement({ organizationLatitude: 52.62 }), CONFIG, NOW);
    expect(near.ok && far.ok).toBe(true);
    if (near.ok && far.ok) expect(near.result.score).toBeGreaterThan(far.result.score);
  });

  it('excludes pairs beyond the matching radius', () => {
    // Berlin → Hamburg (~255 km)
    const outcome = scoreMatch(
      donation(),
      requirement({ organizationLatitude: 53.55, organizationLongitude: 9.99 }),
      CONFIG,
      NOW
    );
    expect(outcome).toEqual({ ok: false, reason: 'OUT_OF_RANGE' });
  });

  it('never fabricates a location (D-07): unknown coordinates exclude the pair', () => {
    expect(scoreMatch(donation({ pickupLatitude: null }), requirement(), CONFIG, NOW)).toEqual({
      ok: false,
      reason: 'LOCATION_UNKNOWN',
    });
    expect(scoreMatch(donation(), requirement({ organizationLongitude: null }), CONFIG, NOW)).toEqual({
      ok: false,
      reason: 'LOCATION_UNKNOWN',
    });
  });

  it('is deterministic and does not mutate inputs', () => {
    const d = donation();
    const r = requirement();
    const snapshot = JSON.stringify([d, r]);
    expect(scoreMatch(d, r, CONFIG, NOW)).toEqual(scoreMatch(d, r, CONFIG, NOW));
    expect(JSON.stringify([d, r])).toBe(snapshot);
  });

  it('keeps the score in [0, 1] for all priority/food combinations', () => {
    for (const priority of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const) {
      for (const foodCategory of ['Prepared meals', 'Dairy']) {
        const outcome = scoreMatch(donation(), requirement({ priority, foodCategory }), CONFIG, NOW);
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.result.score).toBeGreaterThanOrEqual(0);
          expect(outcome.result.score).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
