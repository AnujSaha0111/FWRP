import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DonationStatus, RequirementStatus } from '@prisma/client';
import {
  MATCHABLE_DONATION_STATUSES,
  MATCHABLE_REQUIREMENT_STATUSES,
  MATCHING_INCOMPATIBILITY_REASONS,
  checkMatchingCompatibility,
  isDonationStatusMatchable,
  isRequirementStatusMatchable,
  type MatchingCompatibilityResult,
} from '../utils/matchingCompatibility';
import type { MatchingDonationInput, MatchingRequirementInput } from '../utils/matchingInput';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');
function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.join(backendDir, ...parts), 'utf8');
}

const NOW = new Date('2026-09-20T12:00:00.000Z');
const at = (iso: string) => new Date(iso);

function donation(overrides: Partial<MatchingDonationInput> = {}): MatchingDonationInput {
  return {
    id: 'don-1',
    pickupLocation: '12 Main St, Springfield',
    pickupLatitude: 40.7128,
    pickupLongitude: -74.006,
    category: 'Prepared meals',
    foodType: 'Vegetarian',
    quantity: 120,
    committedQuantity: 0,
    remainingQuantity: 120,
    availableFrom: at('2026-09-20T10:00:00.000Z'),
    availableUntil: at('2026-09-20T22:00:00.000Z'),
    status: 'AVAILABLE',
    createdAt: at('2026-09-20T09:00:00.000Z'),
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
    quantityFulfilled: 20,
    remainingQuantity: 80,
    requiredBy: at('2026-09-21T10:00:00.000Z'),
    priority: 'HIGH',
    location: 'XYZ Shelter, Springfield',
    organizationLatitude: 40.73,
    organizationLongitude: -73.99,
    status: 'OPEN',
    createdAt: at('2026-09-19T09:00:00.000Z'),
    ...overrides,
  };
}

function check(
  d: Partial<MatchingDonationInput> = {},
  r: Partial<MatchingRequirementInput> = {}
): MatchingCompatibilityResult {
  return checkMatchingCompatibility(donation(d), requirement(r), NOW);
}

describe('MATCH-02 status eligibility (feasibility gate only)', () => {
  it('treats AVAILABLE and MATCHED donations as matchable (D-05/ADR-005)', () => {
    expect([...MATCHABLE_DONATION_STATUSES].sort()).toEqual(['AVAILABLE', 'MATCHED']);
    expect(isDonationStatusMatchable('AVAILABLE')).toBe(true);
    expect(isDonationStatusMatchable('MATCHED')).toBe(true);
  });

  it('excludes DRAFT and every committed/terminal donation status', () => {
    const excluded: DonationStatus[] = [
      'DRAFT',
      'ACCEPTED',
      'PICKUP_ASSIGNED',
      'PICKED_UP',
      'IN_TRANSIT',
      'DELIVERED',
      'COMPLETED',
      'EXPIRED',
      'CANCELLED',
    ];
    for (const status of excluded) {
      expect(isDonationStatusMatchable(status)).toBe(false);
      const result = check({ status });
      expect(result.compatible).toBe(false);
      expect(result.reasons).toContain('DONATION_STATUS_NOT_MATCHABLE');
    }
  });

  it('treats OPEN and PARTIALLY_FULFILLED requirements as matchable', () => {
    expect([...MATCHABLE_REQUIREMENT_STATUSES].sort()).toEqual(['OPEN', 'PARTIALLY_FULFILLED']);
    for (const status of MATCHABLE_REQUIREMENT_STATUSES) {
      expect(isRequirementStatusMatchable(status)).toBe(true);
      expect(check({}, { status }).compatible).toBe(true);
    }
  });

  it('excludes terminal requirement statuses', () => {
    const excluded: RequirementStatus[] = ['FULFILLED', 'EXPIRED', 'CANCELLED'];
    for (const status of excluded) {
      expect(isRequirementStatusMatchable(status)).toBe(false);
      const result = check({}, { status });
      expect(result.compatible).toBe(false);
      expect(result.reasons).toContain('REQUIREMENT_STATUS_NOT_MATCHABLE');
    }
  });
});

describe('MATCH-02 remaining-quantity feasibility', () => {
  it('accepts an eligible donation + eligible requirement', () => {
    expect(check()).toEqual({ compatible: true, reasons: [] });
  });

  it('rejects a donation with no derived remaining quantity', () => {
    for (const remainingQuantity of [0, -5]) {
      const result = check({ committedQuantity: 120, remainingQuantity });
      expect(result.compatible).toBe(false);
      expect(result.reasons).toEqual(['DONATION_NO_REMAINING_QUANTITY']);
    }
  });

  it('rejects a requirement with no derived remaining demand', () => {
    for (const remainingQuantity of [0, -1]) {
      const result = check({}, { quantityFulfilled: 100, remainingQuantity });
      expect(result.compatible).toBe(false);
      expect(result.reasons).toEqual(['REQUIREMENT_NO_REMAINING_QUANTITY']);
    }
  });

  it('allows a partial contribution (D-06 Model A): donation < requirement', () => {
    expect(check({ quantity: 20, committedQuantity: 0, remainingQuantity: 20 }, { remainingQuantity: 100 }))
      .toEqual({ compatible: true, reasons: [] });
  });

  it('does not require exact quantity equality (surplus is allowed)', () => {
    expect(check({ remainingQuantity: 120 }, { remainingQuantity: 100 }).compatible).toBe(true);
    expect(check({ remainingQuantity: 500 }, { remainingQuantity: 1 }).compatible).toBe(true);
  });
});

