import type {
  DonationStatus,
  PrismaClient,
  Priority,
  RequirementStatus,
} from '@prisma/client';

export interface MatchingDonationInput {
  id: string;
  pickupLocation: string;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  category: string;
  foodType: string;
  quantity: number;
  /** Derived (REQ-08): SUM(Allocation.committedQuantity) for this donation. */
  committedQuantity: number;
  /** Derived (REQ-08): quantity − committedQuantity. Never persisted. */
  remainingQuantity: number;
  availableFrom: Date;
  availableUntil: Date;
  status: DonationStatus;
  createdAt: Date;
}

export interface MatchingRequirementInput {
  id: string;
  organizationId: string;
  foodCategory: string;
  foodType: string;
  quantityRequired: number;
  quantityFulfilled: number;
  /** Derived (REQ-08): quantityRequired − quantityFulfilled. Never persisted. */
  remainingQuantity: number;
  requiredBy: Date;
  /** Persisted assigned priority — the MATCH-D05 source (not derived). */
  priority: Priority;
  location: string;
  /** From the owning Organization (Requirement has no coordinate fields). */
  organizationLatitude: number | null;
  organizationLongitude: number | null;
  status: RequirementStatus;
  createdAt: Date;
}

// Explicit select projections using only real schema fields.
export const MATCHING_DONATION_SELECT = {
  id: true,
  pickupLocation: true,
  pickupLatitude: true,
  pickupLongitude: true,
  category: true,
  foodType: true,
  quantity: true,
  availableFrom: true,
  availableUntil: true,
  status: true,
  createdAt: true,
} as const;

export const MATCHING_REQUIREMENT_SELECT = {
  id: true,
  organizationId: true,
  foodCategory: true,
  foodType: true,
  quantityRequired: true,
  quantityFulfilled: true,
  requiredBy: true,
  priority: true,
  location: true,
  status: true,
  createdAt: true,
  organization: { select: { latitude: true, longitude: true } },
} as const;

export interface MatchingDonationRow {
  id: string;
  pickupLocation: string;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  category: string;
  foodType: string;
  quantity: number;
  availableFrom: Date;
  availableUntil: Date;
  status: DonationStatus;
  createdAt: Date;
}

export interface MatchingRequirementRow {
  id: string;
  organizationId: string;
  foodCategory: string;
  foodType: string;
  quantityRequired: number;
  quantityFulfilled: number;
  requiredBy: Date;
  priority: Priority;
  location: string;
  status: RequirementStatus;
  createdAt: Date;
  organization: { latitude: number; longitude: number } | null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Pure mapping: persisted donation row (+ allocation sum) → matching input. */
export function toMatchingDonationInput(
  donation: MatchingDonationRow,
  committedQuantity = 0
): MatchingDonationInput {
  return {
    id: donation.id,
    pickupLocation: donation.pickupLocation,
    pickupLatitude: finiteOrNull(donation.pickupLatitude),
    pickupLongitude: finiteOrNull(donation.pickupLongitude),
    category: donation.category,
    foodType: donation.foodType,
    quantity: donation.quantity,
    committedQuantity,
    remainingQuantity: donation.quantity - committedQuantity,
    availableFrom: donation.availableFrom,
    availableUntil: donation.availableUntil,
    status: donation.status,
    createdAt: donation.createdAt,
  };
}

/** Pure mapping: persisted requirement row (incl. owning organization) → matching input. */
export function toMatchingRequirementInput(
  requirement: MatchingRequirementRow
): MatchingRequirementInput {
  return {
    id: requirement.id,
    organizationId: requirement.organizationId,
    foodCategory: requirement.foodCategory,
    foodType: requirement.foodType,
    quantityRequired: requirement.quantityRequired,
    quantityFulfilled: requirement.quantityFulfilled,
    remainingQuantity: requirement.quantityRequired - requirement.quantityFulfilled,
    requiredBy: requirement.requiredBy,
    priority: requirement.priority,
    location: requirement.location,
    organizationLatitude: finiteOrNull(requirement.organization?.latitude),
    organizationLongitude: finiteOrNull(requirement.organization?.longitude),
    status: requirement.status,
    createdAt: requirement.createdAt,
  };
}

/**
 * Read-only adapter: load one donation's matching input (including the derived
 * committed/remaining quantity). Returns `null` when the donation does not exist.
 * The caller supplies the Prisma client (no global client import), matching the
 * `categoryValidation` convention; no transaction and no writes.
 */
export async function loadMatchingDonationInput(
  client: Pick<PrismaClient, 'donation' | 'allocation'>,
  donationId: string
): Promise<MatchingDonationInput | null> {
  const donation = await client.donation.findUnique({
    where: { id: donationId },
    select: MATCHING_DONATION_SELECT,
  });
  if (!donation) return null;
  const committed = await client.allocation.aggregate({
    where: { donationId },
    _sum: { committedQuantity: true },
  });
  return toMatchingDonationInput(donation, committed._sum.committedQuantity ?? 0);
}

/**
 * Read-only adapter: load one requirement's matching input (coordinates from the
 * owning organization). Returns `null` when the requirement does not exist.
 */
export async function loadMatchingRequirementInput(
  client: Pick<PrismaClient, 'requirement'>,
  requirementId: string
): Promise<MatchingRequirementInput | null> {
  const requirement = await client.requirement.findUnique({
    where: { id: requirementId },
    select: MATCHING_REQUIREMENT_SELECT,
  });
  if (!requirement) return null;
  return toMatchingRequirementInput(requirement);
}
