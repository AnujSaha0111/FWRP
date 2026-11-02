import type { DeliveryStatus, DonationStatus } from '@prisma/client';

// LOG-02: Delivery state machine — single source of truth (docs/database.md
// §11.3, PRD FR-14). Linear; ASSIGNED → ASSIGNED reassignment is a volunteer
// change, not a status change, so it is not listed here.
export const DELIVERY_TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  ASSIGNED: ['ACCEPTED'],
  ACCEPTED: ['AT_PICKUP'],
  AT_PICKUP: ['PICKED_UP'],
  PICKED_UP: ['IN_TRANSIT'],
  IN_TRANSIT: ['DELIVERED'],
  DELIVERED: ['CONFIRMED'],
  CONFIRMED: [],
};

/** Pure predicate: is `from → to` a valid Delivery transition? */
export function canDeliveryTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses a volunteer may set through the status endpoint (field progress). */
export const VOLUNTEER_PROGRESS_STATUSES = ['AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED'] as const;
export type VolunteerProgressStatus = (typeof VOLUNTEER_PROGRESS_STATUSES)[number];

/**
 * Deliveries that occupy a volunteer (BR-05: no overlapping assignments).
 * A declined ASSIGNED row does not occupy its volunteer.
 */
export const ACTIVE_DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  'ASSIGNED',
  'ACCEPTED',
  'AT_PICKUP',
  'PICKED_UP',
  'IN_TRANSIT',
];

/** Statuses at which an admin may move the delivery to another volunteer (before pickup). */
export const REASSIGNABLE_DELIVERY_STATUSES: readonly DeliveryStatus[] = ['ASSIGNED', 'ACCEPTED'];

/**
 * Donation status that mirrors a delivery status (FR-14 sync). Statuses absent
 * here (ACCEPTED, AT_PICKUP) leave the donation at PICKUP_ASSIGNED.
 */
export const DONATION_STATUS_FOR_DELIVERY: Partial<Record<DeliveryStatus, DonationStatus>> = {
  ASSIGNED: 'PICKUP_ASSIGNED',
  PICKED_UP: 'PICKED_UP',
  IN_TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
  CONFIRMED: 'COMPLETED',
};

export interface TimeWindowLike {
  availableFrom: Date;
  availableUntil: Date;
}

/** True when two half-open windows [from, until) overlap. */
export function windowsOverlap(a: TimeWindowLike, from: Date, until: Date): boolean {
  return a.availableFrom.getTime() < until.getTime() && a.availableUntil.getTime() > from.getTime();
}