describe('MATCH-02 time feasibility (requiredBy boundary)', () => {
  it('rejects an expired donation using timeWindow semantics', () => {
    // availableUntil === now is expired (isExpired uses now >= availableUntil).
    expect(check({ availableUntil: NOW }).reasons).toEqual(['DONATION_EXPIRED']);
    expect(check({ availableUntil: at('2026-09-20T11:59:59.000Z') }).reasons).toEqual([
      'DONATION_EXPIRED',
    ]);
  });

  it('rejects a requirement whose deadline has passed (strict boundary)', () => {
    expect(check({}, { requiredBy: at('2026-09-20T11:00:00.000Z') }).reasons).toEqual([
      'REQUIREMENT_DEADLINE_PASSED',
    ]);
    // requiredBy exactly now is already passed.
    expect(check({}, { requiredBy: NOW }).reasons).toEqual(['REQUIREMENT_DEADLINE_PASSED']);
  });

  it('accepts a donation whose availability ends after requiredBy', () => {
    const result = check(
      { availableUntil: at('2026-09-25T00:00:00.000Z') },
      { requiredBy: at('2026-09-21T10:00:00.000Z') }
    );
    expect(result).toEqual({ compatible: true, reasons: [] });
  });

  it('requires the donation to become available strictly before requiredBy', () => {
    const requiredBy = at('2026-09-21T10:00:00.000Z');
    const availableUntil = at('2026-09-22T00:00:00.000Z');
    // availableFrom exactly at the deadline cannot deliver in time.
    expect(check({ availableFrom: requiredBy, availableUntil }, { requiredBy }).reasons).toEqual([
      'DONATION_NOT_AVAILABLE_BEFORE_DEADLINE',
    ]);
    // availableFrom after the deadline.
    expect(
      check({ availableFrom: at('2026-09-22T00:00:00.000Z'), availableUntil }, { requiredBy }).reasons
    ).toEqual(['DONATION_NOT_AVAILABLE_BEFORE_DEADLINE']);
    // availableFrom one millisecond before the deadline is feasible.
    expect(
      check(
        { availableFrom: new Date(requiredBy.getTime() - 1), availableUntil },
        { requiredBy }
      ).compatible
    ).toBe(true);
  });

  it('handles not-yet-available donations that CAN become available before the deadline', () => {
    const result = check({
      availableFrom: at('2026-09-20T18:00:00.000Z'),
      availableUntil: at('2026-09-20T22:00:00.000Z'),
    });
    expect(result).toEqual({ compatible: true, reasons: [] });
  });

  it('lists multiple independent infeasibility reasons in deterministic order', () => {
    const result = check(
      {
        status: 'CANCELLED',
        committedQuantity: 120,
        remainingQuantity: 0,
        availableFrom: at('2026-09-20T10:00:00.000Z'),
        availableUntil: NOW,
      },
      { status: 'CANCELLED', quantityFulfilled: 100, remainingQuantity: 0, requiredBy: NOW }
    );
    expect(result.compatible).toBe(false);
    expect(result.reasons).toEqual([
      'DONATION_STATUS_NOT_MATCHABLE',
      'REQUIREMENT_STATUS_NOT_MATCHABLE',
      'DONATION_NO_REMAINING_QUANTITY',
      'REQUIREMENT_NO_REMAINING_QUANTITY',
      'DONATION_EXPIRED',
      'REQUIREMENT_DEADLINE_PASSED',
    ]);
  });
});

describe('MATCH-02 food compatibility is NOT a hard filter (MATCH-D03 boundary)', () => {
  it('does not inspect category/foodType: all food combinations remain feasible', () => {
    const combos = [
      { category: 'Prepared meals', foodType: 'Vegetarian' },
      { category: 'Prepared meals', foodType: 'Non-vegetarian' },
      { category: 'Bakery', foodType: 'Bread' },
      { category: '', foodType: '' },
    ];
    for (const c of combos) {
      const result = check(c, {
        foodCategory: 'Prepared meals',
        foodType: 'Vegetarian',
      });
      expect(result).toEqual({ compatible: true, reasons: [] });
    }
  });

  it('keeps category-only (0.5) and category-mismatch (0.0) pairs eligible for scoring', () => {
    // Same category, different foodType -> MATCH-D03 foodScore 0.5, not excluded.
    expect(check({}, { foodType: 'Non-vegetarian' }).compatible).toBe(true);
    // Different category -> MATCH-D03 foodScore 0.0, still not an eligibility gate.
    expect(check({ category: 'Bakery' }, { foodCategory: 'Prepared meals' }).compatible).toBe(true);
  });

  it('result exposes no food/score fields', () => {
    const result = check();
    expect(Object.keys(result).sort()).toEqual(['compatible', 'reasons']);
    expect('foodScore' in result).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/score|food/i);
  });
});

