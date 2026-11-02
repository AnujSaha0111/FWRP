import { env } from './env';

// MATCH-06: deterministic matching configuration (PRD §1, §4.2). Weights sum
// to 1 so the combined score stays in [0, 1]. LOG-08 adds transportation
// availability (free volunteer windows) as a component.

export interface MatchingWeights {
  distance: number;
  food: number;
  quantity: number;
  priority: number;
  urgency: number;
  transport: number;
}

export interface MatchingConfig {
  weights: MatchingWeights;
  /** Pairs farther apart than this are excluded (hard radius). */
  maxDistanceKm: number;
  /** Deadlines at or beyond this horizon score 0 urgency; imminent ones approach 1. */
  urgencyHorizonMs: number;
  /** Upper bound on candidates evaluated per generation run. */
  candidateLimit: number;
}

export const DEFAULT_MATCHING_WEIGHTS: Readonly<MatchingWeights> = Object.freeze({
  distance: 0.25,
  food: 0.25,
  quantity: 0.15,
  priority: 0.15,
  urgency: 0.1,
  transport: 0.1,
});

export function getMatchingConfig(): MatchingConfig {
  return {
    weights: { ...DEFAULT_MATCHING_WEIGHTS },
    maxDistanceKm: env.MATCHING_MAX_DISTANCE_KM,
    urgencyHorizonMs: 24 * 60 * 60 * 1000,
    candidateLimit: 500,
  };
}
