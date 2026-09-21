import type { RequirementStatus } from '@prisma/client';

export function deriveRequirementRemaining(
  quantityRequired: number,
  quantityFulfilled: number
): number {
  return quantityRequired - quantityFulfilled;
}

export function deriveDonationRemaining(quantity: number, committedQuantity: number): number {
  return quantity - committedQuantity;
}

export function deriveRequirementStatus(
  quantityRequired: number,
  quantityFulfilled: number
): RequirementStatus {
  if (quantityFulfilled <= 0) return 'OPEN';
  if (quantityFulfilled < quantityRequired) return 'PARTIALLY_FULFILLED';
  return 'FULFILLED';
}