describe('MATCH-02 location/distance boundary (D-07)', () => {
  it('is independent of coordinates and never fabricates geocoding', () => {
    const result = check(
      { pickupLatitude: null, pickupLongitude: null },
      { organizationLatitude: null, organizationLongitude: null }
    );
    expect(result).toEqual({ compatible: true, reasons: [] });
    // Coordinates present vs absent yields identical feasibility.
    expect(check({ pickupLatitude: 1, pickupLongitude: 2 })).toEqual(result);
  });
});

describe('MATCH-02 determinism and purity', () => {
  it('is deterministic: same inputs and now produce identical results', () => {
    const d = donation({ availableUntil: at('2026-09-20T23:00:00.000Z') });
    const r = requirement();
    const first = checkMatchingCompatibility(d, r, NOW);
    const second = checkMatchingCompatibility(d, r, NOW);
    expect(second).toEqual(first);
    expect(() => JSON.stringify(first)).not.toThrow();
  });

  it('does not mutate its inputs', () => {
    const d = donation();
    const r = requirement();
    const dSnapshot = { ...d };
    const rSnapshot = { ...r };
    checkMatchingCompatibility(d, r, NOW);
    expect(d).toEqual(dSnapshot);
    expect(r).toEqual(rSnapshot);
  });
});

describe('MATCH-02 scope guards (no later-task leakage)', () => {
  const src = readRepoFile('src', 'utils', 'matchingCompatibility.ts');
  // Assess executable code, not the explanatory doc comments.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('introduces no Haversine/distance computation', () => {
    expect(code).not.toMatch(/haversine|distanceKm|distanceScore|toRadians|EARTH_RADIUS/i);
  });

  it('introduces no scoring, weights, or matching_config', () => {
    expect(code).not.toMatch(/quantityScore|foodScore|timeScore|priorityScore|weightedSum|matchingScore/i);
    expect(code).not.toMatch(/matching_config|matchingConfig|weight/i);
    expect(code).not.toMatch(/\bscore\s*\(/i);
  });

  it('introduces no Match persistence, Allocation writes, or DB access', () => {
    expect(code).not.toMatch(/\.create\(|\.update\(|\.updateMany\(|\.delete\(|\$transaction/);
    expect(code).not.toMatch(/\ballocation\b|\bMatch\b/);
    expect(code).not.toMatch(/\.findUnique\(|\.findMany\(|\.aggregate\(|\bdata\s*:/);
  });

  it('introduces no status/quantity mutation of Donation or Requirement', () => {
    expect(code).not.toMatch(/quantityFulfilled\s*[:=]|quantityFulfilled\s*\+/);
    expect(code).not.toMatch(/status\s*:\s*['"]/);
    expect(code).not.toMatch(/canRequirementTransition|canTransition|deriveRequirementStatus/);
  });

  it('introduces no geocoding, transportation schema, or AI/ML', () => {
    expect(code).not.toMatch(/geocod|nominatim|mapbox|google.?maps|postgis|ST_DWithin/i);
    expect(code).not.toMatch(/transport|volunteer|tensorflow|openai|ml\b/i);
  });

  it('imports no HTTP/route/database layers', () => {
    expect(code).not.toMatch(/from ['"].*(express|routes|controllers|services)/i);
    expect(code).not.toMatch(/getPrisma|PrismaClient/);
  });

  it('is not wired into any route module (matches stays a placeholder)', () => {
    const matchesRoute = readRepoFile('src', 'routes', 'matches.ts');
    expect(matchesRoute).toMatch(/createPlaceholderRouter/);
    expect(matchesRoute).not.toMatch(/matchingCompatibility|checkMatchingCompatibility/);
    // Full route surface scan: only tests import the MATCH-02 module for now.
    const routesDir = path.join(backendDir, 'src', 'routes');
    for (const file of fs.readdirSync(routesDir)) {
      const body = fs.readFileSync(path.join(routesDir, file), 'utf8');
      expect(body, `route ${file} must not wire MATCH-02`).not.toMatch(/matchingCompatibility/);
    }
  });

  it('declares the full ordered reason list used by the gate', () => {
    expect([...MATCHING_INCOMPATIBILITY_REASONS]).toEqual([
      'DONATION_STATUS_NOT_MATCHABLE',
      'REQUIREMENT_STATUS_NOT_MATCHABLE',
      'DONATION_NO_REMAINING_QUANTITY',
      'REQUIREMENT_NO_REMAINING_QUANTITY',
      'DONATION_EXPIRED',
      'REQUIREMENT_DEADLINE_PASSED',
      'DONATION_NOT_AVAILABLE_BEFORE_DEADLINE',
    ]);
  });
});
