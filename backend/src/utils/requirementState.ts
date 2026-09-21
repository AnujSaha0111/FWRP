import { RequirementStatus } from '@prisma/client';

export const REQUIREMENT_TRANSITIONS: Record<RequirementStatus, readonly RequirementStatus[]> = {
  OPEN: ['PARTIALLY_FULFILLED', 'EXPIRED', 'CANCELLED'],
  PARTIALLY_FULFILLED: ['FULFILLED'],
  FULFILLED: [],
  EXPIRED: [],
  CANCELLED: [],
};

/** Pure predicate: is `from → to` a structurally valid Requirement transition? */
export function canRequirementTransition(
  from: RequirementStatus,
  to: RequirementStatus
): boolean {
  return REQUIREMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function requirementStatusesLeadingTo(to: RequirementStatus): RequirementStatus[] {
  return (Object.values(RequirementStatus) as RequirementStatus[]).filter((from) =>
    canRequirementTransition(from, to)
  );
}
