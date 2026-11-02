import { env } from '../config/env';
import { refreshAllActiveMatches } from '../services/matching.service';
import { startIntervalJob, type IntervalJob } from './scheduler';

// MATCH-11: periodic match maintenance (re-scoring keeps urgency and transport
// current; stale recommendations expire).

export type MatchingRefreshJob = IntervalJob;

export function startMatchingRefreshJob(
  intervalMinutes: number = env.MATCHING_REFRESH_INTERVAL_MINUTES,
  run: typeof refreshAllActiveMatches = refreshAllActiveMatches
): MatchingRefreshJob | null {
  return startIntervalJob('Matching refresh', intervalMinutes, () => run());
}
