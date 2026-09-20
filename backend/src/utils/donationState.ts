import { DonationStatus } from '@prisma/client';

export const DONATION_TRANSITIONS: Record<DonationStatus, readonly DonationStatus[]> = {
  DRAFT: ['AVAILABLE'],
  // MATCHED is an optional informational state; it does not gate acceptance.
  AVAILABLE: ['MATCHED', 'ACCEPTED', 'EXPIRED', 'CANCELLED'],
  MATCHED: ['ACCEPTED', 'EXPIRED', 'CANCELLED'],
  ACCEPTED: ['PICKUP_ASSIGNED'],
  PICKUP_ASSIGNED: ['PICKED_UP'],
  PICKED_UP: ['IN_TRANSIT'],
  IN_TRANSIT: ['DELIVERED'],
  DELIVERED: ['COMPLETED'],
  COMPLETED: [],
  EXPIRED: [],
  CANCELLED: [],
};

/** Pure predicate: is `from → to` a structurally valid Donation transition? */
export function canTransition(from: DonationStatus, to: DonationStatus): boolean {
  return DONATION_TRANSITIONS[from]?.includes(to) ?? false;
}

export const DONATION_ADMIN_OVERRIDES: Partial<Record<DonationStatus, readonly DonationStatus[]>> = {
  ACCEPTED: ['CANCELLED'],
  COMPLETED: ['AVAILABLE'],
};

/** Pure predicate: is `from → to` an authorized DON-12 ADMIN override pair? */
export function canAdminOverride(from: DonationStatus, to: DonationStatus): boolean {
  return DONATION_ADMIN_OVERRIDES[from]?.includes(to) ?? false;
}

export function donationStatusesLeadingTo(to: DonationStatus): DonationStatus[] {
  return (Object.values(DonationStatus) as DonationStatus[]).filter((from) => canTransition(from, to));
}
