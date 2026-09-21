import type { DonationStatus, RequirementStatus } from '@prisma/client';
import { isExpired } from './timeWindow';
import type { MatchingDonationInput, MatchingRequirementInput } from './matchingInput';

/** Donation statuses eligible to participate in matching (D-05/ADR-005). */
export const MATCHABLE_DONATION_STATUSES: readonly DonationStatus[] = ['AVAILABLE', 'MATCHED'];

/** Requirement statuses with remaining demand eligible for matching. */
export const MATCHABLE_REQUIREMENT_STATUSES: readonly RequirementStatus[] = [
  'OPEN',
  'PARTIALLY_FULFILLED',
];

/**
 * Deterministic rejection reason codes, listed in fixed evaluation order.
 * `reasons` is empty exactly when `compatible` is true.
 */
export const MATCHING_INCOMPATIBILITY_REASONS = [
  'DONATION_STATUS_NOT_MATCHABLE',
  'REQUIREMENT_STATUS_NOT_MATCHABLE',
  'DONATION_NO_REMAINING_QUANTITY',
  'REQUIREMENT_NO_REMAINING_QUANTITY',
  'DONATION_EXPIRED',
  'REQUIREMENT_DEADLINE_PASSED',
  'DONATION_NOT_AVAILABLE_BEFORE_DEADLINE',
] as const;

export type MatchingIncompatibilityReason = (typeof MATCHING_INCOMPATIBILITY_REASONS)[number];

export interface MatchingCompatibilityResult {
  compatible: boolean;
  /** Ordered infeasibility reasons; empty when `compatible` is true. */
  reasons: MatchingIncompatibilityReason[];
}

/** Pure predicate: can this donation status participate in matching? */
export function isDonationStatusMatchable(status: DonationStatus): boolean {
  return MATCHABLE_DONATION_STATUSES.includes(status);
}

/** Pure predicate: can this requirement status participate in matching? */
export function isRequirementStatusMatchable(status: RequirementStatus): boolean {
  return MATCHABLE_REQUIREMENT_STATUSES.includes(status);
}

/**
 * Pure feasibility check for one Donation + Requirement pair. `now` is
 * injectable for deterministic tests; it defaults to the current time.
 */
export function checkMatchingCompatibility(
  donation: MatchingDonationInput,
  requirement: MatchingRequirementInput,
  now: Date = new Date()
): MatchingCompatibilityResult {
  const reasons: MatchingIncompatibilityReason[] = [];

  if (!isDonationStatusMatchable(donation.status)) {
    reasons.push('DONATION_STATUS_NOT_MATCHABLE');
  }
  if (!isRequirementStatusMatchable(requirement.status)) {
    reasons.push('REQUIREMENT_STATUS_NOT_MATCHABLE');
  }
  if (!(donation.remainingQuantity > 0)) {
    reasons.push('DONATION_NO_REMAINING_QUANTITY');
  }
  if (!(requirement.remainingQuantity > 0)) {
    reasons.push('REQUIREMENT_NO_REMAINING_QUANTITY');
  }
  if (isExpired({ availableFrom: donation.availableFrom, availableUntil: donation.availableUntil }, now)) {
    reasons.push('DONATION_EXPIRED');
  }
  if (requirement.requiredBy.getTime() <= now.getTime()) {
    reasons.push('REQUIREMENT_DEADLINE_PASSED');
  }
  if (donation.availableFrom.getTime() >= requirement.requiredBy.getTime()) {
    reasons.push('DONATION_NOT_AVAILABLE_BEFORE_DEADLINE');
  }

  return { compatible: reasons.length === 0, reasons };
}
