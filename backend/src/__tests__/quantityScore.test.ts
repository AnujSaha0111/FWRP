import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateQuantityScore } from '../utils/quantityScore';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(testDir, '..', '..');
function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.join(backendDir, ...parts), 'utf8');
}

describe('MATCH-05 quantity compatibility scorer (MATCH-D02)', () => {
  it('exact equal positive remaining quantities → 1', () => {
    expect(calculateQuantityScore(100, 100)).toBe(1);
    expect(calculateQuantityScore(0.5, 0.5)).toBe(1);
    expect(calculateQuantityScore(1e-6, 1e-6)).toBe(1);
  });

  it('donation smaller than requirement → donation / requirement', () => {
    expect(calculateQuantityScore(20, 100)).toBeCloseTo(0.2, 10);
    expect(calculateQuantityScore(1, 3)).toBeCloseTo(1 / 3, 10);
  });

  it('requirement smaller than donation → requirement / donation', () => {
    expect(calculateQuantityScore(100, 20)).toBeCloseTo(0.2, 10);
    expect(calculateQuantityScore(3, 1)).toBeCloseTo(1 / 3, 10);
  });

  it('zero donation remaining → 0', () => {
    expect(calculateQuantityScore(0, 100)).toBe(0);
  });

  it('zero requirement remaining → 0', () => {
    expect(calculateQuantityScore(100, 0)).toBe(0);
  });

  it('negative donation remaining → 0', () => {
    expect(calculateQuantityScore(-1, 100)).toBe(0);
    expect(calculateQuantityScore(-0.0001, 5)).toBe(0);
  });

  it('negative requirement remaining → 0', () => {
    expect(calculateQuantityScore(100, -1)).toBe(0);
    expect(calculateQuantityScore(5, -0.0001)).toBe(0);
  });

  it('both non-positive → 0', () => {
    expect(calculateQuantityScore(0, 0)).toBe(0);
    expect(calculateQuantityScore(-5, -5)).toBe(0);
    expect(calculateQuantityScore(0, -5)).toBe(0);
    expect(calculateQuantityScore(-5, 0)).toBe(0);
  });

  it('non-finite inputs → 0 (defensive per MATCH-D02)', () => {
    expect(calculateQuantityScore(NaN, 100)).toBe(0);
    expect(calculateQuantityScore(100, NaN)).toBe(0);
    expect(calculateQuantityScore(Infinity, 100)).toBe(0);
    expect(calculateQuantityScore(100, Infinity)).toBe(0);
    expect(calculateQuantityScore(-Infinity, 100)).toBe(0);
    expect(calculateQuantityScore(100, -Infinity)).toBe(0);
    expect(calculateQuantityScore(NaN, NaN)).toBe(0);
  });

  it('is symmetric: either ordering yields the same score', () => {
    expect(calculateQuantityScore(20, 80)).toBe(calculateQuantityScore(80, 20));
    expect(calculateQuantityScore(7, 300)).toBe(calculateQuantityScore(300, 7));
  });

  it('always returns a finite score within [0, 1]', () => {
    const pairs: Array<[number, number]> = [
      [1, 1],
      [1, 2],
      [2, 1],
      [0, 5],
      [5, 0],
      [-1, 5],
      [5, -1],
      [1e9, 1e-9],
      [0.1, 0.3],
      [Number.MAX_SAFE_INTEGER, 1],
    ];
    for (const [donation, requirement] of pairs) {
      const score = calculateQuantityScore(donation, requirement);
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic across repeated calls', () => {
    expect(calculateQuantityScore(37, 91)).toBe(calculateQuantityScore(37, 91));
  });

  it('does not mutate its inputs', () => {
    const input = { donationRemaining: 40, requirementRemaining: 90 };
    const snapshot = { ...input };
    calculateQuantityScore(input.donationRemaining, input.requirementRemaining);
    expect(input).toEqual(snapshot);
  });
});

describe('MATCH-05 scope guards (quantity scorer only)', () => {
  const src = readRepoFile('src', 'utils', 'quantityScore.ts');
  // Assess executable code, not the explanatory doc comments.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('has no database/Prisma access or writes', () => {
    expect(code).not.toMatch(
      /prisma|getPrisma|\$transaction|\.findUnique\(|\.findMany\(|\.create\(|\.update\(|\.delete\(|\.upsert\(|\bdata\s*:/i
    );
  });

  it('does not allocate quantities or mutate persisted fields', () => {
    expect(code).not.toMatch(/allocation|committedQuantity|quantityFulfilled|status\s*:/i);
  });

  it('creates no Match records', () => {
    expect(code).not.toMatch(/\bMatch\b/);
  });

  it('does not calculate distance or geocode/network', () => {
    expect(code).not.toMatch(
      /haversine|distanceKm|toRadians|EARTH_RADIUS|MAX_DISTANCE|geocod|nominatim|mapbox|google.?maps|fetch\(|axios|XMLHttpRequest/i
    );
  });

  it('does not load matching_config or compute a weighted matching score', () => {
    expect(code).not.toMatch(/matching_config|weightedSum|matchingScore|weight/i);
  });

  it('implements no other MATCH-* scorer', () => {
    expect(code).not.toMatch(
      /foodScore|timeScore|priorityScore|distanceScore|foodCompat|timeUrgency|priorityCompat/i
    );
  });

  it('introduces no transportation or AI/ML', () => {
    expect(code).not.toMatch(/transport|volunteer|tensorflow|openai|neural|machine.?learning/i);
  });

  it('is not wired into any route module', () => {
    const routesDir = path.join(backendDir, 'src', 'routes');
    for (const file of fs.readdirSync(routesDir)) {
      const body = fs.readFileSync(path.join(routesDir, file), 'utf8');
      expect(body, `route ${file} must not wire MATCH-05`).not.toMatch(/quantityScore|calculateQuantityScore/);
    }
  });
});
