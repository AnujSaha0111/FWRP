import type { Priority } from '@prisma/client';
import type { MatchingConfig } from '../config/matching';
import { calculateDistanceKm } from './distance';
import type { MatchingDonationInput, MatchingRequirementInput } from './matchingInput';
import { calculateQuantityScore } from './quantityScore';
import { windowsOverlap, type TimeWindowLike } from './deliveryState';

// MATCH-06: pure weighted scorer for one feasible Donation + Requirement pair.
// Feasibility (status, remaining quantity, time windows) is MATCH-02's job
// (checkMatchingCompatibility); this module only ranks. Deterministic: `now`
// is injectable and outputs are rounded.

export interface MatchScoreComponents {
  distance: number;
  food: number;
  quantity: number;
  priority: number;
  urgency: number;
  transport: number;
}

/** Inputs that are not part of either side of the pair. */
export interface MatchScoreContext {
  /** Availability windows of free volunteers (LOG-08). Omitted → transport 0. */
  volunteerWindows?: readonly TimeWindowLike[];
}

export interface MatchScoreResult {
  /** Weighted sum in [0, 1], rounded to 4 decimals. */
  score: number;
  /** Haversine km, rounded to 3 decimals. */
  distanceKm: number;
  components: MatchScoreComponents;
}

export type MatchScoreExclusion = 'LOCATION_UNKNOWN' | 'OUT_OF_RANGE';

export type MatchScoreOutcome =
  | { ok: true; result: MatchScoreResult }
  | { ok: false; reason: MatchScoreExclusion };

/** MATCH-D05: persisted requirement priority → score. */
export const PRIORITY_SCORES: Readonly<Record<Priority, number>> = Object.freeze({
  LOW: 0.25,
  MEDIUM: 0.5,
  HIGH: 0.75,
  CRITICAL: 1,
});

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** MATCH-D03: exact category + type → 1, same category only → 0.5, otherwise 0. */
export function calculateFoodScore(
  donation: { category: string; foodType: string },
  requirement: { foodCategory: string; foodType: string }
): number {
  if (normalize(donation.category) !== normalize(requirement.foodCategory)) return 0;
  return normalize(donation.foodType) === normalize(requirement.foodType) ? 1 : 0.5;
}

/** Linear decay: 0 km → 1, maxDistanceKm → 0. */
export function calculateDistanceScore(distanceKm: number, maxDistanceKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0 || !(maxDistanceKm > 0)) return 0;
  return Math.max(0, 1 - distanceKm / maxDistanceKm);
}

export function calculatePriorityScore(priority: Priority): number {
  return PRIORITY_SCORES[priority] ?? 0;
}

/**
 * Urgency of the earlier deadline (donation expiry or requirement deadline):
 * 1 when it is now, 0 at or beyond the horizon. Shorter windows rank higher.
 */
export function calculateUrgencyScore(
  availableUntil: Date,
  requiredBy: Date,
  horizonMs: number,
  now: Date = new Date()
): number {
  if (!(horizonMs > 0)) return 0;
  const deadline = Math.min(availableUntil.getTime(), requiredBy.getTime());
  const remaining = Math.max(0, deadline - now.getTime());
  return 1 - Math.min(remaining, horizonMs) / horizonMs;
}

/**
 * LOG-08: 1 when at least one free volunteer window overlaps the period in
 * which the pair can actually be delivered, [max(now, availableFrom),
 * min(availableUntil, requiredBy)); otherwise 0.
 */
export function calculateTransportScore(
  availableFrom: Date,
  availableUntil: Date,
  requiredBy: Date,
  windows: readonly TimeWindowLike[] | undefined,
  now: Date = new Date()
): number {
  if (!windows || windows.length === 0) return 0;
  const from = new Date(Math.max(now.getTime(), availableFrom.getTime()));
  const until = new Date(Math.min(availableUntil.getTime(), requiredBy.getTime()));
  if (until.getTime() <= from.getTime()) return 0;
  return windows.some((w) => windowsOverlap(w, from, until)) ? 1 : 0;
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function scoreMatch(
  donation: MatchingDonationInput,
  requirement: MatchingRequirementInput,
  config: MatchingConfig,
  now: Date = new Date(),
  context: MatchScoreContext = {}
): MatchScoreOutcome {
  // D-07: never fabricate a location — unknown coordinates exclude the pair.
  const distanceKm = calculateDistanceKm(
    { latitude: donation.pickupLatitude, longitude: donation.pickupLongitude },
    { latitude: requirement.organizationLatitude, longitude: requirement.organizationLongitude }
  );
  if (distanceKm === null) return { ok: false, reason: 'LOCATION_UNKNOWN' };
  if (distanceKm > config.maxDistanceKm) return { ok: false, reason: 'OUT_OF_RANGE' };

  const components: MatchScoreComponents = {
    distance: calculateDistanceScore(distanceKm, config.maxDistanceKm),
    food: calculateFoodScore(donation, requirement),
    quantity: calculateQuantityScore(donation.remainingQuantity, requirement.remainingQuantity),
    priority: calculatePriorityScore(requirement.priority),
    urgency: calculateUrgencyScore(
      donation.availableUntil,
      requirement.requiredBy,
      config.urgencyHorizonMs,
      now
    ),
    transport: calculateTransportScore(
      donation.availableFrom,
      donation.availableUntil,
      requirement.requiredBy,
      context.volunteerWindows,
      now
    ),
  };

  const w = config.weights;
  const total = w.distance + w.food + w.quantity + w.priority + w.urgency + w.transport;
  const weighted =
    total > 0
      ? (components.distance * w.distance +
          components.food * w.food +
          components.quantity * w.quantity +
          components.priority * w.priority +
          components.urgency * w.urgency +
          components.transport * w.transport) /
        total
      : 0;

  return {
    ok: true,
    result: {
      score: round(weighted, 4),
      distanceKm: round(distanceKm, 3),
      components: {
        distance: round(components.distance, 4),
        food: components.food,
        quantity: round(components.quantity, 4),
        priority: components.priority,
        urgency: round(components.urgency, 4),
        transport: components.transport,
      },
    },
  };
}
