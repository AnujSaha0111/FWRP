import type { DeliveryStatus, DonationStatus, VerificationStatus } from '@/api/types';
import { Badge, type Tone } from '@/components/ui/surface';

// Plain-language status labels. Color is never the only signal: every badge
// carries its text.

export const DONATION_STATUS: Record<DonationStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  AVAILABLE: { label: 'Available', tone: 'info' },
  MATCHED: { label: 'Matched', tone: 'info' },
  ACCEPTED: { label: 'Accepted', tone: 'warning' },
  PICKUP_ASSIGNED: { label: 'Volunteer assigned', tone: 'warning' },
  PICKED_UP: { label: 'Picked up', tone: 'warning' },
  IN_TRANSIT: { label: 'On the way', tone: 'warning' },
  DELIVERED: { label: 'Delivered', tone: 'success' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};

export const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; tone: Tone }> = {
  ASSIGNED: { label: 'Assigned', tone: 'warning' },
  ACCEPTED: { label: 'Volunteer confirmed', tone: 'warning' },
  AT_PICKUP: { label: 'At pickup', tone: 'warning' },
  PICKED_UP: { label: 'Picked up', tone: 'warning' },
  IN_TRANSIT: { label: 'On the way', tone: 'warning' },
  DELIVERED: { label: 'Delivered', tone: 'success' },
  CONFIRMED: { label: 'Receipt confirmed', tone: 'success' },
};

const VERIFICATION: Record<VerificationStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending verification', tone: 'warning' },
  UNDER_REVIEW: { label: 'Under review', tone: 'info' },
  VERIFIED: { label: 'Verified', tone: 'success' },
  REJECTED: { label: 'Not verified', tone: 'danger' },
};

export function DonationStatusBadge({ status }: { status: DonationStatus }) {
  const s = DONATION_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const s = DELIVERY_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function VerificationBadge({ status }: { status: VerificationStatus }) {
  const s = VERIFICATION[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Donation statuses a provider may still edit or cancel (backend rules). */
export const EDITABLE: readonly DonationStatus[] = ['DRAFT', 'AVAILABLE'];
export const CANCELLABLE: readonly DonationStatus[] = ['AVAILABLE', 'MATCHED'];
export const ACTIVE_DONATION: readonly DonationStatus[] = [
  'AVAILABLE',
  'MATCHED',
  'ACCEPTED',
  'PICKUP_ASSIGNED',
  'PICKED_UP',
  'IN_TRANSIT',
  'DELIVERED',
];
